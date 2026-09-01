import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { fetchCurrentCompany } from "@/lib/company";

export type CompanyRole = "owner" | "manager" | "pilot";

/**
 * The company you're currently looking at.
 *
 * Membership means a player can belong to several companies, so this reads
 * through current_company() rather than assuming one row per user.
 */
export function useCompany() {
  return useQuery({
    queryKey: ["company"],
    queryFn: fetchCurrentCompany,
  });
}

/**
 * Your role in that company, plus the two questions the UI actually asks.
 * Pilots fly; managers spend; the owner runs the roster.
 */
export function useCompanyRole() {
  const { data: company } = useCompany();
  const query = useQuery({
    queryKey: ["company_role", company?.id],
    enabled: !!company?.id,
    queryFn: async () =>
      (await supabase.rpc("company_role", { _company_id: company!.id })).data,
  });

  const role = (query.data ?? null) as CompanyRole | null;
  return {
    role,
    isOwner: role === "owner",
    canManage: role === "owner" || role === "manager",
    isLoading: query.isLoading,
  };
}
