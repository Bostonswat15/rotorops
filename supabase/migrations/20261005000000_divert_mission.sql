-- =============================================================================
-- Divert a contract's final landing to a real nearby airfield, for both wings
-- (user asked 2026-09-16, after an OnAir link about job hopping).
--
-- Every contract's objective list ends with a "land"/"land_off" step -- home,
-- the delivery field, the receiving hospital, wherever the job is actually
-- meant to finish. divert_mission moves just that last step to wherever the
-- pilot chooses and updates the mission's destination to match, so landing
-- there completes the job normally: the bridge already treats a contract
-- whose objectives are all done as having arrived at its destination
-- (onFlight in bridge/src/runner.ts), rather than checking the literal ICAO
-- flown to.
--
-- Payout is fixed at dispatch and never recalculated from distance flown, so
-- diverting neither costs nor earns anything extra -- it only changes where
-- the job ends.
--
-- Refused for goods work (industry/trade/fuel_run: the delivery has to reach
-- the site it is billed to, not any airfield) and check/rating rides (graded
-- on landing where they were booked). Refused when the contract's last
-- objective is not a landing at all -- nothing to divert.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.divert_mission(
  _mission_id UUID, _icao TEXT, _lat NUMERIC, _lon NUMERIC,
  _runway_ft INTEGER DEFAULT NULL, _surface TEXT DEFAULT NULL
)
RETURNS public.missions
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_m    public.missions%ROWTYPE;
  v_objs JSONB;
  v_idx  INTEGER;
  v_last JSONB;
  v_kind TEXT;
BEGIN
  SELECT * INTO v_m FROM public.missions WHERE id = _mission_id FOR UPDATE;
  IF NOT FOUND OR NOT public.is_company_member(v_m.company_id) THEN
    RAISE EXCEPTION 'mission not found';
  END IF;
  IF v_m.status <> 'in_progress' THEN
    RAISE EXCEPTION 'this contract is not in progress';
  END IF;
  IF v_m.assigned_pilot_id IS DISTINCT FROM auth.uid()
     AND NOT public.can_manage_company(v_m.company_id) THEN
    RAISE EXCEPTION 'this contract belongs to another pilot';
  END IF;
  IF v_m.role IN ('checkride', 'rating_ride') THEN
    RAISE EXCEPTION 'a check ride is graded on landing where it was booked -- it cannot be diverted';
  END IF;
  IF v_m.role IN ('industry', 'trade', 'fuel_run') THEN
    RAISE EXCEPTION 'goods have to reach the site they are billed to -- this haul cannot be diverted';
  END IF;

  v_objs := COALESCE(v_m.objectives, '[]'::JSONB);
  v_idx := jsonb_array_length(v_objs) - 1;
  IF v_idx < 0 THEN
    RAISE EXCEPTION 'this contract has no objectives to divert';
  END IF;
  v_last := v_objs -> v_idx;
  v_kind := v_last ->> 'kind';
  IF v_kind IS DISTINCT FROM 'land' AND v_kind IS DISTINCT FROM 'land_off' THEN
    RAISE EXCEPTION 'this contract does not end with a landing -- nothing to divert';
  END IF;

  -- icao is meaningless on a land_off step (it has none normally), but a
  -- stray extra key does nothing -- every reader of this shape looks up the
  -- fields its own kind defines and ignores the rest.
  v_last := v_last || jsonb_build_object(
    'icao', _icao, 'lat', _lat, 'lon', _lon,
    'runway_ft', _runway_ft, 'surface', _surface,
    'label', CASE WHEN v_kind = 'land'
                  THEN format('Land at %s (diverted)', _icao)
                  ELSE format('Land near %s (diverted)', _icao) END,
    'radius_nm', 2
  );
  v_objs := jsonb_set(v_objs, ARRAY[v_idx::TEXT], v_last);

  UPDATE public.missions
     SET objectives = v_objs, destination = _icao
   WHERE id = _mission_id
   RETURNING * INTO v_m;
  RETURN v_m;
END;$fn$;

GRANT EXECUTE ON FUNCTION public.divert_mission(UUID, TEXT, NUMERIC, NUMERIC, INTEGER, TEXT) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.divert_mission(UUID, TEXT, NUMERIC, NUMERIC, INTEGER, TEXT) FROM PUBLIC, anon;
