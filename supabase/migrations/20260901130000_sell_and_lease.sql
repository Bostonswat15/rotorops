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
