import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Helicopter } from "lucide-react";
import { toast } from "sonner";
import { AIRCRAFT_ARCHETYPES } from "@/lib/game-data";

export function CompanySetup({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState("");
  const [baseName, setBaseName] = useState("Main Heliport");
  const [icao, setIcao] = useState("KLAX");
  const [difficulty, setDifficulty] = useState("normal");
  const [realism, setRealism] = useState("balanced");
  const [starter, setStarter] = useState("R44-II");
  const [loading, setLoading] = useState(false);
  const [joinCode, setJoinCode] = useState("");
  const [joining, setJoining] = useState(false);
  const [mode, setMode] = useState<"found" | "join">("found");

  // Company, base, starter airframe and opening capital are created together
  // server-side -- a half-built company can't be left behind by a failed step.
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      const arch = AIRCRAFT_ARCHETYPES.find((a) => a.internal_id === starter)!;
      const { error } = await supabase.rpc("create_company", {
        _name: name,
        _difficulty: difficulty,
        _realism: realism,
        _base_name: baseName,
        _icao: icao,
        _starter: arch as any,
      });
      if (error) throw error;
      toast.success("Operation launched.");
      onCreated();
    } catch (e: any) {
      toast.error(e.message ?? "Failed to create company");
    } finally {
      setLoading(false);
    }
  }

  async function joinWithCode(e: React.FormEvent) {
    e.preventDefault();
    setJoining(true);
    try {
      const { data, error } = await supabase.rpc("join_company", { _code: joinCode });
      if (error) throw error;
      toast.success(`Joined ${(data as any)?.company_name ?? "company"} as ${(data as any)?.role ?? "pilot"}.`);
      onCreated();
    } catch (e: any) {
      toast.error(e.message ?? "Could not join");
    } finally {
      setJoining(false);
    }
  }

  return (
    <div className="min-h-screen overflow-auto bg-background px-4 py-10">
      <div className="mx-auto max-w-2xl">
        <div className="mb-6 flex items-center gap-2">
          <Helicopter className="h-6 w-6 text-primary" />
          <h1 className="text-2xl font-semibold">
            {mode === "found" ? "Found your helicopter company" : "Join a company"}
          </h1>
        </div>

        <div className="mb-6 flex gap-2">
          <Button type="button" variant={mode === "found" ? "default" : "secondary"} size="sm" onClick={() => setMode("found")}>
            Start my own
          </Button>
          <Button type="button" variant={mode === "join" ? "default" : "secondary"} size="sm" onClick={() => setMode("join")}>
            Join with a code
          </Button>
        </div>

        {mode === "join" && (
          <form onSubmit={joinWithCode} className="space-y-4 rounded-xl border border-border bg-card p-6">
            <div>
              <Label htmlFor="join-code">Invite code</Label>
              <Input
                id="join-code"
                required
                value={joinCode}
                onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                placeholder="ABCD2345"
                className="font-mono tracking-[0.3em]"
              />
              <p className="mt-2 text-sm text-muted-foreground">
                Ask an owner or manager for a code from their Crew page. You'll fly for
                their company and share its fleet and finances.
              </p>
            </div>
            <Button type="submit" disabled={joining}>{joining ? "Joining…" : "Join company"}</Button>
          </form>
        )}

        <form
          onSubmit={submit}
          className={`space-y-6 rounded-xl border border-border bg-card p-6 ${mode === "join" ? "hidden" : ""}`}
        >
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <Label>Company name</Label>
              <Input required value={name} onChange={(e) => setName(e.target.value)} placeholder="Ridgeline Aviation" />
            </div>
            <div>
              <Label>Primary base</Label>
              <Input required value={baseName} onChange={(e) => setBaseName(e.target.value)} />
            </div>
            <div>
              <Label>Base ICAO</Label>
              <Input value={icao} onChange={(e) => setIcao(e.target.value.toUpperCase())} maxLength={5} />
            </div>
          </div>

          <div>
            <Label className="mb-2 block">Difficulty</Label>
            <RadioGroup value={difficulty} onValueChange={setDifficulty} className="grid grid-cols-3 gap-2">
              {[
                ["easy", "Easy", "$500k start"],
                ["normal", "Normal", "$250k start"],
                ["hard", "Hard", "$120k start"],
              ].map(([v, l, sub]) => (
                <label key={v} className="flex cursor-pointer flex-col rounded-md border border-border bg-background p-3 has-[:checked]:border-primary has-[:checked]:bg-accent">
                  <RadioGroupItem value={v} className="sr-only" />
                  <span className="font-medium">{l}</span>
                  <span className="text-xs text-muted-foreground">{sub}</span>
                </label>
              ))}
            </RadioGroup>
          </div>

          <div>
            <Label className="mb-2 block">Realism mode</Label>
            <RadioGroup value={realism} onValueChange={setRealism} className="grid grid-cols-3 gap-2">
              {[
                ["strict", "Strict Realistic", "Reject implausible mods"],
                ["balanced", "Balanced Sim", "Warn on suspicious stats"],
                ["sandbox", "Sandbox", "Anything goes"],
              ].map(([v, l, sub]) => (
                <label key={v} className="flex cursor-pointer flex-col rounded-md border border-border bg-background p-3 has-[:checked]:border-primary has-[:checked]:bg-accent">
                  <RadioGroupItem value={v} className="sr-only" />
                  <span className="font-medium">{l}</span>
                  <span className="text-xs text-muted-foreground">{sub}</span>
                </label>
              ))}
            </RadioGroup>
          </div>

          <div>
            <Label className="mb-2 block">Starter helicopter</Label>
            <RadioGroup value={starter} onValueChange={setStarter} className="grid gap-2 md:grid-cols-2">
              {AIRCRAFT_ARCHETYPES.slice(0, 3).map((a) => (
                <label key={a.internal_id} className="flex cursor-pointer flex-col rounded-md border border-border bg-background p-3 has-[:checked]:border-primary has-[:checked]:bg-accent">
                  <RadioGroupItem value={a.internal_id} className="sr-only" />
                  <span className="font-medium">{a.display_name}</span>
                  <span className="text-xs text-muted-foreground">
                    {a.engine_type} · {a.cruise_kts}kts · {a.payload_lbs}lb · ${a.op_cost_hr}/hr
                  </span>
                </label>
              ))}
            </RadioGroup>
          </div>

          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? "Launching…" : "Launch operation"}
          </Button>
        </form>
      </div>
    </div>
  );
}