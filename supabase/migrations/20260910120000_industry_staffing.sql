-- =============================================================================
-- Industries need workers now, not just time.
--
-- Every site until now produced on a pure clock: base_rate * hours elapsed,
-- capped by capacity, whether anyone was flying or the app was even open.
-- Investing bought a bigger silo, never a faster line. This makes staffing
-- the actual throttle: base_rate becomes the output of a FULLY staffed site,
-- and actual production scales by workers / max_workers. Zero workers means
-- zero output, same as an aircraft with no fuel.
--
-- Wages are billed by the hour, same as an aircraft's lease -- charged in
-- industry_tick against whatever real time has actually elapsed, whether or
-- not that labor produced anything sellable (capacity full is still a wage
-- you owe, exactly as a leased helicopter sitting idle still owes its lease).
-- =============================================================================

ALTER TABLE public.industry_defs
  ADD COLUMN IF NOT EXISTS max_workers  INTEGER NOT NULL DEFAULT 4,
  ADD COLUMN IF NOT EXISTS wage_per_hour NUMERIC NOT NULL DEFAULT 20;

UPDATE public.industry_defs SET max_workers = v.workers, wage_per_hour = v.wage FROM (VALUES
  ('forest',        4, 20),
  ('sawmill',       6, 26),
  ('farmland',      5, 18),
  ('grain_mill',    6, 24),
  ('oil_well',      5, 32),
  ('refinery',      8, 38),
  ('quarry',        6, 24),
  ('steel_works',   8, 34),
  ('fishing_camp',  4, 20),
  ('cannery',       6, 26)
) AS v(kind, workers, wage) WHERE public.industry_defs.kind = v.kind;

ALTER TABLE public.industries
  ADD COLUMN IF NOT EXISTS workers INTEGER NOT NULL DEFAULT 0 CHECK (workers >= 0);

-- Every site that already existed before this migration was producing under
-- the old pure-clock rules -- backfilling it to fully staffed is what keeps
-- it producing at the same rate it already was, rather than silently
-- stalling every camp a company has already built the moment this lands.
-- Anything sited or built from here on starts at zero, same as a freshly
-- purchased aircraft with no pilot assigned: staffing is a decision to make,
-- not a default to inherit.
UPDATE public.industries i
   SET workers = d.max_workers
  FROM public.industry_defs d
 WHERE i.kind = d.kind AND i.workers = 0;

-- --------------------------------------------------------------------------
-- Hire or lay off. One pilot spends nothing here -- staffing is an
-- operational decision, same tier as investing, gated the same way.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_industry_workers(_industry_id UUID, _workers INTEGER)
RETURNS public.industries
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_ind public.industries%ROWTYPE;
  v_def public.industry_defs%ROWTYPE;
BEGIN
  IF _workers < 0 THEN RAISE EXCEPTION 'workers cannot be negative'; END IF;

  SELECT * INTO v_ind FROM public.industries WHERE id = _industry_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'industry not found'; END IF;
  IF NOT public.can_manage_company(v_ind.company_id) THEN
    RAISE EXCEPTION 'only owners and managers can staff a site';
  END IF;

  SELECT * INTO v_def FROM public.industry_defs WHERE kind = v_ind.kind;
  IF _workers > v_def.max_workers THEN
    RAISE EXCEPTION 'this site can only usefully staff % workers', v_def.max_workers;
  END IF;

  UPDATE public.industries SET workers = _workers WHERE id = _industry_id
  RETURNING * INTO v_ind;
  RETURN v_ind;
END;$fn$;

GRANT EXECUTE ON FUNCTION public.set_industry_workers(UUID, INTEGER) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.set_industry_workers(UUID, INTEGER) FROM PUBLIC, anon;

-- --------------------------------------------------------------------------
-- industry_tick gains the wage bill and the staffing throttle. Carried
-- forward from 20260903000000_industries.sql -- CREATE OR REPLACE takes the
-- whole body.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.industry_tick(_industry_id UUID)
RETURNS public.industries
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_ind      public.industries%ROWTYPE;
  v_def      public.industry_defs%ROWTYPE;
  v_input    public.industries%ROWTYPE;
  v_hours    NUMERIC;
  v_made     NUMERIC;
  v_wage     NUMERIC;
  v_staff_frac NUMERIC;
  v_price    NUMERIC;
  v_inv      RECORD;
  v_royalty  NUMERIC;
  v_total_invested NUMERIC;
