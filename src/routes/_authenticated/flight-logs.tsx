import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Plus } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/flight-logs")({
  head: () => ({ meta: [{ title: "Flight Logs — RotorOps" }] }),
  component: LogsPage,
});

function LogsPage() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const { data: logs } = useQuery({
    queryKey: ["logs"],
    queryFn: async () => (await supabase.from("flight_logs").select("*, aircraft(display_name)").order("flown_at", { ascending: false })).data ?? [],
  });
  const { data: aircraft } = useQuery({
    queryKey: ["aircraft"],
    queryFn: async () => (await supabase.from("aircraft").select("*")).data ?? [],
  });

  return (
    <div className="space-y-6 p-6 md:p-8">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs uppercase tracking-widest text-muted-foreground">Logbook</p>
          <h1 className="mt-1 text-3xl font-semibold">Flight Logs</h1>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild><Button><Plus className="mr-2 h-4 w-4" /> Manual entry</Button></DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>Log flight</DialogTitle></DialogHeader>
            <LogForm aircraft={aircraft ?? []} onSaved={() => { setOpen(false); qc.invalidateQueries(); }} />
          </DialogContent>
        </Dialog>
      </div>

      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <table className="w-full text-sm">
          <thead className="border-b border-border bg-secondary/40 text-left text-xs uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="px-4 py-2">When</th><th className="px-4 py-2">Aircraft</th><th className="px-4 py-2">Route</th>
              <th className="px-4 py-2">Duration</th><th className="px-4 py-2">Fuel</th><th className="px-4 py-2">Landing</th><th className="px-4 py-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {logs?.length === 0 && <tr><td colSpan={7} className="p-8 text-center text-muted-foreground">No flights logged yet.</td></tr>}
            {logs?.map((l: any) => (
              <tr key={l.id} className="border-b border-border last:border-0">
                <td className="px-4 py-2 text-xs text-muted-foreground">{new Date(l.flown_at).toLocaleString()}</td>
                <td className="px-4 py-2">{l.aircraft?.display_name ?? "—"}</td>
                <td className="px-4 py-2 font-mono text-xs">{l.departure} → {l.arrival}</td>
                <td className="px-4 py-2 font-mono">{Number(l.duration_hr).toFixed(1)}h</td>
                <td className="px-4 py-2 font-mono">{Math.round(l.fuel_used)}lb</td>
                <td className="px-4 py-2 capitalize">{l.landing_quality}</td>
                <td className={`px-4 py-2 text-xs ${l.success ? "text-success" : "text-destructive"}`}>{l.success ? "completed" : "incident"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function LogForm({ aircraft, onSaved }: { aircraft: any[]; onSaved: () => void }) {
  const [f, setF] = useState({ aircraft_id: aircraft[0]?.id ?? "", departure: "", arrival: "", duration_hr: 1, fuel_used: 0, payload: 0, landing_quality: "normal", weather_difficulty: 1, success: true, incidents: "" });
  const [loading, setLoading] = useState(false);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    // Goes through the same resolver the sim bridge uses, so hours, wear and
    // fuel cost are computed one way regardless of how the flight was recorded.
    const { error } = await supabase.rpc("log_positioning_flight", {
      _aircraft_id: f.aircraft_id,
      _telemetry: {
        departure: f.departure || null,
        arrival: f.arrival || null,
        duration_hr: f.duration_hr,
        fuel_used: f.fuel_used || null,
        payload: f.payload,
        landing_quality: f.landing_quality,
        weather_factor: f.weather_difficulty,
        incidents: f.incidents ? [f.incidents] : [],
      } as any,
    });
    setLoading(false);
    if (error) return toast.error(error.message);
    toast.success("Flight logged.");
    onSaved();
  }
  return (
    <form onSubmit={save} className="space-y-4">
      <div>
        <Label>Aircraft</Label>
        <Select value={f.aircraft_id} onValueChange={(v) => setF({ ...f, aircraft_id: v })}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>{aircraft.map((a) => <SelectItem key={a.id} value={a.id}>{a.display_name}</SelectItem>)}</SelectContent>
        </Select>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div><Label>Departure</Label><Input value={f.departure} onChange={(e) => setF({ ...f, departure: e.target.value })} /></div>
        <div><Label>Arrival</Label><Input value={f.arrival} onChange={(e) => setF({ ...f, arrival: e.target.value })} /></div>
        <div><Label>Duration (h)</Label><Input type="number" step="0.1" value={f.duration_hr} onChange={(e) => setF({ ...f, duration_hr: Number(e.target.value) })} /></div>
        <div><Label>Fuel used (lb)</Label><Input type="number" value={f.fuel_used} onChange={(e) => setF({ ...f, fuel_used: Number(e.target.value) })} /></div>
        <div><Label>Payload (lb)</Label><Input type="number" value={f.payload} onChange={(e) => setF({ ...f, payload: Number(e.target.value) })} /></div>
        <div><Label>Weather (1-5)</Label><Input type="number" min={1} max={5} value={f.weather_difficulty} onChange={(e) => setF({ ...f, weather_difficulty: Number(e.target.value) })} /></div>
        <div>
          <Label>Landing</Label>
          <Select value={f.landing_quality} onValueChange={(v) => setF({ ...f, landing_quality: v })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="excellent">Excellent</SelectItem>
              <SelectItem value="normal">Normal</SelectItem>
              <SelectItem value="hard">Hard</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <label className="flex items-end gap-2"><Switch checked={f.success} onCheckedChange={(v) => setF({ ...f, success: v })} /> Successful</label>
      </div>
      <div><Label>Incidents / notes</Label><Textarea value={f.incidents} onChange={(e) => setF({ ...f, incidents: e.target.value })} /></div>
      <Button type="submit" className="w-full" disabled={loading || !f.aircraft_id}>Log flight</Button>
    </form>
  );
}