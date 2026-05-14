// POST /api/admin/communications/templates/[id]/test-send
// Body: { channel: 'sms' | 'line' | 'email', to: string, context?: {...} }
//
// Sends one test message rendered from the template, directly through
// the channel adapter (bypasses the dispatch queue — operator wants
// IMMEDIATE feedback, not "in the queue eventually"). NO retention
// trigger row is written.
//
// Rate-limited 10/10min/IP — operator shouldn't be batch-testing.
// Owner / HQ only.

import { NextResponse } from "next/server";
import { requireRole } from "@/lib/supabaseAuth";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { callerIp, rateLimit } from "@/lib/rateLimit";
import { renderTemplate, type TemplateRow } from "@/lib/emailTemplateService";
import { sendSms } from "@/lib/smsProvider";
import { sendEmail } from "@/lib/channels/email";
import { resolveLineChannelConfig } from "@/lib/lineConfig";
import { pushTextMessage } from "@/lib/lineMessaging";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> }
) {
  const ip = callerIp(req);
  const limit = rateLimit(ip, {
    namespace: "template-test-send",
    limit: 10,
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

  const { id } = await context.params;
  let body: {
    channel?: string;
    to?: string;
    context?: Record<string, string | number | null | undefined>;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { ok: false, reason: "Invalid JSON body" },
      { status: 400 }
    );
  }
  const channel = body.channel;
  if (!channel || !["sms", "line", "email"].includes(channel)) {
    return NextResponse.json(
      { ok: false, reason: "channel ต้องเป็น sms / line / email" },
      { status: 400 }
    );
  }
  const to = (body.to ?? "").trim();
  if (!to) {
    return NextResponse.json(
      { ok: false, reason: "to (recipient) required" },
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
  const tplRes = await admin
    .from("email_templates")
    .select(
      "id, slug, name, subject, preview_text, body_plain, body_html, variables, channels, enabled, current_version, branch_id, updated_at"
    )
    .eq("id", id)
    .maybeSingle();
  if (tplRes.error || !tplRes.data) {
    return NextResponse.json(
      { ok: false, reason: "template not found" },
      { status: 404 }
    );
  }
  const template = tplRes.data as TemplateRow;

  // Build a sensible default context using fallback values for every
  // required variable. Operator can override per-key via body.context.
  const ctx: Record<string, string | number> = {};
  for (const v of template.variables ?? []) {
    ctx[v] = `[${v}]`;
  }
  for (const [k, v] of Object.entries(body.context ?? {})) {
    if (v !== null && v !== undefined) ctx[k] = String(v);
  }

  const rendered = await renderTemplate(
    {
      templateSlug: template.slug,
      context: ctx,
      channel: channel as "sms" | "line" | "email",
    },
    { loadedTemplate: template }
  );
  if (!rendered.ok) {
    return NextResponse.json(
      {
        ok: false,
        reason: rendered.reason,
        missingVariables: rendered.missingVariables,
      },
      { status: 400 }
    );
  }

  // Dispatch directly via the channel adapter — test sends bypass
  // the queue + preferences gate (operator knows what they're doing).
  if (channel === "sms") {
    const r = await sendSms({
      to,
      body: rendered.body,
      meta: { test: true, templateSlug: template.slug },
    });
    return NextResponse.json({
      ok: r.ok,
      provider: r.provider,
      reason: r.ok ? null : r.reason,
      rendered: {
        subject: rendered.subject,
        body: rendered.body,
      },
    });
  }
  if (channel === "email") {
    const r = await sendEmail({
      to,
      subject: rendered.subject,
      body: rendered.body,
      meta: { test: true, templateSlug: template.slug },
    });
    return NextResponse.json({
      ok: r.ok,
      provider: r.provider,
      reason: r.ok ? null : r.reason,
      rendered: {
        subject: rendered.subject,
        body: rendered.body,
      },
    });
  }
  // line
  const lineChannel = await resolveLineChannelConfig(null);
  if (!lineChannel) {
    return NextResponse.json(
      { ok: false, reason: "LINE channel config missing" },
      { status: 503 }
    );
  }
  const pushed = await pushTextMessage(lineChannel, to, rendered.body);
  return NextResponse.json({
    ok: pushed.ok,
    reason: pushed.ok ? null : pushed.reason,
    rendered: {
      subject: rendered.subject,
      body: rendered.body,
    },
  });
}
