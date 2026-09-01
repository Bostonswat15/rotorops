import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { fetchCurrentCompany } from "@/lib/company";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { CERT_LABELS, CERT_UNLOCKS, ALL_CERTS } from "@/lib/game-data";
import { toast } from "sonner";
import { useState, useEffect } from "react";
import { Radio, Trash2, MapPin } from "lucide-react";
import { useCompanyRole } from "@/hooks/use-company";
import { desktop, type BridgeStatus } from "@/lib/desktop";

export const Route = createFileRoute("/_authenticated/settings")({
  head: () => ({ meta: [{ title: "Settings — RotorOps" }] }),
  component: SettingsPage,
});

function SettingsPage() {
  const qc = useQueryClient();
  const { canManage } = useCompanyRole();
  const { data: company } = useQuery({
    queryKey: ["company"],
    queryFn: fetchCurrentCompany,
  });

  async function updateField(patch: any) {
    if (!company) return;
    const { error } = await supabase.from("companies").update(patch).eq("id", company.id);
    if (error) toast.error(error.message);
    else toast.success("Updated.");
    qc.invalidateQueries();
  }

  // Pricing and the cash/reputation checks live in the database now -- with
  // more than one member, a client-side purchase is a permission hole.
  async function purchaseCert(c: string) {
    if (!company) return;
    const { error } = await supabase.rpc("purchase_certification", {
      _company_id: company.id,
      _cert: c,
    });
    if (error) return toast.error(error.message);
    toast.success(`${CERT_LABELS[c]} unlocked.`);
    qc.invalidateQueries();
  }

  if (!company) return null;
  const ownedCerts = new Set<string>(company.certifications ?? []);

  return (
    <div className="space-y-6 p-6 md:p-8">
      <div>
        <p className="text-xs uppercase tracking-widest text-muted-foreground">Company</p>
        <h1 className="mt-1 text-3xl font-semibold">Settings</h1>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-lg border border-border bg-card p-5">
          <h2 className="mb-4 font-semibold">Realism</h2>
          <Label>Realism mode</Label>
          <Select value={company.realism_mode} disabled={!canManage} onValueChange={(v) => updateField({ realism_mode: v })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="strict">Strict Realistic</SelectItem>
              <SelectItem value="balanced">Balanced Sim</SelectItem>
              <SelectItem value="sandbox">Sandbox</SelectItem>
            </SelectContent>
          </Select>
          <Label className="mt-4 block">Difficulty</Label>
          <Select value={company.difficulty} disabled={!canManage} onValueChange={(v) => updateField({ difficulty: v })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="easy">Easy</SelectItem>
              <SelectItem value="normal">Normal</SelectItem>
              <SelectItem value="hard">Hard</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="rounded-lg border border-border bg-card p-5">
          <h2 className="mb-4 font-semibold">Certifications</h2>
          <ul className="space-y-2">
            {ALL_CERTS.map((c) => {
              const owned = ownedCerts.has(c);
              const meta = CERT_UNLOCKS[c as keyof typeof CERT_UNLOCKS];
              return (
                <li key={c} className="flex items-center justify-between rounded border border-border bg-background px-3 py-2 text-sm">
                  <div>
                    <p className="font-medium">{CERT_LABELS[c]}</p>
                    {meta && !owned && <p className="text-xs text-muted-foreground">${meta.cost.toLocaleString()} · rep {meta.minRep}+</p>}
                  </div>
                  {owned ? (
                    <span className="text-xs text-success">Held</span>
                  ) : meta ? (
                    <Button size="sm" variant="secondary" disabled={!canManage} onClick={() => purchaseCert(c)}>Acquire</Button>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      </div>

      <HomeBase canManage={canManage} />
      <SimLink />
    </div>
  );
}

/**
 * Where the company operates from.
 *
 * Everything is anchored here: contracts are generated around the base, and
 * mission scenes are offset from its real position. Changing the ICAO clears
 * that position so the sim bridge resolves the new field next time it runs.
 */
function HomeBase({ canManage }: { canManage: boolean }) {
  const qc = useQueryClient();
  const [icao, setIcao] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const { data: bases } = useQuery({
    queryKey: ["bases"],
    queryFn: async () => (await supabase.from("bases").select("*").order("created_at")).data ?? [],
  });

  const base = (bases ?? []).find((b: any) => b.is_primary) ?? (bases ?? [])[0] ?? null;
  const located = base?.latitude != null && base?.longitude != null;

  useEffect(() => {
    if (base) {
      setIcao(base.icao ?? "");
      setName(base.name ?? "");
    }
  }, [base?.id, base?.icao, base?.name]);

  async function save() {
    if (!base) return;
    const nextIcao = icao.trim().toUpperCase();
    setBusy(true);
    // A different field means the stored coordinates are no longer this base.
    const movingField = nextIcao !== (base.icao ?? "").toUpperCase();
    const { error } = await supabase
      .from("bases")
      .update({
        icao: nextIcao || null,
        name: name.trim() || base.name,
        ...(movingField ? { latitude: null, longitude: null } : {}),
      })
      .eq("id", base.id);
    setBusy(false);
    if (error) return toast.error(error.message);
    toast.success(
      movingField
        ? `Base moved to ${nextIcao}. Run the sim bridge to locate it, then generate fresh contracts.`
        : "Base updated.",
    );
    qc.invalidateQueries();
  }

  if (!base) return null;

  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <div className="flex items-center gap-2">
        <MapPin className="h-4 w-4 text-primary" />
        <h2 className="font-semibold">Home base</h2>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        Contracts are generated around this field, and mission scenes are placed
        relative to it.
      </p>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="base-icao">ICAO</Label>
          <Input
            id="base-icao"
            value={icao}
            disabled={!canManage}
            onChange={(e) => setIcao(e.target.value.toUpperCase())}
            placeholder="KSQL"
            className="font-mono"
          />
        </div>
        <div>
          <Label htmlFor="base-name">Name</Label>
          <Input
            id="base-name"
            value={name}
            disabled={!canManage}
            onChange={(e) => setName(e.target.value)}
            placeholder="Main Heliport"
          />
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button size="sm" onClick={save} disabled={!canManage || busy}>
          {busy ? "Saving…" : "Save base"}
        </Button>
        {located ? (
          <span className="font-mono text-xs text-success">
            located at {Number(base.latitude).toFixed(4)}, {Number(base.longitude).toFixed(4)}
          </span>
        ) : (
          <span className="text-xs text-warning">
            Position unknown — run the sim bridge once to locate it.
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * Pairing for the local MSFS 2024 bridge. The code is short-lived; redeeming it
 * mints a device token that only ever exists on the player's PC.
 */
function SimLink() {
  const app = desktop();
  // Inside the desktop app the bridge is already here and the user is already
  // signed in, so there is nothing to pair by hand.
  if (app) return <SimLinkDesktop app={app} />;
  return <SimLinkBrowser />;
}

/**
 * Desktop: provision a device token silently on first run, then just report
 * what the built-in bridge is doing.
 */
function SimLinkDesktop({ app }: { app: NonNullable<ReturnType<typeof desktop>> }) {
  const [status, setStatus] = useState<BridgeStatus | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const already = await app.hasToken();
      if (!already && !cancelled) {
        // Mint a code as the signed-in user, hand it straight to the shell.
        const { data, error } = await supabase.rpc("create_pairing_code", {
          _name: "RotorOps Desktop",
        });
        if (error) return setSetupError(error.message);
        const row: any = Array.isArray(data) ? data[0] : data;
        if (row?.code) {
          try {
            await app.provision(row.code);
          } catch (e: any) {
            if (!cancelled) setSetupError(e?.message ?? "Could not link the sim bridge");
          }
        }
      }
      const s = await app.status();
      if (!cancelled) setStatus(s);
    })();

    const off = app.onStatus((s) => !cancelled && setStatus(s));
    return () => {
      cancelled = true;
      off();
    };
  }, [app]);

  const flight = status?.flight;

  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <div className="flex items-center gap-2">
        <Radio className={`h-4 w-4 ${status?.simConnected ? "text-success" : "text-muted-foreground"}`} />
        <h2 className="font-semibold">Sim Link</h2>
        <span className="ml-auto text-xs text-muted-foreground">built in</span>
      </div>

      <p className="mt-2 text-sm">
        {status?.simConnected ? (
          <span className="text-success">
            Connected to Microsoft Flight Simulator 2024{status.simVersion ? ` (${status.simVersion})` : ""}
          </span>
        ) : (
          <span className="text-muted-foreground">
            Waiting for MSFS 2024 — start the sim and load a flight.
          </span>
        )}
      </p>

      {setupError && (
        <p className="mt-2 text-sm text-destructive">{setupError}</p>
      )}

      {flight && (
        <div className="mt-4 rounded border border-primary/40 bg-background px-3 py-2 text-sm">
          <p className="font-medium">
            {flight.aircraft ?? flight.simTitle} {flight.airborne ? "· airborne" : "· on the ground"}
          </p>
          <p className="text-xs text-muted-foreground">
            {flight.mission ? `${flight.mission} · ` : "Positioning · "}
            {(flight.hours ?? 0).toFixed(2)}h · {Math.round(flight.fuelUsed ?? 0)} lb fuel ·{" "}
            {(flight.distance ?? 0).toFixed(1)} nm
          </p>
        </div>
      )}

      <LoadedAircraft status={status} />

      <p className="mt-3 text-xs text-muted-foreground">
        Flights log themselves on engine shutdown. Closing this window keeps the
        bridge running in the system tray.
      </p>
    </div>
  );
}

/**
 * Shows what's loaded in the sim and, when it matches nothing in the fleet,
 * lets you bind that exact title to an aircraft.
 *
 * Modded helicopters report long TITLE strings with livery suffixes, and
 * transcribing them by hand is the main way sim-to-fleet matching goes wrong.
 * The bridge already knows the string, so this just hands it over.
 */
function LoadedAircraft({ status }: { status: BridgeStatus | null }) {
  const qc = useQueryClient();
  const [target, setTarget] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const loaded = status?.simAircraft ?? null;

  const { data: fleet } = useQuery({
    queryKey: ["aircraft"],
    queryFn: async () =>
      (await supabase.from("aircraft").select("id,display_name,sim_title,sim_title_aliases")).data ?? [],
  });

  if (!loaded) return null;

  async function bind() {
    const ac = (fleet ?? []).find((a: any) => a.id === target);
    if (!ac || !loaded) return;
    setBusy(true);
    const aliases = [...new Set([...(ac.sim_title_aliases ?? []), loaded.simTitle])];
    const { error } = await supabase
      .from("aircraft")
      .update({ sim_title_aliases: aliases })
      .eq("id", ac.id);
    setBusy(false);
    if (error) return toast.error(error.message);
    toast.success(`"${loaded.simTitle}" now flies as ${ac.display_name}.`);
    qc.invalidateQueries({ queryKey: ["aircraft"] });
  }

  return (
    <div className="mt-4 rounded border border-border bg-background px-3 py-3">
      <p className="text-xs uppercase tracking-wider text-muted-foreground">Loaded in sim</p>
      <p className="mt-1 font-mono text-sm break-all">{loaded.simTitle}</p>

      {loaded.matchedName ? (
        <p className="mt-2 text-sm text-success">Recognised as {loaded.matchedName}.</p>
      ) : (
        <>
          <p className="mt-2 text-sm text-warning">
            Not in your fleet — flights in this aircraft won't be logged.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Select value={target} onValueChange={setTarget}>
              <SelectTrigger className="w-64">
                <SelectValue placeholder="Link to an aircraft…" />
              </SelectTrigger>
              <SelectContent>
                {(fleet ?? []).map((a: any) => (
                  <SelectItem key={a.id} value={a.id}>{a.display_name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button size="sm" onClick={bind} disabled={!target || busy}>
              {busy ? "Linking…" : "Link this title"}
            </Button>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Or add it as a new aircraft on the Aircraft page, pasting this title
            into <em>MSFS sim title</em>.
          </p>
        </>
      )}
    </div>
  );
}

/** Browser: hand out a pairing code for the standalone bridge exe. */
function SimLinkBrowser() {
  const qc = useQueryClient();
  const [code, setCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const { data: devices } = useQuery({
    queryKey: ["sim_devices"],
    queryFn: async () =>
      (await supabase.from("sim_devices").select("*").order("created_at", { ascending: false })).data ?? [],
  });

  async function generate() {
    setBusy(true);
    const { data, error } = await supabase.rpc("create_pairing_code", {});
    setBusy(false);
    if (error) return toast.error(error.message);
    const row = Array.isArray(data) ? data[0] : data;
    setCode((row as any)?.code ?? null);
    qc.invalidateQueries({ queryKey: ["sim_devices"] });
  }

  async function revoke(id: string) {
    const { error } = await supabase.rpc("revoke_sim_device", { _device_id: id });
    if (error) return toast.error(error.message);
    toast.success("Device revoked.");
    qc.invalidateQueries({ queryKey: ["sim_devices"] });
  }

  const paired = (devices ?? []).filter((d: any) => d.paired_at && !d.revoked_at);

  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <div className="flex items-center gap-2">
        <Radio className="h-4 w-4 text-primary" />
        <h2 className="font-semibold">Sim Link</h2>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        Connect the local bridge so flights in Microsoft Flight Simulator 2024 log themselves.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button size="sm" onClick={generate} disabled={busy}>
          {busy ? "Generating…" : "Generate pairing code"}
        </Button>
        {code && (
          <div className="flex items-center gap-3 rounded border border-border bg-background px-3 py-2">
            <span className="font-mono text-lg tracking-[0.3em]">{code}</span>
            <span className="text-xs text-muted-foreground">expires in 15 min</span>
          </div>
        )}
      </div>

      {code && (
        <pre className="mt-3 overflow-x-auto rounded bg-background p-3 text-xs text-muted-foreground">
{`rotorops-bridge.exe pair ${code}
rotorops-bridge.exe

# or from source, in bridge/
npm install && npm run pair -- ${code} && npm start`}
        </pre>
      )}

      <div className="mt-4">
        <p className="text-xs uppercase tracking-wider text-muted-foreground">Paired devices</p>
        {paired.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">No devices paired yet.</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {paired.map((d: any) => (
              <li key={d.id} className="flex items-center justify-between rounded border border-border bg-background px-3 py-2 text-sm">
                <div>
                  <p className="font-medium">{d.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {d.last_seen_at ? `last seen ${new Date(d.last_seen_at).toLocaleString()}` : "never connected"}
                  </p>
                </div>
                <Button size="sm" variant="ghost" onClick={() => revoke(d.id)}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}