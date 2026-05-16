import { ConnectionsPanel } from "../connections-panel";

export default async function ConnectionsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; connected?: string }>;
}) {
  const sp = await searchParams;

  const error = sp.error ?? "";
  const connected = sp.connected ?? "";

  return (
    <div className="min-h-full flex-col">
      <ConnectionsPanel urlError={error || undefined} urlConnected={connected || undefined} />
    </div>
  );
}
