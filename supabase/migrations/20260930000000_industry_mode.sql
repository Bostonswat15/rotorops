-- =============================================================================
-- Industry game mode (user approved 2026-09-15).
--
-- companies.play_mode: 'career' (every kind of contract, as before) or
-- 'industry' (only goods work for the company's own sites -- the app filters the
-- Mission Board, offers more hauls and pays freight on them). Owners and
-- managers can switch it on Settings.
--
-- A company founded in Industry mode gets no free aircraft; instead
-- companies.free_camp_kind names a raw-material camp (lumber camp, farm, quarry
-- or fishing camp) it may build once for free, fully staffed. A new company's
-- base has no position until the sim bridge reports it, so the camp is placed
-- later on the Trading Hall rather than at founding.
--
-- create_company gains _play_mode and _free_camp, so the old six-argument
-- version is dropped first -- two overloads would make every call ambiguous.
-- Carried forward whole: create_company from 20260927000000_starter_no_sale.sql,
-- place_industry from 20260904000000_build_industries.sql.
-- Run after 20260929000000_checkout_follows_aircraft.sql. Safe to re-run.
-- =============================================================================

ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS play_mode TEXT NOT NULL DEFAULT 'career';
ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS free_camp_kind TEXT;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'companies_play_mode_check') THEN
    ALTER TABLE public.companies
      ADD CONSTRAINT companies_play_mode_check CHECK (play_mode IN ('career', 'industry'));
  END IF;
END $$;

-- The mode is a rule players choose, like difficulty; the free camp is not theirs to edit.
GRANT UPDATE (play_mode) ON public.companies TO authenticated;

DROP FUNCTION IF EXISTS public.create_company(TEXT, TEXT, TEXT, TEXT, TEXT, JSONB);

CREATE OR REPLACE FUNCTION public.create_company(
  _name       TEXT,
  _difficulty TEXT DEFAULT 'normal',
  _realism    TEXT DEFAULT 'balanced',
  _base_name  TEXT DEFAULT 'Main Heliport',
  _icao       TEXT DEFAULT NULL,
  _starter    JSONB DEFAULT NULL,
  _play_mode  TEXT DEFAULT 'career',
  -- Industry mode: the raw-material camp the company gets to build for free.
  _free_camp  TEXT DEFAULT NULL
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
  IF COALESCE(_play_mode, 'career') NOT IN ('career', 'industry') THEN
    RAISE EXCEPTION 'invalid game mode: %', _play_mode;
  END IF;
  IF _play_mode = 'industry' AND _free_camp IS NOT NULL
     AND _free_camp NOT IN ('forest', 'farmland', 'quarry', 'fishing_camp') THEN
    RAISE EXCEPTION 'the free camp has to be a lumber camp, farm, quarry or fishing camp';
  END IF;

  -- Opening capital is a rule of the game, not a client input.
  v_cash := CASE _difficulty
    WHEN 'hard' THEN 250000
    WHEN 'easy' THEN 1000000
    ELSE 500000
  END;

  INSERT INTO public.companies (user_id, name, cash, difficulty, realism_mode, play_mode, free_camp_kind)
  VALUES (auth.uid(), trim(_name), v_cash, _difficulty, _realism, COALESCE(_play_mode, 'career'),
          CASE WHEN _play_mode = 'industry' THEN _free_camp END)
  RETURNING * INTO v_co;
  -- on_company_created has already added the owner membership row.

  INSERT INTO public.bases (company_id, name, icao, is_primary)
  VALUES (v_co.id, COALESCE(NULLIF(trim(_base_name), ''), 'Main Heliport'),
          NULLIF(upper(trim(_icao)), ''), true)
  RETURNING id INTO v_base;

  -- An Industry company starts with a free camp instead of a free aircraft.
  IF _starter IS NOT NULL AND COALESCE(_play_mode, 'career') <> 'industry' THEN
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
  public.create_company(TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, TEXT) TO authenticated;
REVOKE EXECUTE ON FUNCTION
  public.create_company(TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, TEXT) FROM PUBLIC, anon;

CREATE OR REPLACE FUNCTION public.place_industry(
  _base_id UUID, _kind TEXT, _lat NUMERIC, _lon NUMERIC, _name TEXT DEFAULT NULL)
RETURNS public.industries
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_company UUID;
  v_def     public.industry_defs%ROWTYPE;
  v_co      public.companies%ROWTYPE;
  v_row     public.industries%ROWTYPE;
  v_free    BOOLEAN;
BEGIN
  SELECT company_id INTO v_company FROM public.bases WHERE id = _base_id;
  IF v_company IS NULL THEN RAISE EXCEPTION 'base not found'; END IF;
  IF NOT public.can_manage_company(v_company) THEN
    RAISE EXCEPTION 'only owners and managers can build a new site';
  END IF;

  SELECT * INTO v_def FROM public.industry_defs WHERE kind = _kind;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown industry kind: %', _kind; END IF;

  IF _lat NOT BETWEEN -90 AND 90 OR _lon NOT BETWEEN -180 AND 180 THEN
    RAISE EXCEPTION 'invalid coordinates';
  END IF;

  SELECT * INTO v_co FROM public.companies WHERE id = v_company FOR UPDATE;
  -- An Industry company's first camp is on the house, and fully staffed.
  v_free := v_co.free_camp_kind IS NOT NULL AND v_co.free_camp_kind = _kind;
  IF NOT v_free AND v_co.cash < v_def.build_cost THEN
    RAISE EXCEPTION 'building a %s costs $%s -- insufficient cash', v_def.kind, v_def.build_cost;
  END IF;

  IF v_free THEN
    UPDATE public.companies SET free_camp_kind = NULL WHERE id = v_company;
  ELSE
    UPDATE public.companies SET cash = cash - v_def.build_cost WHERE id = v_company;
    INSERT INTO public.economy_transactions (company_id, type, amount, description)
    VALUES (v_company, 'industry_construction', -v_def.build_cost,
            format('Built %s (%s)', COALESCE(NULLIF(trim(_name), ''), v_def.kind), v_def.kind));
  END IF;

  INSERT INTO public.industries
    (company_id, base_id, kind, name, latitude, longitude, confidence, source, stock, capacity, base_rate)
  VALUES (
    v_company, _base_id, _kind, NULLIF(left(COALESCE(_name, ''), 80), ''),
    _lat, _lon, 'named', 'built',
    0, v_def.default_capacity, v_def.base_rate
  ) RETURNING * INTO v_row;

  IF v_free THEN
    UPDATE public.industries SET workers = v_def.max_workers WHERE id = v_row.id RETURNING * INTO v_row;
  END IF;

  RETURN v_row;
END;$fn$;
