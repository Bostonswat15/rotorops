import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { ArrowLeft, Helicopter, Plane } from "lucide-react";
import { toast } from "sonner";
import { AIRCRAFT_ARCHETYPES, type AircraftArchetype, type WingType } from "@/lib/game-data";
import { STARTER_MAX_COST } from "@/lib/economy";
import { FREE_CAMP_KINDS, type PlayMode } from "@/lib/play-mode";
import { INDUSTRY_DEFS } from "@/lib/industries";

// What a new company can start with: anything up to STARTER_MAX_COST, cheapest
// first. Planes used to offer every airframe, a $28.5M Citation included, free.
const starters = (wing: WingType) =>
  AIRCRAFT_ARCHETYPES.filter((a) => (a.wing ?? "rotary") === wing && a.acquisition_cost <= STARTER_MAX_COST).sort(
    (a, b) => a.acquisition_cost - b.acquisition_cost,
  );
const STARTERS: Record<WingType, AircraftArchetype[]> = { rotary: starters("rotary"), fixed: starters("fixed") };

const DEFAULT_BASE: Record<WingType, string> = {
  rotary: "Main Heliport",
  fixed: "Main Airfield",
};

export function CompanySetup({
  onCreated,
  onCancel,
  initialMode = "found",
}: {
  onCreated: () => void;
  /** Back to the company you already have. Absent when this is your first. */
  onCancel?: () => void;
  initialMode?: "found" | "join";
}) {
  const [name, setName] = useState("");
  const [wing, setWing] = useState<WingType>("rotary");
  const [baseName, setBaseName] = useState(DEFAULT_BASE.rotary);
  const [icao, setIcao] = useState("KLAX");
  const [difficulty, setDifficulty] = useState("normal");
  const [realism, setRealism] = useState("balanced");
  const [starter, setStarter] = useState(STARTERS.rotary[0].internal_id);
  const [playMode, setPlayMode] = useState<PlayMode>("career");
  const [freeCamp, setFreeCamp] = useState<string>(FREE_CAMP_KINDS[0]);
  const [loading, setLoading] = useState(false);
  const [joinCode, setJoinCode] = useState("");
  const [joining, setJoining] = useState(false);
  const [mode, setMode] = useState<"found" | "join">(initialMode);

  function chooseWing(next: WingType) {
    setWing(next);
    setStarter(STARTERS[next][0].internal_id);
    // Only swap a base name nobody has typed over.
    if (baseName === DEFAULT_BASE[wing]) setBaseName(DEFAULT_BASE[next]);
  }

  // Company, base, starter airframe and opening capital are created together
  // server-side -- a half-built company can't be left behind by a failed step.
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      const industry = playMode === "industry";
      const arch = STARTERS[wing].find((a) => a.internal_id === starter)!;
      const { error } = await supabase.rpc("create_company", {
        _name: name,
        _difficulty: difficulty,
        _realism: realism,
        _base_name: baseName,
        _icao: icao,
        // Industry mode starts with a free camp instead of a free aircraft.
        _starter: industry ? null : (arch as any),
        _play_mode: playMode,
        _free_camp: industry ? freeCamp : null,
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

  const HeaderIcon = mode === "found" && wing === "fixed" ? Plane : Helicopter;

  return (
    <div className="min-h-screen overflow-auto bg-background px-4 py-10">
      <div className="mx-auto max-w-2xl">
        {onCancel && (
          <Button type="button" variant="ghost" size="sm" onClick={onCancel} className="-ml-2 mb-4">
            <ArrowLeft className="mr-1 h-4 w-4" /> Back
          </Button>
        )}
        <div className="mb-6 flex items-center gap-2">
          <HeaderIcon className="h-6 w-6 text-primary" />
          <h1 className="text-2xl font-semibold">
            {mode === "join"
              ? "Join a company"
              : wing === "fixed"
                ? "Found your fixed-wing company"
                : "Found your helicopter company"}
          </h1>
        </div>

        {onCancel && (
          <p className="-mt-3 mb-6 text-sm text-muted-foreground">
            Your other companies carry on as they are. Switch between them from the company
            name at the top of the sidebar.
          </p>
        )}

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
          <div>
            <Label className="mb-2 block">What do you fly?</Label>
            <RadioGroup
              value={wing}
              onValueChange={(v) => chooseWing(v as WingType)}
              className="grid grid-cols-2 gap-2"
            >
              {(
                [
                  ["rotary", "Helicopters", "Rescues, lifts, medevac and scene work"],
                  ["fixed", "Planes", "Freight, charters, air ambulance and survey"],
                ] as const
              ).map(([v, l, sub]) => (
                <label
                  key={v}
                  className="flex cursor-pointer flex-col rounded-md border border-border bg-background p-3 has-[:checked]:border-primary has-[:checked]:bg-accent"
                >
                  <RadioGroupItem value={v} className="sr-only" />
                  <span className="font-medium">{l}</span>
                  <span className="text-xs text-muted-foreground">{sub}</span>
                </label>
              ))}
            </RadioGroup>
            <p className="mt-2 text-xs text-muted-foreground">
              This picks your first aircraft. Either kind can be bought later from the Market.
            </p>
          </div>

          <div>
            <Label className="mb-2 block">Game mode</Label>
            <RadioGroup
              value={playMode}
              onValueChange={(v) => setPlayMode(v as PlayMode)}
              className="grid grid-cols-2 gap-2"
            >
              {(
                [
                  ["career", "Career", "Every kind of contract: rescues, charters, freight, goods"],
                  ["industry", "Industry", "No missions: run camps and mills and fly their goods"],
                ] as const
              ).map(([v, l, sub]) => (
                <label
                  key={v}
                  className="flex cursor-pointer flex-col rounded-md border border-border bg-background p-3 has-[:checked]:border-primary has-[:checked]:bg-accent"
                >
                  <RadioGroupItem value={v} className="sr-only" />
                  <span className="font-medium">{l}</span>
                  <span className="text-xs text-muted-foreground">{sub}</span>
                </label>
              ))}
            </RadioGroup>
            <p className="mt-2 text-xs text-muted-foreground">
              You can switch later on Settings.
            </p>
          </div>

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
                ["easy", "Easy", "$1M start"],
                ["normal", "Normal", "$500k start"],
                ["hard", "Hard", "$250k start"],
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

          {playMode === "industry" && (
            <div>
              <Label className="mb-2 block">Your free camp</Label>
              <RadioGroup value={freeCamp} onValueChange={setFreeCamp} className="grid gap-2 md:grid-cols-2">
                {FREE_CAMP_KINDS.map((k) => (
                  <label key={k} className="flex cursor-pointer flex-col rounded-md border border-border bg-background p-3 has-[:checked]:border-primary has-[:checked]:bg-accent">
                    <RadioGroupItem value={k} className="sr-only" />
                    <span className="font-medium">{INDUSTRY_DEFS[k].label}</span>
                    <span className="text-xs text-muted-foreground">
                      Normally ${INDUSTRY_DEFS[k].build_cost.toLocaleString()} · {INDUSTRY_DEFS[k].max_workers} workers
                    </span>
                  </label>
                ))}
              </RadioGroup>
              <p className="mt-2 text-xs text-muted-foreground">
                Place it anywhere on the Trading Hall once your base has a position, fully staffed and
                at no cost. There's no free aircraft in Industry mode: buy or lease one from the
                Market (a Savage Cub is $75,000).
              </p>
            </div>
          )}

          <div className={playMode === "industry" ? "hidden" : undefined}>
            <Label className="mb-2 block">
              Starter {wing === "fixed" ? "plane" : "helicopter"}
            </Label>
            {/* The plane list is every stock airframe, so it scrolls rather than
                pushing Launch a long way down the page. */}
            <RadioGroup value={starter} onValueChange={setStarter} className="grid max-h-96 gap-2 overflow-y-auto pr-1 md:grid-cols-2">
              {STARTERS[wing].map((a) => (
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
