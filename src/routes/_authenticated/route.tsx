import { createFileRoute, Outlet, redirect, Link, useNavigate, useRouterState } from "@tanstack/react-router";
import type { LinkProps } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { fetchCurrentCompany } from "@/lib/company";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Helicopter, LayoutDashboard, Navigation, Plane, Briefcase, BookOpen, Wrench, DollarSign, Settings, LogOut, Menu, Users, ShoppingCart, Factory, Award, Warehouse } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CompanySetup } from "@/components/company-setup";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async () => {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) throw redirect({ to: "/auth" });
    return { user: data.user };
  },
  component: AuthedLayout,
});

// `to` is optional on LinkProps, but every entry here has one -- and pathname
// matching below needs it to be a string.
const NAV: { to: NonNullable<LinkProps["to"]>; icon: any; label: string }[] = [
  { to: "/dashboard", icon: LayoutDashboard, label: "Dashboard" },
  { to: "/flight", icon: Navigation, label: "In Flight" },
  { to: "/aircraft", icon: Plane, label: "Aircraft" },
  { to: "/market", icon: ShoppingCart, label: "Market" },
  { to: "/missions", icon: Briefcase, label: "Missions" },
  { to: "/industries", icon: Factory, label: "Trading Hall" },
  { to: "/flight-logs", icon: BookOpen, label: "Flight Logs" },
  { to: "/skills", icon: Award, label: "Pilot Skills" },
  { to: "/maintenance", icon: Wrench, label: "Maintenance" },
  { to: "/bases", icon: Warehouse, label: "Bases" },
  { to: "/finance", icon: DollarSign, label: "Finance" },
  { to: "/crew", icon: Users, label: "Crew" },
  { to: "/settings", icon: Settings, label: "Settings" },
];

function AuthedLayout() {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [open, setOpen] = useState(false);

  const { data: company, isLoading, refetch } = useQuery({
    queryKey: ["company"],
    queryFn: async () => {
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) return null;
      return await fetchCurrentCompany();
    },
  });

  async function signOut() {
    await supabase.auth.signOut();
    navigate({ to: "/auth", replace: true });
  }

  if (isLoading) {
    return <div className="flex min-h-screen items-center justify-center text-muted-foreground">Loading…</div>;
  }

  if (!company) {
    return <CompanySetup onCreated={() => refetch()} />;
  }

  return (
    <div className="flex min-h-screen bg-background">
      {/* Sidebar */}
      <aside
        className={`${open ? "translate-x-0" : "-translate-x-full"} fixed inset-y-0 left-0 z-40 flex w-64 transform flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-transform md:relative md:translate-x-0`}
      >
        <div className="flex items-center gap-2 border-b border-sidebar-border px-5 py-4">
          <Helicopter className="h-5 w-5 text-primary" />
          <div>
            <p className="text-sm font-semibold">RotorOps</p>
            <p className="text-xs text-muted-foreground">{company.name}</p>
          </div>
        </div>
        <nav className="flex-1 space-y-0.5 p-3">
          {NAV.map((item) => {
            const active = pathname.startsWith(item.to);
            return (
              <Link
                key={item.to}
                to={item.to}
                onClick={() => setOpen(false)}
                className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors ${
                  active
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
                }`}
              >
                <item.icon className="h-4 w-4" />
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="border-t border-sidebar-border p-3">
          <div className="mb-3 rounded-md bg-sidebar-accent/40 px-3 py-2">
            <p className="text-xs text-muted-foreground">Cash on hand</p>
            <p className="font-mono text-sm font-semibold text-success">
              ${Number(company.cash).toLocaleString()}
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={signOut} className="w-full justify-start">
            <LogOut className="mr-2 h-4 w-4" /> Sign out
          </Button>
        </div>
      </aside>

      {/* Main */}
      <div className="flex flex-1 flex-col md:pl-0">
        <header className="flex items-center justify-between border-b border-border px-4 py-3 md:hidden">
          <button onClick={() => setOpen(!open)} className="rounded-md p-2 hover:bg-accent">
            <Menu className="h-5 w-5" />
          </button>
          <span className="text-sm font-semibold">RotorOps</span>
          <div className="w-9" />
        </header>
        <main className="flex-1 overflow-auto">
          <Outlet />
        </main>
      </div>
      {open && <div onClick={() => setOpen(false)} className="fixed inset-0 z-30 bg-black/50 md:hidden" />}
    </div>
  );
}