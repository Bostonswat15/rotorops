-- =============================================================================
-- A free starter aircraft sells for $0 (user chose this, 2026-09-14).
--
-- A new company's starter costs nothing, but it was recorded at its full
-- catalogue price, so selling it paid 70% of that as cash. After the half-real
-- repricing (20260926) a free starter could sell for hundreds of thousands.
--
--   * aircraft.is_starter marks the starter. create_company sets it; the app
--     can't change it (it isn't in the client UPDATE grants).
--   * Existing starters are found by being inserted in the same transaction as
--     their company (aircraft.created_at = companies.created_at, both now()).
--   * aircraft_sale_value returns 0 for a starter, so sell_aircraft pays $0 and
--     the Aircraft page quotes $0. The loan limit and balance sheet read
--     aircraft_resale directly, so a starter still counts toward credit, and
--     repairs are still priced from its catalogue value.
--
-- Carried forward whole: create_company from 20260926000000_half_real_economy.sql,
-- aircraft_sale_value from 20260914000000_maintenance_and_loans.sql.
-- Run after 20260926000000_half_real_economy.sql. Safe to re-run.
-- =============================================================================

ALTER TABLE public.aircraft ADD COLUMN IF NOT EXISTS is_starter BOOLEAN NOT NULL DEFAULT false;

UPDATE public.aircraft a
   SET is_starter = true
  FROM public.companies c
 WHERE a.company_id = c.id
   AND a.created_at = c.created_at
   AND NOT a.is_leased
   AND NOT a.is_starter;

CREATE OR REPLACE FUNCTION public.create_company(
  _name       TEXT,
  _difficulty TEXT DEFAULT 'normal',
  _realism    TEXT DEFAULT 'balanced',
  _base_name  TEXT DEFAULT 'Main Heliport',
  _icao       TEXT DEFAULT NULL,
  _starter    JSONB DEFAULT NULL
) RETURNS public.companies
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_cash NUMERIC;
  v_co   public.companies%ROWTYPE;
  v_base UUID;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not signed in'; END IF;
  IF coalesce(trim(_name), '') = '' THEN RAISE EXCEPTION 'company name required'; END IF;
  IF _difficulty NOT IN ('easy', 'normal', 'hard') THEN
    RAISE EXCEPTION 'invalid difficulty: %', _difficulty;
  END IF;
  IF _realism NOT IN ('strict', 'balanced', 'sandbox') THEN
    RAISE EXCEPTION 'invalid realism mode: %', _realism;
  END IF;

  -- Opening capital is a rule of the game, not a client input.
  v_cash := CASE _difficulty
    WHEN 'hard' THEN 250000
    WHEN 'easy' THEN 1000000
    ELSE 500000
  END;

  INSERT INTO public.companies (user_id, name, cash, difficulty, realism_mode)
  VALUES (auth.uid(), trim(_name), v_cash, _difficulty, _realism)
  RETURNING * INTO v_co;
  -- on_company_created has already added the owner membership row.

  INSERT INTO public.bases (company_id, name, icao, is_primary)
  VALUES (v_co.id, COALESCE(NULLIF(trim(_base_name), ''), 'Main Heliport'),
          NULLIF(upper(trim(_icao)), ''), true)
  RETURNING id INTO v_base;

  IF _starter IS NOT NULL THEN
    -- A free starter, not a free jet. Mirrors STARTER_MAX_COST in src/lib/economy.ts.
    IF COALESCE((_starter->>'acquisition_cost')::NUMERIC, 0) > 175000 THEN
      RAISE EXCEPTION 'a starter aircraft can cost at most $175,000';
    END IF;
    INSERT INTO public.aircraft (
      company_id, base_id, internal_id, display_name, sim_title, category,
      engine_type, cruise_kts, max_range_nm, fuel_burn_pph, payload_lbs,
      pax_seats, sling_load, hoist, footprint, reliability,
      maintenance_factor, acquisition_cost, op_cost_hr, tags, is_starter
    )
    SELECT
      v_co.id, v_base,
      COALESCE(_starter->>'internal_id', 'CUSTOM'),
      COALESCE(_starter->>'display_name', 'Starter helicopter'),
      _starter->>'sim_title',
      COALESCE(_starter->>'category', 'light_utility'),
      COALESCE(_starter->>'engine_type', 'turbine'),
      COALESCE((_starter->>'cruise_kts')::INTEGER, 110),
      COALESCE((_starter->>'max_range_nm')::INTEGER, 300),
      COALESCE((_starter->>'fuel_burn_pph')::INTEGER, 400),
      COALESCE((_starter->>'payload_lbs')::INTEGER, 1500),
      COALESCE((_starter->>'pax_seats')::INTEGER, 4),
      COALESCE((_starter->>'sling_load')::BOOLEAN, false),
      COALESCE((_starter->>'hoist')::BOOLEAN, false),
      COALESCE(_starter->>'footprint', 'medium'),
      COALESCE((_starter->>'reliability')::INTEGER, 80),
      COALESCE((_starter->>'maintenance_factor')::NUMERIC, 1.0),
      COALESCE((_starter->>'acquisition_cost')::NUMERIC, 0),
      COALESCE((_starter->>'op_cost_hr')::NUMERIC, 600),
      COALESCE(ARRAY(SELECT jsonb_array_elements_text(_starter->'tags')), ARRAY[]::TEXT[]),
      -- Free, so it sells for nothing (aircraft_sale_value).
      true;
  END IF;

  INSERT INTO public.economy_transactions (company_id, type, amount, description)
  VALUES (v_co.id, 'starting_capital', v_cash, 'Initial operating capital');

  RETURN v_co;
END;$fn$;

GRANT EXECUTE ON FUNCTION
  public.create_company(TEXT, TEXT, TEXT, TEXT, TEXT, JSONB) TO authenticated;
REVOKE EXECUTE ON FUNCTION
  public.create_company(TEXT, TEXT, TEXT, TEXT, TEXT, JSONB) FROM PUBLIC, anon;

CREATE OR REPLACE FUNCTION public.aircraft_sale_value(_aircraft_id UUID)
RETURNS NUMERIC
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_ac public.aircraft%ROWTYPE;
BEGIN
  SELECT * INTO v_ac FROM public.aircraft WHERE id = _aircraft_id;
  IF NOT FOUND OR NOT public.is_company_member(v_ac.company_id) THEN
    RETURN 0;
  END IF;
  -- A leased machine isn't yours to sell.
  IF v_ac.is_leased OR v_ac.status IN ('destroyed', 'sold', 'returned') THEN
    RETURN 0;
  END IF;
  -- A free starter can't be turned into cash. It still counts toward the loan
  -- limit and prices its repairs from its catalogue value like any aircraft.
  IF v_ac.is_starter THEN
    RETURN 0;
  END IF;
  RETURN public.aircraft_resale(v_ac.acquisition_cost, v_ac.hours, v_ac.wear);
END;$fn$;
