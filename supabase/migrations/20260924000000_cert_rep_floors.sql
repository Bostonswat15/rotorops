-- =============================================================================
-- Lower reputation floors for certification check rides.
--
-- A company starts at 50 reputation, and the lowest floor was 55: a new company
-- could not book a single check ride, not even Turbine, until it had flown
-- several contracts. The new floors put Turbine in reach from day one and step
-- up from there. Costs are unchanged.
--
--   turbine 55 -> 50   hoist 65 -> 55   medevac 70 -> 60   offshore 70 -> 65
--   firefighting 75 -> 70   sar 80 -> 75   heavy_lift 80 (unchanged)
--
-- book_checkride reads the floor from cert_catalog, so no function changes.
-- Mirrored in src/lib/game-data.ts CERT_UNLOCKS. Safe to re-run.
-- =============================================================================

INSERT INTO public.cert_catalog (cert, cost, min_rep) VALUES
  ('turbine',       15000, 50),
  ('hoist',         25000, 55),
  ('medevac',       50000, 60),
  ('offshore',      60000, 65),
  ('firefighting',  80000, 70),
  ('sar',          100000, 75),
  ('heavy_lift',   120000, 80)
ON CONFLICT (cert) DO UPDATE SET cost = EXCLUDED.cost, min_rep = EXCLUDED.min_rep;
