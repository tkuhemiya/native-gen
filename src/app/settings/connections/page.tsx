import { loadSocialAccountsBlob } from "@/lib/oauth/server-store";
import { socialBlobToPublicStatus } from "@/lib/oauth/public-status";

import { ConnectionsPanel } from "../connections-panel";

export default async function ConnectionsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; connected?: string }>;
}) {
  const sp = await searchParams;
  const blob = await loadSocialAccountsBlob();
  const initial = socialBlobToPublicStatus(blob);

  const error = sp.error ?? "";
  const connected = sp.connected ?? "";

  return (
    <div className="min-h-full flex-col">
      <ConnectionsPanel
        key={`${connected}-${error}`}
        initial={initial}
        urlError={error || undefined}
        urlConnected={connected || undefined}
      />
    </div>
  );
}
