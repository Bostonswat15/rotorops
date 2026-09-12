-- =============================================================================
-- RotorOps: repair run, generated 2026-09-12T12:15:41Z
--
-- Re-running 20260826120000_sim_bridge.sql overwrote six functions with their
-- original pre-coop versions, because CREATE OR REPLACE has no idea it is
-- going backwards. These are every later migration that redefines one of
-- them, concatenated in order so the last writer is the newest version.
--
-- Safe to run more than once. Paste the whole file into the Supabase SQL
-- editor and run it in one go -- the order is the point, so do not run the
-- sections separately.
-- =============================================================================


-- #############################################################################
-- 20260827120100_coop_economy.sql
-- #############################################################################

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


-- #############################################################################
-- 20260830120000_mission_scenes.sql
-- #############################################################################

-- =============================================================================
-- Mission scenes and live objectives.
--
-- Contracts stop being "ICAO to ICAO" and gain a place: a point on the map with
-- a type, plus an ordered objective list the sim bridge ticks off from live
-- telemetry. Progress is stored so every member of the company watches the same
-- rescue unfold, not just the pilot flying it.
--
-- Bases gain a real position. Nothing in the app knows where an ICAO is, but
-- the bridge has the sim's facility cache, so it reports the coordinates back
-- the first time it sees the field.
-- =============================================================================

ALTER TABLE public.bases
  ADD COLUMN IF NOT EXISTS latitude NUMERIC,
  ADD COLUMN IF NOT EXISTS longitude NUMERIC;

ALTER TABLE public.missions
  ADD COLUMN IF NOT EXISTS scene_lat NUMERIC,
  ADD COLUMN IF NOT EXISTS scene_lon NUMERIC,
  ADD COLUMN IF NOT EXISTS scene_type TEXT,
  ADD COLUMN IF NOT EXISTS scene_name TEXT,
  -- Ordered list of objective specs, authored at generation.
  ADD COLUMN IF NOT EXISTS objectives JSONB NOT NULL DEFAULT '[]'::JSONB,
  -- { "<objective id>": { "done": true, "at": "..." }, ... }
  ADD COLUMN IF NOT EXISTS objectives_state JSONB NOT NULL DEFAULT '{}'::JSONB;

-- --------------------------------------------------------------------------
-- The bridge reports where an airport actually is.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.bridge_set_base_position(
  _token TEXT, _base_id UUID, _lat NUMERIC, _lon NUMERIC)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $fn$
DECLARE v_dev public.sim_devices%ROWTYPE;
BEGIN
  v_dev := public.bridge_device(_token);
  IF _lat IS NULL OR _lon IS NULL
     OR _lat < -90 OR _lat > 90 OR _lon < -180 OR _lon > 180 THEN
    RAISE EXCEPTION 'position out of range';
  END IF;

  UPDATE public.bases
     SET latitude = _lat, longitude = _lon
   WHERE id = _base_id
     AND company_id = v_dev.company_id
     AND latitude IS NULL;  -- first sighting wins; never move a known base
END;$fn$;

-- --------------------------------------------------------------------------
-- Objective progress.
--
-- The bridge owns this while a contract is in progress. Marking an objective
-- twice is a no-op, and only the assigned pilot's device can write.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.bridge_complete_objective(
  _token TEXT, _mission_id UUID, _objective_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $fn$
DECLARE
  v_dev   public.sim_devices%ROWTYPE;
  v_m     public.missions%ROWTYPE;
  v_state JSONB;
BEGIN
  v_dev := public.bridge_device(_token);

  SELECT * INTO v_m FROM public.missions
    WHERE id = _mission_id AND company_id = v_dev.company_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'mission not found'; END IF;
  IF v_m.status <> 'in_progress' THEN
    RAISE EXCEPTION 'mission is not in progress';
  END IF;
  IF v_m.assigned_pilot_id IS NOT NULL AND v_m.assigned_pilot_id <> v_dev.user_id THEN
    RAISE EXCEPTION 'this contract belongs to another pilot';
  END IF;
  -- Don't invent objectives that aren't on the contract.
  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_m.objectives) o
     WHERE o->>'id' = _objective_id
  ) THEN
    RAISE EXCEPTION 'no such objective: %', _objective_id;
  END IF;

  v_state := COALESCE(v_m.objectives_state, '{}'::JSONB);
  IF v_state ? _objective_id THEN
    RETURN v_state;  -- already ticked
  END IF;

  v_state := v_state || jsonb_build_object(
    _objective_id, jsonb_build_object('done', true, 'at', to_jsonb(now())));

  UPDATE public.missions SET objectives_state = v_state WHERE id = _mission_id;
  RETURN v_state;
END;$fn$;

-- Clearing a dispatch should also clear the progress.
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
  IF v_m.assigned_pilot_id <> auth.uid()
     AND NOT public.can_manage_company(v_m.company_id) THEN
    RAISE EXCEPTION 'this contract belongs to another pilot';
  END IF;

  UPDATE public.aircraft SET status = 'available'
   WHERE id = v_m.aircraft_id AND status = 'on_mission';
  UPDATE public.missions
     SET status = 'available', aircraft_id = NULL, dispatched_at = NULL,
         assigned_pilot_id = NULL, objectives_state = '{}'::JSONB
   WHERE id = _mission_id RETURNING * INTO v_m;
  RETURN v_m;
END;$fn$;

