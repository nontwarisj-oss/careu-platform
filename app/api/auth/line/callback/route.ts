// LINE OAuth callback. Verifies the state cookie set by /start, exchanges
// the authorization code for an access token, fetches the LINE profile,
// upserts public.users keyed by line_user_id, signs a session cookie, then
// redirects the browser to the app root.
//
// Failure modes are kept verbose so misconfig is debuggable from the UI
// (we 302 to /login with ?error= so the operator sees the reason).

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import supabase from "@/lib/supabase";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import {
  encodeSession,
  isSessionConfigured,
  setSessionCookie,
} from "@/lib/session";
import {
  exchangeCodeForToken,
  fetchLineProfile,
  isLineLoginConfigured,
} from "@/lib/lineLogin";
import { defaultBranch } from "@/lib/brandConfig";
import { DEFAULT_ROLE, normalizeRole, type Role } from "@/lib/roles";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const STATE_COOKIE = "careu_line_state";

type UserRow = {
  id: string;
  display_name: string;
  role: string | null;
  branch_id: string | null;
  active: boolean;
};

function loginFailure(reason: string, url: URL): NextResponse {
  const target = new URL("/login", url);
  target.searchParams.set("error", reason);
  return NextResponse.redirect(target);
}

export async function GET(req: Request) {
  const url = new URL(req.url);

  if (!isLineLoginConfigured()) {
    return loginFailure("line_not_configured", url);
  }
  if (!isSessionConfigured()) {
    return loginFailure("session_secret_missing", url);
  }

  const code = url.searchParams.get("code");
  const stateParam = url.searchParams.get("state");
  const lineError = url.searchParams.get("error");
  if (lineError) return loginFailure(`line_${lineError}`, url);
  if (!code || !stateParam) return loginFailure("missing_code_or_state", url);

  const cookieStore = await cookies();
  const stateCookie = cookieStore.get(STATE_COOKIE)?.value ?? null;
  cookieStore.set({ name: STATE_COOKIE, value: "", maxAge: 0, path: "/" });
  if (!stateCookie || stateCookie !== stateParam) {
    return loginFailure("state_mismatch", url);
  }

  let profile: { userId: string; displayName: string; pictureUrl?: string };
  try {
    const token = await exchangeCodeForToken(code);
    profile = await fetchLineProfile(token.access_token);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[auth/line/callback] token/profile error", message);
    return loginFailure("oauth_exchange_failed", url);
  }

  // Upsert by line_user_id. First user ever to log in is bootstrapped as
  // owner so the shop owner can run setup without a manual SQL step;
  // subsequent signups land as front_staff and a manager promotes them.
  //
  // RLS is enabled on public.profiles — use the service-role admin client
  // when available so the upsert is not denied. Falls back to the anon
  // client (which writes only public.users) when the service role is not
  // yet configured.
  const adminClient = getSupabaseAdmin();
  const dbClient = adminClient ?? supabase;

  const existingRes = await dbClient
    .from("users")
    .select("id, display_name, role, branch_id, active")
    .eq("line_user_id", profile.userId)
    .maybeSingle();

  if (existingRes.error) {
    console.error("[auth/line/callback] users lookup failed", existingRes.error.message);
    return loginFailure("users_table_unreachable", url);
  }

  let user: UserRow | null = existingRes.data as UserRow | null;

  if (!user) {
    const countRes = await dbClient
      .from("users")
      .select("id", { count: "exact", head: true });
    const userCount = countRes.count ?? 0;
    const bootstrapRole: Role = userCount === 0 ? "owner" : "front_staff";
    const insertRes = await dbClient
      .from("users")
      .insert({
        line_user_id: profile.userId,
        display_name: profile.displayName,
        picture_url: profile.pictureUrl ?? null,
        role: bootstrapRole,
        branch_id: defaultBranch.id,
        active: true,
        last_login_at: new Date().toISOString(),
      })
      .select("id, display_name, role, branch_id, active")
      .maybeSingle();
    if (insertRes.error || !insertRes.data) {
      console.error(
        "[auth/line/callback] insert failed",
        insertRes.error?.message
      );
      return loginFailure("users_insert_failed", url);
    }
    user = insertRes.data as UserRow;
  } else {
    if (!user.active) return loginFailure("account_disabled", url);
    await dbClient
      .from("users")
      .update({
        display_name: profile.displayName,
        picture_url: profile.pictureUrl ?? null,
        last_login_at: new Date().toISOString(),
      })
      .eq("id", user.id);
  }

  // Mirror into public.profiles (RLS-protected). branch_id is a uuid in
  // profiles, so resolve via branches.code; if the migration hasn't run yet,
  // skip silently and let the LINE flow keep working off public.users.
  if (adminClient) {
    const branchRes = await adminClient
      .from("branches")
      .select("id")
      .eq("code", user.branch_id ?? defaultBranch.id)
      .maybeSingle();
    const branchUuid = (branchRes.data as { id?: string } | null)?.id ?? null;

    const profileUpsert = await adminClient
      .from("profiles")
      .upsert(
        {
          id: user.id,
          full_name: user.display_name || profile.displayName,
          phone: null,
          line_user_id: profile.userId,
          role: normalizeRole(user.role ?? DEFAULT_ROLE),
          branch_id: branchUuid,
          picture_url: profile.pictureUrl ?? null,
          last_login_at: new Date().toISOString(),
          is_active: user.active ?? true,
        },
        { onConflict: "id" }
      );
    if (
      profileUpsert.error &&
      !/relation .* does not exist|schema cache/i.test(profileUpsert.error.message)
    ) {
      console.warn(
        "[auth/line/callback] profiles upsert failed",
        profileUpsert.error.message
      );
    }
  }

  const role = normalizeRole(user.role ?? DEFAULT_ROLE);
  const encoded = encodeSession({
    uid: user.id,
    sub: profile.userId,
    role,
    branchId: user.branch_id ?? defaultBranch.id,
    name: user.display_name || profile.displayName,
  });
  if (!encoded) return loginFailure("session_encode_failed", url);
  await setSessionCookie(encoded);

  const after = url.searchParams.get("after") ?? "/";
  return NextResponse.redirect(new URL(after, url));
}
