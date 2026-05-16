import { redirect } from "next/navigation";
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
    <div className="flex min-h-full flex-col items-center justify-center gap-6 px-6">
      <div className="w-full max-w-sm space-y-2 text-center">
        <h1 className="text-xl font-semibold tracking-tight">Unlock demo</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
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
          className="rounded-md border border-black/10 bg-white px-3 py-2 text-sm text-black shadow-sm dark:border-white/15 dark:bg-zinc-950 dark:text-zinc-50"
          required
        />
        {sp.error ? (
          <p className="text-center text-sm text-red-600 dark:text-red-400">
            Incorrect passphrase.
          </p>
        ) : null}
        <button
          type="submit"
          className="rounded-md bg-black px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-black dark:hover:bg-white"
        >
          Continue
        </button>
      </form>
    </div>
  );
}
