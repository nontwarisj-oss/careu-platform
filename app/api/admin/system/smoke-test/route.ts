// GET /api/admin/system/smoke-test — production readiness checklist.
//
// Phase 21. Returns a list of named checks each with a status:
//   ok       — green
//   warn     — yellow (works but not ideal)
//   missing  — red (env var / config absent)
//   error    — red (a probe threw)
//
// The page at /admin/system/smoke-test renders this verbatim so the
// operator can ship to a new branch / new VM and verify everything
// is wired without running scripts. NEVER call this from a cron —
// it's a UI-triggered diagnostic.
//
// Owner / hq_admin only. No mutations.

import { NextResponse } from "next/server";
import { requireRole } from "@/lib/supabaseAuth";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type CheckResult = {
  name: string;
  status: "ok" | "warn" | "missing" | "error";
  message: string;
  category: "config" | "db" | "workers" | "broadcast" | "security";
  detail?: Record<string, unknown>;
};

function ok(name: string, msg: string, cat: CheckResult["category"], detail?: Record<string, unknown>): CheckResult {
  return { name, status: "ok", message: msg, category: cat, detail };
}
function warn(name: string, msg: string, cat: CheckResult["category"], detail?: Record<string, unknown>): CheckResult {
  return { name, status: "warn", message: msg, category: cat, detail };
}
function missing(name: string, msg: string, cat: CheckResult["category"]): CheckResult {
  return { name, status: "missing", message: msg, category: cat };
}
function errorRes(name: string, msg: string, cat: CheckResult["category"]): CheckResult {
  return { name, status: "error", message: msg, category: cat };
}

function envSet(key: string): boolean {
  const v = process.env[key];
  return typeof v === "string" && v.trim().length > 0;
}