-- --------------------------------------------------------------------------
-- Objectives feed into whether the contract paid off.
--
-- A scene contract you never reached is not a success, however tidy the
-- landing was. Wraps the resolver rather than duplicating its economy.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mission_objectives_met(_mission_id UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  SELECT NOT EXISTS (
    SELECT 1
      FROM public.missions m,
           jsonb_array_elements(m.objectives) o
     WHERE m.id = _mission_id
       AND NOT COALESCE((m.objectives_state -> (o->>'id') ->> 'done')::BOOLEAN, false)
  );
$fn$;

REVOKE EXECUTE ON FUNCTION public.mission_objectives_met(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mission_objectives_met(UUID) TO authenticated;

GRANT EXECUTE ON FUNCTION public.bridge_set_base_position(TEXT, UUID, NUMERIC, NUMERIC)
  TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bridge_complete_objective(TEXT, UUID, TEXT)
  TO anon, authenticated;

-- --------------------------------------------------------------------------
-- Bridge state gains scenes, objectives and any base still missing a position.
-- --------------------------------------------------------------------------
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
        'aircraft_id', m.aircraft_id, 'dispatched_at', m.dispatched_at,
        'scene_lat', m.scene_lat, 'scene_lon', m.scene_lon,
        'scene_name', m.scene_name, 'scene_type', m.scene_type,
        'objectives', m.objectives, 'objectives_state', m.objectives_state
      )) FROM public.missions m
      WHERE m.company_id = v_dev.company_id
        AND m.status = 'in_progress'
        AND (m.assigned_pilot_id IS NULL OR m.assigned_pilot_id = v_dev.user_id)),
      '[]'::JSONB),
    'bases_needing_position', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', b.id, 'icao', b.icao
      )) FROM public.bases b
      WHERE b.company_id = v_dev.company_id
        AND b.icao IS NOT NULL AND b.latitude IS NULL), '[]'::JSONB),
    'bases', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', b.id, 'icao', b.icao, 'name', b.name,
        'latitude', b.latitude, 'longitude', b.longitude
      )) FROM public.bases b WHERE b.company_id = v_dev.company_id), '[]'::JSONB)
  ) INTO v_out;

  RETURN v_out;
END;$fn$;

GRANT EXECUTE ON FUNCTION public.bridge_state(TEXT) TO anon, authenticated;


-- #############################################################################
-- 20260830130000_land_anchors.sql
-- #############################################################################

-- =============================================================================
-- Land anchors for mission scenes.
--
-- Scenes were placed at a random bearing from base, which put "Barrow Field"
-- in the sea whenever the bearing happened to point offshore. Nothing in the
-- app can see terrain -- but the sim's facility cache knows where airports are,
-- and an airport is by definition on land.
--
-- So the bridge reports the airports around your base, and generation anchors
-- land scenes near one of them. Water scenes (vessels, platforms) do the
-- opposite: they pick the bearing with the fewest airports, which is the way
-- out to sea.
-- =============================================================================

ALTER TABLE public.bases
  ADD COLUMN IF NOT EXISTS nearby_airports JSONB NOT NULL DEFAULT '[]'::JSONB,
  ADD COLUMN IF NOT EXISTS airports_updated_at TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION public.bridge_set_base_airports(
  _token TEXT, _base_id UUID, _airports JSONB)
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $fn$
DECLARE
  v_dev   public.sim_devices%ROWTYPE;
  v_clean JSONB;
  v_count INTEGER;
BEGIN
  v_dev := public.bridge_device(_token);

  IF jsonb_typeof(_airports) <> 'array' THEN
    RAISE EXCEPTION 'airports must be an array';
  END IF;

  -- Keep only well-formed entries, and cap the list so a chatty client can't
  -- push an unbounded blob into the row.
  SELECT COALESCE(jsonb_agg(a), '[]'::JSONB) INTO v_clean
  FROM (
    SELECT jsonb_build_object(
             'icao', upper(trim(e->>'icao')),
             'lat', (e->>'lat')::NUMERIC,
             'lon', (e->>'lon')::NUMERIC
           ) AS a
      FROM jsonb_array_elements(_airports) e
     WHERE e->>'icao' IS NOT NULL
       AND (e->>'lat') ~ '^-?[0-9.]+$'
       AND (e->>'lon') ~ '^-?[0-9.]+$'
       AND (e->>'lat')::NUMERIC BETWEEN -90 AND 90
       AND (e->>'lon')::NUMERIC BETWEEN -180 AND 180
     LIMIT 200
  ) s;

  UPDATE public.bases
     SET nearby_airports = v_clean, airports_updated_at = now()
   WHERE id = _base_id AND company_id = v_dev.company_id;

  SELECT jsonb_array_length(v_clean) INTO v_count;
  RETURN v_count;
END;$fn$;

GRANT EXECUTE ON FUNCTION public.bridge_set_base_airports(TEXT, UUID, JSONB)
  TO anon, authenticated;

-- The bridge needs to know which bases to gather airports for, so hand back
-- every base with its position rather than only the ones missing one.
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
        'aircraft_id', m.aircraft_id, 'dispatched_at', m.dispatched_at,
        'scene_lat', m.scene_lat, 'scene_lon', m.scene_lon,
        'scene_name', m.scene_name, 'scene_type', m.scene_type,
        'objectives', m.objectives, 'objectives_state', m.objectives_state
      )) FROM public.missions m
      WHERE m.company_id = v_dev.company_id
        AND m.status = 'in_progress'
        AND (m.assigned_pilot_id IS NULL OR m.assigned_pilot_id = v_dev.user_id)),
      '[]'::JSONB),
    'bases_needing_position', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', b.id, 'icao', b.icao
      )) FROM public.bases b
      WHERE b.company_id = v_dev.company_id
        AND b.icao IS NOT NULL AND b.latitude IS NULL), '[]'::JSONB),
    'bases', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', b.id, 'icao', b.icao, 'name', b.name,
        'latitude', b.latitude, 'longitude', b.longitude,
        'airport_count', jsonb_array_length(b.nearby_airports),
        'airports_updated_at', b.airports_updated_at
      )) FROM public.bases b WHERE b.company_id = v_dev.company_id), '[]'::JSONB)
  ) INTO v_out;

  RETURN v_out;
END;$fn$;

GRANT EXECUTE ON FUNCTION public.bridge_state(TEXT) TO anon, authenticated;


