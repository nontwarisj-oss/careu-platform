"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { usePathname, useRouter } from "next/navigation";
import { normalizeRole, type Role } from "@/lib/roles";
import { useRole } from "@/lib/roleContext";
import { useBranch } from "@/lib/branchContext";

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

type MeResponse = {
  authRequired: boolean;
  sessionConfigured: boolean;
  lineConfigured: boolean;
  session: {
    uid: string;
    name: string;
    role: string;
    branchId: string | null;
    pictureUrl: string | null;
  } | null;
};

export function AuthProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { setRole } = useRole();
  const { setBranchId } = useBranch();

  const [state, setState] = useState<{
    authRequired: boolean;
    sessionConfigured: boolean;
    lineConfigured: boolean;
    user: AuthUser | null;
    isLoading: boolean;
  }>({
    authRequired: false,
    sessionConfigured: false,
    lineConfigured: false,
    user: null,
    isLoading: true,
  });

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/me", { cache: "no-store" });
      if (!res.ok) throw new Error(`me ${res.status}`);
      const json = (await res.json()) as MeResponse;
      const user: AuthUser | null = json.session
        ? {
            uid: json.session.uid,
            name: json.session.name,
            role: normalizeRole(json.session.role),
            branchId: json.session.branchId,
            pictureUrl: json.session.pictureUrl,
          }
        : null;
      setState({
        authRequired: json.authRequired,
        sessionConfigured: json.sessionConfigured,
        lineConfigured: json.lineConfigured,
        user,
        isLoading: false,
      });
      if (user) {
        setRole(user.role);
        if (user.branchId) setBranchId(user.branchId);
      }
    } catch {
      // /me unreachable — stay in preview mode silently. AuthContext default
      // values keep the platform usable while the API recovers.
      setState((prev) => ({ ...prev, isLoading: false }));
    }
  }, [setRole, setBranchId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Auth-required + no session → bounce to /login (except /login itself).
  useEffect(() => {
    if (state.isLoading) return;
    if (!state.authRequired) return;
    if (state.user) return;
    if (pathname && PUBLIC_PATHS.has(pathname)) return;
    const after = pathname ?? "/";
    router.replace(`/login?after=${encodeURIComponent(after)}`);
  }, [state.authRequired, state.isLoading, state.user, pathname, router]);

  const signOut = useCallback(async () => {
    await fetch("/api/auth/logout", { method: "POST" });
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
