-- =============================================================================
-- Planes get their own landing check (user approved 2026-09-15).
--
-- rotorops_resolve_flight judged every touchdown on helicopter bands: over
-- 240 fpm logged "hard landing" and added wear, and over 600 fpm logged "skid
-- damage on touchdown", added heavy wear and failed the contract. A normal
-- plane arrival is 200-400 fpm, so plane flights were logged hard and worn
-- for landings the flight score called smooth.
--
-- Planes now: excellent to 200 fpm, normal to 500, hard to 900, severe beyond,
-- and a severe plane landing is "gear damage on touchdown". Helicopters are
-- unchanged. Plane or helicopter comes from the bridge's telemetry ("wing",
-- v0.7.4 and later), else from the aircraft's type via rating_info.
--
-- rotorops_resolve_flight, carried forward whole from 20260923000000_cargo_inventory.sql; only the
-- landing check and the severe-landing incident changed.
--
-- Run after 20261002000000_delete_industry.sql. Safe to re-run.
-- =============================================================================

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
  v_score          INTEGER;
  v_grade          TEXT;
  v_xp_mult        NUMERIC := 1.0;
  v_haul_units     NUMERIC := 0;
  v_rating_ride    BOOLEAN;
  v_rating_passed  BOOLEAN := false;
  v_trip           public.trips%ROWTYPE;
  v_wing           TEXT;
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
  v_rating_ride := COALESCE(v_m.role, '') = 'rating_ride';
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

  -- Flight score from the bridge, graded A-F. Absent (a manual log, an older
  -- bridge), the landing quality prices the flight as it always did.
  IF jsonb_typeof(_t->'score') = 'number' THEN
    v_score := LEAST(100, GREATEST(0, ROUND((_t->>'score')::NUMERIC)))::INTEGER;
    v_grade := CASE
      WHEN v_score >= 90 THEN 'A'
      WHEN v_score >= 75 THEN 'B'
      WHEN v_score >= 60 THEN 'C'
      WHEN v_score >= 40 THEN 'D'
      ELSE 'F'
    END;
    v_xp_mult := CASE v_grade
      WHEN 'A' THEN 1.1 WHEN 'C' THEN 0.9 WHEN 'D' THEN 0.75 WHEN 'F' THEN 0.5 ELSE 1.0
    END;
  END IF;

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

  -- Plane or helicopter: what the bridge's scorer decided from the sim, when it
  -- sent that, else the aircraft's type (custom types count as helicopters).
  v_wing := CASE
    WHEN _t->>'wing' IN ('rotary', 'fixed') THEN _t->>'wing'
    ELSE (SELECT i.wing FROM public.rating_info(v_ac.internal_id, v_ac.sim_title, v_ac.display_name) i)
  END;
  -- A helicopter settles onto skids; a plane arrives on its wheels at a few
  -- hundred fpm, which the helicopter bands logged as a hard landing and wore
  -- the airframe for. Planes: excellent to 200 fpm, normal to 500, hard to
  -- 900, severe (a failed contract) beyond (user approved 2026-09-15).
  v_quality := CASE
    WHEN v_fpm IS NULL THEN COALESCE(_t->>'landing_quality', 'normal')
    WHEN v_wing = 'fixed' THEN CASE
      WHEN v_fpm >= -200 THEN 'excellent'
      WHEN v_fpm >= -500 THEN 'normal'
      WHEN v_fpm >= -900 THEN 'hard'
      ELSE 'severe'
    END
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

  -- A rating check ride passes on every objective done and a score of 60 or
  -- better. No score (a manual log) is no pass: the score is the examiner.
  IF v_rating_ride THEN
    v_success := v_success AND public.mission_objectives_met(_mission_id)
                 AND COALESCE(v_score, 0) >= 60;
  END IF;

  -- A contract reset by an earlier crash only counts when this flight took off
  -- from where it has to restart. Flown from anywhere else it resets again.
  IF _mission_id IS NOT NULL AND v_m.restart_from IS NOT NULL AND NOT v_crashed
     AND upper(trim(COALESCE(_t->>'departure', ''))) <> upper(trim(v_m.restart_from)) THEN
    v_wrong_start := true;
    v_success := false;
  END IF;
  v_reset := _mission_id IS NOT NULL AND (v_crashed OR v_wrong_start);

  IF NOT v_arrived THEN v_incidents := array_append(v_incidents, 'off-contract landing'); END IF;
  IF v_quality = 'hard' THEN v_incidents := array_append(v_incidents, 'hard landing'); END IF;
  IF v_quality = 'severe' THEN
    v_incidents := array_append(v_incidents,
      CASE WHEN v_wing = 'fixed' THEN 'gear damage on touchdown' ELSE 'skid damage on touchdown' END);
  END IF;
  IF v_crashed THEN v_incidents := array_append(v_incidents, 'heavy crash damage'); END IF;
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
      v_incidents := array_append(v_incidents, 'mechanical breakdown');
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

  -- The grade prices a scored flight; an unscored one keeps the landing rule.
  v_mult := CASE
    WHEN v_grade IS NOT NULL THEN CASE v_grade
      WHEN 'A' THEN 1.05 WHEN 'B' THEN 1.0 WHEN 'C' THEN 0.95 WHEN 'D' THEN 0.9 ELSE 0.8 END
    ELSE CASE v_quality WHEN 'excellent' THEN 1.05 WHEN 'hard' THEN 0.9 ELSE 1.0 END
  END;
  v_payout := CASE WHEN v_success THEN COALESCE(v_m.payout, 0) * v_mult * v_payout_mult ELSE 0 END;
  -- A check ride pays no contract fee -- the rating is the payout -- whatever
  -- the row's own payout column happens to hold.
  IF v_checkride OR v_rating_ride THEN v_payout := 0; END IF;
  v_net := v_payout - v_fuel_cost - v_op_billed - v_lease;

  v_rep_delta := CASE
    WHEN _mission_id IS NULL THEN 0
    -- Taking off from the wrong place wastes the flight, but isn't a failure.
    WHEN v_wrong_start THEN 0
    -- A check ride, passed or failed, is between the pilot and the examiner.
    WHEN v_rating_ride THEN 0
    WHEN v_success AND v_grade = 'A' THEN COALESCE(v_m.difficulty, 1) + 1 + v_rep_bonus
    WHEN v_success AND v_grade = 'F' THEN COALESCE(v_m.difficulty, 1) - 1
    WHEN v_success AND v_grade IS NULL AND v_quality = 'excellent'
      THEN COALESCE(v_m.difficulty, 1) + 1 + v_rep_bonus
    WHEN v_success THEN COALESCE(v_m.difficulty, 1)
    ELSE -COALESCE(v_m.difficulty, 1) * 2
  END;

  -- A leg of an open cargo trip: the aircraft stays on the trip afterwards.
  SELECT * INTO v_trip FROM public.trips
   WHERE aircraft_id = _aircraft_id AND status = 'active'
   ORDER BY created_at DESC LIMIT 1
   FOR UPDATE;

  INSERT INTO public.flight_logs (
    company_id, aircraft_id, mission_id, pilot_id, departure, arrival,
    duration_hr, fuel_used, payload, landing_quality, incidents,
    weather_difficulty, success, source, telemetry, score, grade, score_items, trip_id
  ) VALUES (
    _company_id, _aircraft_id, _mission_id,
    v_pilot,
    COALESCE(_t->>'departure', v_m.origin),
    COALESCE(_t->>'arrival', v_m.destination),
    ROUND(v_hours, 2), ROUND(v_fuel), v_payload,
    CASE WHEN v_quality = 'severe' THEN 'hard' ELSE v_quality END,
    NULLIF(array_to_string(v_incidents, ', '), ''),
    COALESCE(v_m.weather_factor, COALESCE((_t->>'weather_factor')::INTEGER, 1)),
    v_success, _source, _t,
    v_score, v_grade,
    CASE WHEN jsonb_typeof(_t->'score_items') = 'array' THEN _t->'score_items' ELSE '[]'::JSONB END,
    v_trip.id
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
                  WHEN v_trip.id IS NOT NULL THEN 'on_mission'
                  ELSE 'available' END
  WHERE id = _aircraft_id;

  -- A crash ends the trip: whatever was still aboard goes back to where it
  -- was collected, and the aircraft is grounded above.
  IF v_crashed AND v_trip.id IS NOT NULL THEN
    PERFORM public.release_trip_jobs(v_trip.id);
    UPDATE public.trips SET status = 'cancelled', completed_at = now() WHERE id = v_trip.id;
  END IF;

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
  ELSIF v_rating_ride AND NOT v_success THEN
    -- A failed check ride goes back on the board for the same pilot to retake.
    UPDATE public.missions SET
      status = 'available',
      aircraft_id = NULL,
      dispatched_at = NULL,
      objectives_state = '{}'::JSONB
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

  -- Industry hauls and trade runs: a delivered load reaches the buyer, a
  -- failed one goes back to its source. A reset haul keeps its load reserved
  -- for the restart.
  IF _mission_id IS NOT NULL AND NOT v_reset THEN
    v_haul_units := public.settle_industry_delivery(_mission_id, v_success);
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

  IF v_rating_ride AND v_success AND v_pilot IS NOT NULL THEN
    UPDATE public.pilot_ratings SET passed_at = now()
     WHERE company_id = _company_id AND user_id = v_pilot AND rating = v_m.scene_name;
    v_rating_passed := FOUND;
  END IF;

  -- XP: real contracts pay by hours and difficulty, scaled by the grade;
  -- positioning flights and failed contracts pay nothing, so grinding empty
  -- circuits doesn't level a pilot up. A check ride passed is worth a flat
  -- bonus on top of the ordinary flight.
  v_xp_gain := 0;
  IF v_pilot IS NOT NULL AND _mission_id IS NOT NULL AND v_success
     AND NOT v_checkride AND NOT v_rating_ride THEN
    v_xp_gain := ROUND((10 + ROUND(v_hours * 12) + COALESCE(v_m.difficulty, 1) * 5) * v_xp_mult);
  END IF;
  IF v_pilot IS NOT NULL AND (v_checkride OR v_rating_ride) AND v_success THEN
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
    'restart_from', v_restart_from,
    'score', v_score,
    'grade', v_grade,
    'haul_delivered_units', ROUND(v_haul_units),
    'rating_ride', v_rating_ride,
    'rating_passed', v_rating_passed,
    'trip_id', v_trip.id
  );
END;$fn$;
