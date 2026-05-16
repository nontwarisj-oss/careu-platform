// POST /api/public/quote — public quote-request submission.
//
// Anyone can hit this endpoint. The body lands in public.quote_requests
// where admins triage. NO pricing is computed; the form is "tell us
// what you need" and the operator follows up out of band.
//
// Security:
//   • Rate limit — 5 submissions / hour / IP. Prevents bot floods.
//   • Phone normalisation — required, normalised before insert so
//     admin lookup is deterministic.
//   • Photos field is a JSONB array of strings (URLs). For foundation
//     we don't host uploads ourselves; the customer pastes image URLs
//     from a separate hoster or skips photos entirely. A future phase
//     plugs Supabase Storage in.
//   • Branch code is validated against active branches when present.
//
// We also write one row to customer_activity (anonymously — customer_id
// is NULL until an admin links the request) so the CRM activity log
// captures the inbound event from the start.

import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { callerIp, rateLimit } from "@/lib/rateLimit";
import { normalizePhone } from "@/lib/phone";
import { attributionFromUrl, type UtmParams } from "@/lib/utm";
import { incrementFunnel } from "@/lib/campaignFunnel";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Body = {
  name?: string;
  phone?: string;
  email?: string;
  contactMethod?: "phone" | "line" | "email" | "any";
  branchCode?: string | null;
  serviceCategory?: string | null;
  notes?: string;
  photos?: string[];
  /** Phase 27B quote wizard. */
  urgency?: "standard" | "urgent";
  fulfilmentPreference?: "in_store" | "pickup" | "delivery";
  /** Phase 20: UTM + signed nid passed from the campaign-landing URL.
   *  When the customer lands on /quote?utm_source=...&nid=... the
   *  client can either pass them verbatim or send the full
   *  `referrerUrl` and we parse server-side. */
  utm?: UtmParams;
  referrerUrl?: string;
};

const ALLOWED_CONTACT = new Set(["phone", "line", "email", "any"]);
const ALLOWED_URGENCY = new Set(["standard", "urgent"]);
const ALLOWED_FULFILMENT = new Set(["in_store", "pickup", "delivery"]);
const MAX_NOTES_LEN = 2000;
const MAX_PHOTOS = 10;
const MAX_NAME_LEN = 200;

