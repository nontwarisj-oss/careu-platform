"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { usePathname, useRouter } from "next/navigation";
import { normalizeRole, type Role } from "@/lib/roles";
import { useRole } from "@/lib/roleContext";
import { useBranch } from "@/lib/branchContext";
import { setBridgeJwt } from "@/lib/supabase";
import {
  getSimpleStaffSession,
  clearSimpleStaffSession,
} from "@/lib/simpleStaffSession";

export type AuthUser = {
  uid: string;
  name: string;
  role: Role;
  branchId: string | null;
  pictureUrl: string | null;
};

export type AuthState = {
  authRequired: boolean;
  sessionConfigured: boolean;
  lineConfigured: boolean;
  /** True when SUPABASE_JWT_SECRET is set — the bridge can mint JWTs. */
  jwtBridgeConfigured: boolean;
  user: AuthUser | null;
  /** True until the first /me call lands. */
  isLoading: boolean;
  /** Convenience: true when authRequired AND user is non-null. */
  isAuthenticated: boolean;
  /** Convenience: true when authRequired is false (preview / dev mode). */
  isPreview: boolean;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthState | undefined>(undefined);

const PUBLIC_PATHS = new Set(["/login"]);

/**
 * Path prefixes that the public customer-facing website owns. Unlike
 * PUBLIC_PATHS these are matched by startsWith so the dynamic sub-routes
 * (e.g. `/branches/c24-thonburi-market`) all resolve correctly.
 *
 * Adding a prefix here exempts those routes from the strict-mode
 * `/login` redirect — they render for anonymous visitors. Server-side
 * data exposure is still gated by RLS / per-route authorization; this
 * list only controls the client-side redirect.
 */
const PUBLIC_PREFIXES = [
  "/website",
  "/branches",
  "/services",
  "/track",
  "/quote",
  "/about",
  "/contact",
  "/portal",
];

function isPublicPath(path: string | null): boolean {
  if (!path) return false;
  if (PUBLIC_PATHS.has(path)) return true;
  return PUBLIC_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`)
  );
}

type MeResponse = {
  authRequired: boolean;
  sessionConfigured: boolean;
  lineConfigured: boolean;
  jwtBridgeConfigured?: boolean;
  session: {
    uid: string;
    name: string;
    role: string;
    branchId: string | null;
    pictureUrl: string | null;
    supabaseAccessToken?: string | null;
    supabaseExpiresAt?: number | null;
    supabaseExpiresIn?: number | null;
  } | null;
};

/** Re-fetch /api/auth/me this many seconds before the JWT expires. */
const JWT_REFRESH_LEAD_SECONDS = 5 * 60;

export function AuthProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { setRole } = useRole();
  const { setBranchId } = useBranch();

  const [state, setState] = useState<{
    authRequired: boolean;
    sessionConfigured: boolean;
    lineConfigured: boolean;
    jwtBridgeConfigured: boolean;
    user: AuthUser | null;
    isLoading: boolean;
  }>({
    authRequired: false,
    sessionConfigured: false,
    lineConfigured: false,
    jwtBridgeConfigured: false,
    user: null,
    isLoading: true,
  });

  // Timer handle for the proactive JWT refresh — cleared on every refresh()
  // so we never stack multiple timers.
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    // Simple staff session (localStorage) — works with no SESSION_SECRET and
    // no signed cookie. It is the fallback identity when /api/auth/me returns
    // no server (cookie) session.
    const simple = getSimpleStaffSession();
    const simpleUser: AuthUser | null = simple
      ? {
          uid: simple.staffId,
          name: simple.name,
          role: normalizeRole(simple.role),
          branchId: simple.branchId,
          pictureUrl: null,
        }
      : null;
    try {
      const res = await fetch("/api/auth/me", { cache: "no-store" });
      if (!res.ok) throw new Error(`me ${res.status}`);
      const json = (await res.json()) as MeResponse;
      const cookieUser: AuthUser | null = json.session
        ? {
            uid: json.session.uid,
            name: json.session.name,
            role: normalizeRole(json.session.role),
            branchId: json.session.branchId,
            pictureUrl: json.session.pictureUrl,
          }
        : null;
      // A signed cookie session wins when present; otherwise the simple
      // localStorage staff session is the identity.
      const user = cookieUser ?? simpleUser;

      // Install the bridge JWT into the supabase singleton so RLS-enabled
      // tables (orders, customers post-20260522) see auth.uid().
      const accessToken = json.session?.supabaseAccessToken ?? null;
      setBridgeJwt(accessToken);

      setState({
        authRequired: json.authRequired,
        sessionConfigured: json.sessionConfigured,
        lineConfigured: json.lineConfigured,
        jwtBridgeConfigured: json.jwtBridgeConfigured ?? false,
        user,
        isLoading: false,
      });
      if (user) {
        setRole(user.role);
        if (user.branchId) setBranchId(user.branchId);
      }

      // Schedule a proactive refresh so the JWT never silently expires
      // while the user is mid-flow.
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
      const expiresIn = json.session?.supabaseExpiresIn ?? null;
      if (expiresIn && expiresIn > JWT_REFRESH_LEAD_SECONDS) {
        const delayMs = (expiresIn - JWT_REFRESH_LEAD_SECONDS) * 1000;
        refreshTimerRef.current = setTimeout(() => {
          void refresh();
        }, delayMs);
      }
    } catch {
      // /me unreachable — keep any localStorage staff session usable so the
      // platform still works while the API recovers.
      setBridgeJwt(null);
      setState((prev) => ({
        ...prev,
        user: simpleUser,
        authRequired: prev.authRequired || simpleUser !== null,
        isLoading: false,
      }));
      if (simpleUser) {
        setRole(simpleUser.role);
        if (simpleUser.branchId) setBranchId(simpleUser.branchId);
      }
    }
  }, [setRole, setBranchId]);

  useEffect(() => {
    void refresh();
    return () => {
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
  }, [refresh]);

  // Auth-required + no session → bounce to /login (except /login itself).
  useEffect(() => {
    if (state.isLoading) return;
    if (!state.authRequired) return;
    if (state.user) return;
    if (isPublicPath(pathname)) return;
    const after = pathname ?? "/";
    router.replace(`/login?after=${encodeURIComponent(after)}`);
  }, [state.authRequired, state.isLoading, state.user, pathname, router]);

  const signOut = useCallback(async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    clearSimpleStaffSession();
    setBridgeJwt(null);
    if (refreshTimerRef.current) {
      clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }
    setState((prev) => ({ ...prev, user: null }));
    if (typeof window !== "undefined") {
      window.localStorage.removeItem("careu.role");
    }
    router.replace("/login");
  }, [router]);

  const value = useMemo<AuthState>(
    () => ({
      authRequired: state.authRequired,
      sessionConfigured: state.sessionConfigured,
      lineConfigured: state.lineConfigured,
      jwtBridgeConfigured: state.jwtBridgeConfigured,
      user: state.user,
      isLoading: state.isLoading,
      isAuthenticated: state.authRequired && !!state.user,
      isPreview: !state.authRequired,
      refresh,
      signOut,
    }),
    [state, refresh, signOut]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return ctx;
}
