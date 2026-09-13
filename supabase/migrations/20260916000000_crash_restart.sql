-- =============================================================================
-- Crashing is a setback, not a write-off.
--
-- Before: a crash failed the contract for good and destroyed the aircraft --
-- so a one-aircraft company that crashed was simply finished.
--
-- Now:
--   * The aircraft takes heavy damage: wear to 100%, grounded, and flagged
--     crash_damaged with the wear it had before. The Repair service costs 10%
--     of its price (instead of 1% for a breakdown) and puts that wear back.
--     Inspection and overhaul wait until the crash is repaired.
--   * The contract resets: back on the board with its objectives cleared,
--     still reserved for the pilot who crashed, and marked restart_from its
--     origin (or the home base when it has none). Fuel and half the operating
--     cost are charged and reputation drops as for a failed contract; there is
--     no pay and no XP.
--   * A restarted contract only counts when the flight took off from
--     restart_from. Flown from anywhere else it resets again, with no further
--     reputation loss, rather than failing for good. The bridge also holds its
--     objectives until the flight has taken off from there.
--   * dispatch_mission refuses a reserved contract to anyone but its pilot or a
--     manager; cancel_dispatch still releases it to the company as before.
--   * A crashed fuel run keeps its avgas reserved for the restart.
--
-- Carried forward, whole bodies: rotorops_resolve_flight from
-- 20260915000000_fuel_farms.sql; dispatch_mission and service_aircraft from
-- 20260914000000_maintenance_and_loans.sql; bridge_state from
-- 20260901130000_sell_and_lease.sql.
--
-- Run 20260913, 20260914 and 20260915 first. Safe to re-run.
-- =============================================================================

ALTER TABLE public.missions
  ADD COLUMN IF NOT EXISTS restart_from TEXT,
  ADD COLUMN IF NOT EXISTS crash_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE public.aircraft
  ADD COLUMN IF NOT EXISTS crash_damaged BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS wear_before_crash NUMERIC;

-- --------------------------------------------------------------------------
-- Dispatch: reserved contracts stay with their pilot.
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
  -- A contract reset by a crash is still that pilot's to restart. A manager
  -- can hand it to someone else.
  IF v_m.assigned_pilot_id IS NOT NULL
     AND v_m.assigned_pilot_id <> auth.uid()
     AND NOT public.can_manage_company(v_m.company_id) THEN
    RAISE EXCEPTION 'this contract is reserved for the pilot who has to restart it';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.aircraft
                 WHERE id = _aircraft_id AND company_id = v_m.company_id
                   AND status = 'available') THEN
    RAISE EXCEPTION 'aircraft unavailable';
  END IF;
  IF EXISTS (SELECT 1 FROM public.aircraft
              WHERE id = _aircraft_id AND hours - hours_at_inspection > 110) THEN
    RAISE EXCEPTION 'aircraft is overdue its 100-hour inspection -- service it on the Maintenance page';
  END IF;

  -- Claiming a contract assigns it to you; nobody else can fly it.
  UPDATE public.missions
     SET status = 'in_progress', aircraft_id = _aircraft_id,
         dispatched_at = now(), assigned_pilot_id = auth.uid()
   WHERE id = _mission_id RETURNING * INTO v_m;
  UPDATE public.aircraft SET status = 'on_mission' WHERE id = _aircraft_id;
  RETURN v_m;
END;$fn$;

