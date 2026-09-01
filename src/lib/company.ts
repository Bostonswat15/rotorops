import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";

export type Company = Database["public"]["Tables"]["companies"]["Row"];

/**
 * The company you're currently looking at, or null if you aren't in one.
 *
 * `current_company()` returns a composite type. When you're a member of no
 * company it returns SQL NULL, which PostgREST serialises as an object with
 * every field set to null rather than as `null` itself -- so a plain truthiness
 * check reads "no company" as "a company with no name and no cash", skips the
 * setup screen, and renders a dashboard full of nulls. A missing id is the
 * reliable tell.
 */
export async function fetchCurrentCompany(): Promise<Company | null> {
  const { data, error } = await supabase.rpc("current_company");
  if (error) throw error;
  const row = data as Company | null;
  return row?.id ? row : null;
}
