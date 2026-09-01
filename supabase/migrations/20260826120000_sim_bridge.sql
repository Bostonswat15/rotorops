-- =============================================================================
-- Sim bridge: paired local devices + server-side flight resolution.
--
-- Two things happen here:
--   1. `sim_devices` lets a local MSFS bridge authenticate without a password.
--      It calls the anon-executable `bridge_*` functions with a device token;
--      those are SECURITY DEFINER and resolve the company themselves, so the
--      bridge never needs a user session and RLS is never bypassed by a client.
--   2. Mission economy moves out of the browser. `rotorops_resolve_flight` is
--      the single source of truth for fuel, wear, payout and reputation --
--      called by the bridge (real telemetry) and by the app (manual entry).
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- --------------------------------------------------------------------------
-- Schema additions
-- --------------------------------------------------------------------------

-- Missions gain a dispatched state: assigned to an aircraft, awaiting the flight.
ALTER TABLE public.missions
  ADD COLUMN IF NOT EXISTS dispatched_at TIMESTAMPTZ;

-- Flight logs record where the numbers came from, and keep the raw telemetry
-- so scoring can be re-derived later without re-flying.
ALTER TABLE public.flight_logs
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS telemetry JSONB;

-- Link a fleet aircraft to whatever the sim actually reports as its TITLE.
ALTER TABLE public.aircraft
  ADD COLUMN IF NOT EXISTS sim_title_aliases TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

CREATE TABLE IF NOT EXISTS public.sim_devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'MSFS 2024 Bridge',
  pairing_code TEXT UNIQUE,
  pairing_expires_at TIMESTAMPTZ,
  token_hash TEXT UNIQUE,
  paired_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, DELETE ON public.sim_devices TO authenticated;
GRANT ALL ON public.sim_devices TO service_role;
ALTER TABLE public.sim_devices ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "own devices select" ON public.sim_devices;
CREATE POLICY "own devices select" ON public.sim_devices
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "own devices delete" ON public.sim_devices;
CREATE POLICY "own devices delete" ON public.sim_devices
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS sim_devices_company_idx ON public.sim_devices(company_id);
-- missions(company_id, status) is already indexed by the initial migration.

