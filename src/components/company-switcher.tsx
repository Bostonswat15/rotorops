import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Check, ChevronsUpDown, Helicopter, KeyRound, Plus } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { desktop } from "@/lib/desktop";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

type MyCompany = {
  id: string;
  name: string;
  role: string;
  cash: number;
  reputation: number;
  is_active: boolean;
};

/**
 * The sidebar header: the company you're looking at, every other one you
 * belong to, and the way to start or join another.
 *
 * Switching changes what the whole app shows and -- because the sim bridge
 * follows the active company server-side (bridge_device) -- which company your
 * flights are logged against.
 */
export function CompanySwitcher({
  current,
  onNew,
}: {
  current: { id: string; name: string };
  onNew: (mode: "found" | "join") => void;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data: companies } = useQuery({
    queryKey: ["my_companies"],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("my_companies");
      if (error) throw error;
      return (data ?? []) as MyCompany[];
    },
  });

  // The server refuses a switch while a contract is dispatched. A positioning
  // flight has no contract, but its aircraft belongs to this company and won't
  // log against another, so ask first.
  async function okToLeave() {
    const app = desktop();
    if (!app) return true;
    let flying = false;
    try {
      flying = !!(await app.status())?.flight;
    } catch {
      // No status yet: nothing is being tracked.
    }
    return (
      !flying ||
      window.confirm(
        `A flight is being tracked for ${current.name} right now. It won't be logged once you switch. Switch anyway?`,
      )
    );
  }

  async function switchTo(c: MyCompany) {
    if (c.id === current.id || !(await okToLeave())) return;
    const { error } = await supabase.rpc("set_active_company", { _company_id: c.id });
    if (error) {
      toast.error(error.message);
      return;
    }
    // Everything cached belongs to the company you just left.
    await qc.resetQueries();
    navigate({ to: "/dashboard" });
    toast.success(`Now running ${c.name}.`);
  }

  async function startNew(mode: "found" | "join") {
    if (await okToLeave()) onNew(mode);
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex w-full items-center gap-2 border-b border-sidebar-border px-5 py-4 text-left transition-colors hover:bg-sidebar-accent/50 focus:outline-none">
        <Helicopter className="h-5 w-5 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">RotorOps</p>
          <p className="truncate text-xs text-muted-foreground">{current.name}</p>
        </div>
        <ChevronsUpDown className="h-4 w-4 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>Your companies</DropdownMenuLabel>
        {(companies ?? []).map((c) => (
          <DropdownMenuItem key={c.id} onSelect={() => void switchTo(c)} className="gap-2">
            <Check className={`h-4 w-4 shrink-0 ${c.id === current.id ? "text-primary" : "invisible"}`} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm">{c.name}</p>
              <p className="text-xs text-muted-foreground">
                <span className="capitalize">{c.role}</span> · ${Number(c.cash).toLocaleString()}
              </p>
            </div>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void startNew("found")} className="gap-2">
          <Plus className="h-4 w-4" /> Start a new company
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void startNew("join")} className="gap-2">
          <KeyRound className="h-4 w-4" /> Join with a code
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
