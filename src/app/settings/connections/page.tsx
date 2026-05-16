import { cookies } from "next/headers";

import { readSocialBlob, SOCIAL_COOKIE } from "@/lib/oauth/cookies";
import { socialBlobToPublicStatus } from "@/lib/oauth/public-status";

import { ConnectionsPanel } from "../connections-panel";

export default async function ConnectionsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; connected?: string }>;
}) {
  const sp = await searchParams;
  const jar = await cookies();
  const initial = socialBlobToPublicStatus(readSocialBlob(jar.get(SOCIAL_COOKIE)?.value));

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
