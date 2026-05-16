import { NextResponse } from "next/server";

import { loadSocialAccountsBlob } from "@/lib/oauth/server-store";
import { socialBlobToPublicStatus } from "@/lib/oauth/public-status";

export async function GET() {
  const blob = await loadSocialAccountsBlob();
  return NextResponse.json(socialBlobToPublicStatus(blob));
}
