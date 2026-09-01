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
