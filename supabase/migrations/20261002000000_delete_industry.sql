-- =============================================================================
-- Delete a site you own, for free (user asked 2026-09-15).
--
-- delete_industry removes one of the company's industry sites: no charge and no
-- refund. Owners and managers only, and only a site the company owns
-- (industry_is_owned: Career, built, or claimed in Industry mode).
--
--   * Refused while any work involving it is under way: a dispatched haul, trade
--     run or Cargo Hub goods job from or to it, or a dispatched fuel run from it.
--   * Work still waiting on the board for it is removed first. Deleting those
--     missions fires the existing refund triggers (refund_undelivered_haul,
--     refund_undelivered_fuel_run), which tidy the stock they had reserved.
--   * Deleting the site cascades its investments; delivery and fuel run records
--     keep their history with the site link set to null.
--
-- A later scan can find a real-world site again, as an unclaimed nearby site in
-- Industry mode. Run after 20261001000000_claim_industries.sql. Safe to re-run.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.delete_industry(_industry_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_ind public.industries%ROWTYPE;
BEGIN
  SELECT * INTO v_ind FROM public.industries WHERE id = _industry_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'site not found'; END IF;
  IF NOT public.can_manage_company(v_ind.company_id) THEN
    RAISE EXCEPTION 'only owners and managers can delete a site';
  END IF;
  IF NOT public.industry_is_owned(_industry_id) THEN
    RAISE EXCEPTION 'this site isn''t yours -- only sites you built or claimed can be deleted';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.missions m
     WHERE m.company_id = v_ind.company_id
       AND m.status = 'in_progress'
       AND (m.haul_from_industry_id = _industry_id OR m.haul_to_industry_id = _industry_id)
  ) OR EXISTS (
    SELECT 1 FROM public.fuel_farm_deliveries d
      JOIN public.missions m ON m.id = d.mission_id
     WHERE d.industry_id = _industry_id AND m.status = 'in_progress'
  ) THEN
    RAISE EXCEPTION 'a flight for this site is under way -- finish or cancel it first';
  END IF;

  -- Work still on the board for this site goes with it.
  DELETE FROM public.missions
   WHERE company_id = v_ind.company_id
     AND status = 'available'
     AND (haul_from_industry_id = _industry_id OR haul_to_industry_id = _industry_id
          OR id IN (SELECT mission_id FROM public.fuel_farm_deliveries WHERE industry_id = _industry_id));

  DELETE FROM public.industries WHERE id = _industry_id;
END;$fn$;

GRANT EXECUTE ON FUNCTION public.delete_industry(UUID) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.delete_industry(UUID) FROM PUBLIC, anon;
