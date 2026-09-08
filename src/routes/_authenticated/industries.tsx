import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { fetchCurrentCompany } from "@/lib/company";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useState } from "react";
import { toast } from "sonner";
import { Factory, TrendingUp, TrendingDown, Coins, Compass } from "lucide-react";
import { useCompanyRole } from "@/hooks/use-company";
import { findIndustrySites } from "@/lib/osm";
import {
  siteIndustries, INDUSTRY_DEFS, CHAIN_LABEL, buyPrice, sellPrice,
  type IndustryKind,
} from "@/lib/industries";
import { goodById } from "@/lib/goods";

export const Route = createFileRoute("/_authenticated/industries")({
  head: () => ({ meta: [{ title: "Trading Hall — RotorOps" }] }),
  component: IndustriesPage,
});

const money = (n: number) => `$${Math.round(n).toLocaleString()}`;

function IndustriesPage() {
  const qc = useQueryClient();
  const { canManage } = useCompanyRole();
  const [scanning, setScanning] = useState(false);
  const [investing, setInvesting] = useState<string | null>(null);
  const [investAmount, setInvestAmount] = useState("5000");
  const [tradeQty, setTradeQty] = useState<Record<string, string>>({});
  const [tradeDest, setTradeDest] = useState<Record<string, string>>({});
  const [busyTrade, setBusyTrade] = useState<string | null>(null);

  const { data: company } = useQuery({ queryKey: ["company"], queryFn: fetchCurrentCompany });
  const { data: bases } = useQuery({
    queryKey: ["bases"],
    queryFn: async () => (await supabase.from("bases").select("*")).data ?? [],
  });
  const { data: industries, refetch: refetchIndustries } = useQuery({
    queryKey: ["industries"],
    queryFn: async () => (await supabase.from("industries").select("*")).data ?? [],
  });
  const { data: investments } = useQuery({
    queryKey: ["industry-investments"],
    queryFn: async () =>
      (await supabase.from("company_industry_investments").select("*")).data ?? [],
  });

  const base = (bases ?? []).find((b: any) => b.latitude != null && b.longitude != null) ?? null;

  async function scan() {
    if (!base) return toast.error("Set a located home base first.");
    setScanning(true);
    try {
      const raw = await findIndustrySites(
        { lat: Number(base.latitude), lon: Number(base.longitude) },
        50,
      );
      if (!raw) return toast.error("Could not reach OpenStreetMap. Try again in a moment.");
      const sited = siteIndustries(raw);
      if (sited.length === 0) {
        return toast.info("No forests, farmland, quarries or wells found near this base.");
      }
      const { error } = await supabase.rpc("site_industries", {
        _base_id: base.id,
        _sites: sited as unknown as never,
      });
      if (error) return toast.error(error.message);
      toast.success(`Sited ${sited.length} industry site${sited.length === 1 ? "" : "s"}.`);
      qc.invalidateQueries({ queryKey: ["industries"] });
    } finally {
      setScanning(false);
    }
  }

  async function tick() {
    if (!base) return;
    await supabase.rpc("tick_base_industries", { _base_id: base.id });
    qc.invalidateQueries({ queryKey: ["industries"] });
  }

  async function invest(industryId: string) {
    const amount = Number(investAmount);
    if (!Number.isFinite(amount) || amount <= 0) return toast.error("Enter a valid amount.");
    setInvesting(industryId);
    const { error } = await supabase.rpc("invest_in_industry", {
      _industry_id: industryId,
      _amount: amount,
    });
    setInvesting(null);
    if (error) return toast.error(error.message);
    toast.success(`Invested ${money(amount)}.`);
    qc.invalidateQueries({ queryKey: ["industries"] });
    qc.invalidateQueries({ queryKey: ["industry-investments"] });
    qc.invalidateQueries({ queryKey: ["company"] });
  }

  async function dispatchTrade(fromId: string) {
    const toId = tradeDest[fromId];
    const qty = Number(tradeQty[fromId] ?? "0");
    if (!toId) return toast.error("Pick a destination.");
    if (!Number.isFinite(qty) || qty <= 0) return toast.error("Enter a quantity.");
    setBusyTrade(fromId);
    const { data, error } = await supabase.rpc("dispatch_trade_run", {
      _from_industry_id: fromId,
      _to_industry_id: toId,
      _quantity: qty,
    });
    setBusyTrade(null);
    if (error) return toast.error(error.message);
    toast.success(
      `Trade run created — ${money(Number((data as any)?.payout ?? 0))} margin locked in. ` +
        `Dispatch it from the Mission Board.`,
    );
    qc.invalidateQueries({ queryKey: ["industries"] });
    qc.invalidateQueries({ queryKey: ["missions"] });
  }

  if (!company) return <div className="p-8 text-muted-foreground">Loading…</div>;

  const list = industries ?? [];
  const byChain = new Map<string, any[]>();
  for (const ind of list) {
    const def = INDUSTRY_DEFS[ind.kind as IndustryKind];
    if (!def) continue;
    if (!byChain.has(def.chain)) byChain.set(def.chain, []);
    byChain.get(def.chain)!.push(ind);
  }
  const investedById = new Map((investments ?? []).map((i: any) => [i.industry_id, i]));

  return (
    <div className="space-y-6 p-6 md:p-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-widest text-muted-foreground">Industries</p>
          <h1 className="mt-1 text-3xl font-semibold">Trading Hall</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {list.length} sites known near {base?.icao ?? "your base"} · cash on hand{" "}
            {money(Number(company.cash))}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={tick}>Refresh stock</Button>
          {canManage && (
            <Button onClick={scan} disabled={scanning || !base}>
              <Compass className="mr-2 h-4 w-4" />
              {scanning ? "Scanning…" : list.length === 0 ? "Scan for industries" : "Rescan"}
            </Button>
          )}
        </div>
      </div>

      {!base && (
        <p className="rounded-lg border border-border bg-card px-4 py-3 text-sm text-muted-foreground">
          Set a home base with a real position before scanning for industries. The sim bridge fills
          this in the first time it sees your base airport.
        </p>
      )}

      {base && list.length === 0 && (
        <p className="rounded-lg border border-border bg-card px-4 py-3 text-sm text-muted-foreground">
          No industries sited yet.{" "}
          {canManage ? "Click Scan for industries — this takes a moment the first time." : "Ask a manager to scan."}
        </p>
      )}

      {[...byChain.entries()].map(([chain, sites]) => {
        const tier1 = sites.find((s) => INDUSTRY_DEFS[s.kind as IndustryKind]?.tier === 1);
        const tier2 = sites.find((s) => INDUSTRY_DEFS[s.kind as IndustryKind]?.tier === 2);
        return (
          <div key={chain} className="rounded-lg border border-border bg-card p-5">
            <h2 className="mb-3 flex items-center gap-2 text-lg font-semibold">
              <Factory className="h-4 w-4 text-primary" /> {CHAIN_LABEL[chain as keyof typeof CHAIN_LABEL]}
            </h2>
            <div className="grid gap-4 md:grid-cols-2">
              {[tier1, tier2].filter(Boolean).map((ind) => {
                const def = INDUSTRY_DEFS[ind.kind as IndustryKind];
                const good = goodById(def.output);
                if (!good) return null;
                const ratio = ind.capacity > 0 ? Number(ind.stock) / Number(ind.capacity) : 0;
                const buy = buyPrice(good, ratio);
                const sell = sellPrice(good, ratio);
                const inv = investedById.get(ind.id) as any;
                const otherSites = sites.filter((s) => s.id !== ind.id);

                return (
                  <div key={ind.id} className="rounded-md border border-border p-4">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="font-medium">
                          {ind.name ?? def.label}
                          {ind.confidence === "synthesised" && (
                            <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                              estimated site
                            </span>
                          )}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {def.label} · produces {good.name}
                        </p>
                      </div>
                      <span className="font-mono text-xs text-muted-foreground">
                        {Math.round(ratio * 100)}% stocked
                      </span>
                    </div>

                    <div className="mt-2 h-1.5 overflow-hidden rounded bg-muted">
                      <div
                        className="h-full bg-primary"
                        style={{ width: `${Math.round(ratio * 100)}%` }}
                      />
                    </div>

                    <div className="mt-3 flex justify-between font-mono text-sm">
                      <span className="flex items-center gap-1 text-success">
                        <TrendingDown className="h-3.5 w-3.5" /> buy {money(buy)}/unit
                      </span>
                      <span className="flex items-center gap-1 text-warning">
                        <TrendingUp className="h-3.5 w-3.5" /> sell {money(sell)}/unit
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {Math.round(Number(ind.stock)).toLocaleString()} / {Math.round(Number(ind.capacity)).toLocaleString()} units on hand
                    </p>

                    {canManage && (
                      <div className="mt-4 space-y-3 border-t border-border pt-3">
                        <div className="flex items-center gap-2">
                          <Input
                            type="number" min={0} className="h-8 w-28 text-sm"
                            value={investAmount} onChange={(e) => setInvestAmount(e.target.value)}
                          />
                          <Button
                            size="sm" variant="secondary"
                            disabled={investing === ind.id}
                            onClick={() => invest(ind.id)}
                          >
                            <Coins className="mr-1.5 h-3.5 w-3.5" />
                            Invest{inv ? ` (+${money(Number(inv.invested_total))} so far)` : ""}
                          </Button>
                        </div>

                        {otherSites.length > 0 && (() => {
                          const qty = Number(tradeQty[ind.id] ?? "0");
                          const weight = Number.isFinite(qty) ? qty * good.unit_lb : 0;
                          // The heaviest single airframe in the whole fleet -- a
                          // CH-47 -- tops out at 24,000 lb. Nothing stops a
                          // player choosing a bigger quantity than that (it may
                          // genuinely take two flights), but they should see it
                          // coming rather than find out after dispatching.
                          const tooHeavy = weight > 24000;
                          return (
                            <div className="flex flex-wrap items-center gap-2">
                              <div>
                                <Input
                                  type="number" min={0} placeholder="qty" className="h-8 w-20 text-sm"
                                  value={tradeQty[ind.id] ?? ""}
                                  onChange={(e) => setTradeQty((s) => ({ ...s, [ind.id]: e.target.value }))}
                                />
                                {weight > 0 && (
                                  <p className={`mt-0.5 text-xs ${tooHeavy ? "text-destructive" : "text-muted-foreground"}`}>
                                    {Math.round(weight).toLocaleString()} lb
                                    {tooHeavy && " — no single aircraft carries this in one flight"}
                                  </p>
                                )}
                              </div>
                              <Select
                                value={tradeDest[ind.id] ?? ""}
                                onValueChange={(v) => setTradeDest((s) => ({ ...s, [ind.id]: v }))}
                              >
                                <SelectTrigger className="h-8 w-40 text-sm"><SelectValue placeholder="deliver to…" /></SelectTrigger>
                                <SelectContent>
                                  {otherSites.map((o) => (
                                    <SelectItem key={o.id} value={o.id}>
                                      {o.name ?? INDUSTRY_DEFS[o.kind as IndustryKind]?.label}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                              <Button
                                size="sm"
                                disabled={busyTrade === ind.id}
                                onClick={() => dispatchTrade(ind.id)}
                              >
                                Dispatch trade run
                              </Button>
                            </div>
                          );
                        })()}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}

      {!canManage && list.length > 0 && (
        <p className="text-sm text-muted-foreground">
          Only owners and managers can invest or dispatch trade runs. Ask one to set one up, then fly
          it from the Mission Board.
        </p>
      )}
    </div>
  );
}
