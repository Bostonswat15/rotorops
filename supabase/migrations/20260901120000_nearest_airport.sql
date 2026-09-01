-- =============================================================================
-- Nearest airport to a mission scene.
--
-- Computed client-side at generation time from the base's nearby_airports list
-- (already sent up by the bridge for land-anchoring scenes -- see
-- 20260830130000_land_anchors.sql), so this is just two columns to hold the
-- answer, not a new data source.
-- =============================================================================

ALTER TABLE public.missions
  ADD COLUMN IF NOT EXISTS nearest_airport_icao TEXT,
  ADD COLUMN IF NOT EXISTS nearest_airport_nm NUMERIC;