-- #############################################################################
-- 20260901130000_sell_and_lease.sql
-- #############################################################################

-- =============================================================================
-- Selling and leasing aircraft.
--
-- Two ways to change the fleet without buying outright:
--   sell    -- recover part of the capital, less depreciation and dealer margin
--   lease   -- small deposit up front, an hourly rate on every flight, hand it
--             back whenever
--
-- Retirement is by status, never DELETE: flight_logs and maintenance_events
-- both cascade off aircraft.id, so removing a sold airframe would erase its
-- entire flight history along with it.
-- =============================================================================

ALTER TABLE public.aircraft
  ADD COLUMN IF NOT EXISTS is_leased BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS retired_at TIMESTAMPTZ;

-- --------------------------------------------------------------------------
-- What an airframe is worth today
--
-- 70% of purchase as-new -- the rest is the dealer's margin -- then reduced by
-- accumulated wear and airframe hours. Floors at 15% so an abused machine is
-- still worth something.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.aircraft_sale_value(_aircraft_id UUID)
RETURNS NUMERIC
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_ac     public.aircraft%ROWTYPE;
  v_factor NUMERIC;
BEGIN
  SELECT * INTO v_ac FROM public.aircraft WHERE id = _aircraft_id;
  IF NOT FOUND OR NOT public.is_company_member(v_ac.company_id) THEN
    RETURN 0;
  END IF;
  -- A leased machine isn't yours to sell.
  IF v_ac.is_leased OR v_ac.status IN ('destroyed', 'sold', 'returned') THEN
    RETURN 0;
  END IF;

  v_factor := 0.70
              - (LEAST(GREATEST(v_ac.wear, 0), 100) / 100.0) * 0.30
              - LEAST(v_ac.hours / 2000.0, 1) * 0.15;

  RETURN ROUND(v_ac.acquisition_cost * GREATEST(v_factor, 0.15));
END;$fn$;

