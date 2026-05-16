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
import { checkManifestDrift } from "@/lib/manifestDriftCheck";
import { webhookMetrics } from "@/lib/webhookAudit";
import { SERVICE_CONTENT } from "@/lib/serviceContent";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type CheckResult = {
  name: string;
  status: "ok" | "warn" | "missing" | "error";
  message: string;
  category: "config" | "db" | "workers" | "broadcast" | "security" | "public";
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
  // Phase 22: link auto-wrap needs a public base URL to build
  // tracking redirects. Without it, broadcast URLs send un-tracked.
  checks.push(
    envSet("NEXT_PUBLIC_BASE_URL")
      ? ok("base_url", "NEXT_PUBLIC_BASE_URL set — broadcast links auto-wrap", "config")
      : warn(
          "base_url",
          "NEXT_PUBLIC_BASE_URL ยังไม่ตั้ง — broadcast URLs จะส่งแบบไม่ track",
          "config"
        )
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

    // Phase 20–22 tables.
    for (const tbl of [
      "worker_locks",
      "cron_failure_streaks",
      "alert_events",
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
              `${cnt} stale lock(s) — worker-maintenance cron sweeps these every 15min`,
              "workers"
            )
      );
    } catch (err) {
      checks.push(errorRes("worker_locks_stale", err instanceof Error ? err.message : String(err), "workers"));
    }

    // Phase 22: worker-maintenance cron heartbeat — the janitor +
    // alert sweep. Stale heartbeat means stale locks + un-evaluated
    // alert rules.
    try {
      const r = await admin
        .from("cron_heartbeat_logs")
        .select("started_at")
        .eq("cron_name", "worker-maintenance")
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      const last = (r.data as { started_at: string } | null)?.started_at;
      if (!last) {
        checks.push(
          warn(
            "worker_maintenance_cron",
            "worker-maintenance has never run — schedule /api/cron/worker-maintenance every ~15min",
            "workers"
          )
        );
      } else {
        const ageMin = Math.round(
          (Date.now() - new Date(last).getTime()) / 60000
        );
        checks.push(
          ageMin <= 45
            ? ok("worker_maintenance_cron", `last ran ${ageMin}m ago`, "workers")
            : errorRes(
                "worker_maintenance_cron",
                `worker-maintenance silent for ${ageMin}m — locks + alerts not being swept`,
                "workers"
              )
        );
      }
    } catch (err) {
      checks.push(errorRes("worker_maintenance_cron", err instanceof Error ? err.message : String(err), "workers"));
    }

    // Phase 22: alert rule health — at least one enabled rule means
    // breaches get caught.
    try {
      const r = await admin
        .from("communication_alert_rules")
        .select("id", { count: "exact", head: true })
        .eq("enabled", true);
      const cnt = r.count ?? 0;
      checks.push(
        cnt > 0
          ? ok("alert_rules", `${cnt} enabled alert rule(s)`, "workers")
          : warn(
              "alert_rules",
              "no enabled alert rules — worker breaches will not raise alerts",
              "workers"
            )
      );
    } catch (err) {
      checks.push(errorRes("alert_rules", err instanceof Error ? err.message : String(err), "workers"));
    }

    // Phase 22: active (unresolved) alert events.
    try {
      const r = await admin
        .from("alert_events")
        .select("severity", { count: "exact" })
        .in("status", ["active", "acknowledged"]);
      const rows = (r.data ?? []) as Array<{ severity: string }>;
      const cnt = r.count ?? rows.length;
      const critical = rows.filter((x) => x.severity === "critical").length;
      checks.push(
        cnt === 0
          ? ok("active_alerts", "no open alert events", "workers")
          : critical > 0
            ? errorRes(
                "active_alerts",
                `${cnt} open alert(s), ${critical} critical — see workers dashboard`,
                "workers"
              )
            : warn("active_alerts", `${cnt} open alert(s)`, "workers")
      );
    } catch (err) {
      checks.push(errorRes("active_alerts", err instanceof Error ? err.message : String(err), "workers"));
    }

    // Phase 25: cron manifest drift — manifest vs vercel.json vs
    // heartbeat history must agree.
    try {
      const drift = await checkManifestDrift();
      if (drift.ok) {
        checks.push(
          ok(
            "cron_manifest_drift",
            `manifest (${drift.manifestCount}) + vercel.json (${drift.vercelCount}) in sync`,
            "workers"
          )
        );
      } else {
        const worst = drift.findings.some(
          (f) => f.kind === "missing" || f.kind === "orphan"
        );
        const msg = drift.findings
          .slice(0, 4)
          .map((f) => `${f.kind}:${f.cronName}`)
          .join(" · ");
        checks.push(
          worst
            ? errorRes("cron_manifest_drift", msg, "workers")
            : warn("cron_manifest_drift", msg, "workers")
        );
      }
    } catch (err) {
      checks.push(errorRes("cron_manifest_drift", err instanceof Error ? err.message : String(err), "workers"));
    }

    // Phase 25: webhook trust — invalid signatures / malformed bodies
    // in the last 24h.
    try {
      const wm = await webhookMetrics(24);
      const bad = wm.invalidSignature + wm.malformed + wm.error;
      checks.push(
        bad === 0
          ? ok(
              "webhook_trust",
              `${wm.accepted} accepted · ${wm.replay} replays caught · 0 bad`,
              "security"
            )
          : warn(
              "webhook_trust",
              `${bad} bad webhook call(s) — invalid-sig ${wm.invalidSignature}, malformed ${wm.malformed}, error ${wm.error}`,
              "security"
            )
      );
    } catch (err) {
      checks.push(errorRes("webhook_trust", err instanceof Error ? err.message : String(err), "security"));
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

    // Phase 22: send caps configured. Default caps apply even with no
    // rows, so this is informational — a row means the operator has
    // explicitly tuned a ceiling.
    try {
      const r = await admin
        .from("engagement_guardrails")
        .select("key")
        .in("key", [
          "max_sends_per_day_global",
          "max_sends_per_day_branch",
          "max_campaigns_per_week_branch",
          "dry_run_required",
        ]);
      const cnt = (r.data ?? []).length;
      checks.push(
        ok(
          "send_caps",
          cnt > 0
            ? `${cnt} explicit cap row(s) — defaults apply to the rest`
            : "using default caps (global 5000/day, branch 1000/day, 5 campaigns/week)",
          "security",
          { explicitRows: cnt }
        )
      );
    } catch (err) {
      checks.push(errorRes("send_caps", err instanceof Error ? err.message : String(err), "security"));
    }

    // ----- Phase 27D: public website -----
    // Branch pages — at least one active branch backs /branches/[code].
    try {
      const r = await admin
        .from("branches")
        .select("code", { count: "exact", head: true })
        .eq("is_active", true);
      const cnt = r.count ?? 0;
      checks.push(
        cnt > 0
          ? ok("public_branch_pages", `${cnt} active branch page(s)`, "public")
          : warn(
              "public_branch_pages",
              "no active branches — /branches is empty",
              "public"
            )
      );
    } catch (err) {
      checks.push(errorRes("public_branch_pages", err instanceof Error ? err.message : String(err), "public"));
    }

    // Branch public-settings coverage — how many have operating_hours.
    try {
      const r = await admin
        .from("branches")
        .select("operating_hours")
        .eq("is_active", true);
      const rows = (r.data ?? []) as Array<{
        operating_hours: unknown;
      }>;
      const withHours = rows.filter(
        (x) => x.operating_hours && typeof x.operating_hours === "object"
      ).length;
      checks.push(
        ok(
          "public_branch_hours",
          `${withHours}/${rows.length} branch(es) have operating hours set`,
          "public",
          { withHours, total: rows.length }
        )
      );
    } catch (err) {
      checks.push(errorRes("public_branch_hours", err instanceof Error ? err.message : String(err), "public"));
    }

    // Recent quote requests — proves the public quote pipeline works.
    try {
      const since = new Date(
        Date.now() - 30 * 24 * 60 * 60 * 1000
      ).toISOString();
      const r = await admin
        .from("quote_requests")
        .select("id", { count: "exact", head: true })
        .gte("created_at", since);
      checks.push(
        ok(
          "public_quote_pipeline",
          `${r.count ?? 0} quote request(s) in last 30d`,
          "public"
        )
      );
    } catch (err) {
      checks.push(errorRes("public_quote_pipeline", err instanceof Error ? err.message : String(err), "public"));
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

  // ----- Public website checks that need no DB -----
  checks.push(
    ok("public_service_pages", `${SERVICE_CONTENT.length} service SEO page(s)`, "public", {
      slugs: SERVICE_CONTENT.map((s) => s.slug),
    })
  );
  checks.push(
    envSet("NEXT_PUBLIC_SITE_URL")
      ? ok("public_sitemap", "NEXT_PUBLIC_SITE_URL set — sitemap absolute URLs OK", "public")
      : warn(
          "public_sitemap",
          "NEXT_PUBLIC_SITE_URL unset — sitemap falls back to a placeholder host",
          "public"
        )
  );
  checks.push(
    envSet("NEXT_PUBLIC_BASE_URL")
      ? ok("public_upload", "NEXT_PUBLIC_BASE_URL set — quote uploads + tracking links resolve", "public")
      : warn(
          "public_upload",
          "NEXT_PUBLIC_BASE_URL unset — quote upload URLs may not resolve",
          "public"
        )
  );
  checks.push(
    envSet("NEXT_PUBLIC_LINE_OA_URL")
      ? ok("public_line_cta", "NEXT_PUBLIC_LINE_OA_URL set — LINE CTAs link out", "public")
      : warn(
          "public_line_cta",
          "NEXT_PUBLIC_LINE_OA_URL unset — global LINE CTA falls back to /contact",
          "public"
        )
  );

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
