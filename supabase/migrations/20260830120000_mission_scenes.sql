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
