import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { Helicopter } from "lucide-react";

export const Route = createFileRoute("/reset-password")({
  head: () => ({ meta: [{ title: "Set a new password — RotorOps Manager" }] }),
  component: ResetPasswordPage,
});

type Phase = "checking" | "ready" | "done" | "invalid";

/**
 * Where a password recovery link lands.
 *
 * The app serves itself on a fixed loopback port, so the recovery email can
 * point straight back here rather than at some separately hosted page. That
 * costs nothing to run and keeps the whole flow inside code that can actually
 * reach Supabase -- but it does mean the link only works on the machine
 * running RotorOps, with the app open. Opened on a phone it will not connect,
 * which is the honest trade for not hosting anything.
 */
function ResetPasswordPage() {
  const navigate = useNavigate();
  const [phase, setPhase] = useState<Phase>("checking");
  const [email, setEmail] = useState<string | null>(null);
  const [pw1, setPw1] = useState("");
  const [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;

    // supabase-js parses the recovery token out of the URL as it initialises
    // and fires PASSWORD_RECOVERY once it has a real session for that account.
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (!live) return;
      if (event === "PASSWORD_RECOVERY" && session?.user) {
        setEmail(session.user.email ?? null);
        setPhase("ready");
      }
    });

    // The event can land before this component mounts, so a session that is
    // already present counts just as much as one that arrives later.
    supabase.auth.getSession().then(({ data }) => {
      if (!live) return;
      if (data.session?.user) {
        setEmail(data.session.user.email ?? null);
        setPhase((p) => (p === "checking" ? "ready" : p));
      }
    });

    // Nothing arrived: the link was already used, has expired, or this page
    // was opened directly rather than from an email.
    const timer = setTimeout(() => {
      if (live) setPhase((p) => (p === "checking" ? "invalid" : p));
    }, 5000);

    return () => {
      live = false;
      clearTimeout(timer);
      sub.subscription.unsubscribe();
      clearTimeout(timer);
    };
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (pw1.length < 6) return toast.error("Password must be at least 6 characters.");
    if (pw1 !== pw2) return toast.error("Those two passwords don't match.");

    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password: pw1 });
    setBusy(false);
    if (error) return toast.error(error.message);

    setPhase("done");
    toast.success("Password updated.");
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-md">
        <div className="mb-8 flex items-center gap-2 text-lg font-semibold">
          <Helicopter className="h-5 w-5 text-primary" /> RotorOps Manager
        </div>
        <div className="rounded-xl border border-border bg-card p-6">
          {phase === "checking" && (
            <>
              <h1 className="text-lg font-semibold">Checking your link</h1>
              <p className="mt-2 text-sm text-muted-foreground">
                Confirming this is a genuine recovery request.
              </p>
            </>
          )}

          {phase === "ready" && (
            <>
              <h1 className="text-lg font-semibold">Set a new password</h1>
              <p className="mt-2 text-sm text-muted-foreground">
                This replaces the password on{" "}
                <span className="font-mono text-foreground">{email ?? "your account"}</span>.
              </p>
              <form onSubmit={submit} className="mt-5 space-y-4">
                <div>
                  <Label>New password</Label>
                  <Input
                    type="password" minLength={6} required autoFocus
                    value={pw1} onChange={(e) => setPw1(e.target.value)}
                  />
                </div>
                <div>
                  <Label>Confirm password</Label>
                  <Input
                    type="password" minLength={6} required
                    value={pw2} onChange={(e) => setPw2(e.target.value)}
                  />
                </div>
                <Button type="submit" className="w-full" disabled={busy}>
                  {busy ? "Setting password…" : "Set new password"}
                </Button>
              </form>
            </>
          )}

          {phase === "done" && (
            <>
              <h1 className="text-lg font-semibold text-success">Password updated</h1>
              <p className="mt-2 text-sm text-muted-foreground">
                Sign in with your new password.
              </p>
              <Button
                className="mt-5 w-full"
                onClick={() => navigate({ to: "/auth", replace: true })}
              >
                Go to sign in
              </Button>
            </>
          )}

          {phase === "invalid" && (
            <>
              <h1 className="text-lg font-semibold text-destructive">
                Link expired or already used
              </h1>
              <p className="mt-2 text-sm text-muted-foreground">
                Recovery links work once and expire after an hour. Request a fresh one from the
                sign-in screen and open it straight away — or ask your company owner to set a new
                password for you from the Supabase dashboard.
              </p>
              <Button
                variant="secondary" className="mt-5 w-full"
                onClick={() => navigate({ to: "/auth", replace: true })}
              >
                Back to sign in
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