-- --------------------------------------------------------------------------
-- Servicing: a crash repair is 10% of the price and restores the old wear.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.service_aircraft(_aircraft_id UUID, _type TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_ac       public.aircraft%ROWTYPE;
  v_co       public.companies%ROWTYPE;
  v_cost     NUMERIC;
  v_wear     NUMERIC;
  v_new_wear NUMERIC;
  v_broken   BOOLEAN;
  v_status   TEXT;
  v_crash    BOOLEAN;
BEGIN
  IF _type NOT IN ('inspection', 'overhaul', 'repair') THEN
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
  IF v_ac.status IN ('sold', 'returned') THEN
    RAISE EXCEPTION 'aircraft has already left the fleet';
  END IF;

  v_crash := v_ac.crash_damaged AND _type = 'repair';
  IF v_ac.crash_damaged AND _type <> 'repair' THEN
    RAISE EXCEPTION 'repair the crash damage first';
  END IF;
  IF _type = 'repair' AND v_ac.broken_down_at IS NULL AND NOT v_ac.crash_damaged THEN
    RAISE EXCEPTION 'nothing to repair -- this aircraft has not broken down';
  END IF;

  v_cost := CASE _type
    WHEN 'inspection' THEN ROUND(v_ac.op_cost_hr * 6 * v_ac.maintenance_factor)
    WHEN 'overhaul'   THEN ROUND(v_ac.acquisition_cost * 0.04 * v_ac.maintenance_factor)
    ELSE ROUND(v_ac.acquisition_cost * CASE WHEN v_crash THEN 0.10 ELSE 0.01 END)
  END;
  v_wear := CASE _type WHEN 'inspection' THEN 30 WHEN 'overhaul' THEN 80 ELSE 0 END;
  v_new_wear := CASE
    WHEN v_crash THEN LEAST(v_ac.wear, COALESCE(v_ac.wear_before_crash, v_ac.wear))
    ELSE GREATEST(0, v_ac.wear - v_wear)
  END;

  SELECT * INTO v_co FROM public.companies WHERE id = v_ac.company_id FOR UPDATE;
  IF v_co.cash < v_cost THEN RAISE EXCEPTION 'insufficient cash'; END IF;

  INSERT INTO public.maintenance_events (
    company_id, aircraft_id, type, description, cost, wear_removed,
    status, completed_at)
  VALUES (v_ac.company_id, _aircraft_id, _type,
          format('%s on %s', CASE WHEN v_crash THEN 'crash repair' ELSE _type END,
                 v_ac.display_name),
          v_cost, v_ac.wear - v_new_wear, 'completed', now());

  -- An inspection doesn't fix a breakdown, and a repair doesn't remove wear:
  -- whatever is still wrong afterwards keeps the aircraft on the ground.
  v_broken := v_ac.broken_down_at IS NOT NULL AND _type <> 'repair';
  v_status := CASE
    WHEN v_ac.status = 'destroyed' THEN v_ac.status
    WHEN v_broken OR v_new_wear >= 85 THEN 'grounded'
    ELSE 'available'
  END;

  UPDATE public.aircraft
     SET wear = v_new_wear,
         hours_at_inspection = CASE WHEN _type IN ('inspection', 'overhaul')
                                    THEN hours ELSE hours_at_inspection END,
         broken_down_at = CASE WHEN _type = 'repair' THEN NULL ELSE broken_down_at END,
         crash_damaged = CASE WHEN _type = 'repair' THEN false ELSE crash_damaged END,
         wear_before_crash = CASE WHEN _type = 'repair' THEN NULL ELSE wear_before_crash END,
         status = v_status
   WHERE id = _aircraft_id;
  UPDATE public.companies SET cash = cash - v_cost WHERE id = v_ac.company_id;
  INSERT INTO public.economy_transactions (company_id, type, amount, description)
  VALUES (v_ac.company_id, 'maintenance', -v_cost,
          format('%s: %s', CASE WHEN v_crash THEN 'crash repair' ELSE _type END,
                 v_ac.display_name));

  RETURN jsonb_build_object(
    'cost', v_cost,
    'wear_removed', v_ac.wear - v_new_wear,
    'status', v_status,
    'crash_repair', v_crash);
END;$fn$;

-- --------------------------------------------------------------------------
-- Bridge state: tell the bridge where a reset contract restarts from.
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
        'objectives', m.objectives, 'objectives_state', m.objectives_state,
        'restart_from', m.restart_from, 'crash_count', m.crash_count
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

-- --------------------------------------------------------------------------
-- Flight resolution: crash damage and contract reset.
-- Carried forward from 20260915000000_fuel_farms.sql.
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
  v_wear_cost_mult NUMERIC;
  v_break_chance   NUMERIC;
  v_breakdown      BOOLEAN := false;
  v_repay          NUMERIC := 0;
  v_dep            TEXT;
  v_farm           public.fuel_farms%ROWTYPE;
  v_tank_lb        NUMERIC := 0;
  v_tank_cost      NUMERIC := 0;
  v_delivery       public.fuel_farm_deliveries%ROWTYPE;
  v_delivered_lb   NUMERIC := 0;
  v_wrong_start    BOOLEAN := false;
  v_reset          BOOLEAN := false;
  v_restart_from   TEXT;
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

  -- A worn airframe costs more to run: +0.5% operating cost per wear point
  -- above 40, judged on the condition it took off in.
  v_wear_cost_mult := 1 + GREATEST(0, LEAST(v_ac.wear, 100) - 40) * 0.005;

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

  -- Fuel farm: a flight departing a base with fuel in its tank burns that
  -- first, at the tank's average cost. The pump covers whatever is left.
  v_dep := upper(trim(COALESCE(_t->>'departure', v_m.origin, '')));
  IF v_dep <> '' AND v_fuel > 0 THEN
    SELECT f.* INTO v_farm
      FROM public.fuel_farms f
      JOIN public.bases b ON b.id = f.base_id
     WHERE f.company_id = _company_id
       AND upper(trim(b.icao)) = v_dep
       AND f.fuel_lb > 0
     ORDER BY f.fuel_lb DESC
     LIMIT 1
     FOR UPDATE OF f;
    IF FOUND THEN
      v_tank_lb := LEAST(v_farm.fuel_lb, v_fuel);
      v_tank_cost := v_farm.fuel_value * v_tank_lb / v_farm.fuel_lb;
      UPDATE public.fuel_farms
         SET fuel_lb = fuel_lb - v_tank_lb,
             fuel_value = CASE WHEN fuel_lb - v_tank_lb <= 0 THEN 0
                               ELSE GREATEST(0, fuel_value - v_tank_cost) END
       WHERE id = v_farm.id;
    END IF;
  END IF;

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

  -- A contract reset by an earlier crash only counts when this flight took off
  -- from where it has to restart. Flown from anywhere else it resets again.
  IF _mission_id IS NOT NULL AND v_m.restart_from IS NOT NULL AND NOT v_crashed
     AND upper(trim(COALESCE(_t->>'departure', ''))) <> upper(trim(v_m.restart_from)) THEN
    v_wrong_start := true;
    v_success := false;
  END IF;
  v_reset := _mission_id IS NOT NULL AND (v_crashed OR v_wrong_start);

  IF NOT v_arrived THEN v_incidents := v_incidents || 'off-contract landing'; END IF;
  IF v_quality = 'hard' THEN v_incidents := v_incidents || 'hard landing'; END IF;
  IF v_quality = 'severe' THEN v_incidents := v_incidents || 'skid damage on touchdown'; END IF;
  IF v_crashed THEN v_incidents := v_incidents || 'heavy crash damage'; END IF;
  IF v_wrong_start THEN
    v_incidents := v_incidents || format('not restarted from %s', v_m.restart_from);
  END IF;

  v_wear := v_hours * (COALESCE(v_m.difficulty, 1) * 0.8) * v_ac.maintenance_factor * v_wear_mult
            + (CASE v_quality WHEN 'hard' THEN 3 WHEN 'severe' THEN 12 ELSE 0 END) * v_hardwear_mult
            + (CARDINALITY(v_incidents) * 1.5);

  -- Breakdowns: the condition it took off in against its reliability. A crash
  -- is already the worst outcome, so a crashed flight doesn't roll. Decided
  -- here, after the fact -- it never fails the contract that was just flown.
  IF NOT v_crashed THEN
    v_break_chance := (LEAST(GREATEST(v_ac.wear, 0), 100) / 100.0)
                      * ((100 - LEAST(GREATEST(v_ac.reliability, 0), 100)) / 100.0)
                      * 0.25;
    IF random() < v_break_chance THEN
      v_breakdown := true;
      v_wear := v_wear + 20;
      v_incidents := v_incidents || 'mechanical breakdown';
    END IF;
  END IF;

  -- A crash leaves the airframe at 100% wear until it is repaired.
  v_new_wear := CASE WHEN v_crashed THEN 100 ELSE LEAST(100, v_ac.wear + v_wear) END;

  -- Only pump fuel is paid in cash now; tank fuel was paid for when it was bought.
  v_fuel_cost := (v_fuel - v_tank_lb) * fuel_price_per_lb;
  v_op_cost   := v_hours * v_ac.op_cost_hr;
  v_op_billed := (CASE WHEN v_success THEN v_op_cost ELSE v_op_cost * 0.5 END)
                 * v_op_mult * v_wear_cost_mult;
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
    -- Taking off from the wrong place wastes the flight, but isn't a failure.
    WHEN v_wrong_start THEN 0
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

  -- A crash is heavy damage, not a write-off: grounded, and remembering the
  -- wear it had so the crash repair can put it back. In SET, the column names
  -- on the right still read the row as it was before this update.
  UPDATE public.aircraft SET
    hours  = hours + v_hours,
    wear   = v_new_wear,
    crash_damaged = crash_damaged OR v_crashed,
    wear_before_crash = CASE WHEN v_crashed AND NOT crash_damaged THEN v_ac.wear
                             ELSE wear_before_crash END,
    broken_down_at = CASE WHEN v_breakdown OR v_crashed THEN now() ELSE broken_down_at END,
    status = CASE WHEN v_crashed OR v_breakdown OR v_new_wear >= 85
                       OR broken_down_at IS NOT NULL
                    THEN 'grounded'
                  ELSE 'available' END
  WHERE id = _aircraft_id;

  IF v_reset THEN
    -- Back on the board, objectives cleared, still this pilot's to restart --
    -- from its origin, or the home base when it has none.
    v_restart_from := COALESCE(
      NULLIF(upper(trim(v_m.restart_from)), ''),
      NULLIF(upper(trim(v_m.origin)), ''),
      (SELECT upper(trim(icao)) FROM public.bases
        WHERE company_id = _company_id AND icao IS NOT NULL
        ORDER BY is_primary DESC, created_at LIMIT 1));
    UPDATE public.missions SET
      status = 'available',
      aircraft_id = NULL,
      dispatched_at = NULL,
      assigned_pilot_id = COALESCE(assigned_pilot_id, v_pilot),
      objectives_state = '{}'::JSONB,
      restart_from = v_restart_from,
      crash_count = crash_count + CASE WHEN v_crashed THEN 1 ELSE 0 END
    WHERE id = _mission_id;
  ELSIF _mission_id IS NOT NULL THEN
    UPDATE public.missions SET
      status = CASE WHEN v_success THEN 'completed' ELSE 'failed' END,
      completed_at = now(),
      aircraft_id = _aircraft_id
    WHERE id = _mission_id;
  END IF;

  -- Fuel runs: fill the tank on a successful delivery; otherwise the avgas
  -- goes back to the refinery it came from. A reset run keeps its avgas
  -- reserved for the restart.
  IF COALESCE(v_m.role, '') = 'fuel_run' AND NOT v_reset THEN
    SELECT * INTO v_delivery FROM public.fuel_farm_deliveries
     WHERE mission_id = _mission_id AND outcome IS NULL
     FOR UPDATE;
    IF FOUND THEN
      IF v_success THEN
        UPDATE public.fuel_farms
           SET fuel_lb = LEAST(capacity_lb, fuel_lb + v_delivery.fuel_lb)
         WHERE id = v_delivery.fuel_farm_id;
        v_delivered_lb := v_delivery.fuel_lb;
      ELSIF v_delivery.industry_id IS NOT NULL THEN
        UPDATE public.industries SET stock = stock + v_delivery.units
         WHERE id = v_delivery.industry_id;
      END IF;
      UPDATE public.fuel_farm_deliveries
         SET outcome = CASE WHEN v_success THEN 'delivered' ELSE 'failed' END,
             settled_at = now()
       WHERE mission_id = _mission_id;
    END IF;
  END IF;

  IF v_fuel_cost > 0 OR v_tank_lb = 0 THEN
    INSERT INTO public.economy_transactions (company_id, type, amount, description)
    VALUES (_company_id, 'fuel', -ROUND(v_fuel_cost),
            format('Fuel: %s', COALESCE(v_m.title, 'positioning flight')));
  END IF;
  IF v_tank_lb > 0 THEN
    -- Booked at cost as an operating expense, and the same amount back as the
    -- tank stock drawn down: no cash moves, but the flight still carries its fuel.
    INSERT INTO public.economy_transactions (company_id, type, amount, description) VALUES
      (_company_id, 'fuel', -ROUND(v_tank_cost),
       format('Fuel from tank at %s: %s lb', v_dep, ROUND(v_tank_lb))),
      (_company_id, 'fuel_from_tank', ROUND(v_tank_cost),
       format('Tank stock used at %s: %s lb', v_dep, ROUND(v_tank_lb)));
  END IF;
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

  -- Loans: a tenth of contract pay goes to the balance until it's cleared.
  IF v_payout > 0 AND COALESCE(v_co.loan_balance, 0) > 0 THEN
    v_repay := LEAST(v_co.loan_balance, ROUND(v_payout * 0.10));
    UPDATE public.companies
       SET cash = cash - v_repay, loan_balance = loan_balance - v_repay
     WHERE id = _company_id;
    INSERT INTO public.economy_transactions (company_id, type, amount, description)
    VALUES (_company_id, 'loan_repayment', -v_repay,
            format('Loan repayment from %s', v_m.title));
  END IF;

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
    'xp_gained', v_xp_gain,
    'breakdown', v_breakdown,
    'loan_repayment', v_repay,
    'inspection_due_in_hr',
      ROUND(100 - (v_ac.hours + v_hours - COALESCE(v_ac.hours_at_inspection, 0)), 1),
    'fuel_from_tank_lb', ROUND(v_tank_lb),
    'fuel_tank_cost', ROUND(v_tank_cost),
    'fuel_delivered_lb', ROUND(v_delivered_lb),
    'crashed', v_crashed,
    'restart_required', v_reset,
    'restart_from', v_restart_from
  );
END;$fn$;

-- --------------------------------------------------------------------------
-- Grants
-- --------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION public.dispatch_mission(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.service_aircraft(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.bridge_state(TEXT) TO anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.dispatch_mission(UUID, UUID) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.service_aircraft(UUID, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION
  public.rotorops_resolve_flight(UUID, UUID, UUID, JSONB, TEXT, UUID)
  FROM PUBLIC, anon, authenticated;
