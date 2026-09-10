import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { fetchCurrentCompany } from "@/lib/company";
import { Button } from "@/components/ui/button";
import { useState } from "react";
import { toast } from "sonner";
import { Award, Lock, CheckCircle2 } from "lucide-react";
import {
  PERK_CATALOG, TIERS, availablePoints, totalPoints, xpToNextPoint, canUnlock,
  type PilotPerk,
} from "@/lib/pilot-skills";

export const Route = createFileRoute("/_authenticated/skills")({
  head: () => ({ meta: [{ title: "Pilot Skills — RotorOps" }] }),
  component: SkillsPage,
});

function SkillsPage() {
  const qc = useQueryClient();
  const [unlocking, setUnlocking] = useState<string | null>(null);

  const { data: company } = useQuery({ queryKey: ["company"], queryFn: fetchCurrentCompany });

  const { data: userId } = useQuery({
    queryKey: ["auth-user-id"],
    queryFn: async () => (await supabase.auth.getUser()).data.user?.id ?? null,
  });

  const { data: skills } = useQuery({
    queryKey: ["pilot_skills", company?.id, userId],
    enabled: !!company?.id && !!userId,
    queryFn: async () =>
      (
        await supabase
          .from("pilot_skills")
          .select("*")
          .eq("company_id", company!.id)
          .eq("user_id", userId!)
          .maybeSingle()
      ).data,
  });

  // A roster view: everyone else's progress in this company, for context.
  // Read-only -- pilot_skills only ever accepts writes from your own account.
  const { data: roster } = useQuery({
    queryKey: ["pilot_skills_roster", company?.id],
    enabled: !!company?.id,
    queryFn: async () =>
      (await supabase.from("pilot_skills").select("*").eq("company_id", company!.id)).data ?? [],
  });

  const { data: members } = useQuery({
    queryKey: ["company_members", company?.id],
    enabled: !!company?.id,
    queryFn: async () =>
      (await supabase.from("company_members").select("user_id,callsign").eq("company_id", company!.id)).data ?? [],
  });

  const xp = skills?.xp ?? 0;
  const unlocked: string[] = skills?.unlocked_perks ?? [];
  const points = totalPoints(xp);
  const available = availablePoints(xp, unlocked);
  const toNext = xpToNextPoint(xp);

  async function unlock(perk: PilotPerk) {
    if (!company) return;
    setUnlocking(perk.id);
    const { error } = await supabase.rpc("unlock_pilot_perk", {
      _company_id: company.id,
      _perk: perk.id,
    });
    setUnlocking(null);
    if (error) return toast.error(error.message);
    toast.success(`${perk.label} unlocked.`);
    qc.invalidateQueries({ queryKey: ["pilot_skills"] });
    qc.invalidateQueries({ queryKey: ["pilot_skills_roster"] });
  }

  if (!company) return <div className="p-8 text-muted-foreground">Loading…</div>;

  return (
    <div className="space-y-6 p-6 md:p-8">
      <div>
        <p className="text-xs uppercase tracking-widest text-muted-foreground">Career</p>
        <h1 className="mt-1 text-3xl font-semibold">Pilot Skills</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Earned by flying real contracts to completion — a positioning flight or a failed
          contract pays no XP. A check ride passed is worth a flat bonus on top.
        </p>
      </div>

      <div className="rounded-lg border border-border bg-card p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-wider text-muted-foreground">Experience</p>
            <p className="mt-1 font-mono text-2xl font-semibold">{xp.toLocaleString()} XP</p>
          </div>
          <div className="text-right">
            <p className="text-xs uppercase tracking-wider text-muted-foreground">Perk points</p>
            <p className="mt-1 font-mono text-2xl font-semibold text-primary">
              {available} <span className="text-sm text-muted-foreground">/ {points} earned</span>
            </p>
          </div>
        </div>
        <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full bg-primary transition-all"
            style={{ width: `${((100 - toNext) / 100) * 100}%` }}
          />
        </div>
        <p className="mt-1.5 text-xs text-muted-foreground">{toNext} XP to the next point.</p>
      </div>

      <div className="relative space-y-8">
        {TIERS.map(({ tier, label, note }, i) => {
          const perks = PERK_CATALOG.filter((p) => p.tier === tier);
          return (
            <div key={tier} className="relative">
              {i > 0 && (
                <div className="absolute -top-8 left-1/2 h-8 w-px -translate-x-1/2 bg-border" />
              )}
              <div className="mb-3 text-center">
                <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                  {label}
                </h2>
                <p className="text-xs text-muted-foreground">{note}</p>
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                {perks.map((perk) => {
                  const owned = unlocked.includes(perk.id);
                  const gate = canUnlock(perk, xp, unlocked);
                  return (
                    <div
                      key={perk.id}
                      className={`rounded-lg border p-4 ${
                        owned
                          ? "border-success/50 bg-success/5"
                          : "border-border bg-card"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <h3 className="font-medium">{perk.label}</h3>
                        {owned ? (
                          <CheckCircle2 className="h-4 w-4 shrink-0 text-success" />
                        ) : (
                          <Lock className="h-4 w-4 shrink-0 text-muted-foreground" />
                        )}
                      </div>
                      <p className="mt-1.5 text-xs text-muted-foreground">{perk.description}</p>
                      {!owned && (
                        <Button
                          size="sm"
                          variant="secondary"
                          className="mt-3 w-full"
                          disabled={!gate.ok || unlocking === perk.id}
                          onClick={() => unlock(perk)}
                        >
                          {unlocking === perk.id
                            ? "Unlocking…"
                            : gate.ok
                              ? `Unlock — ${perk.cost} pt${perk.cost === 1 ? "" : "s"}`
                              : gate.reason}
                        </Button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {(roster ?? []).length > 1 && (
        <div className="rounded-lg border border-border bg-card p-5">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
            <Award className="h-4 w-4 text-primary" /> Roster experience
          </h2>
          <ul className="space-y-1.5 text-sm">
            {(roster ?? [])
              .slice()
              .sort((a: any, b: any) => b.xp - a.xp)
              .map((r: any) => {
                const m = (members ?? []).find((x: any) => x.user_id === r.user_id);
                return (
                  <li key={r.user_id} className="flex items-center justify-between">
                    <span className="text-muted-foreground">
                      {m?.callsign || (r.user_id === userId ? "You" : "Pilot")}
                    </span>
                    <span className="font-mono">
                      {r.xp.toLocaleString()} XP · {(r.unlocked_perks ?? []).length} perks
                    </span>
                  </li>
                );
              })}
          </ul>
        </div>
      )}
    </div>
  );
}
