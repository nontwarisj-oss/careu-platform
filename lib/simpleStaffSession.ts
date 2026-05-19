// Simple client-side staff session — localStorage only.
//
// A small-shop operations system, not a high-security enterprise app: after
// the server verifies employee_code + password (POST /api/auth/staff/login),
// the browser keeps a lightweight session here. No SESSION_SECRET, no signed
// cookie. No password or password hash is ever stored — only identity + role.
//
// Client-only (touches window.localStorage). The server cannot read
// localStorage, so protected API routes validate the claimed staffId via the
// x-careu-staff-id header against staff_accounts (see lib/staffActor.ts).

export type SimpleStaffSession = {
  staffId: string;
  employeeCode: string;
  name: string;
  /** Canonical app role: owner / hq_admin / branch_manager / front_staff / technician. */
  role: string;
  branchId: string | null;
  loggedInAt: string; // ISO timestamp
};

export const SIMPLE_STAFF_SESSION_KEY = "careu_staff_session";

/** Read + validate the staff session from localStorage. null when absent/corrupt. */
export function getSimpleStaffSession(): SimpleStaffSession | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(SIMPLE_STAFF_SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SimpleStaffSession>;
    if (
      typeof parsed.staffId !== "string" ||
      parsed.staffId.length === 0 ||
      typeof parsed.role !== "string" ||
      parsed.role.length === 0
    ) {
      return null;
    }
    return {
      staffId: parsed.staffId,
      employeeCode:
        typeof parsed.employeeCode === "string" ? parsed.employeeCode : "",
      name: typeof parsed.name === "string" ? parsed.name : "",
      role: parsed.role,
      branchId: typeof parsed.branchId === "string" ? parsed.branchId : null,
      loggedInAt:
        typeof parsed.loggedInAt === "string" ? parsed.loggedInAt : "",
    };
  } catch {
    return null;
  }
}

/** Persist the staff session to localStorage. */
export function setSimpleStaffSession(session: SimpleStaffSession): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      SIMPLE_STAFF_SESSION_KEY,
      JSON.stringify(session)
    );
  } catch {
    /* storage full / disabled — non-fatal */
  }
}

/** Remove the staff session from localStorage (logout). */
export function clearSimpleStaffSession(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(SIMPLE_STAFF_SESSION_KEY);
  } catch {
    /* ignore */
  }
}

export function isSimpleStaffLoggedIn(): boolean {
  return getSimpleStaffSession() !== null;
}

export function getSimpleStaffRole(): string | null {
  return getSimpleStaffSession()?.role ?? null;
}

/**
 * Headers that carry the current staff identity to protected API routes.
 * The server validates the id against staff_accounts — claimed-identity only,
 * adequate for an internal back office, not a hardened trust boundary.
 */
export function getSimpleStaffAuthHeaders(): Record<string, string> {
  const session = getSimpleStaffSession();
  return session ? { "x-careu-staff-id": session.staffId } : {};
}
