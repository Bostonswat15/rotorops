-- =============================================================================
-- The company check ride follows the aircraft it is dispatched to.
--
-- book_rating_ride builds the company check ride for one wing -- helicopter
-- unless the whole fleet is aeroplanes -- and it is flown in any company
-- aircraft. A pilot in a mixed fleet who took it in a plane was asked to hover.
-- dispatch_mission now rebuilds its steps for the aircraft chosen, from the
-- ride's own check point and landing: helicopter hover below 50 ft AGL for 30 s,
-- reach (0.6 nm), land (1.5 nm); plane reach (1 nm), land (2 nm) -- the same
-- rules book_rating_ride already uses for each wing. Type rating rides are
-- untouched: they are always flown in their own type.
--
-- Carried forward whole: dispatch_mission from 20260919000000_pilot_ratings.sql.
-- Run after 20260928000000_camps_on_bridge.sql. Safe to re-run.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.dispatch_mission(_mission_id UUID, _aircraft_id UUID)
RETURNS public.missions
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_m     public.missions%ROWTYPE;
  v_from  public.industries%ROWTYPE;
  v_def   public.industry_defs%ROWTYPE;
  v_units NUMERIC;
  v_ac    public.aircraft%ROWTYPE;
  v_info  RECORD;
  v_rate  public.pilot_ratings%ROWTYPE;
  v_cash  NUMERIC;
  v_reach JSONB;
  v_land  JSONB;
  v_steps JSONB;
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

  -- A check ride is only ever flown by the pilot it was booked for.
  IF v_m.role = 'rating_ride' AND v_m.assigned_pilot_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'this check ride is booked for another pilot';
  END IF;

  -- Check rides. The owner is exempt. Everyone else has to pass the company
  -- check ride before taking contracts, and be rated on an aircraft's type
  -- before flying it.
  IF COALESCE(public.company_role(v_m.company_id), '') <> 'owner' THEN
    SELECT * INTO v_ac FROM public.aircraft WHERE id = _aircraft_id;
    SELECT * INTO v_info FROM public.rating_info(v_ac.internal_id, v_ac.sim_title, v_ac.display_name);

    IF v_m.role = 'rating_ride' THEN
      SELECT * INTO v_rate FROM public.pilot_ratings
       WHERE company_id = v_m.company_id AND user_id = auth.uid() AND rating = v_m.scene_name
       FOR UPDATE;
      IF v_m.scene_name <> 'checkout' AND v_m.scene_name <> v_info.rating THEN
        RAISE EXCEPTION 'this check ride has to be flown in a %', COALESCE(v_rate.label, v_m.scene_name);
      END IF;

      -- The company check ride is flown in whatever company aircraft the pilot
      -- takes, so its steps follow that aircraft: a helicopter hovers, reaches
      -- the point and lands; a plane reaches it and lands. It was booked for one
      -- wing (helicopter unless the fleet is all planes), so a pilot flying it in
      -- a plane was asked to hover.
      IF v_m.scene_name = 'checkout' THEN
        SELECT o INTO v_reach FROM jsonb_array_elements(v_m.objectives) o WHERE o->>'kind' = 'reach' LIMIT 1;
        SELECT o INTO v_land FROM jsonb_array_elements(v_m.objectives) o WHERE o->>'kind' = 'land' LIMIT 1;
        v_steps := '[]'::JSONB;
        IF v_info.wing <> 'fixed' THEN
          v_steps := v_steps || jsonb_build_array(jsonb_build_object(
            'id', 'hover', 'kind', 'hover', 'label', 'Hold a hover below 50 ft AGL for 30 seconds',
            'max_agl_ft', 50, 'max_gs_kts', 10, 'hold_seconds', 30));
        END IF;
        IF v_reach IS NOT NULL THEN
          v_steps := v_steps || jsonb_build_array(v_reach || jsonb_build_object(
            'radius_nm', CASE WHEN v_info.wing = 'fixed' THEN 1.0 ELSE 0.6 END));
        END IF;
        IF v_land IS NOT NULL THEN
          v_steps := v_steps || jsonb_build_array(v_land || jsonb_build_object(
            'radius_nm', CASE WHEN v_info.wing = 'fixed' THEN 2 ELSE 1.5 END));
        END IF;
        UPDATE public.missions SET objectives = v_steps WHERE id = _mission_id;
      END IF;
      -- The examiner is paid once per rating, on the first dispatch; a retake
      -- is free. Charged here rather than when booked, because rides are booked
      -- automatically -- on joining, on a purchase -- when the cash may not be there.
      IF v_rate.rating IS NOT NULL AND NOT v_rate.fee_paid THEN
        SELECT cash INTO v_cash FROM public.companies WHERE id = v_m.company_id FOR UPDATE;
        IF v_cash < 1000 THEN
          RAISE EXCEPTION 'the company needs $1,000 for the examiner';
        END IF;
        UPDATE public.companies SET cash = cash - 1000 WHERE id = v_m.company_id;
        INSERT INTO public.economy_transactions (company_id, type, amount, description)
        VALUES (v_m.company_id, 'checkride_fee', -1000, format('Examiner fee: %s', v_m.title));
        UPDATE public.pilot_ratings SET fee_paid = true
         WHERE company_id = v_m.company_id AND user_id = auth.uid() AND rating = v_m.scene_name;
      END IF;
    ELSE
      IF NOT EXISTS (SELECT 1 FROM public.pilot_ratings
                      WHERE company_id = v_m.company_id AND user_id = auth.uid()
                        AND rating = 'checkout' AND passed_at IS NOT NULL) THEN
        RAISE EXCEPTION 'pass your company check ride before taking contracts -- it''s on the Mission Board';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM public.pilot_ratings
                      WHERE company_id = v_m.company_id AND user_id = auth.uid()
                        AND rating = v_info.rating AND passed_at IS NOT NULL) THEN
        RAISE EXCEPTION 'you aren''t rated on the % yet -- fly its check ride on the Mission Board first',
          v_info.label;
      END IF;
    END IF;
  END IF;

  -- An industry haul takes its goods out of stock now, so two contracts can't
  -- both fly the same load. One already holding its load -- a trade run, or a
  -- haul reset by a crash -- keeps what it has.
  IF v_m.haul_from_industry_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.industry_deliveries
        WHERE mission_id = _mission_id AND outcome IS NULL) THEN
    PERFORM public.industry_tick(v_m.haul_from_industry_id);
    SELECT * INTO v_from FROM public.industries
     WHERE id = v_m.haul_from_industry_id FOR UPDATE;
    IF NOT FOUND OR v_from.company_id <> v_m.company_id THEN
      RAISE EXCEPTION 'the site this haul collects from is gone -- clear it from the board';
    END IF;
    IF v_m.haul_to_industry_id IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM public.industries
          WHERE id = v_m.haul_to_industry_id AND company_id = v_m.company_id) THEN
      RAISE EXCEPTION 'the site this haul delivers to is gone -- clear it from the board';
    END IF;
    SELECT * INTO v_def FROM public.industry_defs WHERE kind = v_from.kind;
    v_units := FLOOR(COALESCE(v_m.haul_units, 0));
    IF v_units <= 0 THEN RAISE EXCEPTION 'this haul has nothing to carry'; END IF;
    IF v_units > v_from.stock THEN
      RAISE EXCEPTION '% has only % units of % left -- clear the board and generate again',
        COALESCE(v_from.name, v_def.kind), FLOOR(v_from.stock), v_def.output_good;
    END IF;
    -- Contracts are written in the browser, so the weight the pilot has to
    -- carry is held to what the goods actually weigh.
    IF COALESCE(v_m.min_payload, 0) < FLOOR(v_units * v_def.good_unit_lb * 0.85) - 1 THEN
      RAISE EXCEPTION 'this haul''s payload doesn''t match its load -- clear it and generate again';
    END IF;
    INSERT INTO public.industry_deliveries (
      mission_id, company_id, from_industry_id, to_industry_id, good, units)
    VALUES (_mission_id, v_m.company_id, v_from.id, v_m.haul_to_industry_id,
            v_def.output_good, v_units);
    UPDATE public.industries SET stock = stock - v_units WHERE id = v_from.id;
  END IF;

  -- Claiming a contract assigns it to you; nobody else can fly it.
  UPDATE public.missions
     SET status = 'in_progress', aircraft_id = _aircraft_id,
         dispatched_at = now(), assigned_pilot_id = auth.uid()
   WHERE id = _mission_id RETURNING * INTO v_m;
  UPDATE public.aircraft SET status = 'on_mission' WHERE id = _aircraft_id;
  RETURN v_m;
END;$fn$;
