-- =============================================================================
-- Lower the lease rate: 0.08% -> 0.03% of the aircraft's price per flight hour.
--
-- At 0.08% a leased Caravan cost about $2,070 an hour, more than most plane
-- contracts earned, so any long leg flown in a leased aircraft lost money.
-- 0.03% (about $775 an hour for a Caravan) is closer to a real dry lease and
-- leaves a long leg worth flying. User approved 2026-09-14.
--
-- lease_aircraft stores the rate on the aircraft when it is leased, so this
-- applies to new leases only; aircraft already on lease keep the rate they
-- were leased at. The deposit (2% of the price) is unchanged.
--
-- Mirrored for display in src/routes/_authenticated/market.tsx. Safe to re-run.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.lease_rate_for(_acquisition_cost NUMERIC)
RETURNS NUMERIC LANGUAGE sql IMMUTABLE AS $fn$
  SELECT ROUND(GREATEST(_acquisition_cost, 0) * 0.0003);
$fn$;

GRANT EXECUTE ON FUNCTION public.lease_rate_for(NUMERIC) TO authenticated;