CREATE OR REPLACE FUNCTION public.sell_aircraft(_aircraft_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_ac    public.aircraft%ROWTYPE;
  v_value NUMERIC;
BEGIN
  SELECT * INTO v_ac FROM public.aircraft WHERE id = _aircraft_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'aircraft not found'; END IF;
  IF NOT public.can_manage_company(v_ac.company_id) THEN
    RAISE EXCEPTION 'only owners and managers can sell aircraft';
  END IF;
  IF v_ac.is_leased THEN
    RAISE EXCEPTION 'this aircraft is leased -- return it instead';
  END IF;
  IF v_ac.status = 'on_mission' THEN
    RAISE EXCEPTION 'aircraft is out on a contract';
  END IF;
  IF v_ac.status IN ('sold', 'returned') THEN
    RAISE EXCEPTION 'aircraft has already left the fleet';
  END IF;

  v_value := public.aircraft_sale_value(_aircraft_id);

  UPDATE public.aircraft
     SET status = 'sold', retired_at = now(), base_id = NULL
   WHERE id = _aircraft_id;

  UPDATE public.companies SET cash = cash + v_value WHERE id = v_ac.company_id;
  INSERT INTO public.economy_transactions (company_id, type, amount, description)
  VALUES (v_ac.company_id, 'aircraft_sale', v_value,
          format('Sold %s (%s hrs, %s%% wear)',
                 v_ac.display_name, ROUND(v_ac.hours), ROUND(v_ac.wear)));

  RETURN jsonb_build_object(
    'sold', v_ac.display_name,
    'value', v_value,
    'paid', v_ac.acquisition_cost);
END;$fn$;

-- --------------------------------------------------------------------------
-- Leasing
--
-- Rate and deposit are derived from the airframe's value server-side, so a
-- client can't lease a Chinook for pennies. The hourly rate is charged by
-- flight resolution on top of fuel and operating cost.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.lease_rate_for(_acquisition_cost NUMERIC)
RETURNS NUMERIC LANGUAGE sql IMMUTABLE AS $fn$
  SELECT ROUND(GREATEST(_acquisition_cost, 0) * 0.0008);
$fn$;

CREATE OR REPLACE FUNCTION public.lease_deposit_for(_acquisition_cost NUMERIC)
RETURNS NUMERIC LANGUAGE sql IMMUTABLE AS $fn$
  SELECT ROUND(GREATEST(_acquisition_cost, 0) * 0.02);
$fn$;

CREATE OR REPLACE FUNCTION public.lease_aircraft(_company_id UUID, _spec JSONB)
RETURNS public.aircraft
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_co      public.companies%ROWTYPE;
  v_cost    NUMERIC;
  v_deposit NUMERIC;
  v_rate    NUMERIC;
  v_ac      public.aircraft%ROWTYPE;
BEGIN
  IF NOT public.can_manage_company(_company_id) THEN
    RAISE EXCEPTION 'only owners and managers can lease aircraft';
  END IF;

  v_cost := GREATEST(COALESCE((_spec->>'acquisition_cost')::NUMERIC, 0), 0);
  v_deposit := public.lease_deposit_for(v_cost);
  v_rate := public.lease_rate_for(v_cost);

  SELECT * INTO v_co FROM public.companies WHERE id = _company_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'company not found'; END IF;
  IF v_co.cash < v_deposit THEN
    RAISE EXCEPTION 'insufficient cash for the deposit ($%)', v_deposit;
  END IF;

  INSERT INTO public.aircraft (
    company_id, base_id, internal_id, display_name, sim_title, category,
    engine_type, cruise_kts, max_range_nm, fuel_burn_pph, payload_lbs,
    pax_seats, sling_load, hoist, footprint, reliability, maintenance_factor,
    acquisition_cost, lease_cost, op_cost_hr, tags, is_modded, is_leased, notes
  )
  SELECT
    _company_id,
    NULLIF(_spec->>'base_id', '')::UUID,
    COALESCE(_spec->>'internal_id', 'CUSTOM'),
    COALESCE(_spec->>'display_name', 'Leased helicopter'),
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
    v_rate,
    COALESCE((_spec->>'op_cost_hr')::NUMERIC, 600),
    COALESCE(ARRAY(SELECT jsonb_array_elements_text(_spec->'tags')), ARRAY[]::TEXT[]),
    COALESCE((_spec->>'is_modded')::BOOLEAN, false),
    true,
    format('Leased at $%s/flight hour', v_rate)
  RETURNING * INTO v_ac;

  UPDATE public.companies SET cash = cash - v_deposit WHERE id = _company_id;
  INSERT INTO public.economy_transactions (company_id, type, amount, description)
  VALUES (_company_id, 'lease_deposit', -v_deposit,
          format('Lease deposit: %s', v_ac.display_name));

  RETURN v_ac;
END;$fn$;

CREATE OR REPLACE FUNCTION public.return_aircraft(_aircraft_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_ac public.aircraft%ROWTYPE;
BEGIN
  SELECT * INTO v_ac FROM public.aircraft WHERE id = _aircraft_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'aircraft not found'; END IF;
  IF NOT public.can_manage_company(v_ac.company_id) THEN
    RAISE EXCEPTION 'only owners and managers can return a lease';
  END IF;
  IF NOT v_ac.is_leased THEN
    RAISE EXCEPTION 'this aircraft is owned -- sell it instead';
  END IF;
  IF v_ac.status = 'on_mission' THEN
    RAISE EXCEPTION 'aircraft is out on a contract';
  END IF;
  IF v_ac.status IN ('sold', 'returned') THEN
    RAISE EXCEPTION 'aircraft has already left the fleet';
  END IF;

  -- Heavy wear costs a handback penalty, the way a real lease would.
  DECLARE v_penalty NUMERIC := 0;
  BEGIN
    IF v_ac.wear > 50 THEN
      v_penalty := ROUND(v_ac.acquisition_cost * 0.01 * ((v_ac.wear - 50) / 50.0));
      UPDATE public.companies SET cash = cash - v_penalty WHERE id = v_ac.company_id;
      INSERT INTO public.economy_transactions (company_id, type, amount, description)
      VALUES (v_ac.company_id, 'lease_penalty', -v_penalty,
              format('Handback condition penalty: %s (%s%% wear)',
                     v_ac.display_name, ROUND(v_ac.wear)));
    END IF;

    UPDATE public.aircraft
       SET status = 'returned', retired_at = now(), base_id = NULL
     WHERE id = _aircraft_id;

    RETURN jsonb_build_object(
      'returned', v_ac.display_name,
      'penalty', v_penalty,
      'wear', ROUND(v_ac.wear));
  END;
END;$fn$;

GRANT EXECUTE ON FUNCTION public.aircraft_sale_value(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sell_aircraft(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.lease_aircraft(UUID, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.return_aircraft(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.lease_rate_for(NUMERIC) TO authenticated;
GRANT EXECUTE ON FUNCTION public.lease_deposit_for(NUMERIC) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.aircraft_sale_value(UUID) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.sell_aircraft(UUID) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.lease_aircraft(UUID, JSONB) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.return_aircraft(UUID) FROM PUBLIC, anon;

-- --------------------------------------------------------------------------
-- Retired airframes leave the bridge's view of the fleet.
-- --------------------------------------------------------------------------
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
      WHERE a.company_id = v_dev.company_id
        AND a.status NOT IN ('destroyed', 'sold', 'returned')), '[]'::JSONB),
    'dispatched', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', m.id, 'title', m.title, 'role', m.role,
        'origin', m.origin, 'destination', m.destination,
        'distance_nm', m.distance_nm, 'min_payload', m.min_payload,
        'payout', m.payout, 'difficulty', m.difficulty,
        'aircraft_id', m.aircraft_id, 'dispatched_at', m.dispatched_at,
        'scene_lat', m.scene_lat, 'scene_lon', m.scene_lon,
        'scene_name', m.scene_name, 'scene_type', m.scene_type,
        'objectives', m.objectives, 'objectives_state', m.objectives_state
      )) FROM public.missions m
      WHERE m.company_id = v_dev.company_id
        AND m.status = 'in_progress'
        AND (m.assigned_pilot_id IS NULL OR m.assigned_pilot_id = v_dev.user_id)),
      '[]'::JSONB),
    'bases_needing_position', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', b.id, 'icao', b.icao
      )) FROM public.bases b
      WHERE b.company_id = v_dev.company_id
        AND b.icao IS NOT NULL AND b.latitude IS NULL), '[]'::JSONB),
    'bases', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', b.id, 'icao', b.icao, 'name', b.name,
        'latitude', b.latitude, 'longitude', b.longitude,
        'airport_count', jsonb_array_length(b.nearby_airports),
        'airports_updated_at', b.airports_updated_at
      )) FROM public.bases b WHERE b.company_id = v_dev.company_id), '[]'::JSONB)
  ) INTO v_out;

  RETURN v_out;
END;$fn$;

GRANT EXECUTE ON FUNCTION public.bridge_state(TEXT) TO anon, authenticated;

-- --------------------------------------------------------------------------
-- Flight resolution now bills the lease rate.
--
-- Restated in full because Postgres replaces a whole function body; the only
-- change from the previous definition is v_lease and the ledger line for it.
-- --------------------------------------------------------------------------
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
  v_lease     NUMERIC;
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
  -- Lease is owed on every hour flown, successful contract or not.
  v_lease := v_hours * COALESCE(v_ac.lease_cost, 0);

  v_mult := CASE v_quality WHEN 'excellent' THEN 1.05 WHEN 'hard' THEN 0.9 ELSE 1.0 END;
  v_payout := CASE WHEN v_success THEN COALESCE(v_m.payout, 0) * v_mult ELSE 0 END;
  v_net := v_payout - v_fuel_cost - v_op_billed - v_lease;

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
  IF v_lease > 0 THEN
    INSERT INTO public.economy_transactions (company_id, type, amount, description)
    VALUES (_company_id, 'lease', -ROUND(v_lease),
            format('Lease: %s (%s hrs)', v_ac.display_name, ROUND(v_hours, 1)));
  END IF;
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
    'lease_cost', ROUND(v_lease),
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


