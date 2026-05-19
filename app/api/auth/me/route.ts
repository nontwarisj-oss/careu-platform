// Reports auth state to the client.
//
// Internal staff login is now localStorage-based (lib/simpleStaffSession.ts).
// The server cannot read localStorage, so this endpoint simply reports that
// simple staff-auth mode is active — it is NOT gated on SESSION_SECRET and
// never blocks the app. The client treats its localStorage session as the
// identity.
//
// A signed cookie session (LINE login, or staff login on a deployment where
// SESSION_SECRET happens to be set) is still resolved + returned when present,
// so that path keeps working untouched.

import { NextResponse } from "next/server";
import { readSessionFromCookies } from "@/lib/session";
import { isLineLoginConfigured } from "@/lib/lineLogin";
import supabase from "@/lib/supabase";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import {
  isSupabaseJwtConfigured,
  mintSupabaseJwt,
} from "@/lib/supabaseJwt";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type ResolvedAccount = {
  id: string;
  name: string;
  role: string;
  branchId: string | null;
  pictureUrl: string | null;
  active: boolean;
};

// Never cache — reflects live cookie state.
function json(body: unknown) {
  return NextResponse.json(body, {
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}

export async function GET() {
  const lineConfigured = isLineLoginConfigured();
  const jwtBridgeConfigured = isSupabaseJwtConfigured();

  // Internal staff login is localStorage-based — always available, never
  // blocked on SESSION_SECRET.
  const baseFlags = {
    authRequired: true,
    sessionConfigured: true,
    simpleStaffAuth: true,
    sessionMode: "localStorage" as const,
    lineConfigured,
    jwtBridgeConfigured,
  };

  // A signed cookie session is optional. Resolve + return it when one exists
  // (keeps LINE login working where SESSION_SECRET is configured); otherwise
  // session is null and the client uses its localStorage staff session.
  const session = await readSessionFromCookies();
  if (!session) {
    return json({ ...baseFlags, session: null });
  }

  const admin = getSupabaseAdmin();
  const dbClient = admin ?? supabase;

  let resolved: ResolvedAccount | null = null;

  // LINE-login / public.users account.
  const userRes = await dbClient
    .from("users")
    .select("id, display_name, role, branch_id, active, picture_url")
    .eq("id", session.uid)
    .maybeSingle();
  if (!userRes.error && userRes.data) {
    const u = userRes.data as {
      id: string;
      display_name: string | null;
      role: string | null;
      branch_id: string | null;
      active: boolean | null;
      picture_url: string | null;
    };
    resolved = {
      id: u.id,
      name: u.display_name ?? session.name,
      role: u.role ?? session.role,
      branchId: u.branch_id ?? session.branchId,
      pictureUrl: u.picture_url ?? null,
      active: u.active !== false,
    };
  }

  // Internal staff_accounts login (RLS-on / no-policy — service-role only).
  if (!resolved && admin) {
    const staffRes = await admin
      .from("staff_accounts")
      .select("id, full_name, role, branch_id, active")
      .eq("id", session.uid)
      .maybeSingle();
    if (!staffRes.error && staffRes.data) {
      const s = staffRes.data as {
        id: string;
        full_name: string | null;
        role: string | null;
        branch_id: string | null;
        active: boolean | null;
      };
      resolved = {
        id: s.id,
        name: s.full_name ?? session.name,
        role: s.role ?? session.role,
        branchId: s.branch_id ?? session.branchId,
        pictureUrl: null,
        active: s.active !== false,
      };
    }
  }

  if (!resolved) {
    return json({ ...baseFlags, session: null });
  }
  if (!resolved.active) {
    return json({ ...baseFlags, session: null, reason: "account_disabled" });
  }

  const minted = mintSupabaseJwt({ profileId: resolved.id, email: null });

  return json({
    ...baseFlags,
    session: {
      uid: resolved.id,
      name: resolved.name,
      role: resolved.role,
      branchId: resolved.branchId,
      pictureUrl: resolved.pictureUrl,
      supabaseAccessToken: minted?.token ?? null,
      supabaseExpiresAt: minted?.expiresAt ?? null,
      supabaseExpiresIn: minted?.expiresIn ?? null,
    },
  });
}
