// Reports current auth state to the client. The frontend's AuthProvider
// hits this on mount to decide preview-mode vs strict-mode and to hydrate
// role / branch from the cookie.
//
// The session uid is resolved against EITHER identity store:
//   • public.users          — LINE login
//   • public.staff_accounts  — internal employee_code / password login
// whichever the signed cookie's uid belongs to.
//
// Includes safe (no secret value) diagnostics so a SESSION_SECRET
// misconfiguration is debuggable straight from this endpoint.

import { NextResponse } from "next/server";
import {
  isSessionConfigured,
  readSessionFromCookies,
  resolveSessionSecret,
  SESSION_SECRET_ENV_NAMES,
  MIN_SESSION_SECRET_LENGTH,
} from "@/lib/session";
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

// Never cache — this response reflects live env + cookie state, and a stale
// browser-cached copy is a classic false "still not configured" red herring.
function json(body: unknown) {
  return NextResponse.json(body, {
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}

export async function GET() {
  // --- SESSION_SECRET runtime detection + safe diagnostics ----------------
  // resolveSessionSecret() reads process.env at call time (SESSION_SECRET,
  // then the STAFF_/INTERNAL_ aliases). Diagnostics expose only the env var
  // NAMES and booleans — never the secret value itself.
  const rawSecret = resolveSessionSecret();
  const sessionSecretPresent = rawSecret !== null;
  const sessionSecretLengthOk =
    (rawSecret?.length ?? 0) >= MIN_SESSION_SECRET_LENGTH;
  const sessionConfigured = isSessionConfigured();

  const lineConfigured = isLineLoginConfigured();
  const jwtBridgeConfigured = isSupabaseJwtConfigured();
  // Strict mode is driven by the internal staff login: once SESSION_SECRET is
  // set, employee_code / password sign-in is available, so auth is required.
  const authRequired = sessionConfigured;

  const baseFlags = {
    authRequired,
    sessionConfigured,
    lineConfigured,
    jwtBridgeConfigured,
    envChecked: [...SESSION_SECRET_ENV_NAMES],
    sessionSecretPresent,
    sessionSecretLengthOk,
  };

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

  // Internal staff_accounts login. The table is RLS-on / no-policy, so only
  // the service-role client can read it.
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
    return json({
      ...baseFlags,
      session: null,
      reason: "account_disabled",
    });
  }

  // Mint a short-lived PostgREST-compatible JWT so the browser supabase
  // client can satisfy RLS. When SUPABASE_JWT_SECRET is unset this is null
  // and queries run as anon — the correct (locked) behaviour for RLS tables.
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