-- #############################################################################
-- 20260905000000_checkrides.sql
-- #############################################################################

-- =============================================================================
-- Check rides: a certification is earned by flying, not bought outright.
--
-- purchase_certification made every rating a straight transaction -- pay the
-- cost, meet a reputation floor, click a button, done. Booking a check ride
-- keeps exactly that gate (same cost, same reputation floor, still only an
-- owner or manager can spend the money), but what it buys is no longer the
-- cert itself: it's a real mission on the board. The cert is only granted
-- once that flight is actually flown and every graded objective on it is
-- genuinely completed.
--
-- purchase_certification is left in place, unused by the client from here on,
-- rather than dropped -- deleting a SECURITY DEFINER function a running
-- desktop build might still reference is a worse failure mode than one extra
-- unused function sitting in the schema.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.book_checkride(
  _company_id UUID, _cert TEXT, _mission JSONB)
RETURNS public.missions
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_co  public.companies%ROWTYPE;
  v_cat public.cert_catalog%ROWTYPE;
  v_row public.missions%ROWTYPE;
BEGIN
  IF NOT public.can_manage_company(_company_id) THEN
    RAISE EXCEPTION 'only owners and managers can book a check ride';
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

  -- One booked check ride per cert at a time -- failing one and immediately
  -- booking a duplicate is not how retaking an exam works.
  IF EXISTS (
    SELECT 1 FROM public.missions
     WHERE company_id = _company_id AND role = 'checkride'
       AND scene_name = _cert AND status IN ('available', 'in_progress')
  ) THEN
    RAISE EXCEPTION 'a check ride for this rating is already booked';
  END IF;

  UPDATE public.companies SET cash = cash - v_cat.cost WHERE id = _company_id;
  INSERT INTO public.economy_transactions (company_id, type, amount, description)
  VALUES (_company_id, 'checkride_fee', -v_cat.cost, format('Check ride booked: %s', _cert));

  -- The mission's own geometry (where the practice area sits, exactly which
  -- objectives) is computed client-side from the company's base, the same as
  -- every other scene-based contract -- there is nothing here worth hiding
  -- the way a SAR casualty's true position is. This function's job is only
  -- the part that touches money: validate the gate, charge it, and hand back
  -- a mission id nobody can spend without actually paying for.
  INSERT INTO public.missions (
    company_id, role, title, description, origin, destination, distance_nm,
    required_tags, required_certs, min_payload, payout, difficulty, weather_factor,
    scene_lat, scene_lon, scene_type, scene_name, status, objectives
  )
  SELECT
    _company_id, 'checkride',
    _mission->>'title', _mission->>'description',
    _mission->>'origin', _mission->>'destination',
    COALESCE((_mission->>'distance_nm')::INTEGER, 2),
    COALESCE(ARRAY(SELECT jsonb_array_elements_text(_mission->'required_tags')), ARRAY[]::TEXT[]),
    ARRAY[]::TEXT[],
    COALESCE((_mission->>'min_payload')::INTEGER, 0),
    0, -- a check ride pays no contract fee, whatever the client sent
    COALESCE((_mission->>'difficulty')::INTEGER, 3),
    COALESCE((_mission->>'weather_factor')::INTEGER, 1),
    (_mission->>'scene_lat')::NUMERIC, (_mission->>'scene_lon')::NUMERIC,
    'checkride', _cert, 'available',
    COALESCE(_mission->'objectives', '[]'::JSONB)
  RETURNING * INTO v_row;

  RETURN v_row;
END;$fn$;

GRANT EXECUTE ON FUNCTION public.book_checkride(UUID, TEXT, JSONB) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.book_checkride(UUID, TEXT, JSONB) FROM PUBLIC, anon;