-- --------------------------------------------------------------------------
-- Flight resolution -- the single source of truth for the economy.
--
-- Replaces the browser-side dice roll. Success is no longer random: you
-- succeeded if you arrived at the destination, in one piece, with the load.
-- `_mission_id` may be NULL for a positioning/training flight, which still
-- accrues hours, wear and fuel cost but pays nothing.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rotorops_resolve_flight(
  _company_id UUID,
  _mission_id UUID,
  _aircraft_id UUID,
  _t JSONB,
  _source TEXT DEFAULT 'manual'
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
DECLARE
  fuel_price_per_lb CONSTANT NUMERIC := 0.9;
  v_ac        public.aircraft%ROWTYPE;
  v_m         public.missions%ROWTYPE;
  v_co        public.companies%ROWTYPE;
  v_hours     NUMERIC;
  v_fuel      NUMERIC;
  v_fpm       NUMERIC;
  v_quality   TEXT;
  v_payload   INTEGER;
  v_crashed   BOOLEAN;
  v_arrived   BOOLEAN;
  v_success   BOOLEAN;
  v_incidents TEXT[];
  v_wear      NUMERIC;
  v_new_wear  NUMERIC;
  v_fuel_cost NUMERIC;
  v_op_cost   NUMERIC;
  v_op_billed NUMERIC;
  v_payout    NUMERIC;
  v_mult      NUMERIC;
  v_net       NUMERIC;
  v_rep_delta INTEGER;
  v_log_id    UUID;
BEGIN
  SELECT * INTO v_co FROM public.companies WHERE id = _company_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'company not found'; END IF;

  SELECT * INTO v_ac FROM public.aircraft
    WHERE id = _aircraft_id AND company_id = _company_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'aircraft not found for this company'; END IF;

  IF _mission_id IS NOT NULL THEN
    SELECT * INTO v_m FROM public.missions
      WHERE id = _mission_id AND company_id = _company_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'mission not found for this company'; END IF;
    IF v_m.status NOT IN ('available', 'in_progress') THEN
      RAISE EXCEPTION 'mission already resolved (status: %)', v_m.status;
    END IF;
  END IF;

  -- Prefer measured values; fall back to the aircraft's book figures.
  v_hours := COALESCE(NULLIF((_t->>'duration_hr')::NUMERIC, 0),
                      COALESCE(v_m.distance_nm, 0)::NUMERIC / NULLIF(v_ac.cruise_kts, 0));
  v_hours := GREATEST(COALESCE(v_hours, 0), 0);
  v_fuel  := GREATEST(COALESCE((_t->>'fuel_used')::NUMERIC,
                               v_hours * v_ac.fuel_burn_pph), 0);
  v_payload := COALESCE((_t->>'payload')::INTEGER, COALESCE(v_m.min_payload, 0));
  v_fpm     := (_t->>'touchdown_fpm')::NUMERIC;
  v_crashed := COALESCE((_t->>'crashed')::BOOLEAN, false);
  v_incidents := COALESCE(
    ARRAY(SELECT jsonb_array_elements_text(_t->'incidents')), ARRAY[]::TEXT[]);

  -- Touchdown rate drives landing quality. No reading (manual entry) is 'normal'.
  v_quality := CASE
    WHEN v_fpm IS NULL THEN COALESCE(_t->>'landing_quality', 'normal')
    WHEN v_fpm >= -60  THEN 'excellent'
    WHEN v_fpm >= -240 THEN 'normal'
    WHEN v_fpm >= -600 THEN 'hard'
    ELSE 'severe'
  END;

  -- Arrived if the sim reported an airport and it matches the contract.
  -- When nothing was reported we trust the filing.
  v_arrived := CASE
    WHEN _mission_id IS NULL THEN true
    WHEN _t->>'arrival' IS NULL OR v_m.destination IS NULL THEN true
    ELSE upper(trim(_t->>'arrival')) = upper(trim(v_m.destination))
  END;

  v_success := _mission_id IS NOT NULL
               AND NOT v_crashed
               AND v_quality <> 'severe'
               AND v_arrived
               AND v_payload >= COALESCE(v_m.min_payload, 0);

  IF NOT v_arrived THEN v_incidents := v_incidents || 'off-contract landing'; END IF;
  IF v_quality = 'hard' THEN v_incidents := v_incidents || 'hard landing'; END IF;
  IF v_quality = 'severe' THEN v_incidents := v_incidents || 'skid damage on touchdown'; END IF;
  IF v_crashed THEN v_incidents := v_incidents || 'airframe loss'; END IF;

  -- Wear scales with time, contract difficulty and the airframe's own factor.
  v_wear := v_hours * (COALESCE(v_m.difficulty, 1) * 0.8) * v_ac.maintenance_factor
            + CASE v_quality WHEN 'hard' THEN 3 WHEN 'severe' THEN 12 ELSE 0 END
            + (CARDINALITY(v_incidents) * 1.5);
  v_new_wear := LEAST(100, v_ac.wear + v_wear);

  v_fuel_cost := v_fuel * fuel_price_per_lb;
  v_op_cost   := v_hours * v_ac.op_cost_hr;
  -- A failed contract still burns fuel and half the operating cost.
  v_op_billed := CASE WHEN v_success THEN v_op_cost ELSE v_op_cost * 0.5 END;

  -- Airmanship bonus/penalty on the contract payout.
  v_mult := CASE v_quality WHEN 'excellent' THEN 1.05 WHEN 'hard' THEN 0.9 ELSE 1.0 END;
  v_payout := CASE WHEN v_success THEN COALESCE(v_m.payout, 0) * v_mult ELSE 0 END;
  v_net := v_payout - v_fuel_cost - v_op_billed;

  v_rep_delta := CASE
    WHEN _mission_id IS NULL THEN 0
    WHEN v_success AND v_quality = 'excellent' THEN COALESCE(v_m.difficulty, 1) + 1
    WHEN v_success THEN COALESCE(v_m.difficulty, 1)
    ELSE -COALESCE(v_m.difficulty, 1) * 2
  END;

  INSERT INTO public.flight_logs (
    company_id, aircraft_id, mission_id, departure, arrival, duration_hr,
    fuel_used, payload, landing_quality, incidents, weather_difficulty,
    success, source, telemetry
  ) VALUES (
    _company_id, _aircraft_id, _mission_id,
    COALESCE(_t->>'departure', v_m.origin),
    COALESCE(_t->>'arrival', v_m.destination),
    ROUND(v_hours, 2), ROUND(v_fuel), v_payload,
    CASE WHEN v_quality = 'severe' THEN 'hard' ELSE v_quality END,
    NULLIF(array_to_string(v_incidents, ', '), ''),
    COALESCE(v_m.weather_factor, COALESCE((_t->>'weather_factor')::INTEGER, 1)),
    v_success, _source, _t
  ) RETURNING id INTO v_log_id;

  UPDATE public.aircraft SET
    hours  = hours + v_hours,
    wear   = v_new_wear,
    status = CASE WHEN v_crashed THEN 'destroyed'
                  WHEN v_new_wear >= 85 THEN 'grounded'
                  ELSE 'available' END
  WHERE id = _aircraft_id;

  IF _mission_id IS NOT NULL THEN
    UPDATE public.missions SET
      status = CASE WHEN v_success THEN 'completed' ELSE 'failed' END,
      completed_at = now(),
      aircraft_id = _aircraft_id
    WHERE id = _mission_id;
  END IF;

  INSERT INTO public.economy_transactions (company_id, type, amount, description)
  VALUES (_company_id, 'fuel', -ROUND(v_fuel_cost),
          format('Fuel: %s', COALESCE(v_m.title, 'positioning flight')));
  INSERT INTO public.economy_transactions (company_id, type, amount, description)
  VALUES (_company_id, 'operating', -ROUND(v_op_billed),
          format('Op cost: %s', v_ac.display_name));
  IF v_payout > 0 THEN
    INSERT INTO public.economy_transactions (company_id, type, amount, description)
    VALUES (_company_id, 'mission_payout', ROUND(v_payout), v_m.title);
  END IF;

  UPDATE public.companies SET
    cash = cash + v_net,
    reputation = GREATEST(0, LEAST(100, reputation + v_rep_delta))
  WHERE id = _company_id;

  RETURN jsonb_build_object(
    'flight_log_id', v_log_id,
    'success', v_success,
    'landing_quality', v_quality,
    'duration_hr', ROUND(v_hours, 2),
    'fuel_used', ROUND(v_fuel),
    'fuel_cost', ROUND(v_fuel_cost),
    'op_cost', ROUND(v_op_billed),
    'payout', ROUND(v_payout),
    'net', ROUND(v_net),
    'wear_added', ROUND(v_wear, 1),
    'aircraft_wear', ROUND(v_new_wear, 1),
    'reputation_delta', v_rep_delta,
    'incidents', to_jsonb(v_incidents)
  );
END;$fn$;

-- Internal only: callers go through the wrappers below, which establish identity.
REVOKE EXECUTE ON FUNCTION public.rotorops_resolve_flight(UUID, UUID, UUID, JSONB, TEXT)
  FROM PUBLIC, anon, authenticated;

-- --------------------------------------------------------------------------
-- Authenticated wrappers (the web app)
-- --------------------------------------------------------------------------

-- Assign an aircraft to a contract and mark it awaiting the flight.
CREATE OR REPLACE FUNCTION public.dispatch_mission(_mission_id UUID, _aircraft_id UUID)
RETURNS public.missions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE v_m public.missions%ROWTYPE;
BEGIN
  SELECT * INTO v_m FROM public.missions WHERE id = _mission_id FOR UPDATE;
  IF NOT FOUND OR NOT public.owns_company(v_m.company_id) THEN
    RAISE EXCEPTION 'mission not found';
  END IF;
  IF v_m.status <> 'available' THEN
    RAISE EXCEPTION 'mission is not available (status: %)', v_m.status;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.aircraft
                 WHERE id = _aircraft_id AND company_id = v_m.company_id
                   AND status = 'available') THEN
    RAISE EXCEPTION 'aircraft unavailable';
  END IF;

  UPDATE public.missions
    SET status = 'in_progress', aircraft_id = _aircraft_id, dispatched_at = now()
    WHERE id = _mission_id RETURNING * INTO v_m;
  UPDATE public.aircraft SET status = 'on_mission' WHERE id = _aircraft_id;
  RETURN v_m;
