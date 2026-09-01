import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { fetchCurrentCompany } from "@/lib/company";
import { TrendingUp, TrendingDown, DollarSign } from "lucide-react";

export const Route = createFileRoute("/_authenticated/finance")({
  head: () => ({ meta: [{ title: "Finance — RotorOps" }] }),
  component: FinancePage,
});

function FinancePage() {
  const { data: company } = useQuery({
    queryKey: ["company"],
    queryFn: fetchCurrentCompany,
  });
  const { data: txns } = useQuery({
    queryKey: ["txns"],
    queryFn: async () => (await supabase.from("economy_transactions").select("*").order("created_at", { ascending: false }).limit(100)).data ?? [],
  });

  const income = txns?.filter((t: any) => Number(t.amount) > 0).reduce((s: number, t: any) => s + Number(t.amount), 0) ?? 0;
  const expense = txns?.filter((t: any) => Number(t.amount) < 0).reduce((s: number, t: any) => s + Number(t.amount), 0) ?? 0;

  return (
    <div className="space-y-6 p-6 md:p-8">
      <div>
        <p className="text-xs uppercase tracking-widest text-muted-foreground">Finance</p>
        <h1 className="mt-1 text-3xl font-semibold">Ledger</h1>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Stat icon={DollarSign} label="Cash on hand" value={`$${Number(company?.cash ?? 0).toLocaleString()}`} tone="default" />
        <Stat icon={TrendingUp} label="Income (100 txn)" value={`+$${income.toLocaleString()}`} tone="success" />
        <Stat icon={TrendingDown} label="Expense (100 txn)" value={`-$${Math.abs(expense).toLocaleString()}`} tone="destructive" />
      </div>

      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <table className="w-full text-sm">
          <thead className="border-b border-border bg-secondary/40 text-left text-xs uppercase tracking-wider text-muted-foreground">
            <tr><th className="px-4 py-2">Date</th><th className="px-4 py-2">Type</th><th className="px-4 py-2">Description</th><th className="px-4 py-2 text-right">Amount</th></tr>
          </thead>
          <tbody>
            {txns?.length === 0 && <tr><td colSpan={4} className="p-8 text-center text-muted-foreground">No transactions yet.</td></tr>}
            {txns?.map((t: any) => (
              <tr key={t.id} className="border-b border-border last:border-0">
                <td className="px-4 py-2 text-xs text-muted-foreground">{new Date(t.created_at).toLocaleString()}</td>
                <td className="px-4 py-2 text-xs capitalize">{t.type.replace("_", " ")}</td>
                <td className="px-4 py-2">{t.description}</td>
                <td className={`px-4 py-2 text-right font-mono ${Number(t.amount) >= 0 ? "text-success" : "text-destructive"}`}>
                  {Number(t.amount) >= 0 ? "+" : ""}${Math.abs(Number(t.amount)).toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Stat({ icon: Icon, label, value, tone }: { icon: any; label: string; value: string; tone: "default" | "success" | "destructive" }) {
  const c = tone === "success" ? "text-success" : tone === "destructive" ? "text-destructive" : "text-foreground";
  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <div className="flex items-center justify-between text-xs uppercase tracking-wider text-muted-foreground">
        <span>{label}</span><Icon className="h-4 w-4" />
      </div>
      <p className={`mt-2 font-mono text-2xl font-semibold ${c}`}>{value}</p>
    </div>
  );
}