-- --------------------------------------------------------------------------
-- rotorops_resolve_flight gains one strict rule and one payout override, both
-- guarded behind role = 'checkride' so no existing contract type's behaviour
-- changes at all -- that role never existed before this migration, so the
-- branch is unreachable for anything already on the board.
--
-- The strict rule is the entire point of this feature: ordinary contracts
-- only check that you landed somewhere sane with the right weight aboard,
-- not that every objective was actually completed (SAR/medevac/sling
-- contracts enforce their steps as a checklist the pilot sees, but do not
-- currently gate payout on it -- a real gap, noted rather than fixed here,
-- since closing it for every existing contract type is a materially larger
-- and riskier change than adding a strict requirement to a role that starts
-- from zero). A check ride cannot have that gap: mission_objectives_met is
-- required, or the rating is not earned.
-- --------------------------------------------------------------------------
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
  v_lease     NUMERIC;
  v_payout    NUMERIC;
  v_mult      NUMERIC;
  v_net       NUMERIC;
  v_rep_delta INTEGER;
  v_log_id    UUID;
  v_checkride BOOLEAN;
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

  -- COALESCE rather than a bare comparison: with no mission_id (a
  -- positioning flight) v_m is never populated, so v_m.role is NULL and a
  -- bare = would leave v_checkride NULL too. Every later IF v_checkride
  -- happens to treat NULL as false, but that is a Postgres quirk worth not
  -- depending on -- this makes the variable an actual boolean.
  v_checkride := COALESCE(v_m.role, '') = 'checkride';

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

  IF v_checkride THEN
    v_success := v_success AND public.mission_objectives_met(_mission_id);
  END IF;

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
  -- Lease is owed on every hour flown, successful contract or not.
  v_lease := v_hours * COALESCE(v_ac.lease_cost, 0);

  v_mult := CASE v_quality WHEN 'excellent' THEN 1.05 WHEN 'hard' THEN 0.9 ELSE 1.0 END;
  v_payout := CASE WHEN v_success THEN COALESCE(v_m.payout, 0) * v_mult ELSE 0 END;
  -- A check ride pays no contract fee -- the rating is the payout -- whatever
  -- the row's own payout column happens to hold.
  IF v_checkride THEN v_payout := 0; END IF;
  v_net := v_payout - v_fuel_cost - v_op_billed - v_lease;

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
  IF v_lease > 0 THEN
    INSERT INTO public.economy_transactions (company_id, type, amount, description)
    VALUES (_company_id, 'lease', -ROUND(v_lease),
            format('Lease: %s (%s hrs)', v_ac.display_name, ROUND(v_hours, 1)));
  END IF;
  IF v_payout > 0 THEN
    INSERT INTO public.economy_transactions (company_id, type, amount, description)
    VALUES (_company_id, 'mission_payout', ROUND(v_payout), v_m.title);
  END IF;

  UPDATE public.companies SET
    cash = cash + v_net,
    reputation = GREATEST(0, LEAST(100, reputation + v_rep_delta))
  WHERE id = _company_id;

  -- The one thing a check ride does that no other mission does: pass it, and
  -- the rating is yours. scene_name carries which cert -- see book_checkride
  -- above for why that column rather than a new one.
  IF v_checkride AND v_success THEN
    UPDATE public.companies
       SET certifications = array_append(certifications, v_m.scene_name)
     WHERE id = _company_id
       AND NOT (v_m.scene_name = ANY(certifications));
  END IF;

  RETURN jsonb_build_object(
    'flight_log_id', v_log_id,
    'success', v_success,
    'landing_quality', v_quality,
    'duration_hr', ROUND(v_hours, 2),
    'fuel_used', ROUND(v_fuel),
    'fuel_cost', ROUND(v_fuel_cost),
    'op_cost', ROUND(v_op_billed),
    'lease_cost', ROUND(v_lease),
    'payout', ROUND(v_payout),
    'net', ROUND(v_net),
    'wear_added', ROUND(v_wear, 1),
    'aircraft_wear', ROUND(v_new_wear, 1),
    'reputation_delta', v_rep_delta,
    'incidents', to_jsonb(v_incidents),
    'checkride', v_checkride,
    'checkride_passed', CASE WHEN v_checkride THEN v_success ELSE NULL END
  );
END;$fn$;

REVOKE EXECUTE ON FUNCTION
  public.rotorops_resolve_flight(UUID, UUID, UUID, JSONB, TEXT, UUID)
  FROM PUBLIC, anon, authenticated;


-- #############################################################################
-- 20260910000000_pilot_skills.sql
-- #############################################################################

-- =============================================================================
-- Pilot skills: flying earns XP, XP buys perks, perks make flying cheaper.
--
-- XP belongs to a (company, user) pair, not a person globally -- the same
-- account flying for two different companies (their own, and a friend's) has
-- two separate careers, same as cash and reputation already work per company.
--
-- Perks are a fixed catalog (public.pilot_perk_catalog) rather than a table
-- someone could insert rows into -- the set of possible perks is code, not
-- data. Three tiers, one point per tier's cost, unlocking a tier requires
-- already owning at least one perk from the tier below.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.pilot_skills (
  company_id     UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id        UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  xp             INTEGER NOT NULL DEFAULT 0,
  unlocked_perks TEXT[] NOT NULL DEFAULT '{}',
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, user_id),
  FOREIGN KEY (company_id, user_id)
    REFERENCES public.company_members(company_id, user_id) ON DELETE CASCADE
);

GRANT SELECT ON public.pilot_skills TO authenticated;
GRANT ALL ON public.pilot_skills TO service_role;
ALTER TABLE public.pilot_skills ENABLE ROW LEVEL SECURITY;

-- Read-only for everyone in the company -- a roster where you can see how
-- experienced your co-pilots are, same spirit as flight_logs being shared.
-- No INSERT/UPDATE/DELETE policy at all: the only ways XP or perks change
-- are rotorops_resolve_flight (earning) and unlock_pilot_perk (spending),
-- both SECURITY DEFINER below.
DROP POLICY IF EXISTS "pilot skills read" ON public.pilot_skills;
CREATE POLICY "pilot skills read" ON public.pilot_skills FOR SELECT TO authenticated
  USING (public.is_company_member(company_id));

ALTER TABLE public.pilot_skills REPLICA IDENTITY FULL;
DO $do$
BEGIN
  BEGIN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.pilot_skills';
  EXCEPTION
    WHEN duplicate_object THEN NULL;
    WHEN undefined_object THEN NULL;
  END;
END;$do$;

-- --------------------------------------------------------------------------
-- The catalog. Keep this in sync with PERK_CATALOG in src/lib/pilot-skills.ts
-- -- the client draws the tree from its own copy (for labels/descriptions),
-- this one is what actually gates spending.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pilot_perk_catalog()
RETURNS TABLE(perk TEXT, tier INT, cost INT)
LANGUAGE sql IMMUTABLE AS $fn$
  VALUES
    ('fuel_discipline',   1, 1),
    ('easy_hands',        1, 1),
    ('lean_ops',          1, 1),
    ('veteran_wear',      2, 2),
    ('field_reputation',  2, 2),
    ('trusted_lessee',    2, 2),
    ('ace_pilot',         3, 3),
    ('iron_airframe',     3, 3),
    ('master_of_type',    3, 3);
$fn$;

-- --------------------------------------------------------------------------
-- Spend a point. One perk at a time; each pilot spends their own -- there is
-- no "spend for someone else," even for an owner/manager.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.unlock_pilot_perk(_company_id UUID, _perk TEXT)
RETURNS public.pilot_skills
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_tier      INT;
  v_cost      INT;
  v_row       public.pilot_skills%ROWTYPE;
  v_spent     INT;
  v_available INT;
  v_lower_owned INT;
