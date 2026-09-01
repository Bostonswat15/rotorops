import { createFileRoute } from "@tanstack/react-router";
import { Link } from "@tanstack/react-router";
import { Helicopter, Wrench, Briefcase, Activity } from "lucide-react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "RotorOps Manager — Helicopter Career Sim" },
      { name: "description", content: "Run a helicopter operation in Microsoft Flight Simulator. Fleet, missions, maintenance, finance — all rotor-first." },
    ],
  }),
  component: Index,
});

function Index() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-2 font-semibold tracking-tight">
            <Helicopter className="h-5 w-5 text-primary" />
            <span>RotorOps Manager</span>
          </div>
          <Link
            to="/auth"
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            Sign in
          </Link>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-20">
        <p className="text-xs uppercase tracking-[0.3em] text-muted-foreground">Rotary-wing operations</p>
        <h1 className="mt-4 text-5xl font-semibold tracking-tight md:text-6xl">
          A serious helicopter career manager
          <span className="block text-primary">for MSFS pilots.</span>
        </h1>
        <p className="mt-6 max-w-2xl text-lg text-muted-foreground">
          Dispatch utility lifts, offshore crew changes, medevac, SAR, and heavy-lift jobs. Maintain a real fleet
          — stock or modded helicopters — and grow from a one-ship operator to a specialized rotorcraft company.
        </p>
        <div className="mt-8 flex gap-3">
          <Link to="/auth" className="rounded-md bg-primary px-5 py-3 font-medium text-primary-foreground hover:opacity-90">
            Start your operation
          </Link>
        </div>

        <div className="mt-20 grid gap-4 md:grid-cols-4">
          {[
            { icon: Helicopter, t: "Aircraft Registry", d: "Stock + modded helicopter records with role tags and validated stats." },
            { icon: Briefcase, t: "Mission Dispatch", d: "Role-based jobs from tower lifts to SAR hoist extractions." },
            { icon: Wrench, t: "Maintenance", d: "Wear tracking, inspections, return-to-service workflow." },
            { icon: Activity, t: "Finance", d: "Cash, leases, fuel, insurance, payouts — playable but realistic." },
          ].map((f) => (
            <div key={f.t} className="rounded-lg border border-border bg-card p-5">
              <f.icon className="h-5 w-5 text-primary" />
              <p className="mt-3 font-medium">{f.t}</p>
              <p className="mt-1 text-sm text-muted-foreground">{f.d}</p>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
