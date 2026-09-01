-- =============================================================================
-- Founding a company, in one transaction.
--
-- Setup used to be four client inserts: company, base, starter aircraft,
-- opening capital. Two of those tables no longer accept direct writes, and the
-- starting cash was being chosen by the client regardless. This does the whole
-- thing server-side, so a half-created company can't exist.
-- =============================================================================

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
    WHEN 'hard' THEN 120000
    WHEN 'easy' THEN 500000
    ELSE 250000
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
    INSERT INTO public.aircraft (
      company_id, base_id, internal_id, display_name, sim_title, category,
      engine_type, cruise_kts, max_range_nm, fuel_burn_pph, payload_lbs,
      pax_seats, sling_load, hoist, footprint, reliability,
      maintenance_factor, acquisition_cost, op_cost_hr, tags
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
      COALESCE(ARRAY(SELECT jsonb_array_elements_text(_starter->'tags')), ARRAY[]::TEXT[]);
  END IF;

  INSERT INTO public.economy_transactions (company_id, type, amount, description)
  VALUES (v_co.id, 'starting_capital', v_cash, 'Initial operating capital');

  RETURN v_co;
END;$fn$;

GRANT EXECUTE ON FUNCTION
  public.create_company(TEXT, TEXT, TEXT, TEXT, TEXT, JSONB) TO authenticated;
REVOKE EXECUTE ON FUNCTION
  public.create_company(TEXT, TEXT, TEXT, TEXT, TEXT, JSONB) FROM PUBLIC, anon;
