import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { readSocialBlob, SOCIAL_COOKIE } from "@/lib/oauth/cookies";
import { socialBlobToPublicStatus } from "@/lib/oauth/public-status";

export async function GET() {
  const jar = await cookies();
  const blob = readSocialBlob(jar.get(SOCIAL_COOKIE)?.value);
  return NextResponse.json(socialBlobToPublicStatus(blob));
}
