import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

/** Auth/publish integrations removed — keep middleware noop for compatibility. */
export function middleware(_request: NextRequest) {
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
