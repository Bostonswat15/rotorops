-- =============================================================================
-- Career companies own only the sites they build or claim (user chose 2026-09-15).
--
-- A scan used to hand a Career company every nearby camp, mill and well. Now,
-- as in Industry mode, a site is yours once you build it or claim it at its
-- full build cost; the rest are nearby sites you could claim.
--
--   industry_is_owned   built or claimed, in both modes
--   claim_industry      open to Career companies too
--   industry_tick       a Career site you don't own runs on its own at half a
--                       full crew's rate with no wages to you, so haul contracts
--                       from it keep getting stock; a mill draws only on a camp
--                       of the same standing. Industry mode's unclaimed sites
--                       stay idle, as before.
--
-- Reset: every scanned Career site that wasn't claimed is no longer owned,
-- including ones with workers, investment or stock. Their crews are stood down
-- (no more wages); stock stays for contract hauls. Built sites are untouched.
--
-- Everything already guarded by industry_is_owned follows: staffing,
-- investing, trade runs, deleting and the bridge's camp dressing need a site
-- you own. Career haul and Cargo Hub goods contracts still come from any site
-- (app side).
--
-- Carried forward whole: industry_is_owned from 20261001000000_claim_industries.sql,
-- claim_industry from 20261001000000_claim_industries.sql, industry_tick from 20261001000000_claim_industries.sql.
-- Run after 20261003000000_plane_landing_check.sql. Safe to re-run.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.industry_is_owned(_industry_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  SELECT COALESCE((
    SELECT i.source = 'built' OR i.claimed_at IS NOT NULL
      FROM public.industries i
      JOIN public.companies c ON c.id = i.company_id
     WHERE i.id = _industry_id), false);
$fn$;

CREATE OR REPLACE FUNCTION public.claim_industry(_industry_id UUID)
RETURNS public.industries
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_ind public.industries%ROWTYPE;
  v_def public.industry_defs%ROWTYPE;
  v_co  public.companies%ROWTYPE;
BEGIN
  SELECT * INTO v_ind FROM public.industries WHERE id = _industry_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'site not found'; END IF;
  IF NOT public.can_manage_company(v_ind.company_id) THEN
    RAISE EXCEPTION 'only owners and managers can claim a site';
  END IF;

  SELECT * INTO v_co FROM public.companies WHERE id = v_ind.company_id FOR UPDATE;
  IF v_ind.source = 'built' OR v_ind.claimed_at IS NOT NULL THEN
    RAISE EXCEPTION 'this site is already yours';
  END IF;

  SELECT * INTO v_def FROM public.industry_defs WHERE kind = v_ind.kind;
  IF v_co.cash < v_def.build_cost THEN
    RAISE EXCEPTION 'claiming this site costs $% -- insufficient cash', v_def.build_cost;
  END IF;

  UPDATE public.companies SET cash = cash - v_def.build_cost WHERE id = v_co.id;
  INSERT INTO public.economy_transactions (company_id, type, amount, description)
  VALUES (v_co.id, 'industry_claim', -v_def.build_cost,
          format('Claimed %s (%s)', COALESCE(v_ind.name, v_def.kind), v_def.kind));

  -- Its clock starts now: nothing was produced or paid while it wasn't yours.
  UPDATE public.industries SET claimed_at = now(), last_tick_at = now()
   WHERE id = _industry_id RETURNING * INTO v_ind;
  RETURN v_ind;
END;$fn$;

CREATE OR REPLACE FUNCTION public.industry_tick(_industry_id UUID)
RETURNS public.industries
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_ind      public.industries%ROWTYPE;
  v_def      public.industry_defs%ROWTYPE;
  v_input    public.industries%ROWTYPE;
  v_hours    NUMERIC;
  v_made     NUMERIC;
  v_want     NUMERIC;
  v_room     NUMERIC;
  v_from_buffer NUMERIC := 0;
  v_from_camp   NUMERIC := 0;
  v_wage     NUMERIC;
  v_staff_frac NUMERIC;
  v_price    NUMERIC;
  v_inv      RECORD;
  v_royalty  NUMERIC;
  v_total_invested NUMERIC;
  v_owned    BOOLEAN;
  v_career   BOOLEAN;
BEGIN
  SELECT * INTO v_ind FROM public.industries WHERE id = _industry_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'industry not found'; END IF;
  SELECT * INTO v_def FROM public.industry_defs WHERE kind = v_ind.kind;
  v_owned := public.industry_is_owned(_industry_id);
  SELECT c.play_mode <> 'industry' INTO v_career FROM public.companies c WHERE c.id = v_ind.company_id;

  v_hours := GREATEST(0, EXTRACT(EPOCH FROM (now() - v_ind.last_tick_at)) / 3600.0);
  IF v_hours < (1.0 / 60) THEN RETURN v_ind; END IF; -- nothing meaningful happened

  -- Wages: billed for the labor on shift regardless of whether it produced
  -- anything sellable this tick (capacity full, or no input to work with).
  -- Only a site that is yours pays your crew.
  IF v_owned AND v_ind.workers > 0 THEN
    v_wage := v_ind.workers * v_def.wage_per_hour * v_hours;
    UPDATE public.companies SET cash = cash - v_wage WHERE id = v_ind.company_id;
    INSERT INTO public.economy_transactions (company_id, type, amount, description)
    VALUES (v_ind.company_id, 'industry_wages', -ROUND(v_wage),
            format('Wages: %s (%s workers)', COALESCE(v_ind.name, v_def.kind), v_ind.workers));
  END IF;

  v_staff_frac := LEAST(1.0, v_ind.workers::NUMERIC / NULLIF(v_def.max_workers, 0));
  v_staff_frac := COALESCE(v_staff_frac, 0);
  -- Career: a site nobody has claimed runs on its own at half a full crew's
  -- rate, free, so its haul contracts have stock (user chose 2026-09-15).
  -- Industry mode's unclaimed sites stay idle.
  IF NOT v_owned THEN
    v_staff_frac := CASE WHEN COALESCE(v_career, true) THEN 0.5 ELSE 0 END;
  END IF;

  IF v_def.tier = 1 THEN
    v_made := LEAST(v_def.base_rate * v_staff_frac * v_hours, GREATEST(0, v_ind.capacity - v_ind.stock));
    v_ind.stock := v_ind.stock + v_made;
  ELSE
    -- Flown-in input first, at the full rate; then straight from the camp at
    -- half the rate. Pulling everything from the camp meant a delivered haul
    -- changed nothing.
    v_want := v_def.base_rate * v_staff_frac * v_hours;
    v_room := GREATEST(0, v_ind.capacity - v_ind.stock);
    v_from_buffer := LEAST(v_want, v_room, GREATEST(0, v_ind.input_stock));
    SELECT * INTO v_input FROM public.industries
      WHERE company_id = v_ind.company_id AND base_id = v_ind.base_id
        AND kind = (SELECT kind FROM public.industry_defs WHERE chain = v_def.chain AND tier = 1)
        -- Like with like: your mill draws on your camp, an unclaimed mill on an
        -- unclaimed one, so running your own chain never drains the other.
        AND public.industry_is_owned(id) = v_owned
      LIMIT 1
      FOR UPDATE;
    IF FOUND THEN
      v_from_camp := GREATEST(0, LEAST(
        LEAST(v_want, v_room) - v_from_buffer,
        v_want * 0.5,
        v_input.stock
      ));
      UPDATE public.industries SET stock = stock - v_from_camp WHERE id = v_input.id;
    END IF;
    v_made := v_from_buffer + v_from_camp;
    v_ind.input_stock := v_ind.input_stock - v_from_buffer;
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

  UPDATE public.industries
     SET stock = v_ind.stock, input_stock = v_ind.input_stock, last_tick_at = now()
   WHERE id = _industry_id RETURNING * INTO v_ind;
  RETURN v_ind;
END;$fn$;

-- Stand down crews on Career sites that are no longer the company's.
UPDATE public.industries i
   SET workers = 0
  FROM public.companies c
 WHERE c.id = i.company_id
   AND c.play_mode <> 'industry'
   AND i.source <> 'built'
   AND i.claimed_at IS NULL
   AND i.workers > 0;
