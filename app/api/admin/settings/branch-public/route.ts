// GET  /api/admin/settings/branch-public — list branches + their
//        public-facing settings.
// POST /api/admin/settings/branch-public — update one branch's
//        public settings.
//
// Phase 27D. Owner / hq_admin only. Lets operators manage the
// franchise public layer (hours, promo, open/closed override,
// holidays, map + LINE links, hero image) without a code edit.
// Every change is audited to cron_heartbeat_logs (settings-edit).

import { NextResponse } from "next/server";
import { requireRole } from "@/lib/supabaseAuth";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { callerIp, rateLimit } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PUBLIC_COLUMNS =
  "code, name, short_label, is_active, operating_hours, promo_banner, manual_status, holiday_dates, map_url, line_url, hero_image_path";

const DAY_KEYS = new Set(["mon", "tue", "wed", "thu", "fri", "sat", "sun", "note"]);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET() {
  const guarded = await requireRole(["owner", "hq_admin"]);
  if (guarded instanceof NextResponse) return guarded;

  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json(
      { ok: false, reason: "SERVICE_ROLE_KEY ยังไม่ตั้งค่า" },
      { status: 503 }
    );
  }
  const res = await admin
    .from("branches")
    .select(PUBLIC_COLUMNS)
    .order("code", { ascending: true });
  if (res.error) {
    return NextResponse.json(
      { ok: false, reason: res.error.message },
      { status: 500 }
    );
  }
  return NextResponse.json({ ok: true, branches: res.data ?? [] });
}

type Body = {
  code?: string;
  operatingHours?: Record<string, string> | null;
  promoBanner?: string | null;
  manualStatus?: "open" | "closed" | "auto" | null;
  holidayDates?: string[] | null;
  mapUrl?: string | null;
  lineUrl?: string | null;
  heroImagePath?: string | null;
};

export async function POST(req: Request) {
  const ip = callerIp(req);
  const limit = rateLimit(ip, {
    namespace: "branch-public-write",
    limit: 40,
    windowMs: 10 * 60 * 1000,
  });
  if (!limit.ok) {
    return NextResponse.json(
      { ok: false, reason: limit.reason ?? "ลองมากเกินไป" },
      { status: 429 }
    );
  }
  const guarded = await requireRole(["owner", "hq_admin"]);
  if (guarded instanceof NextResponse) return guarded;
  const actorId = guarded.profile.id;

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json(
      { ok: false, reason: "Invalid JSON body" },
      { status: 400 }
    );
  }
  const code = (body.code ?? "").trim();
  if (!code) {
    return NextResponse.json(
      { ok: false, reason: "code required" },
      { status: 400 }
    );
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json(
      { ok: false, reason: "SERVICE_ROLE_KEY ยังไม่ตั้งค่า" },
      { status: 503 }
    );
  }

  // Confirm the branch exists.
  const exists = await admin
    .from("branches")
    .select("code")
    .eq("code", code)
    .maybeSingle();
  if (!exists.data) {
    return NextResponse.json(
      { ok: false, reason: "ไม่พบสาขา" },
      { status: 404 }
    );
  }

  const patch: Record<string, unknown> = {};

  if (body.operatingHours !== undefined) {
    if (body.operatingHours === null) {
      patch.operating_hours = null;
    } else if (typeof body.operatingHours === "object") {
      // Keep only known keys; trim values; cap length.
      const clean: Record<string, string> = {};
      for (const [k, v] of Object.entries(body.operatingHours)) {
        if (DAY_KEYS.has(k) && typeof v === "string" && v.trim()) {
          clean[k] = v.trim().slice(0, 80);
        }
      }
      patch.operating_hours = Object.keys(clean).length > 0 ? clean : null;
    }
  }
  if (body.promoBanner !== undefined) {
    patch.promo_banner = body.promoBanner?.trim().slice(0, 240) || null;
  }
  if (body.manualStatus !== undefined) {
    patch.manual_status =
      body.manualStatus === "open" || body.manualStatus === "closed"
        ? body.manualStatus
        : null; // 'auto' / null both clear the override
  }
  if (body.holidayDates !== undefined) {
    const dates = Array.isArray(body.holidayDates)
      ? Array.from(
          new Set(
            body.holidayDates
              .map((d) => String(d).trim())
              .filter((d) => ISO_DATE.test(d))
          )
        ).slice(0, 60)
      : [];
    patch.holiday_dates = dates;
  }
  if (body.mapUrl !== undefined) {
    patch.map_url = sanitiseUrl(body.mapUrl);
  }
  if (body.lineUrl !== undefined) {
    patch.line_url = sanitiseUrl(body.lineUrl);
  }
  if (body.heroImagePath !== undefined) {
    patch.hero_image_path = body.heroImagePath?.trim().slice(0, 300) || null;
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json(
      { ok: false, reason: "ไม่มีฟิลด์ให้บันทึก" },
      { status: 400 }
    );
  }

  const upd = await admin.from("branches").update(patch).eq("code", code);
  if (upd.error) {
    return NextResponse.json(
      { ok: false, reason: upd.error.message },
      { status: 500 }
    );
  }

  // Audit.
  try {
    const now = new Date().toISOString();
    await admin.from("cron_heartbeat_logs").insert({
      cron_name: "settings-edit",
      started_at: now,
      finished_at: now,
      duration_ms: 0,
      success: true,
      rows_processed: 1,
      details: {
        kind: "branch_public_settings",
        branchCode: code,
        fields: Object.keys(patch),
        actorId,
        ip: ip === "unknown" ? null : ip,
      },
    });
  } catch {
    // best-effort
  }

  return NextResponse.json({ ok: true });
}

/** Accept only http(s) URLs; reject anything else (no javascript: etc). */
function sanitiseUrl(raw: string | null | undefined): string | null {
  const v = (raw ?? "").trim();
  if (!v) return null;
  if (!/^https?:\/\//i.test(v)) return null;
  return v.slice(0, 400);
}
