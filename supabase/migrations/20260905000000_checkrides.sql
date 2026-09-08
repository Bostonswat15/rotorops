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
