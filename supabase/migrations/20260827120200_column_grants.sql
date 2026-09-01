-- =============================================================================
-- Column-level grants.
--
-- RLS decides which *rows* you may touch, never which *columns*. Without this,
-- the "company settings" policy that lets a manager rename the company also
-- lets them run `UPDATE companies SET cash = 99999999`, and the aircraft policy
-- lets them zero out `wear` to dodge a maintenance bill.
--
-- Postgres expresses that as GRANT UPDATE (col, ...), so the writable surface
-- is spelled out here and everything else moves through a function.
-- =============================================================================

-- companies: presentation and rules are editable; the balance sheet is not.
REVOKE UPDATE ON public.companies FROM authenticated;
GRANT UPDATE (name, realism_mode, difficulty) ON public.companies TO authenticated;

-- aircraft: naming and sim-matching are editable. hours, wear, status,
-- costs and performance figures are set by flight resolution and purchase.
REVOKE UPDATE ON public.aircraft FROM authenticated;
GRANT UPDATE (
  display_name, sim_title, sim_title_aliases, notes, base_id, is_modded, tags
) ON public.aircraft TO authenticated;

-- missions: clients read and generate them; state transitions are functions.
REVOKE UPDATE ON public.missions FROM authenticated;

-- profiles: your own display name, nothing else. active_company_id moves
-- through set_active_company(), which checks membership first.
REVOKE UPDATE ON public.profiles FROM authenticated;
GRANT UPDATE (display_name) ON public.profiles TO authenticated;
