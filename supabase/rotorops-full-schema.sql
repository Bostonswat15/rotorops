-- =============================================================================
-- RotorOps -- complete schema, for a fresh Supabase project.
--
-- Paste the whole file into the Supabase SQL editor and run it once. It is the
-- seven migrations in supabase/migrations/ concatenated in order:
--
--   1. base schema        tables, RLS, signup trigger
--   2. hardening          revoke EXECUTE from anon/public
--   3. sim bridge         device tokens, server-side flight resolution
--   4. co-op              membership, roles, invites, RLS rewrite
--   5. co-op economy      purchases/maintenance moved server-side, realtime
--   6. column grants      stop clients writing cash/wear directly
--   7. create_company     atomic company founding
--
-- Order matters -- step 4 drops and recreates every policy from step 1.
-- Safe to re-run: tables, policies, triggers and indexes are all guarded,
-- so running this twice is a no-op rather than an error.
-- =============================================================================



-- ###########################################################################
-- ## 20260629122426_da93795e-6371-4b29-b663-22f475850240.sql
-- ###########################################################################


-- Profiles
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "own profile select" ON public.profiles;
CREATE POLICY "own profile select" ON public.profiles FOR SELECT TO authenticated USING (auth.uid() = id);
DROP POLICY IF EXISTS "own profile insert" ON public.profiles;
CREATE POLICY "own profile insert" ON public.profiles FOR INSERT TO authenticated WITH CHECK (auth.uid() = id);
DROP POLICY IF EXISTS "own profile update" ON public.profiles;
CREATE POLICY "own profile update" ON public.profiles FOR UPDATE TO authenticated USING (auth.uid() = id);

-- Auto create profile on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.profiles (id, display_name) VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data->>'display_name', split_part(NEW.email, '@', 1)));
  RETURN NEW;
END;$$;
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Companies
CREATE TABLE IF NOT EXISTS public.companies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  cash NUMERIC NOT NULL DEFAULT 250000,
  reputation INTEGER NOT NULL DEFAULT 50,
  realism_mode TEXT NOT NULL DEFAULT 'balanced',
  difficulty TEXT NOT NULL DEFAULT 'normal',
  certifications TEXT[] NOT NULL DEFAULT ARRAY['basic_utility','training'],
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.companies TO authenticated;
GRANT ALL ON public.companies TO service_role;
ALTER TABLE public.companies ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "own company all" ON public.companies;
CREATE POLICY "own company all" ON public.companies FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- Helper: does user own company?
CREATE OR REPLACE FUNCTION public.owns_company(_company_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.companies WHERE id = _company_id AND user_id = auth.uid());
$$;

-- Bases
CREATE TABLE IF NOT EXISTS public.bases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  icao TEXT,
  region TEXT,
  is_primary BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.bases TO authenticated;
GRANT ALL ON public.bases TO service_role;
ALTER TABLE public.bases ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "own bases all" ON public.bases;
CREATE POLICY "own bases all" ON public.bases FOR ALL TO authenticated USING (public.owns_company(company_id)) WITH CHECK (public.owns_company(company_id));