export async function GET() {
  const guarded = await requireRole(["owner", "hq_admin"]);
  if (guarded instanceof NextResponse) return guarded;

  const checks: CheckResult[] = [];

  // ----- Config: required envs -----
  checks.push(
    envSet("NEXT_PUBLIC_SUPABASE_URL")
      ? ok("supabase_url", "NEXT_PUBLIC_SUPABASE_URL set", "config")
      : missing("supabase_url", "NEXT_PUBLIC_SUPABASE_URL ยังไม่ตั้ง", "config")
  );
  checks.push(
    envSet("SUPABASE_SERVICE_ROLE_KEY")
      ? ok("service_role_key", "service-role key set", "config")
      : missing("service_role_key", "SUPABASE_SERVICE_ROLE_KEY ยังไม่ตั้ง — admin endpoints จะตอบ 503", "config")
  );
  checks.push(
    envSet("SESSION_SECRET")
      ? ok("session_secret", "SESSION_SECRET set", "config")
      : missing("session_secret", "SESSION_SECRET ยังไม่ตั้ง — auth จะใช้ insecure fallback", "config")
  );
  checks.push(
    envSet("CRON_SECRET")
      ? ok("cron_secret", "CRON_SECRET set", "config")
      : missing("cron_secret", "CRON_SECRET ยังไม่ตั้ง — cron routes ตอบ 503", "config")
  );
  checks.push(
    envSet("TRACKING_LINK_SECRET")
      ? ok("tracking_secret", "TRACKING_LINK_SECRET set", "config")
      : missing("tracking_secret", "TRACKING_LINK_SECRET ยังไม่ตั้ง — UTM + click tracking ไม่ทำงาน", "config")
  );

  // Provider env (warn rather than missing — the system runs without them).
  checks.push(
    envSet("RESEND_API_KEY") && envSet("RESEND_WEBHOOK_SECRET")
      ? ok("resend_provider", "Resend (email) configured", "config")
      : warn("resend_provider", "Resend ยังไม่ครบ — email channel จะข้าม", "config")
  );
  checks.push(
    envSet("TWILIO_ACCOUNT_SID") &&
      envSet("TWILIO_AUTH_TOKEN") &&
      (envSet("TWILIO_MESSAGING_SERVICE_SID") || envSet("TWILIO_FROM_NUMBER"))
      ? ok("twilio_provider", "Twilio (SMS) configured", "config")
      : warn("twilio_provider", "Twilio ยังไม่ครบ — SMS channel จะข้าม", "config")
  );
  checks.push(
    envSet("LINE_CHANNEL_ACCESS_TOKEN") || envSet("LINE_CHANNEL_SECRET")
      ? ok("line_provider", "LINE channel partially/fully configured", "config")
      : warn("line_provider", "LINE channel ยังไม่ตั้ง — LINE messaging จะ no-op", "config")
  );

  const admin = getSupabaseAdmin();

  // ----- DB connectivity -----
  if (admin) {
    try {
      const r = await admin.from("branches").select("id", { head: true, count: "exact" });
      if (r.error) {
        checks.push(errorRes("db_connect", `branches read failed: ${r.error.message}`, "db"));
      } else {
        checks.push(ok("db_connect", `branches reachable (${r.count ?? 0} rows)`, "db"));
      }
    } catch (err) {
      checks.push(errorRes("db_connect", err instanceof Error ? err.message : String(err), "db"));
    }

    // Phase 21 tables.
    for (const tbl of [
      "worker_locks",
      "cron_failure_streaks",
      "engagement_guardrails",
      "campaign_funnel_metrics",
      "broadcast_send_jobs",
      "broadcast_send_targets",
      "branch_trigger_overrides",
    ]) {
      try {
        const r = await admin.from(tbl).select("*", { head: true, count: "exact" });
        if (r.error) {
          checks.push(errorRes(`table:${tbl}`, r.error.message, "db"));
        } else {
          checks.push(ok(`table:${tbl}`, `${r.count ?? 0} rows`, "db"));
        }
      } catch (err) {
        checks.push(errorRes(`table:${tbl}`, err instanceof Error ? err.message : String(err), "db"));
      }
    }

    // ----- Worker health -----
    try {
      const r = await admin
        .from("cron_failure_streaks")
        .select("cron_name, current_streak")
        .gt("current_streak", 0);
      const rows = (r.data ?? []) as Array<{ cron_name: string; current_streak: number }>;
      if (rows.length === 0) {
        checks.push(ok("cron_failure_streaks", "no crons currently failing", "workers"));
      } else {
        const worst = rows.reduce((a, b) =>
          a.current_streak > b.current_streak ? a : b
        );
        checks.push(
          worst.current_streak >= 3
            ? errorRes(
                "cron_failure_streaks",
                `${rows.length} cron(s) failing — worst: ${worst.cron_name} × ${worst.current_streak}`,
                "workers"
              )
            : warn(
                "cron_failure_streaks",
                `${rows.length} cron(s) failing — worst: ${worst.cron_name} × ${worst.current_streak}`,
                "workers"
              )
        );
      }
    } catch (err) {
      checks.push(errorRes("cron_failure_streaks", err instanceof Error ? err.message : String(err), "workers"));
    }

    // Stale worker_locks → indicates a crashed tick.
    try {
      const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      const r = await admin
        .from("worker_locks")
        .select("lock_name, expires_at", { count: "exact" })
        .lt("expires_at", cutoff);
      const cnt = r.count ?? 0;
      checks.push(
        cnt === 0
          ? ok("worker_locks_stale", "no stale locks", "workers")
          : warn(
              "worker_locks_stale",
              `${cnt} stale lock(s) — opportunistically cleared on next acquire`,
              "workers"
            )
      );
    } catch (err) {
      checks.push(errorRes("worker_locks_stale", err instanceof Error ? err.message : String(err), "workers"));
    }

    // ----- Broadcast pipeline -----
    try {
      const stuckCutoff = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
      const r = await admin
        .from("broadcast_send_jobs")
        .select("id", { count: "exact", head: true })
        .in("status", ["processing"])
        .lt("started_at", stuckCutoff);
      const cnt = r.count ?? 0;
      checks.push(
        cnt === 0
          ? ok("broadcast_stuck_jobs", "no stuck broadcast jobs (>6h)", "broadcast")
          : errorRes(
              "broadcast_stuck_jobs",
              `${cnt} broadcast job(s) stuck in 'processing' for >6h — check workers tab`,
              "broadcast"
            )
      );
    } catch (err) {
      checks.push(errorRes("broadcast_stuck_jobs", err instanceof Error ? err.message : String(err), "broadcast"));
    }

    // Recent broadcast send activity (last 7d).
    try {
      const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const r = await admin
        .from("broadcast_send_jobs")
        .select("id", { count: "exact", head: true })
        .gte("created_at", since);
      const cnt = r.count ?? 0;
      checks.push(
        ok("broadcast_recent_jobs", `${cnt} broadcast job(s) created in last 7d`, "broadcast", {
          count: cnt,
        })
      );
    } catch {
      // best-effort, not a blocker
    }

    // ----- Security: emergency stop state -----
    try {
      const r = await admin
        .from("engagement_guardrails")
        .select("value")
        .eq("key", "global_emergency_stop")
        .is("branch_id", null)
        .maybeSingle();
      const value = (r.data as { value: unknown } | null)?.value;
      const stopped = value === true;
      checks.push(
        stopped
          ? warn(
              "emergency_stop",
              "ALL sends are HALTED — owner has the global stop active",
              "security"
            )
          : ok("emergency_stop", "global emergency stop is off — sends allowed", "security")
      );
    } catch (err) {
      checks.push(errorRes("emergency_stop", err instanceof Error ? err.message : String(err), "security"));
    }
  } else {
    checks.push(
      missing(
        "db_admin",
        "service-role client could not be constructed — most DB checks skipped",
        "db"
      )
    );
  }

  // ----- Summary -----
  const summary = {
    total: checks.length,
    ok: checks.filter((c) => c.status === "ok").length,
    warn: checks.filter((c) => c.status === "warn").length,
    missing: checks.filter((c) => c.status === "missing").length,
    error: checks.filter((c) => c.status === "error").length,
  };
  const overall: "healthy" | "degraded" | "critical" =
    summary.error > 0 || summary.missing > 0
      ? "critical"
      : summary.warn > 0
        ? "degraded"
        : "healthy";

  return NextResponse.json({
    ok: true,
    generatedAt: new Date().toISOString(),
    overall,
    summary,
    checks,
  });
}
