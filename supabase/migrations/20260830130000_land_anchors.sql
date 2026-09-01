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