BEGIN
  IF NOT public.is_company_member(_company_id) THEN
    RAISE EXCEPTION 'not a member of this company';
  END IF;

  SELECT tier, cost INTO v_tier, v_cost FROM public.pilot_perk_catalog() WHERE perk = _perk;
  IF v_tier IS NULL THEN RAISE EXCEPTION 'unknown perk: %', _perk; END IF;

  INSERT INTO public.pilot_skills (company_id, user_id)
  VALUES (_company_id, auth.uid())
  ON CONFLICT (company_id, user_id) DO NOTHING;

  SELECT * INTO v_row FROM public.pilot_skills
    WHERE company_id = _company_id AND user_id = auth.uid() FOR UPDATE;

  IF _perk = ANY(v_row.unlocked_perks) THEN
    RAISE EXCEPTION 'already unlocked';
  END IF;

  IF v_tier > 1 THEN
    SELECT COUNT(*) INTO v_lower_owned
      FROM unnest(v_row.unlocked_perks) p
      JOIN public.pilot_perk_catalog() c ON c.perk = p AND c.tier = v_tier - 1;
    IF v_lower_owned < 1 THEN
      RAISE EXCEPTION 'unlock a tier % perk first', v_tier - 1;
    END IF;
  END IF;

  SELECT COALESCE(SUM(c.cost), 0) INTO v_spent
    FROM unnest(v_row.unlocked_perks) p
    JOIN public.pilot_perk_catalog() c ON c.perk = p;

  v_available := FLOOR(v_row.xp / 100.0) - v_spent;
  IF v_available < v_cost THEN
    RAISE EXCEPTION 'not enough perk points (have %, need %)', v_available, v_cost;
  END IF;

  UPDATE public.pilot_skills
     SET unlocked_perks = array_append(unlocked_perks, _perk), updated_at = now()
   WHERE company_id = _company_id AND user_id = auth.uid()
  RETURNING * INTO v_row;

  RETURN v_row;
END;$fn$;

GRANT EXECUTE ON FUNCTION public.unlock_pilot_perk(UUID, TEXT) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.unlock_pilot_perk(UUID, TEXT) FROM PUBLIC, anon;

