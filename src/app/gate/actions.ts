"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

export async function unlockGate(formData: FormData) {
  const expected = process.env.NATIVE_GEN_GATE_SECRET;
  if (!expected) redirect("/");

  const password = String(formData.get("password") ?? "");
  if (password !== expected) {
    redirect("/gate?error=1");
  }

  (await cookies()).set("ng_ok", "1", {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 14,
  });

  const next = String(formData.get("next") || "/");
  redirect(next.startsWith("/") ? next : "/");
}
