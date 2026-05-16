import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { loadSocialAccountsFromRequest } from "@/lib/oauth/request-social";
import { socialBlobToPublicStatus } from "@/lib/oauth/public-status";

export async function GET(request: NextRequest) {
  const blob = loadSocialAccountsFromRequest(request);
  return NextResponse.json(socialBlobToPublicStatus(blob));
}
