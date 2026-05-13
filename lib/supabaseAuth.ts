// Centralised server-side auth helpers. Every route handler that needs
// "who is calling?" or "are they allowed to touch branch X?" should go
// through these — never re-implement the cookie read / profile lookup /
// role check inline.
//
// All four helpers are server-only (they call cookies() and read
// SUPABASE_SERVICE_ROLE_KEY). Never import from a "use client" file.

import { NextResponse } from "next/server";
import {
  readSessionFromCookies,
  type SessionPayload,
} from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { normalizeRole, type Role } from "@/lib/roles";
import { canViewAllBranches } from "@/lib/permissions";

// ---------- Types ---------------------------------------------------------

export type CurrentUser = {
  uid: string;
  sub: string | null;
  role: Role;
  branchId: string | null;   // text slug as stored in the session cookie
  name: string;
};

export type CurrentProfile = {
  id: string;
  role: Role;
  /** branches.id (uuid) joined via profiles.branch_id. */
  branchId: string | null;
  /** branches.code (text slug) — what orders.branch_id stores. */
  branchCode: string | null;
  fullName: string;
  phone: string | null;
  active: boolean;
};

// ---------- Reads ---------------------------------------------------------

/**
 * Lightweight session decoder — does NOT hit the database. Use this when you
 * only need the role / branch / uid that's already in the cookie.
 */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  const session: SessionPayload | null = await readSessionFromCookies();
  if (!session) return null;
  return {
    uid: session.uid,
    sub: session.sub,
    role: normalizeRole(session.role),
    branchId: session.branchId,
    name: session.name,
  };
}

/**
 * Full profile lookup — hits the DB via the service-role client, so it works
 * even with RLS on profiles. Returns null when no session or when the user
 * row has been disabled (`is_active=false`).
 */
export async function getCurrentProfile(): Promise<CurrentProfile | null> {
  const user = await getCurrentUser();
  if (!user) return null;
  const admin = getSupabaseAdmin();
  if (!admin) {
    // No service role configured — fall back to whatever the cookie said.
    return {
      id: user.uid,
      role: user.role,
      branchId: null,
      branchCode: user.branchId,
      fullName: user.name,
      phone: null,
      active: true,
    };
  }
  const res = await admin
    .from("profiles")
    .select("id, full_name, phone, role, branch_id, is_active, branches:branch_id (code)")
    .eq("id", user.uid)
    .maybeSingle();
  if (res.error || !res.data) return null;
  // Supabase types embedded relations as an array — collapse to first row.
  const row = res.data as unknown as {
    id: string;
    full_name: string | null;
    phone: string | null;
    role: string | null;
    branch_id: string | null;
    is_active: boolean | null;
    branches: { code: string | null } | { code: string | null }[] | null;
  };
  if (row.is_active === false) return null;
  const branchRow = Array.isArray(row.branches)
    ? row.branches[0] ?? null
    : row.branches;
  return {
    id: row.id,
    role: normalizeRole(row.role ?? user.role),
    branchId: row.branch_id,
    branchCode: branchRow?.code ?? null,
    fullName: row.full_name ?? user.name,
    phone: row.phone,
    active: true,
  };
}

// ---------- Guards --------------------------------------------------------

type GuardResult<T> = { profile: T } | NextResponse;

/**
 * Require an authenticated user with a role in the allow-list. On failure
 * returns a NextResponse (401 / 403) that the caller can simply return.
 * Pattern:
 *
 *     const guarded = await requireRole(['owner', 'hq_admin']);
 *     if (guarded instanceof NextResponse) return guarded;
 *     const { profile } = guarded;
 *     // … do work …
 */
export async function requireRole(
  allowed: readonly Role[]
): Promise<GuardResult<CurrentProfile>> {
  const profile = await getCurrentProfile();
  if (!profile) {
    return NextResponse.json(
      { ok: false, reason: "Not authenticated" },
      { status: 401 }
    );
  }
  if (!allowed.includes(profile.role)) {
    return NextResponse.json(
      {
        ok: false,
        reason: `บทบาท "${profile.role}" ไม่มีสิทธิ์เข้าถึง endpoint นี้`,
        required: allowed,
      },
      { status: 403 }
    );
  }
  return { profile };
}

/**
 * Require the user to have access to the given branch (by `branches.code`).
 * Owner / HQ admin always pass. Branch-scoped roles must match the requested
 * branch exactly. Mirrors the RLS policies in 20260522.
 */
export async function requireBranchAccess(
  branchCode: string
): Promise<GuardResult<CurrentProfile>> {
  const profile = await getCurrentProfile();
  if (!profile) {
    return NextResponse.json(
      { ok: false, reason: "Not authenticated" },
      { status: 401 }
    );
  }
  if (canViewAllBranches(profile.role)) return { profile };
  if (profile.branchCode !== branchCode) {
    return NextResponse.json(
      {
        ok: false,
        reason: `บทบาท "${profile.role}" เข้าถึงข้อมูลสาขาอื่นไม่ได้`,
        requestedBranch: branchCode,
        userBranch: profile.branchCode,
      },
      { status: 403 }
    );
  }
  return { profile };
}
