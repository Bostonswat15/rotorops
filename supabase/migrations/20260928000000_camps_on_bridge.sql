-- =============================================================================
-- Industry camps reach the sim bridge (user asked 2026-09-14).
--
-- bridge_state sent the fleet, contracts, trips and bases but nothing about the
-- company's industry sites, so the bridge only ever dressed a camp while a haul
-- from it was armed -- you flew to an empty clearing the rest of the time. It
-- now also sends every industry site with a position (id, kind, name, lat/lon),
-- and the bridge stands that kind's stock plant at any camp you fly near.
--
-- Carried forward whole: bridge_state from 20260923000000_cargo_inventory.sql, with only the
-- 'industries' list added. Run after 20260927000000_starter_no_sale.sql.
-- Safe to re-run.
-- =============================================================================

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
        'cruise_kts', a.cruise_kts, 'fuel_burn_pph', a.fuel_burn_pph,
        'empty_weight_lb', a.empty_weight_lb, 'max_gross_lb', a.max_gross_lb,
        'fuel_capacity_lb', a.fuel_capacity_lb
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
        -- Cargo jobs fly as trips, below.
        AND m.trip_id IS NULL
        AND (m.assigned_pilot_id IS NULL OR m.assigned_pilot_id = v_dev.user_id)),
      '[]'::JSONB),
    -- Open trips this pilot is flying: where they load, and each job's drop.
    'trips', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', t.id, 'aircraft_id', t.aircraft_id, 'fuel_lb', t.fuel_lb,
        'cargo_lb', t.cargo_lb, 'pax', t.pax,
        'pickup_name', t.pickup_name, 'pickup_icao', t.pickup_icao,
        'pickup_lat', t.pickup_lat, 'pickup_lon', t.pickup_lon,
        'pickup_radius_nm', t.pickup_radius_nm, 'loaded_at', t.loaded_at,
        'jobs', COALESCE((SELECT jsonb_agg(jsonb_build_object(
            'id', j.id, 'title', j.title, 'cargo_lb', j.cargo_lb, 'payout', j.payout,
            'drop_name', j.drop_name, 'drop_icao', j.drop_icao,
            'drop_lat', j.drop_lat, 'drop_lon', j.drop_lon,
            'drop_radius_nm', j.drop_radius_nm,
            'delivered', j.delivered_at IS NOT NULL
          ) ORDER BY j.generated_at, j.id) FROM public.missions j WHERE j.trip_id = t.id), '[]'::JSONB)
      )) FROM public.trips t
      WHERE t.company_id = v_dev.company_id
        AND t.status = 'active'
        AND (t.pilot_id IS NULL OR t.pilot_id = v_dev.user_id)), '[]'::JSONB),
    'bases_needing_position', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', b.id, 'icao', b.icao
      )) FROM public.bases b
      WHERE b.company_id = v_dev.company_id
        AND b.icao IS NOT NULL AND b.latitude IS NULL), '[]'::JSONB),
    -- Company industry sites, so the bridge can dress a camp whenever you fly near it.
    'industries', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', i.id, 'kind', i.kind, 'name', i.name,
        'latitude', i.latitude, 'longitude', i.longitude
      )) FROM public.industries i
      WHERE i.company_id = v_dev.company_id
        AND i.latitude IS NOT NULL AND i.longitude IS NOT NULL), '[]'::JSONB),
    'bases', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', b.id, 'icao', b.icao, 'name', b.name,
        'latitude', b.latitude, 'longitude', b.longitude,
        'airport_count', jsonb_array_length(b.nearby_airports),
        'airports_updated_at', b.airports_updated_at
      )) FROM public.bases b WHERE b.company_id = v_dev.company_id), '[]'::JSONB)
  ) INTO v_out;

  RETURN v_out;
END;$fn$;
