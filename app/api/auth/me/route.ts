// Reports current auth state to the client. The frontend's AuthProvider
// hits this on mount to decide preview-mode vs strict-mode and to hydrate
// role / branch from the cookie.

import { NextResponse } from "next/server";
import {
  isSessionConfigured,
  readSessionFromCookies,
} from "@/lib/session";
import { isLineLoginConfigured } from "@/lib/lineLogin";
import supabase from "@/lib/supabase";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const sessionConfigured = isSessionConfigured();
  const lineConfigured = isLineLoginConfigured();
  // Strict mode kicks in once the operator has done both: set SESSION_SECRET
  // and wired LINE Login. Until then the platform behaves as before (preview
  // mode, role/branch from localStorage).
  const authRequired = sessionConfigured && lineConfigured;

  const session = await readSessionFromCookies();
  if (!session) {
    return NextResponse.json({
      authRequired,
      sessionConfigured,
      lineConfigured,
      session: null,
    });
  }

  // Refresh allowed-branches list from the users row so disabling a user
  // takes effect on their next /me call without waiting for cookie expiry.
  // Uses the service-role client when available so RLS on profiles (next
  // phase) cannot lock us out of our own session lookup.
  const dbClient = getSupabaseAdmin() ?? supabase;
  const userRes = await dbClient
    .from("users")
    .select("id, display_name, role, branch_id, active, picture_url")
    .eq("id", session.uid)
    .maybeSingle();

  if (userRes.error || !userRes.data) {
    return NextResponse.json({
      authRequired,
      sessionConfigured,
      lineConfigured,
      session: null,
    });
  }

  const user = userRes.data as {
    id: string;
    display_name: string;
    role: string | null;
    branch_id: string | null;
    active: boolean;
    picture_url: string | null;
  };

  if (!user.active) {
    return NextResponse.json({
      authRequired,
      sessionConfigured,
      lineConfigured,
      session: null,
      reason: "account_disabled",
    });
  }

  return NextResponse.json({
    authRequired,
    sessionConfigured,
    lineConfigured,
    session: {
      uid: user.id,
      name: user.display_name,
      role: user.role ?? session.role,
      branchId: user.branch_id ?? session.branchId,
      pictureUrl: user.picture_url ?? null,
    },
  });
}
