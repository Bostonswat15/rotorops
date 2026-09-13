import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useState } from "react";
import { toast } from "sonner";
import { Users, UserPlus, Crown, Wrench, Plane, Copy, X } from "lucide-react";
import { useCompany, useCompanyRole, type CompanyRole } from "@/hooks/use-company";

export const Route = createFileRoute("/_authenticated/crew")({
  head: () => ({ meta: [{ title: "Crew — RotorOps" }] }),
  component: CrewPage,
});

const ROLE_META: Record<CompanyRole, { label: string; icon: any; blurb: string }> = {
  owner: { label: "Owner", icon: Crown, blurb: "Runs the company and the roster" },
  manager: { label: "Manager", icon: Wrench, blurb: "Buys aircraft, certs and contracts" },
  pilot: { label: "Pilot", icon: Plane, blurb: "Claims contracts and flies them" },
};

function CrewPage() {
  const qc = useQueryClient();
  const { data: company } = useCompany();
  const { role, isOwner, canManage } = useCompanyRole();

  const { data: roster } = useQuery({
    queryKey: ["roster", company?.id],
    enabled: !!company?.id,
    queryFn: async () =>
      (await supabase.rpc("company_roster", { _company_id: company!.id })).data ?? [],
  });

  const { data: invites } = useQuery({
    queryKey: ["invites", company?.id],
    enabled: !!company?.id && canManage,
    queryFn: async () =>
      (await supabase.from("company_invites").select("*").order("created_at", { ascending: false })).data ?? [],
  });

  // Null until the pilot ratings migration is run: show nothing rather than
  // every rating as due.
  const { data: ratings } = useQuery({
    queryKey: ["pilot_ratings", company?.id],
    enabled: !!company?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("pilot_ratings")
        .select("*")
        .eq("company_id", company!.id);
      return error ? null : data;
    },
  });

  async function removeMember(userId: string, self: boolean) {
    const { error } = await supabase.rpc("remove_member", {
      _company_id: company!.id,
      _user_id: userId,
    });
    if (error) return toast.error(error.message);
    toast.success(self ? "You left the company." : "Member removed.");
    qc.invalidateQueries();
  }

  async function changeRole(userId: string, newRole: string) {
    const { error } = await supabase.rpc("set_member_role", {
      _company_id: company!.id,
      _user_id: userId,
      _role: newRole,
    });
    if (error) return toast.error(error.message);
    toast.success("Role updated.");
    qc.invalidateQueries();
  }

  if (!company) return null;

  return (
    <div className="space-y-6 p-6 md:p-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-widest text-muted-foreground">{company.name}</p>
          <h1 className="mt-1 text-3xl font-semibold">Crew</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {roster?.length ?? 0} member{(roster?.length ?? 0) === 1 ? "" : "s"} · you are {role ?? "—"}
          </p>
        </div>
      </div>

      <div className="rounded-lg border border-border bg-card">
        {(roster ?? []).map((m: any) => {
          const meta = ROLE_META[m.role as CompanyRole] ?? ROLE_META.pilot;
          const Icon = meta.icon;
          return (
            <div key={m.user_id} className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3 last:border-0">
              <Icon className="h-4 w-4 shrink-0 text-primary" />
              <div className="min-w-40 flex-1">
                <p className="font-medium">{m.display_name ?? "Unnamed pilot"}</p>
                <p className="text-xs text-muted-foreground">
                  {meta.label} · {Number(m.flights)} flight{Number(m.flights) === 1 ? "" : "s"} · {Number(m.hours).toFixed(1)}h
                  {m.avg_score != null && ` · average score ${Math.round(Number(m.avg_score))}`}
                </p>
                <RatingChips
                  role={m.role}
                  ratings={ratings ? ratings.filter((r) => r.user_id === m.user_id) : null}
                />
              </div>
              {isOwner && (
                <Select value={m.role} onValueChange={(v) => changeRole(m.user_id, v)}>
                  <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="owner">Owner</SelectItem>
                    <SelectItem value="manager">Manager</SelectItem>
                    <SelectItem value="pilot">Pilot</SelectItem>
                  </SelectContent>
                </Select>
              )}
              {(isOwner || m.role === role) && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => removeMember(m.user_id, m.role === role)}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          );
        })}
      </div>

      {canManage && <InvitePanel companyId={company.id} isOwner={isOwner} invites={invites ?? []} />}

      <div className="grid gap-4 md:grid-cols-3">
        {(Object.keys(ROLE_META) as CompanyRole[]).map((r) => {
          const meta = ROLE_META[r];
          const Icon = meta.icon;
          return (
            <div key={r} className="rounded-lg border border-border bg-card p-4">
              <Icon className="h-4 w-4 text-primary" />
              <p className="mt-2 font-medium">{meta.label}</p>
              <p className="mt-1 text-sm text-muted-foreground">{meta.blurb}</p>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** A member's check rides: done ones ticked, due ones hollow. */
function RatingChips({ role, ratings }: { role: string; ratings: { rating: string; label: string; passed_at: string | null }[] | null }) {
  if (role === "owner") {
    return <p className="mt-1 text-xs text-muted-foreground">Owner — no check rides needed</p>;
  }
  if (!ratings) return null;
  const checkout = ratings.find((r) => r.rating === "checkout");
  const types = ratings
    .filter((r) => r.rating !== "checkout")
    .sort((a, b) => a.label.localeCompare(b.label));
  return (
    <div className="mt-1.5 flex flex-wrap gap-1">
      <RatingChip done={!!checkout?.passed_at} label={checkout?.passed_at ? "Checked out" : "Company check ride due"} />
      {types.map((r) => (
        <RatingChip key={r.rating} done={!!r.passed_at} label={r.label} />
      ))}
    </div>
  );
}

function RatingChip({ done, label }: { done: boolean; label: string }) {
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[11px] ${
        done ? "bg-success/15 text-success" : "bg-muted text-muted-foreground"
      }`}
    >
      {done ? "✓ " : "◌ "}
      {label}
    </span>
  );
}

function InvitePanel({ companyId, isOwner, invites }: any) {
  const qc = useQueryClient();
  const [role, setRole] = useState("pilot");
  const [uses, setUses] = useState("1");
  const [busy, setBusy] = useState(false);

  async function create() {
    setBusy(true);
    const { error } = await supabase.rpc("create_invite", {
      _company_id: companyId,
      _role: role,
      _max_uses: Number(uses) || 1,
    });
    setBusy(false);
    if (error) return toast.error(error.message);
    toast.success("Invite created.");
    qc.invalidateQueries({ queryKey: ["invites"] });
  }

  async function revoke(id: string) {
    const { error } = await supabase.rpc("revoke_invite", { _invite_id: id });
    if (error) return toast.error(error.message);
    qc.invalidateQueries({ queryKey: ["invites"] });
  }

  const live = invites.filter((i: any) => new Date(i.expires_at) > new Date() && i.uses < i.max_uses);

  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <div className="flex items-center gap-2">
        <UserPlus className="h-4 w-4 text-primary" />
        <h2 className="font-semibold">Invite pilots</h2>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        Share a code. They sign up, enter it, and join your company.
      </p>

      <div className="mt-4 flex flex-wrap items-end gap-3">
        <div>
          <Label>Joins as</Label>
          <Select value={role} onValueChange={setRole}>
            <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="pilot">Pilot</SelectItem>
              {isOwner && <SelectItem value="manager">Manager</SelectItem>}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label htmlFor="uses">Max uses</Label>
          <Input id="uses" className="w-24" inputMode="numeric" value={uses} onChange={(e) => setUses(e.target.value)} />
        </div>
        <Button onClick={create} disabled={busy}>{busy ? "Creating…" : "Create invite"}</Button>
      </div>

      {live.length > 0 && (
        <ul className="mt-4 space-y-2">
          {live.map((i: any) => (
            <li key={i.id} className="flex flex-wrap items-center gap-3 rounded border border-border bg-background px-3 py-2">
              <span className="font-mono text-lg tracking-[0.3em]">{i.code}</span>
              <span className="flex-1 text-xs text-muted-foreground">
                joins as {i.role} · {i.uses}/{i.max_uses} used · expires {new Date(i.expires_at).toLocaleDateString()}
              </span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  navigator.clipboard?.writeText(i.code);
                  toast.success("Code copied.");
                }}
              >
                <Copy className="h-3.5 w-3.5" />
              </Button>
              <Button size="sm" variant="ghost" onClick={() => revoke(i.id)}>
                <X className="h-3.5 w-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
