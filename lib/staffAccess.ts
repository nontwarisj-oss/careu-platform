// Role-based route access for the simple staff session.
//
// The staff member's role (read from staff_accounts at login, carried in the
// localStorage simple session) is the single source of permission. These are
// pure helpers over (role, pathname) — safe to import anywhere.
//
// canAccessRoute uses a RESTRICTED-PREFIX model: a route not listed below is
// open to any signed-in staff. The prefixes + allow-lists deliberately mirror
// the per-page PageKey matrix in lib/roles.ts, so the global guard and the
// per-page RouteGuard never disagree. Longest matching prefix wins, so the
// /admin/* exceptions override the broad /admin rule.

import type { Role } from "@/lib/roles";

/** Pure membership check — true when `role` is in `allowed`. */
export function requireRole(
  role: Role | null | undefined,
  allowed: readonly Role[]
): boolean {
  return role != null && allowed.includes(role);
}

type RouteRule = { prefix: string; allow: readonly Role[] };

// Owner is omitted from every allow-list — canAccessRoute short-circuits owner
// to "allowed everywhere" before the rules are consulted.
const ROUTE_RULES: readonly RouteRule[] = [
  // --- /admin subtree: specific exceptions first, broad rule last ---------
  // Customer detail is open to front desk (RouteGuard page="customers").
  { prefix: "/admin/customers", allow: ["hq_admin", "branch_manager", "front_staff"] },
  // Recovery / health views are management-tier (RouteGuard page="recovery").
  { prefix: "/admin/recovery", allow: ["hq_admin", "branch_manager"] },
  { prefix: "/admin/system/branch-health", allow: ["hq_admin", "branch_manager"] },
  { prefix: "/admin/system/delivery-trace", allow: ["hq_admin", "branch_manager"] },
  { prefix: "/admin/system/webhook-retries", allow: ["hq_admin", "branch_manager"] },
  // Everything else under /admin (incl. pricing-master, staff-accounts) is
  // owner / hq_admin only.
  { prefix: "/admin", allow: ["hq_admin"] },
  // --- management areas --------------------------------------------------
  { prefix: "/pricing", allow: ["hq_admin", "branch_manager"] },
  { prefix: "/production", allow: ["hq_admin"] },
  { prefix: "/reports", allow: ["hq_admin", "branch_manager"] },
  { prefix: "/invoices", allow: ["hq_admin", "branch_manager"] },
  { prefix: "/expenses", allow: ["hq_admin", "branch_manager"] },
];

function matchRule(pathname: string): RouteRule | null {
  let best: RouteRule | null = null;
  for (const rule of ROUTE_RULES) {
    const hit =
      pathname === rule.prefix || pathname.startsWith(`${rule.prefix}/`);
    if (hit && (!best || rule.prefix.length > best.prefix.length)) {
      best = rule;
    }
  }
  return best;
}

/**
 * True when `role` may open `pathname`.
 *  - signed out (null role)          → denied
 *  - owner                           → allowed everywhere
 *  - route not in ROUTE_RULES        → allowed for any signed-in staff
 *  - otherwise                       → role must be in the matched allow-list
 */
export function canAccessRoute(
  pathname: string,
  role: Role | null | undefined
): boolean {
  if (!role) return false;
  if (role === "owner") return true;
  const rule = matchRule(pathname);
  if (!rule) return true;
  return requireRole(role, rule.allow);
}