export async function POST(req: Request) {
  const ip = callerIp(req);
  const limit = rateLimit(ip, {
    namespace: "public-quote",
    limit: 5,
    windowMs: 60 * 60 * 1000, // 5/hour
  });
  if (!limit.ok) {
    return NextResponse.json(
      {
        ok: false,
        reason: "ส่งคำขอบ่อยเกินไป — รออีกสักครู่แล้วลองใหม่",
      },
      { status: 429, headers: { "Retry-After": "3600" } }
    );
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json(
      { ok: false, reason: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const name = (body.name ?? "").trim().slice(0, MAX_NAME_LEN);
  const phone = normalizePhone(body.phone ?? "");
  const email = (body.email ?? "").trim().slice(0, 200);
  const notes = (body.notes ?? "").trim().slice(0, MAX_NOTES_LEN);
  const branchCode = (body.branchCode ?? "").trim() || null;
  const serviceCategory = (body.serviceCategory ?? "").trim() || null;
  const contactMethod =
    body.contactMethod && ALLOWED_CONTACT.has(body.contactMethod)
      ? body.contactMethod
      : "phone";
  const photos = Array.isArray(body.photos)
    ? body.photos
        .filter((u) => typeof u === "string" && u.length < 500)
        .slice(0, MAX_PHOTOS)
    : [];
  const urgency =
    body.urgency && ALLOWED_URGENCY.has(body.urgency) ? body.urgency : null;
  const fulfilmentPreference =
    body.fulfilmentPreference &&
    ALLOWED_FULFILMENT.has(body.fulfilmentPreference)
      ? body.fulfilmentPreference
      : null;

  if (!phone) {
    return NextResponse.json(
      { ok: false, reason: "ต้องระบุเบอร์โทร" },
      { status: 400 }
    );
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json(
      {
        ok: false,
        reason: "บริการขอใบเสนอราคาปิดชั่วคราว — กรุณาลองภายหลัง",
      },
      { status: 503 }
    );
  }

  // Validate branchCode against active branches when provided. Keeps
  // garbage out of the queue + the customer doesn't pick a closed shop.
  if (branchCode) {
    const branchRes = await admin
      .from("branches")
      .select("code, is_active")
      .eq("code", branchCode)
      .maybeSingle();
    const branchRow = branchRes.data as
      | { code: string; is_active: boolean }
      | null;
    if (!branchRow || branchRow.is_active === false) {
      return NextResponse.json(
        { ok: false, reason: "สาขาที่เลือกยังไม่เปิดให้บริการ — ลองสาขาอื่น" },
        { status: 400 }
      );
    }
  }

  // Phase 20: resolve attribution. The client either supplied `utm`
  // directly OR passed `referrerUrl` and we parse server-side. The
  // signed `nid` token is verified — only valid notification ids
  // become attributedNotificationId.
  const attrib = body.referrerUrl
    ? attributionFromUrl(body.referrerUrl)
    : { utm: body.utm ?? {}, notificationId: null };

  const insertRes = await admin
    .from("quote_requests")
    .insert({
      customer_name: name || null,
      customer_phone: phone,
      customer_email: email || null,
      contact_method: contactMethod,
      branch_code: branchCode,
      service_category: serviceCategory,
      notes: notes || null,
      photos,
      urgency,
      fulfilment_preference: fulfilmentPreference,
      status: "new",
      utm_source: attrib.utm.utm_source ?? null,
      utm_medium: attrib.utm.utm_medium ?? null,
      utm_campaign: attrib.utm.utm_campaign ?? null,
      utm_branch: attrib.utm.utm_branch ?? null,
      utm_channel: attrib.utm.utm_channel ?? null,
      attributed_notification_id: attrib.notificationId,
    })
    .select("id, created_at")
    .single();
  if (insertRes.error || !insertRes.data) {
    return NextResponse.json(
      {
        ok: false,
        reason: insertRes.error?.message ?? "Insert failed",
      },
      { status: 500 }
    );
  }
  const row = insertRes.data as { id: string; created_at: string };

  // Append to customer_activity. customer_id stays NULL — an admin links
  // the activity to a real customer when triaging. payload carries the
  // submission context so the CRM screen can render the timeline.
  try {
    await admin.from("customer_activity").insert({
      customer_id: null,
      branch_id: branchCode,
      kind: "quote_submitted",
      payload: {
        quoteRequestId: row.id,
        customerPhone: phone,
        customerName: name || null,
        serviceCategory,
        contactMethod,
        ip: ip === "unknown" ? null : ip,
      },
    });
  } catch (err) {
    // Activity logging is best-effort — never block the submission.
    console.warn(
      "[public-quote] activity insert failed:",
      err instanceof Error ? err.message : String(err)
    );
  }

  // Phase 20: when we have a verified notification id, increment the
  // quote_started funnel counter for the originating campaign. Best-
  // effort — failures don't block the submission.
  if (attrib.notificationId) {
    try {
      const notif = await admin
        .from("customer_notifications")
        .select("kind, channel, branch_id, payload")
        .eq("id", attrib.notificationId)
        .maybeSingle();
      const n = notif.data as
        | {
            kind: string;
            channel: string;
            branch_id: string | null;
            payload: Record<string, unknown>;
          }
        | null;
      if (n) {
        let sourceKind: "broadcast_send_job" | "retention_trigger" | null =
          null;
        let sourceId: string | null = null;
        if (n.kind === "broadcast") {
          sourceKind = "broadcast_send_job";
          sourceId =
            typeof n.payload?.broadcastJobId === "string"
              ? (n.payload.broadcastJobId as string)
              : null;
        } else if (n.kind === "retention") {
          sourceKind = "retention_trigger";
          // Look up the retention job for this notification.
          const trigger = await admin
            .from("retention_trigger_jobs")
            .select("id")
            .eq("notification_id", attrib.notificationId)
            .maybeSingle();
          sourceId = (trigger.data as { id: string } | null)?.id ?? null;
        }
        if (sourceKind && sourceId) {
          await incrementFunnel({
            sourceKind,
            sourceId,
            channel: n.channel,
            branchId: n.branch_id ?? branchCode,
            stage: "quote_started",
          });
        }
      }
    } catch {
      // best-effort
    }
  }

  return NextResponse.json({
    ok: true,
    quoteRequestId: row.id,
    receivedAt: row.created_at,
    /** Operator-facing copy the form can show to set expectations. */
    nextSteps: [
      "ทางร้านจะติดต่อกลับภายใน 1 วันทำการ",
      "ระหว่างรอ สามารถดูบริการอื่น ๆ ของเราได้ที่หน้า /services",
      "ถ้ามีงานเร่งด่วน โทร / ทักไลน์สาขาที่เลือกได้เลย",
    ],
  });
}
