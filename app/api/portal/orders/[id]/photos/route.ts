// GET /api/portal/orders/[id]/photos — list the order's attached photos
// with short-lived signed READ URLs.
//
// Customer-safe scope:
//   • Hard-checks orders.customer_id === session.customerId (same 404
//     enumeration-resistant pattern as the detail/timeline routes).
//   • Returns ONLY image MIME types — intake notes / PDFs / videos are
//     suppressed for the portal viewer (the operator UI handles those).
//   • file_url on order_attachments is stored as a storage *path*; we
//     mint a 5-minute signed URL per row. Long enough for the browser
//     to load + cache, short enough that copy-pasting the URL doesn't
//     share access permanently.

import { NextResponse } from "next/server";
import { readCustomerSessionFromCookies } from "@/lib/customerSession";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { issueReadUrl } from "@/lib/uploadService";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const READ_TTL_SECONDS = 5 * 60;
const IMAGE_MIME_PREFIX = "image/";

export async function GET(
  _req: Request,
  context: { params: Promise<{ id: string }> }
) {
  const session = await readCustomerSessionFromCookies();
  if (!session) {
    return NextResponse.json(
      { ok: false, reason: "ยังไม่ได้เข้าสู่ระบบ" },
      { status: 401 }
    );
  }
  const { id } = await context.params;
  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json(
      { ok: false, reason: "SERVICE_ROLE_KEY ยังไม่ตั้งค่า" },
      { status: 503 }
    );
  }

  const orderRes = await admin
    .from("orders")
    .select("id, customer_id")
    .eq("id", id)
    .maybeSingle();
  if (orderRes.error || !orderRes.data) {
    return NextResponse.json(
      { ok: false, reason: "ไม่พบงาน" },
      { status: 404 }
    );
  }
  const order = orderRes.data as { id: string; customer_id: string | null };
  if (order.customer_id !== session.customerId) {
    return NextResponse.json(
      { ok: false, reason: "ไม่พบงาน" },
      { status: 404 }
    );
  }

  // order_attachments is the canonical store. Existing-but-empty in
  // production today; the writer wiring happens in a later phase. If
  // the table is missing on an under-migrated DB, treat it as empty.
  const att = await admin
    .from("order_attachments")
    .select("id, file_url, file_type, file_name, created_at")
    .eq("order_id", id)
    .order("created_at", { ascending: true });

  if (att.error) {
    // Missing table / column → empty gallery, not a 500. The portal
    // should degrade gracefully on a fresh / partially migrated DB.
    return NextResponse.json({ ok: true, photos: [] });
  }

  const rows = (att.data ?? []) as Array<{
    id: string;
    file_url: string;
    file_type: string | null;
    file_name: string | null;
    created_at: string;
  }>;

  const images = rows.filter((r) =>
    (r.file_type ?? "").toLowerCase().startsWith(IMAGE_MIME_PREFIX)
  );

  const photos = await Promise.all(
    images.map(async (r) => {
      const signed = await issueReadUrl(r.file_url, READ_TTL_SECONDS);
      return {
        id: r.id,
        url: signed,
        mime: r.file_type,
        name: r.file_name,
        createdAt: r.created_at,
      };
    })
  );

  // Drop rows whose signed URL couldn't be minted (e.g. missing
  // object). The customer shouldn't see broken image placeholders.
  const usable = photos.filter((p) => !!p.url) as Array<{
    id: string;
    url: string;
    mime: string | null;
    name: string | null;
    createdAt: string;
  }>;

  return NextResponse.json({
    ok: true,
    photos: usable,
    expiresInSeconds: READ_TTL_SECONDS,
  });
}