-- Aircraft
CREATE TABLE IF NOT EXISTS public.aircraft (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  base_id UUID REFERENCES public.bases(id) ON DELETE SET NULL,
  internal_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  sim_title TEXT,
  category TEXT NOT NULL DEFAULT 'light_utility',
  engine_type TEXT NOT NULL DEFAULT 'turbine',
  cruise_kts INTEGER NOT NULL DEFAULT 110,
  max_range_nm INTEGER NOT NULL DEFAULT 300,
  fuel_burn_pph INTEGER NOT NULL DEFAULT 400,
  payload_lbs INTEGER NOT NULL DEFAULT 1500,
  pax_seats INTEGER NOT NULL DEFAULT 4,
  sling_load BOOLEAN NOT NULL DEFAULT false,
  hoist BOOLEAN NOT NULL DEFAULT false,
  footprint TEXT NOT NULL DEFAULT 'medium',
  reliability INTEGER NOT NULL DEFAULT 80,
  maintenance_factor NUMERIC NOT NULL DEFAULT 1.0,
  acquisition_cost NUMERIC NOT NULL DEFAULT 500000,
  lease_cost NUMERIC NOT NULL DEFAULT 0,
  op_cost_hr NUMERIC NOT NULL DEFAULT 600,
  tags TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  hours NUMERIC NOT NULL DEFAULT 0,
  wear NUMERIC NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'available',
  is_modded BOOLEAN NOT NULL DEFAULT false,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.aircraft TO authenticated;
GRANT ALL ON public.aircraft TO service_role;
ALTER TABLE public.aircraft ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "own aircraft all" ON public.aircraft;
CREATE POLICY "own aircraft all" ON public.aircraft FOR ALL TO authenticated USING (public.owns_company(company_id)) WITH CHECK (public.owns_company(company_id));

-- Missions
CREATE TABLE IF NOT EXISTS public.missions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  aircraft_id UUID REFERENCES public.aircraft(id) ON DELETE SET NULL,
  role TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  origin TEXT,
  destination TEXT,
  distance_nm INTEGER NOT NULL DEFAULT 50,
  required_tags TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  required_certs TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  min_payload INTEGER NOT NULL DEFAULT 0,
  payout NUMERIC NOT NULL DEFAULT 1000,
  difficulty INTEGER NOT NULL DEFAULT 1,
  weather_factor INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'available',
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.missions TO authenticated;
GRANT ALL ON public.missions TO service_role;
ALTER TABLE public.missions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "own missions all" ON public.missions;
CREATE POLICY "own missions all" ON public.missions FOR ALL TO authenticated USING (public.owns_company(company_id)) WITH CHECK (public.owns_company(company_id));

-- Flight Logs
CREATE TABLE IF NOT EXISTS public.flight_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  aircraft_id UUID NOT NULL REFERENCES public.aircraft(id) ON DELETE CASCADE,
  mission_id UUID REFERENCES public.missions(id) ON DELETE SET NULL,
  departure TEXT,
  arrival TEXT,
  duration_hr NUMERIC NOT NULL DEFAULT 1,
  fuel_used NUMERIC NOT NULL DEFAULT 0,
  payload INTEGER NOT NULL DEFAULT 0,
  landing_quality TEXT NOT NULL DEFAULT 'normal',
  incidents TEXT,
  weather_difficulty INTEGER NOT NULL DEFAULT 1,
  success BOOLEAN NOT NULL DEFAULT true,
  flown_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.flight_logs TO authenticated;
GRANT ALL ON public.flight_logs TO service_role;
ALTER TABLE public.flight_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "own logs all" ON public.flight_logs;
CREATE POLICY "own logs all" ON public.flight_logs FOR ALL TO authenticated USING (public.owns_company(company_id)) WITH CHECK (public.owns_company(company_id));

-- Maintenance Events
CREATE TABLE IF NOT EXISTS public.maintenance_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  aircraft_id UUID NOT NULL REFERENCES public.aircraft(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  description TEXT,
  cost NUMERIC NOT NULL DEFAULT 0,
  wear_removed NUMERIC NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'scheduled',
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.maintenance_events TO authenticated;
GRANT ALL ON public.maintenance_events TO service_role;
ALTER TABLE public.maintenance_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "own maint all" ON public.maintenance_events;
CREATE POLICY "own maint all" ON public.maintenance_events FOR ALL TO authenticated USING (public.owns_company(company_id)) WITH CHECK (public.owns_company(company_id));

-- Economy
CREATE TABLE IF NOT EXISTS public.economy_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  amount NUMERIC NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.economy_transactions TO authenticated;
GRANT ALL ON public.economy_transactions TO service_role;
ALTER TABLE public.economy_transactions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "own econ all" ON public.economy_transactions;
CREATE POLICY "own econ all" ON public.economy_transactions FOR ALL TO authenticated USING (public.owns_company(company_id)) WITH CHECK (public.owns_company(company_id));

CREATE INDEX IF NOT EXISTS aircraft_company_id_idx ON public.aircraft(company_id);
CREATE INDEX IF NOT EXISTS missions_company_id_status_idx ON public.missions(company_id, status);
CREATE INDEX IF NOT EXISTS flight_logs_company_id_flown_at_idx ON public.flight_logs(company_id, flown_at DESC);
CREATE INDEX IF NOT EXISTS maintenance_events_aircraft_id_idx ON public.maintenance_events(aircraft_id);
CREATE INDEX IF NOT EXISTS economy_transactions_company_id_created_at_idx ON public.economy_transactions(company_id, created_at DESC);


-- ###########################################################################
-- ## 20260629122444_d1f984f2-c386-4f7e-90a0-532b4332bdc1.sql
-- ###########################################################################


REVOKE EXECUTE ON FUNCTION public.owns_company(UUID) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;


-- ###########################################################################
-- ## 20260826120000_sim_bridge.sql
-- ###########################################################################

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
DROP POLICY IF EXISTS "own devices select" ON public.sim_devices;
CREATE POLICY "own devices select" ON public.sim_devices
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "own devices delete" ON public.sim_devices;
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


-- ###########################################################################
-- ## 20260827120000_coop.sql
-- ###########################################################################

-- =============================================================================
-- Co-op: one company, many pilots.
--
-- The schema was single-owner throughout -- `companies.user_id` plus an
-- `owns_company()` check on every policy. This replaces that with membership
-- and roles:
--
--   owner    runs the company, manages the roster, can delete it
--   manager  spends money: aircraft, certifications, maintenance, contracts
--   pilot    claims contracts and flies them
--
-- Two consequences drive most of what follows:
--   1. Anything that moves cash has to leave the browser. With more than one
--      member, a client-side `UPDATE companies SET cash` is a permission hole,
--      so purchases/maintenance/certs become SECURITY DEFINER functions.
--   2. Flights need attribution, so logs and contracts carry a pilot.
-- =============================================================================

-- --------------------------------------------------------------------------
-- Membership
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.company_members (
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL DEFAULT 'pilot' CHECK (role IN ('owner', 'manager', 'pilot')),
  callsign   TEXT,
  joined_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, user_id)
);

GRANT SELECT ON public.company_members TO authenticated;
GRANT ALL ON public.company_members TO service_role;
ALTER TABLE public.company_members ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS company_members_user_idx ON public.company_members(user_id);

-- Existing companies: the founder becomes the owner.
INSERT INTO public.company_members (company_id, user_id, role)
SELECT id, user_id, 'owner' FROM public.companies
ON CONFLICT (company_id, user_id) DO NOTHING;

-- Keep membership in step when a company is created by the app.
CREATE OR REPLACE FUNCTION public.handle_new_company()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
  INSERT INTO public.company_members (company_id, user_id, role)
  VALUES (NEW.id, NEW.user_id, 'owner')
  ON CONFLICT (company_id, user_id) DO NOTHING;
  -- Founding a company makes it the one you're looking at.
  UPDATE public.profiles SET active_company_id = NEW.id WHERE id = NEW.user_id;
  RETURN NEW;
END;$fn$;

-- --------------------------------------------------------------------------
-- Which company am I looking at?
--
-- A player can own one company and fly for a friend's, so "the" company is no
-- longer implied by the user. Every screen reads through current_company().
-- --------------------------------------------------------------------------

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS active_company_id UUID REFERENCES public.companies(id) ON DELETE SET NULL;

-- --------------------------------------------------------------------------
-- Role helpers.
--
-- SECURITY DEFINER matters here: these are called from company_members' own
-- policies, and without it the policy would recurse into itself.
-- --------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.company_role(_company_id UUID)
RETURNS TEXT LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  SELECT role FROM public.company_members
   WHERE company_id = _company_id AND user_id = auth.uid();
$fn$;

CREATE OR REPLACE FUNCTION public.is_company_member(_company_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  SELECT EXISTS (SELECT 1 FROM public.company_members
                  WHERE company_id = _company_id AND user_id = auth.uid());
$fn$;

CREATE OR REPLACE FUNCTION public.can_manage_company(_company_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  SELECT public.company_role(_company_id) IN ('owner', 'manager');
$fn$;

CREATE OR REPLACE FUNCTION public.is_company_owner(_company_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  SELECT public.company_role(_company_id) = 'owner';
$fn$;

-- Retained because the earlier migration's policies referenced it. Now means
-- "is a member"; anything that needs authority calls can_manage_company().
CREATE OR REPLACE FUNCTION public.owns_company(_company_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  SELECT public.is_company_member(_company_id);
$fn$;

REVOKE EXECUTE ON FUNCTION public.company_role(UUID) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.is_company_member(UUID) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.can_manage_company(UUID) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.is_company_owner(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.company_role(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_company_member(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_manage_company(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_company_owner(UUID) TO authenticated;

DROP TRIGGER IF EXISTS on_company_created ON public.companies;
DROP TRIGGER IF EXISTS on_company_created ON public.companies;
CREATE TRIGGER on_company_created AFTER INSERT ON public.companies
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_company();

-- --------------------------------------------------------------------------
-- Pilot attribution
-- --------------------------------------------------------------------------

ALTER TABLE public.flight_logs
  ADD COLUMN IF NOT EXISTS pilot_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.missions
  ADD COLUMN IF NOT EXISTS assigned_pilot_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS flight_logs_pilot_idx ON public.flight_logs(company_id, pilot_id);

-- --------------------------------------------------------------------------
-- Row-level security, rewritten.
--
-- Read is company-wide: every member sees the same books. Write authority is
-- role-gated, and anything touching cash is routed through a function instead
-- of being granted at all.
-- --------------------------------------------------------------------------

DROP POLICY IF EXISTS "own company all" ON public.companies;
DROP POLICY IF EXISTS "own bases all" ON public.bases;
DROP POLICY IF EXISTS "own aircraft all" ON public.aircraft;
DROP POLICY IF EXISTS "own missions all" ON public.missions;
DROP POLICY IF EXISTS "own logs all" ON public.flight_logs;
DROP POLICY IF EXISTS "own maint all" ON public.maintenance_events;
DROP POLICY IF EXISTS "own econ all" ON public.economy_transactions;

-- companies -----------------------------------------------------------------
DROP POLICY IF EXISTS "company read" ON public.companies;
CREATE POLICY "company read" ON public.companies
  FOR SELECT TO authenticated USING (public.is_company_member(id));
DROP POLICY IF EXISTS "company create" ON public.companies;
CREATE POLICY "company create" ON public.companies
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
-- Cash and reputation are not writable from a client; settings are.
DROP POLICY IF EXISTS "company settings" ON public.companies;
CREATE POLICY "company settings" ON public.companies
  FOR UPDATE TO authenticated
  USING (public.can_manage_company(id)) WITH CHECK (public.can_manage_company(id));
DROP POLICY IF EXISTS "company delete" ON public.companies;
CREATE POLICY "company delete" ON public.companies
  FOR DELETE TO authenticated USING (public.is_company_owner(id));

-- company_members -----------------------------------------------------------
DROP POLICY IF EXISTS "roster read" ON public.company_members;
CREATE POLICY "roster read" ON public.company_members
  FOR SELECT TO authenticated USING (public.is_company_member(company_id));

-- bases ---------------------------------------------------------------------
DROP POLICY IF EXISTS "bases read" ON public.bases;
CREATE POLICY "bases read" ON public.bases
  FOR SELECT TO authenticated USING (public.is_company_member(company_id));
DROP POLICY IF EXISTS "bases write" ON public.bases;
CREATE POLICY "bases write" ON public.bases
  FOR ALL TO authenticated
  USING (public.can_manage_company(company_id))
  WITH CHECK (public.can_manage_company(company_id));

-- aircraft ------------------------------------------------------------------
DROP POLICY IF EXISTS "aircraft read" ON public.aircraft;
CREATE POLICY "aircraft read" ON public.aircraft
  FOR SELECT TO authenticated USING (public.is_company_member(company_id));
DROP POLICY IF EXISTS "aircraft manage" ON public.aircraft;
CREATE POLICY "aircraft manage" ON public.aircraft
  FOR UPDATE TO authenticated
  USING (public.can_manage_company(company_id))
  WITH CHECK (public.can_manage_company(company_id));
DROP POLICY IF EXISTS "aircraft retire" ON public.aircraft;
CREATE POLICY "aircraft retire" ON public.aircraft
  FOR DELETE TO authenticated USING (public.can_manage_company(company_id));
-- INSERT is deliberately absent: buying goes through purchase_aircraft().

-- missions ------------------------------------------------------------------
DROP POLICY IF EXISTS "missions read" ON public.missions;
CREATE POLICY "missions read" ON public.missions
  FOR SELECT TO authenticated USING (public.is_company_member(company_id));
DROP POLICY IF EXISTS "missions generate" ON public.missions;
CREATE POLICY "missions generate" ON public.missions
  FOR INSERT TO authenticated WITH CHECK (public.can_manage_company(company_id));
DROP POLICY IF EXISTS "missions clear" ON public.missions;
CREATE POLICY "missions clear" ON public.missions
  FOR DELETE TO authenticated USING (public.can_manage_company(company_id));
-- UPDATE is absent: dispatch and resolution go through functions.

-- flight_logs, maintenance_events, economy_transactions ---------------------
-- Read-only to clients. Every write is a function that also moves money.
DROP POLICY IF EXISTS "logs read" ON public.flight_logs;
CREATE POLICY "logs read" ON public.flight_logs
  FOR SELECT TO authenticated USING (public.is_company_member(company_id));
DROP POLICY IF EXISTS "maint read" ON public.maintenance_events;
CREATE POLICY "maint read" ON public.maintenance_events
  FOR SELECT TO authenticated USING (public.is_company_member(company_id));
DROP POLICY IF EXISTS "econ read" ON public.economy_transactions;
CREATE POLICY "econ read" ON public.economy_transactions
  FOR SELECT TO authenticated USING (public.is_company_member(company_id));

REVOKE INSERT, UPDATE, DELETE ON public.flight_logs FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.maintenance_events FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.economy_transactions FROM authenticated;
REVOKE INSERT ON public.aircraft FROM authenticated;

-- sim_devices ---------------------------------------------------------------
-- A device belongs to a person, not the company, so this stays user-scoped.

-- --------------------------------------------------------------------------
-- Invites
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.company_invites (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  code       TEXT NOT NULL UNIQUE,
  role       TEXT NOT NULL DEFAULT 'pilot' CHECK (role IN ('manager', 'pilot')),
  created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  max_uses   INTEGER NOT NULL DEFAULT 1,
  uses       INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT ON public.company_invites TO authenticated;
GRANT ALL ON public.company_invites TO service_role;
ALTER TABLE public.company_invites ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "invites read" ON public.company_invites;
CREATE POLICY "invites read" ON public.company_invites
  FOR SELECT TO authenticated USING (public.can_manage_company(company_id));

CREATE OR REPLACE FUNCTION public.create_invite(
  _company_id UUID, _role TEXT DEFAULT 'pilot', _max_uses INTEGER DEFAULT 1)
RETURNS public.company_invites
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $fn$
DECLARE
  alphabet CONSTANT TEXT := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_code TEXT := '';
  v_row  public.company_invites%ROWTYPE;
  i INTEGER;
BEGIN
  IF NOT public.can_manage_company(_company_id) THEN
    RAISE EXCEPTION 'only owners and managers can invite';
  END IF;
  IF _role NOT IN ('manager', 'pilot') THEN
    RAISE EXCEPTION 'invalid role: %', _role;
  END IF;
  -- Only an owner can hand out authority over the treasury.
  IF _role = 'manager' AND NOT public.is_company_owner(_company_id) THEN
    RAISE EXCEPTION 'only the owner can invite managers';
  END IF;

  FOR i IN 1..8 LOOP
    v_code := v_code || substr(alphabet, 1 + floor(random() * length(alphabet))::INT, 1);
  END LOOP;

  INSERT INTO public.company_invites (company_id, code, role, created_by, expires_at, max_uses)
  VALUES (_company_id, v_code, _role, auth.uid(), now() + INTERVAL '7 days',
          GREATEST(1, LEAST(_max_uses, 50)))
  RETURNING * INTO v_row;
  RETURN v_row;
END;$fn$;

CREATE OR REPLACE FUNCTION public.revoke_invite(_invite_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_company UUID;
BEGIN
  SELECT company_id INTO v_company FROM public.company_invites WHERE id = _invite_id;
  IF v_company IS NULL OR NOT public.can_manage_company(v_company) THEN
    RAISE EXCEPTION 'invite not found';
  END IF;
  DELETE FROM public.company_invites WHERE id = _invite_id;
END;$fn$;

CREATE OR REPLACE FUNCTION public.join_company(_code TEXT)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_inv  public.company_invites%ROWTYPE;
  v_name TEXT;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not signed in'; END IF;

  SELECT * INTO v_inv FROM public.company_invites
    WHERE code = upper(trim(_code)) AND expires_at > now() AND uses < max_uses
    FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'invite code invalid, expired, or fully used'; END IF;

  IF EXISTS (SELECT 1 FROM public.company_members
              WHERE company_id = v_inv.company_id AND user_id = auth.uid()) THEN
    RAISE EXCEPTION 'you are already a member of this company';
  END IF;

  INSERT INTO public.company_members (company_id, user_id, role)
  VALUES (v_inv.company_id, auth.uid(), v_inv.role);

  UPDATE public.company_invites SET uses = uses + 1 WHERE id = v_inv.id;
  UPDATE public.profiles SET active_company_id = v_inv.company_id WHERE id = auth.uid();

  SELECT name INTO v_name FROM public.companies WHERE id = v_inv.company_id;
  RETURN jsonb_build_object(
    'company_id', v_inv.company_id, 'company_name', v_name, 'role', v_inv.role);
END;$fn$;

-- Roster management ---------------------------------------------------------

CREATE OR REPLACE FUNCTION public.set_member_role(
  _company_id UUID, _user_id UUID, _role TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
  IF NOT public.is_company_owner(_company_id) THEN
    RAISE EXCEPTION 'only the owner can change roles';
  END IF;
  IF _role NOT IN ('owner', 'manager', 'pilot') THEN
    RAISE EXCEPTION 'invalid role: %', _role;
  END IF;
  IF _user_id = auth.uid() AND _role <> 'owner' THEN
    RAISE EXCEPTION 'transfer ownership before demoting yourself';
  END IF;

  UPDATE public.company_members SET role = _role
   WHERE company_id = _company_id AND user_id = _user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'not a member of this company'; END IF;

  -- One owner at a time: promoting someone hands over the company.
  IF _role = 'owner' THEN
    UPDATE public.company_members SET role = 'manager'
     WHERE company_id = _company_id AND user_id = auth.uid();
    UPDATE public.companies SET user_id = _user_id WHERE id = _company_id;
  END IF;
END;$fn$;

CREATE OR REPLACE FUNCTION public.remove_member(_company_id UUID, _user_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
  -- Anyone may leave; only the owner may remove someone else.
  IF _user_id <> auth.uid() AND NOT public.is_company_owner(_company_id) THEN
    RAISE EXCEPTION 'only the owner can remove members';
  END IF;
  IF public.company_role(_company_id) = 'owner' AND _user_id = auth.uid() THEN
    RAISE EXCEPTION 'transfer ownership before leaving';
  END IF;

  DELETE FROM public.company_members
   WHERE company_id = _company_id AND user_id = _user_id;
  UPDATE public.profiles SET active_company_id = NULL
   WHERE id = _user_id AND active_company_id = _company_id;
END;$fn$;

CREATE OR REPLACE FUNCTION public.set_active_company(_company_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
  IF NOT public.is_company_member(_company_id) THEN
    RAISE EXCEPTION 'not a member of this company';
  END IF;
  UPDATE public.profiles SET active_company_id = _company_id WHERE id = auth.uid();
END;$fn$;

GRANT EXECUTE ON FUNCTION public.create_invite(UUID, TEXT, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_invite(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.join_company(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_member_role(UUID, UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.remove_member(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_active_company(UUID) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.create_invite(UUID, TEXT, INTEGER) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.revoke_invite(UUID) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.join_company(TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.set_member_role(UUID, UUID, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.remove_member(UUID, UUID) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.set_active_company(UUID) FROM PUBLIC, anon;


-- ###########################################################################
-- ## 20260827120100_coop_economy.sql
-- ###########################################################################

-- =============================================================================
-- Co-op, part 2: the economy moves server-side.
--
-- With more than one member, every client-side `UPDATE companies SET cash` is a
-- way for any pilot to print money. This replaces the last five of them with
-- functions that own their own pricing, and threads pilot attribution through
-- flight resolution.
-- =============================================================================

-- --------------------------------------------------------------------------
-- Reading your own company
-- --------------------------------------------------------------------------

-- Prefers the profile's active company, falling back to the earliest one you
-- joined -- so a stale active_company_id can't leave you with no company.
CREATE OR REPLACE FUNCTION public.current_company()
RETURNS public.companies
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  SELECT c.* FROM public.companies c
   WHERE c.id = (
     SELECT cm.company_id FROM public.company_members cm
      WHERE cm.user_id = auth.uid()
      ORDER BY (cm.company_id = (SELECT p.active_company_id
                                   FROM public.profiles p
                                  WHERE p.id = auth.uid())) DESC NULLS LAST,
               cm.joined_at
      LIMIT 1);
$fn$;

-- Everything you're a member of, for the company switcher.
CREATE OR REPLACE FUNCTION public.my_companies()
RETURNS TABLE (id UUID, name TEXT, role TEXT, cash NUMERIC, reputation INTEGER, is_active BOOLEAN)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  SELECT c.id, c.name, cm.role, c.cash, c.reputation,
         c.id = (SELECT p.active_company_id FROM public.profiles p WHERE p.id = auth.uid())
    FROM public.company_members cm
    JOIN public.companies c ON c.id = cm.company_id
   WHERE cm.user_id = auth.uid()
   ORDER BY cm.joined_at;
$fn$;

-- The roster, with display names pulled from profiles.
CREATE OR REPLACE FUNCTION public.company_roster(_company_id UUID)
RETURNS TABLE (user_id UUID, display_name TEXT, role TEXT, callsign TEXT,
               joined_at TIMESTAMPTZ, flights BIGINT, hours NUMERIC)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  SELECT cm.user_id, p.display_name, cm.role, cm.callsign, cm.joined_at,
         COUNT(fl.id),
         COALESCE(SUM(fl.duration_hr), 0)
    FROM public.company_members cm
    LEFT JOIN public.profiles p ON p.id = cm.user_id
    LEFT JOIN public.flight_logs fl
           ON fl.pilot_id = cm.user_id AND fl.company_id = cm.company_id
   WHERE cm.company_id = _company_id
     AND public.is_company_member(_company_id)
   GROUP BY cm.user_id, p.display_name, cm.role, cm.callsign, cm.joined_at
   ORDER BY cm.joined_at;
$fn$;

GRANT EXECUTE ON FUNCTION public.current_company() TO authenticated;
GRANT EXECUTE ON FUNCTION public.my_companies() TO authenticated;
GRANT EXECUTE ON FUNCTION public.company_roster(UUID) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.current_company() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.my_companies() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.company_roster(UUID) FROM PUBLIC, anon;

-- --------------------------------------------------------------------------
-- Certification catalog
--
-- Prices have to live server-side now, or the client names its own. Mirrors
-- CERT_UNLOCKS in src/lib/game-data.ts -- keep the two in step.
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.cert_catalog (
  cert    TEXT PRIMARY KEY,
  cost    NUMERIC NOT NULL,
  min_rep INTEGER NOT NULL
);
GRANT SELECT ON public.cert_catalog TO authenticated, anon;
GRANT ALL ON public.cert_catalog TO service_role;
ALTER TABLE public.cert_catalog ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "catalog readable" ON public.cert_catalog;
DROP POLICY IF EXISTS "catalog readable" ON public.cert_catalog;
CREATE POLICY "catalog readable" ON public.cert_catalog FOR SELECT TO authenticated USING (true);

INSERT INTO public.cert_catalog (cert, cost, min_rep) VALUES
  ('turbine',       15000, 55),
  ('hoist',         25000, 65),
  ('medevac',       50000, 70),
  ('offshore',      60000, 70),
  ('firefighting',  80000, 75),
  ('sar',          100000, 80),
  ('heavy_lift',   120000, 80)
ON CONFLICT (cert) DO UPDATE SET cost = EXCLUDED.cost, min_rep = EXCLUDED.min_rep;

CREATE OR REPLACE FUNCTION public.purchase_certification(_company_id UUID, _cert TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_co   public.companies%ROWTYPE;
  v_cat  public.cert_catalog%ROWTYPE;
BEGIN
  IF NOT public.can_manage_company(_company_id) THEN
    RAISE EXCEPTION 'only owners and managers can purchase certifications';
  END IF;

  SELECT * INTO v_cat FROM public.cert_catalog WHERE cert = _cert;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown certification: %', _cert; END IF;

  SELECT * INTO v_co FROM public.companies WHERE id = _company_id FOR UPDATE;
  IF _cert = ANY(v_co.certifications) THEN
    RAISE EXCEPTION 'already certified';
  END IF;
  IF v_co.cash < v_cat.cost THEN RAISE EXCEPTION 'insufficient cash'; END IF;
  IF v_co.reputation < v_cat.min_rep THEN
    RAISE EXCEPTION 'reputation % required (you have %)', v_cat.min_rep, v_co.reputation;
  END IF;

  UPDATE public.companies
     SET cash = cash - v_cat.cost,
         certifications = array_append(certifications, _cert)
   WHERE id = _company_id;
  INSERT INTO public.economy_transactions (company_id, type, amount, description)
  VALUES (_company_id, 'certification', -v_cat.cost, format('Certification: %s', _cert));

  RETURN jsonb_build_object('cert', _cert, 'cost', v_cat.cost);
END;$fn$;

-- --------------------------------------------------------------------------
-- Aircraft acquisition
--
-- Specs come from the client because custom and modded airframes are the point
-- of this app -- there is no fixed catalog to price against. Manager-gated
-- instead, so the trust boundary is the roster rather than the payload.
-- --------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.purchase_aircraft(
  _company_id UUID, _spec JSONB, _purchase BOOLEAN DEFAULT true)
RETURNS public.aircraft
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_co   public.companies%ROWTYPE;
  v_cost NUMERIC;
  v_ac   public.aircraft%ROWTYPE;
BEGIN
  IF NOT public.can_manage_company(_company_id) THEN
    RAISE EXCEPTION 'only owners and managers can add aircraft';
  END IF;

  v_cost := GREATEST(COALESCE((_spec->>'acquisition_cost')::NUMERIC, 0), 0);
  SELECT * INTO v_co FROM public.companies WHERE id = _company_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'company not found'; END IF;
  IF _purchase AND v_co.cash < v_cost THEN RAISE EXCEPTION 'insufficient cash'; END IF;

  INSERT INTO public.aircraft (
    company_id, base_id, internal_id, display_name, sim_title, category,
    engine_type, cruise_kts, max_range_nm, fuel_burn_pph, payload_lbs,
    pax_seats, sling_load, hoist, footprint, reliability, maintenance_factor,
    acquisition_cost, lease_cost, op_cost_hr, tags, is_modded, notes
  )
  SELECT
    _company_id,
    NULLIF(_spec->>'base_id', '')::UUID,
    COALESCE(_spec->>'internal_id', 'CUSTOM'),
    COALESCE(_spec->>'display_name', 'Unnamed helicopter'),
    _spec->>'sim_title',
    COALESCE(_spec->>'category', 'light_utility'),
    COALESCE(_spec->>'engine_type', 'turbine'),
    COALESCE((_spec->>'cruise_kts')::INTEGER, 110),
    COALESCE((_spec->>'max_range_nm')::INTEGER, 300),
    COALESCE((_spec->>'fuel_burn_pph')::INTEGER, 400),
    COALESCE((_spec->>'payload_lbs')::INTEGER, 1500),
    COALESCE((_spec->>'pax_seats')::INTEGER, 4),
    COALESCE((_spec->>'sling_load')::BOOLEAN, false),
    COALESCE((_spec->>'hoist')::BOOLEAN, false),
    COALESCE(_spec->>'footprint', 'medium'),
    COALESCE((_spec->>'reliability')::INTEGER, 80),
    COALESCE((_spec->>'maintenance_factor')::NUMERIC, 1.0),
    v_cost,
    COALESCE((_spec->>'lease_cost')::NUMERIC, 0),
    COALESCE((_spec->>'op_cost_hr')::NUMERIC, 600),
    COALESCE(ARRAY(SELECT jsonb_array_elements_text(_spec->'tags')), ARRAY[]::TEXT[]),
    COALESCE((_spec->>'is_modded')::BOOLEAN, false),
    _spec->>'notes'
  RETURNING * INTO v_ac;

  IF _purchase AND v_cost > 0 THEN
    UPDATE public.companies SET cash = cash - v_cost WHERE id = _company_id;
    INSERT INTO public.economy_transactions (company_id, type, amount, description)
    VALUES (_company_id, 'aircraft_purchase', -v_cost,
            format('Purchased %s', v_ac.display_name));
  END IF;

  RETURN v_ac;
END;$fn$;

-- --------------------------------------------------------------------------
-- Maintenance -- priced from the airframe, so the client can't discount it.
-- --------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.service_aircraft(_aircraft_id UUID, _type TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_ac   public.aircraft%ROWTYPE;
  v_co   public.companies%ROWTYPE;
  v_cost NUMERIC;
  v_wear NUMERIC;
BEGIN
  IF _type NOT IN ('inspection', 'overhaul') THEN
    RAISE EXCEPTION 'unknown service type: %', _type;
  END IF;

  SELECT * INTO v_ac FROM public.aircraft WHERE id = _aircraft_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'aircraft not found'; END IF;
  IF NOT public.can_manage_company(v_ac.company_id) THEN
    RAISE EXCEPTION 'only owners and managers can authorise maintenance';
  END IF;
  IF v_ac.status = 'on_mission' THEN
    RAISE EXCEPTION 'aircraft is out on a contract';
  END IF;

  v_cost := CASE _type
    WHEN 'inspection' THEN ROUND(v_ac.op_cost_hr * 6 * v_ac.maintenance_factor)
    ELSE ROUND(v_ac.acquisition_cost * 0.04 * v_ac.maintenance_factor)
  END;
  v_wear := CASE _type WHEN 'inspection' THEN 30 ELSE 80 END;

  SELECT * INTO v_co FROM public.companies WHERE id = v_ac.company_id FOR UPDATE;
  IF v_co.cash < v_cost THEN RAISE EXCEPTION 'insufficient cash'; END IF;

  INSERT INTO public.maintenance_events (
    company_id, aircraft_id, type, description, cost, wear_removed,
    status, completed_at)
  VALUES (v_ac.company_id, _aircraft_id, _type,
          format('%s on %s', _type, v_ac.display_name),
          v_cost, v_wear, 'completed', now());

  UPDATE public.aircraft
     SET wear = GREATEST(0, wear - v_wear),
         status = CASE WHEN status = 'destroyed' THEN status ELSE 'available' END
   WHERE id = _aircraft_id;
  UPDATE public.companies SET cash = cash - v_cost WHERE id = v_ac.company_id;
  INSERT INTO public.economy_transactions (company_id, type, amount, description)
  VALUES (v_ac.company_id, 'maintenance', -v_cost,
          format('%s: %s', _type, v_ac.display_name));

  RETURN jsonb_build_object('cost', v_cost, 'wear_removed', v_wear);
END;$fn$;

GRANT EXECUTE ON FUNCTION public.purchase_certification(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.purchase_aircraft(UUID, JSONB, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.service_aircraft(UUID, TEXT) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.purchase_certification(UUID, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.purchase_aircraft(UUID, JSONB, BOOLEAN) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.service_aircraft(UUID, TEXT) FROM PUBLIC, anon;

-- --------------------------------------------------------------------------
-- Flight resolution, now with a pilot attached.
-- --------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.rotorops_resolve_flight(UUID, UUID, UUID, JSONB, TEXT);

CREATE OR REPLACE FUNCTION public.rotorops_resolve_flight(
  _company_id UUID,
  _mission_id UUID,
  _aircraft_id UUID,
  _t JSONB,
  _source TEXT DEFAULT 'manual',
  _pilot_id UUID DEFAULT NULL
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
    -- A contract belongs to whoever claimed it.
    IF v_m.assigned_pilot_id IS NOT NULL
       AND _pilot_id IS NOT NULL
       AND v_m.assigned_pilot_id <> _pilot_id THEN
      RAISE EXCEPTION 'this contract is assigned to another pilot';
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

  v_quality := CASE
    WHEN v_fpm IS NULL THEN COALESCE(_t->>'landing_quality', 'normal')
    WHEN v_fpm >= -60  THEN 'excellent'
    WHEN v_fpm >= -240 THEN 'normal'
    WHEN v_fpm >= -600 THEN 'hard'
    ELSE 'severe'
  END;

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

  v_wear := v_hours * (COALESCE(v_m.difficulty, 1) * 0.8) * v_ac.maintenance_factor
            + CASE v_quality WHEN 'hard' THEN 3 WHEN 'severe' THEN 12 ELSE 0 END
            + (CARDINALITY(v_incidents) * 1.5);
  v_new_wear := LEAST(100, v_ac.wear + v_wear);

  v_fuel_cost := v_fuel * fuel_price_per_lb;
  v_op_cost   := v_hours * v_ac.op_cost_hr;
  v_op_billed := CASE WHEN v_success THEN v_op_cost ELSE v_op_cost * 0.5 END;

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
    company_id, aircraft_id, mission_id, pilot_id, departure, arrival,
    duration_hr, fuel_used, payload, landing_quality, incidents,
    weather_difficulty, success, source, telemetry
  ) VALUES (
    _company_id, _aircraft_id, _mission_id,
    COALESCE(_pilot_id, v_m.assigned_pilot_id),
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

REVOKE EXECUTE ON FUNCTION
  public.rotorops_resolve_flight(UUID, UUID, UUID, JSONB, TEXT, UUID)
  FROM PUBLIC, anon, authenticated;

-- --------------------------------------------------------------------------
-- Wrappers, updated for membership and pilots
-- --------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.dispatch_mission(_mission_id UUID, _aircraft_id UUID)
RETURNS public.missions
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_m public.missions%ROWTYPE;
BEGIN
  SELECT * INTO v_m FROM public.missions WHERE id = _mission_id FOR UPDATE;
  IF NOT FOUND OR NOT public.is_company_member(v_m.company_id) THEN
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

  -- Claiming a contract assigns it to you; nobody else can fly it.
  UPDATE public.missions
     SET status = 'in_progress', aircraft_id = _aircraft_id,
         dispatched_at = now(), assigned_pilot_id = auth.uid()
   WHERE id = _mission_id RETURNING * INTO v_m;
  UPDATE public.aircraft SET status = 'on_mission' WHERE id = _aircraft_id;
  RETURN v_m;
END;$fn$;

CREATE OR REPLACE FUNCTION public.cancel_dispatch(_mission_id UUID)
RETURNS public.missions
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_m public.missions%ROWTYPE;
BEGIN
  SELECT * INTO v_m FROM public.missions WHERE id = _mission_id FOR UPDATE;
  IF NOT FOUND OR NOT public.is_company_member(v_m.company_id) THEN
    RAISE EXCEPTION 'mission not found';
  END IF;
  IF v_m.status <> 'in_progress' THEN
    RAISE EXCEPTION 'mission is not dispatched';
  END IF;
  -- Your own contract, or a manager clearing someone's abandoned one.
  IF v_m.assigned_pilot_id <> auth.uid()
     AND NOT public.can_manage_company(v_m.company_id) THEN
    RAISE EXCEPTION 'this contract belongs to another pilot';
  END IF;

  UPDATE public.aircraft SET status = 'available'
   WHERE id = v_m.aircraft_id AND status = 'on_mission';
  UPDATE public.missions
     SET status = 'available', aircraft_id = NULL,
         dispatched_at = NULL, assigned_pilot_id = NULL
   WHERE id = _mission_id RETURNING * INTO v_m;
  RETURN v_m;
END;$fn$;

CREATE OR REPLACE FUNCTION public.complete_mission_manual(
  _mission_id UUID, _aircraft_id UUID, _telemetry JSONB DEFAULT '{}'::JSONB)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_company UUID;
BEGIN
  SELECT company_id INTO v_company FROM public.missions WHERE id = _mission_id;
  IF v_company IS NULL OR NOT public.is_company_member(v_company) THEN
    RAISE EXCEPTION 'mission not found';
  END IF;
  RETURN public.rotorops_resolve_flight(
    v_company, _mission_id, _aircraft_id,
    COALESCE(_telemetry, '{}'::JSONB), 'manual', auth.uid());
END;$fn$;

-- Replaces the direct flight_logs insert the log form used to do.
CREATE OR REPLACE FUNCTION public.log_positioning_flight(
  _aircraft_id UUID, _telemetry JSONB DEFAULT '{}'::JSONB)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_company UUID;
BEGIN
  SELECT company_id INTO v_company FROM public.aircraft WHERE id = _aircraft_id;
  IF v_company IS NULL OR NOT public.is_company_member(v_company) THEN
    RAISE EXCEPTION 'aircraft not found';
  END IF;
  RETURN public.rotorops_resolve_flight(
    v_company, NULL, _aircraft_id,
    COALESCE(_telemetry, '{}'::JSONB), 'manual', auth.uid());
END;$fn$;

GRANT EXECUTE ON FUNCTION public.log_positioning_flight(UUID, JSONB) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.log_positioning_flight(UUID, JSONB) FROM PUBLIC, anon;

-- Bridge wrappers: the device's owner is the pilot.
CREATE OR REPLACE FUNCTION public.bridge_submit_flight(
  _token TEXT, _aircraft_id UUID, _mission_id UUID, _telemetry JSONB)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $fn$
DECLARE v_dev public.sim_devices%ROWTYPE;
BEGIN
  v_dev := public.bridge_device(_token);
  UPDATE public.sim_devices SET last_seen_at = now() WHERE id = v_dev.id;

  RETURN public.rotorops_resolve_flight(
    v_dev.company_id, _mission_id, _aircraft_id,
    COALESCE(_telemetry, '{}'::JSONB), 'msfs2024', v_dev.user_id);
END;$fn$;

-- Only hand the bridge contracts this pilot actually claimed.
CREATE OR REPLACE FUNCTION public.bridge_state(_token TEXT)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $fn$
DECLARE
  v_dev public.sim_devices%ROWTYPE;
  v_out JSONB;
BEGIN
  v_dev := public.bridge_device(_token);
  UPDATE public.sim_devices SET last_seen_at = now() WHERE id = v_dev.id;

  SELECT jsonb_build_object(
    'company', (SELECT to_jsonb(c) - 'user_id' FROM public.companies c
                 WHERE c.id = v_dev.company_id),
    'role', (SELECT role FROM public.company_members
              WHERE company_id = v_dev.company_id AND user_id = v_dev.user_id),
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
      WHERE m.company_id = v_dev.company_id
        AND m.status = 'in_progress'
        AND (m.assigned_pilot_id IS NULL OR m.assigned_pilot_id = v_dev.user_id)),
      '[]'::JSONB)
  ) INTO v_out;

  RETURN v_out;
END;$fn$;

GRANT EXECUTE ON FUNCTION public.bridge_state(TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bridge_submit_flight(TEXT, UUID, UUID, JSONB) TO anon, authenticated;

-- --------------------------------------------------------------------------
-- Realtime: everyone watching a company sees the same books update live.
-- --------------------------------------------------------------------------

ALTER TABLE public.companies REPLICA IDENTITY FULL;
ALTER TABLE public.missions REPLICA IDENTITY FULL;
ALTER TABLE public.aircraft REPLICA IDENTITY FULL;
ALTER TABLE public.flight_logs REPLICA IDENTITY FULL;
ALTER TABLE public.company_members REPLICA IDENTITY FULL;

DO $do$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['companies', 'missions', 'aircraft', 'flight_logs',
                           'economy_transactions', 'company_members'] LOOP
    BEGIN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
    EXCEPTION
      WHEN duplicate_object THEN NULL;  -- already published
      WHEN undefined_object THEN NULL;  -- no supabase_realtime publication here
    END;
  END LOOP;
END;$do$;


-- ###########################################################################
-- ## 20260827120200_column_grants.sql
-- ###########################################################################

-- =============================================================================
-- Column-level grants.
--
-- RLS decides which *rows* you may touch, never which *columns*. Without this,
-- the "company settings" policy that lets a manager rename the company also
-- lets them run `UPDATE companies SET cash = 99999999`, and the aircraft policy
-- lets them zero out `wear` to dodge a maintenance bill.
--
-- Postgres expresses that as GRANT UPDATE (col, ...), so the writable surface
-- is spelled out here and everything else moves through a function.
-- =============================================================================

-- companies: presentation and rules are editable; the balance sheet is not.
REVOKE UPDATE ON public.companies FROM authenticated;
GRANT UPDATE (name, realism_mode, difficulty) ON public.companies TO authenticated;

-- aircraft: naming and sim-matching are editable. hours, wear, status,
-- costs and performance figures are set by flight resolution and purchase.
REVOKE UPDATE ON public.aircraft FROM authenticated;
GRANT UPDATE (
  display_name, sim_title, sim_title_aliases, notes, base_id, is_modded, tags
) ON public.aircraft TO authenticated;

-- missions: clients read and generate them; state transitions are functions.
REVOKE UPDATE ON public.missions FROM authenticated;

-- profiles: your own display name, nothing else. active_company_id moves
-- through set_active_company(), which checks membership first.
REVOKE UPDATE ON public.profiles FROM authenticated;
GRANT UPDATE (display_name) ON public.profiles TO authenticated;


-- ###########################################################################
-- ## 20260827120300_create_company.sql
-- ###########################################################################

-- =============================================================================
-- Founding a company, in one transaction.
--
-- Setup used to be four client inserts: company, base, starter aircraft,
-- opening capital. Two of those tables no longer accept direct writes, and the
-- starting cash was being chosen by the client regardless. This does the whole
-- thing server-side, so a half-created company can't exist.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.create_company(
  _name       TEXT,
  _difficulty TEXT DEFAULT 'normal',
  _realism    TEXT DEFAULT 'balanced',
  _base_name  TEXT DEFAULT 'Main Heliport',
  _icao       TEXT DEFAULT NULL,
  _starter    JSONB DEFAULT NULL
) RETURNS public.companies
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_cash NUMERIC;
  v_co   public.companies%ROWTYPE;
  v_base UUID;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not signed in'; END IF;
  IF coalesce(trim(_name), '') = '' THEN RAISE EXCEPTION 'company name required'; END IF;
  IF _difficulty NOT IN ('easy', 'normal', 'hard') THEN
    RAISE EXCEPTION 'invalid difficulty: %', _difficulty;
  END IF;
  IF _realism NOT IN ('strict', 'balanced', 'sandbox') THEN
    RAISE EXCEPTION 'invalid realism mode: %', _realism;
  END IF;

  -- Opening capital is a rule of the game, not a client input.
  v_cash := CASE _difficulty
    WHEN 'hard' THEN 120000
    WHEN 'easy' THEN 500000
    ELSE 250000
  END;

  INSERT INTO public.companies (user_id, name, cash, difficulty, realism_mode)
  VALUES (auth.uid(), trim(_name), v_cash, _difficulty, _realism)
  RETURNING * INTO v_co;
  -- on_company_created has already added the owner membership row.

  INSERT INTO public.bases (company_id, name, icao, is_primary)
  VALUES (v_co.id, COALESCE(NULLIF(trim(_base_name), ''), 'Main Heliport'),
          NULLIF(upper(trim(_icao)), ''), true)
  RETURNING id INTO v_base;

  IF _starter IS NOT NULL THEN
    INSERT INTO public.aircraft (
      company_id, base_id, internal_id, display_name, sim_title, category,
      engine_type, cruise_kts, max_range_nm, fuel_burn_pph, payload_lbs,
      pax_seats, sling_load, hoist, footprint, reliability,
      maintenance_factor, acquisition_cost, op_cost_hr, tags
    )
    SELECT
      v_co.id, v_base,
      COALESCE(_starter->>'internal_id', 'CUSTOM'),
      COALESCE(_starter->>'display_name', 'Starter helicopter'),
      _starter->>'sim_title',
      COALESCE(_starter->>'category', 'light_utility'),
      COALESCE(_starter->>'engine_type', 'turbine'),
      COALESCE((_starter->>'cruise_kts')::INTEGER, 110),
      COALESCE((_starter->>'max_range_nm')::INTEGER, 300),
      COALESCE((_starter->>'fuel_burn_pph')::INTEGER, 400),
      COALESCE((_starter->>'payload_lbs')::INTEGER, 1500),
      COALESCE((_starter->>'pax_seats')::INTEGER, 4),
      COALESCE((_starter->>'sling_load')::BOOLEAN, false),
      COALESCE((_starter->>'hoist')::BOOLEAN, false),
      COALESCE(_starter->>'footprint', 'medium'),
      COALESCE((_starter->>'reliability')::INTEGER, 80),
      COALESCE((_starter->>'maintenance_factor')::NUMERIC, 1.0),
      COALESCE((_starter->>'acquisition_cost')::NUMERIC, 0),
      COALESCE((_starter->>'op_cost_hr')::NUMERIC, 600),
      COALESCE(ARRAY(SELECT jsonb_array_elements_text(_starter->'tags')), ARRAY[]::TEXT[]);
  END IF;

  INSERT INTO public.economy_transactions (company_id, type, amount, description)
  VALUES (v_co.id, 'starting_capital', v_cash, 'Initial operating capital');

  RETURN v_co;
END;$fn$;

GRANT EXECUTE ON FUNCTION
  public.create_company(TEXT, TEXT, TEXT, TEXT, TEXT, JSONB) TO authenticated;
REVOKE EXECUTE ON FUNCTION
  public.create_company(TEXT, TEXT, TEXT, TEXT, TEXT, JSONB) FROM PUBLIC, anon;