END;$fn$;

CREATE OR REPLACE FUNCTION public.cancel_dispatch(_mission_id UUID)
RETURNS public.missions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE v_m public.missions%ROWTYPE;
BEGIN
  SELECT * INTO v_m FROM public.missions WHERE id = _mission_id FOR UPDATE;
  IF NOT FOUND OR NOT public.owns_company(v_m.company_id) THEN
    RAISE EXCEPTION 'mission not found';
  END IF;
  IF v_m.status <> 'in_progress' THEN
    RAISE EXCEPTION 'mission is not dispatched';
  END IF;

  UPDATE public.aircraft SET status = 'available'
    WHERE id = v_m.aircraft_id AND status = 'on_mission';
  UPDATE public.missions
    SET status = 'available', aircraft_id = NULL, dispatched_at = NULL
    WHERE id = _mission_id RETURNING * INTO v_m;
  RETURN v_m;
END;$fn$;

-- Manual resolution, for flying without the bridge running.
CREATE OR REPLACE FUNCTION public.complete_mission_manual(
  _mission_id UUID, _aircraft_id UUID, _telemetry JSONB DEFAULT '{}'::JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE v_company UUID;
BEGIN
  SELECT company_id INTO v_company FROM public.missions WHERE id = _mission_id;
  IF v_company IS NULL OR NOT public.owns_company(v_company) THEN
    RAISE EXCEPTION 'mission not found';
  END IF;
  RETURN public.rotorops_resolve_flight(
    v_company, _mission_id, _aircraft_id, COALESCE(_telemetry, '{}'::JSONB), 'manual');
END;$fn$;

-- Issue a short pairing code for a new bridge install. Valid for 15 minutes.
CREATE OR REPLACE FUNCTION public.create_pairing_code(_name TEXT DEFAULT 'MSFS 2024 Bridge')
RETURNS TABLE (code TEXT, expires_at TIMESTAMPTZ)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
DECLARE
  -- No 0/O/1/I: these get read aloud and retyped.
  alphabet CONSTANT TEXT := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_company UUID;
  v_code    TEXT := '';
  i INTEGER;
BEGIN
  SELECT id INTO v_company FROM public.companies WHERE user_id = auth.uid() LIMIT 1;
  IF v_company IS NULL THEN RAISE EXCEPTION 'create a company first'; END IF;

  FOR i IN 1..8 LOOP
    v_code := v_code || substr(alphabet, 1 + floor(random() * length(alphabet))::INT, 1);
  END LOOP;

  -- Drop any unredeemed codes so only the newest is live.
  DELETE FROM public.sim_devices
    WHERE user_id = auth.uid() AND token_hash IS NULL;

  INSERT INTO public.sim_devices (user_id, company_id, name, pairing_code, pairing_expires_at)
  VALUES (auth.uid(), v_company, _name, v_code, now() + INTERVAL '15 minutes');

  RETURN QUERY SELECT v_code, now() + INTERVAL '15 minutes';
END;$fn$;

CREATE OR REPLACE FUNCTION public.revoke_sim_device(_device_id UUID)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $fn$
  UPDATE public.sim_devices SET revoked_at = now()
   WHERE id = _device_id AND user_id = auth.uid();
$fn$;

GRANT EXECUTE ON FUNCTION public.dispatch_mission(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_dispatch(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.complete_mission_manual(UUID, UUID, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_pairing_code(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_sim_device(UUID) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.dispatch_mission(UUID, UUID) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.cancel_dispatch(UUID) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.complete_mission_manual(UUID, UUID, JSONB) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.create_pairing_code(TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.revoke_sim_device(UUID) FROM PUBLIC, anon;

-- --------------------------------------------------------------------------
-- Bridge wrappers (the local MSFS process)
--
-- These are the only functions `anon` may execute. Each one authenticates by
-- device token and derives the company itself -- a caller cannot name one.
-- --------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.bridge_device(_token TEXT)
RETURNS public.sim_devices
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
DECLARE v_dev public.sim_devices%ROWTYPE;
BEGIN
  IF _token IS NULL OR length(_token) < 32 THEN
    RAISE EXCEPTION 'invalid device token';
  END IF;
  SELECT * INTO v_dev FROM public.sim_devices
    WHERE token_hash = encode(digest(_token, 'sha256'), 'hex')
      AND revoked_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'invalid device token'; END IF;
  RETURN v_dev;
END;$fn$;

REVOKE EXECUTE ON FUNCTION public.bridge_device(TEXT) FROM PUBLIC, anon, authenticated;

-- Exchange a one-time pairing code for a long-lived device token.
-- The raw token is returned exactly once; only its hash is stored.
CREATE OR REPLACE FUNCTION public.redeem_pairing_code(_code TEXT, _device_name TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
DECLARE
  v_dev   public.sim_devices%ROWTYPE;
  v_token TEXT;
BEGIN
  SELECT * INTO v_dev FROM public.sim_devices
    WHERE pairing_code = upper(trim(_code))
      AND token_hash IS NULL
      AND pairing_expires_at > now()
    FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'pairing code invalid or expired'; END IF;

  v_token := encode(gen_random_bytes(32), 'hex');

  UPDATE public.sim_devices SET
    token_hash = encode(digest(v_token, 'sha256'), 'hex'),
    name = COALESCE(NULLIF(trim(_device_name), ''), name),
    paired_at = now(),
    last_seen_at = now(),
    pairing_code = NULL,
    pairing_expires_at = NULL
  WHERE id = v_dev.id;

  RETURN jsonb_build_object(
    'device_id', v_dev.id,
    'device_token', v_token,
    'company_id', v_dev.company_id
  );
END;$fn$;

-- Everything the bridge needs to match aircraft and recognise dispatched work.
CREATE OR REPLACE FUNCTION public.bridge_state(_token TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
DECLARE
  v_dev public.sim_devices%ROWTYPE;
  v_out JSONB;
BEGIN
  v_dev := public.bridge_device(_token);
  UPDATE public.sim_devices SET last_seen_at = now() WHERE id = v_dev.id;

  SELECT jsonb_build_object(
    'company', (SELECT to_jsonb(c) - 'user_id' FROM public.companies c WHERE c.id = v_dev.company_id),
    'aircraft', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', a.id, 'internal_id', a.internal_id, 'display_name', a.display_name,
        'sim_title', a.sim_title, 'sim_title_aliases', a.sim_title_aliases,
        'status', a.status, 'hours', a.hours, 'wear', a.wear,
        'cruise_kts', a.cruise_kts, 'fuel_burn_pph', a.fuel_burn_pph
      )) FROM public.aircraft a
      WHERE a.company_id = v_dev.company_id AND a.status <> 'destroyed'), '[]'::JSONB),
    'dispatched', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', m.id, 'title', m.title, 'role', m.role,
        'origin', m.origin, 'destination', m.destination,
        'distance_nm', m.distance_nm, 'min_payload', m.min_payload,
        'payout', m.payout, 'difficulty', m.difficulty,
        'aircraft_id', m.aircraft_id, 'dispatched_at', m.dispatched_at
      )) FROM public.missions m
      WHERE m.company_id = v_dev.company_id AND m.status = 'in_progress'), '[]'::JSONB)
  ) INTO v_out;

  RETURN v_out;
END;$fn$;

-- Submit a completed flight. `_mission_id` NULL logs a positioning flight.
CREATE OR REPLACE FUNCTION public.bridge_submit_flight(
  _token TEXT, _aircraft_id UUID, _mission_id UUID, _telemetry JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
DECLARE v_dev public.sim_devices%ROWTYPE;
BEGIN
  v_dev := public.bridge_device(_token);
  UPDATE public.sim_devices SET last_seen_at = now() WHERE id = v_dev.id;

  RETURN public.rotorops_resolve_flight(
    v_dev.company_id, _mission_id, _aircraft_id,
    COALESCE(_telemetry, '{}'::JSONB), 'msfs2024');
END;$fn$;

GRANT EXECUTE ON FUNCTION public.redeem_pairing_code(TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bridge_state(TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bridge_submit_flight(TEXT, UUID, UUID, JSONB) TO anon, authenticated;
