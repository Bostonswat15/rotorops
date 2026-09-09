import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";
import { Helicopter } from "lucide-react";

// Supabase must never be handed a loopback address to put in an email link.
// The desktop app serves itself from 127.0.0.1 on a private port, so
// window.location.origin there is the *sender's own machine* -- dead on
// every other device, dead on a phone even for the person who asked.
function reachableOrigin(): string | null {
  const origin = window.location.origin;
  const ok =
    /^https?:\/\//.test(origin) &&
    !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|$)/.test(origin);
  return ok ? origin : null;
}

// Where a password-recovery email actually sends people: a small hosted page
// that completes the reset, since the app itself runs on that same dead
// loopback origin and can't be the destination of an emailed link.
const PASSWORD_RESET_URL = "https://claude.ai/code/artifact/b98d0dd3-7445-4864-9006-f56de222f3d7";

export const Route = createFileRoute("/auth")({
  head: () => ({ meta: [{ title: "Sign in — RotorOps Manager" }] }),
  component: AuthPage,
});

function AuthPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) navigate({ to: "/dashboard", replace: true });
    });
  }, [navigate]);

  const [resetting, setResetting] = useState(false);

  async function signIn(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (error) return toast.error(error.message);
    navigate({ to: "/dashboard", replace: true });
  }

  // The link always sends people to a small hosted page rather than back
  // into the app -- the desktop app runs on 127.0.0.1, which is dead the
  // moment the email is opened anywhere but this exact machine right now.
  async function forgotPassword() {
    if (!email) return toast.error("Enter your email above first, then click this again.");
    setResetting(true);
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: PASSWORD_RESET_URL,
    });
    setResetting(false);
    if (error) return toast.error(error.message);
    toast.success("If that email has an account, a reset link is on its way.", { duration: 8000 });
  }

  async function signUp(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    const origin = reachableOrigin();
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        ...(origin ? { emailRedirectTo: origin } : {}),
        data: { display_name: displayName || email.split("@")[0] },
      },
    });
    setLoading(false);
    if (error) return toast.error(error.message);

    // A session only comes back when the project has email confirmation off.
    // Claiming "you're signed in" and pushing to the dashboard when it is on
    // just bounces the new user straight back here with no explanation.
    if (!data.session) {
      return toast.info(
        "Account created. Confirm your email address, then sign in — " +
          "or ask whoever runs the company to confirm it for you.",
        { duration: 12000 },
      );
    }
    toast.success("Account created. You're signed in.");
    navigate({ to: "/dashboard", replace: true });
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-md">
        <div className="mb-8 flex items-center gap-2 text-lg font-semibold">
          <Helicopter className="h-5 w-5 text-primary" /> RotorOps Manager
        </div>
        <div className="rounded-xl border border-border bg-card p-6">
          <Tabs defaultValue="signin">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="signin">Sign in</TabsTrigger>
              <TabsTrigger value="signup">Create account</TabsTrigger>
            </TabsList>
            <TabsContent value="signin">
              <form onSubmit={signIn} className="mt-4 space-y-4">
                <div>
                  <Label>Email</Label>
                  <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
                </div>
                <div>
                  <div className="flex items-center justify-between">
                    <Label>Password</Label>
                    <button
                      type="button"
                      onClick={forgotPassword}
                      disabled={resetting}
                      className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground disabled:opacity-50"
                    >
                      {resetting ? "Sending…" : "Forgot password?"}
                    </button>
                  </div>
                  <Input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} />
                </div>
                <Button type="submit" className="w-full" disabled={loading}>
                  {loading ? "Signing in…" : "Sign in"}
                </Button>
              </form>
            </TabsContent>
            <TabsContent value="signup">
              <form onSubmit={signUp} className="mt-4 space-y-4">
                <div>
                  <Label>Operator name</Label>
                  <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Chief Pilot" />
                </div>
                <div>
                  <Label>Email</Label>
                  <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
                </div>
                <div>
                  <Label>Password</Label>
                  <Input type="password" required minLength={6} value={password} onChange={(e) => setPassword(e.target.value)} />
                </div>
                <Button type="submit" className="w-full" disabled={loading}>
                  {loading ? "Creating…" : "Create account"}
                </Button>
              </form>
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </div>
  );
}