-- --------------------------------------------------------------------------
-- rotorops_resolve_flight gains XP awarding plus nine small multipliers, one
-- per perk. Everything else in this function is copied forward unchanged
-- from 20260905000000_checkrides.sql -- CREATE OR REPLACE takes the whole
-- body, there is no way to patch just a few lines.
-- --------------------------------------------------------------------------
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
  v_lease     NUMERIC;
  v_payout    NUMERIC;
  v_mult      NUMERIC;
  v_net       NUMERIC;
  v_rep_delta INTEGER;
  v_log_id    UUID;
  v_checkride BOOLEAN;
  v_pilot     UUID;
  v_perks     TEXT[];
  v_fuel_mult NUMERIC;
  v_wear_mult NUMERIC;
  v_hardwear_mult NUMERIC;
  v_op_mult   NUMERIC;
  v_lease_mult NUMERIC;
  v_payout_mult NUMERIC;
  v_rep_bonus INTEGER;
  v_xp_gain   INTEGER;
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

  v_checkride := COALESCE(v_m.role, '') = 'checkride';
  v_pilot := COALESCE(_pilot_id, v_m.assigned_pilot_id);

  -- Perks belong to whoever is actually flying. No pilot attributed (an old
  -- bridge build, or a positioning flight with nobody claimed) means no
  -- perks apply -- every multiplier below defaults to 1.0 in that case.
  SELECT unlocked_perks INTO v_perks FROM public.pilot_skills
    WHERE company_id = _company_id AND user_id = v_pilot;
  v_perks := COALESCE(v_perks, ARRAY[]::TEXT[]);

  v_fuel_mult := 1.0
    * (CASE WHEN 'fuel_discipline' = ANY(v_perks) THEN 0.92 ELSE 1.0 END)
    * (CASE WHEN 'master_of_type'  = ANY(v_perks) THEN 0.92 ELSE 1.0 END);
  v_wear_mult := 1.0
    * (CASE WHEN 'veteran_wear'    = ANY(v_perks) THEN 0.85 ELSE 1.0 END)
    * (CASE WHEN 'iron_airframe'   = ANY(v_perks) THEN 0.8  ELSE 1.0 END);
  v_hardwear_mult := CASE WHEN 'easy_hands' = ANY(v_perks) THEN 0.7 ELSE 1.0 END;
  v_op_mult := 1.0
    * (CASE WHEN 'lean_ops'        = ANY(v_perks) THEN 0.9  ELSE 1.0 END)
    * (CASE WHEN 'master_of_type'  = ANY(v_perks) THEN 0.92 ELSE 1.0 END);
  v_lease_mult := CASE WHEN 'trusted_lessee' = ANY(v_perks) THEN 0.8 ELSE 1.0 END;
  v_payout_mult := CASE WHEN 'ace_pilot' = ANY(v_perks) THEN 1.05 ELSE 1.0 END;
  v_rep_bonus := CASE WHEN 'field_reputation' = ANY(v_perks) THEN 1 ELSE 0 END;

  -- Prefer measured values; fall back to the aircraft's book figures.
  v_hours := COALESCE(NULLIF((_t->>'duration_hr')::NUMERIC, 0),
                      COALESCE(v_m.distance_nm, 0)::NUMERIC / NULLIF(v_ac.cruise_kts, 0));
  v_hours := GREATEST(COALESCE(v_hours, 0), 0);
  v_fuel  := GREATEST(COALESCE((_t->>'fuel_used')::NUMERIC,
                               v_hours * v_ac.fuel_burn_pph), 0) * v_fuel_mult;
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

  IF v_checkride THEN
    v_success := v_success AND public.mission_objectives_met(_mission_id);
  END IF;

  IF NOT v_arrived THEN v_incidents := v_incidents || 'off-contract landing'; END IF;
  IF v_quality = 'hard' THEN v_incidents := v_incidents || 'hard landing'; END IF;
  IF v_quality = 'severe' THEN v_incidents := v_incidents || 'skid damage on touchdown'; END IF;
  IF v_crashed THEN v_incidents := v_incidents || 'airframe loss'; END IF;

  v_wear := v_hours * (COALESCE(v_m.difficulty, 1) * 0.8) * v_ac.maintenance_factor * v_wear_mult
            + (CASE v_quality WHEN 'hard' THEN 3 WHEN 'severe' THEN 12 ELSE 0 END) * v_hardwear_mult
            + (CARDINALITY(v_incidents) * 1.5);
  v_new_wear := LEAST(100, v_ac.wear + v_wear);

  v_fuel_cost := v_fuel * fuel_price_per_lb;
  v_op_cost   := v_hours * v_ac.op_cost_hr;
  v_op_billed := (CASE WHEN v_success THEN v_op_cost ELSE v_op_cost * 0.5 END) * v_op_mult;
  -- Lease is owed on every hour flown, successful contract or not.
  v_lease := v_hours * COALESCE(v_ac.lease_cost, 0) * v_lease_mult;

  v_mult := CASE v_quality WHEN 'excellent' THEN 1.05 WHEN 'hard' THEN 0.9 ELSE 1.0 END;
  v_payout := CASE WHEN v_success THEN COALESCE(v_m.payout, 0) * v_mult * v_payout_mult ELSE 0 END;
  -- A check ride pays no contract fee -- the rating is the payout -- whatever
  -- the row's own payout column happens to hold.
  IF v_checkride THEN v_payout := 0; END IF;
  v_net := v_payout - v_fuel_cost - v_op_billed - v_lease;

  v_rep_delta := CASE
    WHEN _mission_id IS NULL THEN 0
    WHEN v_success AND v_quality = 'excellent' THEN COALESCE(v_m.difficulty, 1) + 1 + v_rep_bonus
    WHEN v_success THEN COALESCE(v_m.difficulty, 1)
    ELSE -COALESCE(v_m.difficulty, 1) * 2
  END;

  INSERT INTO public.flight_logs (
    company_id, aircraft_id, mission_id, pilot_id, departure, arrival,
    duration_hr, fuel_used, payload, landing_quality, incidents,
    weather_difficulty, success, source, telemetry
  ) VALUES (
    _company_id, _aircraft_id, _mission_id,
    v_pilot,
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
  IF v_lease > 0 THEN
    INSERT INTO public.economy_transactions (company_id, type, amount, description)
    VALUES (_company_id, 'lease', -ROUND(v_lease),
            format('Lease: %s (%s hrs)', v_ac.display_name, ROUND(v_hours, 1)));
  END IF;
  IF v_payout > 0 THEN
    INSERT INTO public.economy_transactions (company_id, type, amount, description)
    VALUES (_company_id, 'mission_payout', ROUND(v_payout), v_m.title);
  END IF;

  UPDATE public.companies SET
    cash = cash + v_net,
    reputation = GREATEST(0, LEAST(100, reputation + v_rep_delta))
  WHERE id = _company_id;

  -- The one thing a check ride does that no other mission does: pass it, and
  -- the rating is yours. scene_name carries which cert -- see book_checkride
  -- above for why that column rather than a new one.
  IF v_checkride AND v_success THEN
    UPDATE public.companies
       SET certifications = array_append(certifications, v_m.scene_name)
     WHERE id = _company_id
       AND NOT (v_m.scene_name = ANY(certifications));
  END IF;

  -- XP: real contracts pay by hours and difficulty; positioning flights and
  -- failed contracts pay nothing, so grinding empty circuits doesn't level a
  -- pilot up. A check ride passed is worth a flat bonus on top of the
  -- ordinary flight -- it's usually short, but it's a real accomplishment.
  v_xp_gain := 0;
  IF v_pilot IS NOT NULL AND _mission_id IS NOT NULL AND v_success AND NOT v_checkride THEN
    v_xp_gain := 10 + ROUND(v_hours * 12) + COALESCE(v_m.difficulty, 1) * 5;
  END IF;
  IF v_pilot IS NOT NULL AND v_checkride AND v_success THEN
    v_xp_gain := v_xp_gain + 150;
  END IF;

  IF v_pilot IS NOT NULL AND v_xp_gain > 0 THEN
    INSERT INTO public.pilot_skills (company_id, user_id, xp)
    VALUES (_company_id, v_pilot, v_xp_gain)
    ON CONFLICT (company_id, user_id) DO UPDATE
      SET xp = pilot_skills.xp + EXCLUDED.xp, updated_at = now();
  END IF;

  RETURN jsonb_build_object(
    'flight_log_id', v_log_id,
    'success', v_success,
    'landing_quality', v_quality,
    'duration_hr', ROUND(v_hours, 2),
    'fuel_used', ROUND(v_fuel),
    'fuel_cost', ROUND(v_fuel_cost),
    'op_cost', ROUND(v_op_billed),
    'lease_cost', ROUND(v_lease),
    'payout', ROUND(v_payout),
    'net', ROUND(v_net),
    'wear_added', ROUND(v_wear, 1),
    'aircraft_wear', ROUND(v_new_wear, 1),
    'reputation_delta', v_rep_delta,
    'incidents', to_jsonb(v_incidents),
    'checkride', v_checkride,
    'checkride_passed', CASE WHEN v_checkride THEN v_success ELSE NULL END,
    'xp_gained', v_xp_gain
  );
END;$fn$;

REVOKE EXECUTE ON FUNCTION
  public.rotorops_resolve_flight(UUID, UUID, UUID, JSONB, TEXT, UUID)
  FROM PUBLIC, anon, authenticated;

