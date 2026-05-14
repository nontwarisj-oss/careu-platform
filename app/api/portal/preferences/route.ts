// GET / PATCH /api/portal/preferences — customer-facing notification
// preference center.
//
// GET   → returns the customer's current preferences (or defaults if
//         no row exists yet).
// PATCH → upserts the preferences row + writes a `prefs_changed` row
//         to customer_activity so the customer + admin can audit the
//         change.
//
// Every edit is audited because the spec treats preferences as
// "identity changes" — anti-spam compliance + audit trail is a
// requirement, not a nicety.

import { NextResponse } from "next/server";
import { readCustomerSessionFromCookies } from "@/lib/customerSession";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { callerIp, rateLimit } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Prefs = {
  sms_enabled: boolean;
  line_enabled: boolean;
  email_enabled: boolean;
  pickup_reminders: boolean;
  order_status_alerts: boolean;
  payment_alerts: boolean;
  promotional: boolean;
};

const DEFAULT_PREFS: Prefs = {
  sms_enabled: true,
  line_enabled: true,
  email_enabled: false,
  pickup_reminders: true,
  order_status_alerts: true,
  payment_alerts: true,
  promotional: false,
};

const FIELD_LABELS: Record<keyof Prefs, string> = {
  sms_enabled: "SMS",
  line_enabled: "LINE",
  email_enabled: "อีเมล",
  pickup_reminders: "เตือนมารับงาน",
  order_status_alerts: "อัปเดตสถานะงาน",
  payment_alerts: "การชำระเงิน",
  promotional: "โปรโมชั่น",
};

function sanitisePrefs(body: Partial<Prefs>): Prefs {
  return {
    sms_enabled: typeof body.sms_enabled === "boolean" ? body.sms_enabled : DEFAULT_PREFS.sms_enabled,
    line_enabled: typeof body.line_enabled === "boolean" ? body.line_enabled : DEFAULT_PREFS.line_enabled,
    email_enabled: typeof body.email_enabled === "boolean" ? body.email_enabled : DEFAULT_PREFS.email_enabled,
    pickup_reminders:
      typeof body.pickup_reminders === "boolean" ? body.pickup_reminders : DEFAULT_PREFS.pickup_reminders,
    order_status_alerts:
      typeof body.order_status_alerts === "boolean"
        ? body.order_status_alerts
        : DEFAULT_PREFS.order_status_alerts,
    payment_alerts:
      typeof body.payment_alerts === "boolean" ? body.payment_alerts : DEFAULT_PREFS.payment_alerts,
    promotional: typeof body.promotional === "boolean" ? body.promotional : DEFAULT_PREFS.promotional,
  };
}

function diffPrefs(before: Prefs | null, after: Prefs): Array<{
  field: keyof Prefs;
  label: string;
  from: boolean | null;
  to: boolean;
}> {
  const changes: Array<{
    field: keyof Prefs;
    label: string;
    from: boolean | null;
    to: boolean;
  }> = [];
  (Object.keys(after) as Array<keyof Prefs>).forEach((k) => {
    const beforeVal = before ? before[k] : null;
    if (beforeVal !== after[k]) {
      changes.push({ field: k, label: FIELD_LABELS[k], from: beforeVal, to: after[k] });
    }
  });
  return changes;
}

export async function GET() {
  const session = await readCustomerSessionFromCookies();
  if (!session) {
    return NextResponse.json(
      { ok: false, reason: "ยังไม่ได้เข้าสู่ระบบ" },
      { status: 401 }
    );
  }
  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json(
      { ok: false, reason: "SERVICE_ROLE_KEY ยังไม่ตั้งค่า" },
      { status: 503 }
    );
  }
  const res = await admin
    .from("customer_notification_preferences")
    .select(
      "sms_enabled, line_enabled, email_enabled, pickup_reminders, order_status_alerts, payment_alerts, promotional, last_updated_at"
    )
    .eq("customer_id", session.customerId)
    .maybeSingle();
  if (res.error) {
    return NextResponse.json(
      { ok: false, reason: res.error.message },
      { status: 500 }
    );
  }
  const prefs = (res.data as Prefs & { last_updated_at: string | null } | null) ?? null;
  return NextResponse.json({
    ok: true,
    prefs: prefs ?? { ...DEFAULT_PREFS, last_updated_at: null },
    defaultsApplied: !prefs,
  });
}

export async function PATCH(req: Request) {
  const ip = callerIp(req);
  const limit = rateLimit(ip, {
    namespace: "portal-prefs",
    limit: 20,
    windowMs: 10 * 60 * 1000,
  });
  if (!limit.ok) {
    return NextResponse.json(
      { ok: false, reason: limit.reason ?? "ลองมากเกินไป" },
      { status: 429 }
    );
  }

  const session = await readCustomerSessionFromCookies();
  if (!session) {
    return NextResponse.json(
      { ok: false, reason: "ยังไม่ได้เข้าสู่ระบบ" },
      { status: 401 }
    );
  }
  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json(
      { ok: false, reason: "SERVICE_ROLE_KEY ยังไม่ตั้งค่า" },
      { status: 503 }
    );
  }

  let body: Partial<Prefs>;
  try {
    body = (await req.json()) as Partial<Prefs>;
  } catch {
    return NextResponse.json(
      { ok: false, reason: "Invalid JSON body" },
      { status: 400 }
    );
  }
  const next = sanitisePrefs(body);

  // Read current to compute diff for audit.
  const currentRes = await admin
    .from("customer_notification_preferences")
    .select(
      "sms_enabled, line_enabled, email_enabled, pickup_reminders, order_status_alerts, payment_alerts, promotional"
    )
    .eq("customer_id", session.customerId)
    .maybeSingle();
  const current = (currentRes.data as Prefs | null) ?? null;

  const now = new Date().toISOString();
  const upsert = await admin
    .from("customer_notification_preferences")
    .upsert(
      {
        customer_id: session.customerId,
        ...next,
        last_updated_at: now,
        updated_at: now,
      },
      { onConflict: "customer_id" }
    );
  if (upsert.error) {
    return NextResponse.json(
      { ok: false, reason: upsert.error.message },
      { status: 500 }
    );
  }

  const changes = diffPrefs(current, next);

  // Audit only when something actually changed. Saving the same prefs
  // shouldn't accumulate noise.
  if (changes.length > 0) {
    try {
      await admin.from("customer_activity").insert({
        customer_id: session.customerId,
        kind: "prefs_changed",
        payload: {
          changes: changes.map((c) => ({
            field: c.field,
            label: c.label,
            from: c.from,
            to: c.to,
          })),
          ip: ip === "unknown" ? null : ip,
        },
      });
    } catch (err) {
      // Audit failures must never break the user's save.
      console.warn(
        "[portal-prefs] audit insert failed",
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  return NextResponse.json({
    ok: true,
    prefs: next,
    changesApplied: changes.length,
  });
}
