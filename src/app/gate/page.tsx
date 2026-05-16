import { redirect } from "next/navigation";
import { ThemeToggle } from "@/components/theme-toggle";
import { unlockGate } from "./actions";

export default async function GatePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  const sp = await searchParams;
  if (!process.env.NATIVE_GEN_GATE_SECRET) {
    redirect("/");
  }

  return (
    <div className="relative flex min-h-full flex-col items-center justify-center gap-6 px-6">
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>
      <div className="w-full max-w-sm space-y-2 text-center">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          Unlock demo
        </h1>
        <p className="text-sm text-muted-foreground">
          This deploy is gated. Enter the shared passphrase to continue.
        </p>
      </div>
      <form action={unlockGate} className="flex w-full max-w-sm flex-col gap-3">
        <input type="hidden" name="next" value={sp.next ?? "/"} />
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          placeholder="Passphrase"
          className="rounded-md border border-border bg-card px-3 py-2 text-sm text-card-foreground shadow-sm"
          required
        />
        {sp.error ? (
          <p className="text-center text-sm text-destructive">
            Incorrect passphrase.
          </p>
        ) : null}
        <button
          type="submit"
          className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          Continue
        </button>
      </form>
    </div>
  );
}
