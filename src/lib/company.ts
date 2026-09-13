import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { desktop } from "@/lib/desktop";

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

/**
 * Re-link the desktop app's built-in bridge when its device is gone.
 *
 * A paired device cascades from its company, so deleting your only company
 * takes the device with it and leaves the desktop app holding a token nothing
 * accepts. Called after founding or joining a company. A no-op in a browser,
 * and while any desktop device is still paired -- which does miss the case of
 * a second PC's desktop app still being linked while this one's was removed.
 */
export async function ensureDesktopBridgeLinked(): Promise<void> {
  const app = desktop();
  if (!app) return;
  const { data: devices } = await supabase.from("sim_devices").select("name, paired_at, revoked_at");
  const linked = (devices ?? []).some(
    (d) => d.paired_at && !d.revoked_at && d.name.startsWith("RotorOps Desktop"),
  );
  if (linked && (await app.hasToken())) return;

  const { data, error } = await supabase.rpc("create_pairing_code", { _name: "RotorOps Desktop" });
  if (error) throw error;
  const row = (Array.isArray(data) ? data[0] : data) as { code?: string } | null;
  if (row?.code) await app.provision(row.code);
}