BEGIN
  SELECT * INTO v_ind FROM public.industries WHERE id = _industry_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'industry not found'; END IF;
  SELECT * INTO v_def FROM public.industry_defs WHERE kind = v_ind.kind;

  v_hours := GREATEST(0, EXTRACT(EPOCH FROM (now() - v_ind.last_tick_at)) / 3600.0);
  IF v_hours < (1.0 / 60) THEN RETURN v_ind; END IF; -- nothing meaningful happened

  -- Wages: billed for the labor on shift regardless of whether it produced
  -- anything sellable this tick (capacity full, or no input to work with).
  IF v_ind.workers > 0 THEN
    v_wage := v_ind.workers * v_def.wage_per_hour * v_hours;
    UPDATE public.companies SET cash = cash - v_wage WHERE id = v_ind.company_id;
    INSERT INTO public.economy_transactions (company_id, type, amount, description)
    VALUES (v_ind.company_id, 'industry_wages', -ROUND(v_wage),
            format('Wages: %s (%s workers)', COALESCE(v_ind.name, v_def.kind), v_ind.workers));
  END IF;

  v_staff_frac := LEAST(1.0, v_ind.workers::NUMERIC / NULLIF(v_def.max_workers, 0));
  v_staff_frac := COALESCE(v_staff_frac, 0);

  IF v_def.tier = 1 THEN
    v_made := LEAST(v_def.base_rate * v_staff_frac * v_hours, GREATEST(0, v_ind.capacity - v_ind.stock));
    v_ind.stock := v_ind.stock + v_made;
  ELSE
    SELECT * INTO v_input FROM public.industries
      WHERE company_id = v_ind.company_id AND base_id = v_ind.base_id
        AND kind = (SELECT kind FROM public.industry_defs WHERE chain = v_def.chain AND tier = 1)
      FOR UPDATE;
    v_made := LEAST(
      v_def.base_rate * v_staff_frac * v_hours,
      GREATEST(0, v_ind.capacity - v_ind.stock),
      COALESCE(v_input.stock, 0)
    );
    IF FOUND THEN
      UPDATE public.industries SET stock = stock - v_made WHERE id = v_input.id;
    END IF;
    v_ind.stock := v_ind.stock + v_made;
  END IF;

  -- Royalty: base value at a balanced market times what was actually made,
  -- split across every company invested in proportion to their stake.
  IF v_made > 0 THEN
    SELECT SUM(invested_total) INTO v_total_invested
      FROM public.company_industry_investments WHERE industry_id = _industry_id;
    IF v_total_invested > 0 THEN
      v_price := v_def.good_base_value;
      FOR v_inv IN
        SELECT company_id, invested_total FROM public.company_industry_investments
         WHERE industry_id = _industry_id AND invested_total > 0
      LOOP
        -- A gentle royalty, not the sale price itself -- investors are
        -- paid a cut of throughput, not the full market value of every unit,
        -- or owning a stake would simply be a better contract than flying one.
        v_royalty := ROUND(v_made * v_price * 0.06 * (v_inv.invested_total / v_total_invested), 2);
        IF v_royalty >= 0.01 THEN
          UPDATE public.companies SET cash = cash + v_royalty WHERE id = v_inv.company_id;
          INSERT INTO public.economy_transactions (company_id, type, amount, description)
          VALUES (v_inv.company_id, 'industry_royalty', v_royalty,
                  format('Royalty from %s (%s)', COALESCE(v_ind.name, v_def.chain), v_def.kind));
        END IF;
      END LOOP;
    END IF;
  END IF;

  UPDATE public.industries SET stock = v_ind.stock, last_tick_at = now()
   WHERE id = _industry_id RETURNING * INTO v_ind;
  RETURN v_ind;
END;$fn$;

GRANT EXECUTE ON FUNCTION public.industry_tick(UUID) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.industry_tick(UUID) FROM PUBLIC, anon;
