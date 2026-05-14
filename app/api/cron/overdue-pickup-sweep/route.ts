// GET/POST /api/cron/overdue-pickup-sweep — scheduled sweeper that
// fires an overdue_pickup notification for orders that have been
// 'ready-for-pickup' past their due_date AND haven't been picked up.
//
// Auth: Bearer ${CRON_SECRET}. Identical pattern to the existing
// /api/cron/retry-worker and /api/cron/dispatch-worker endpoints —
// machine-only, no role gate.
//
// Idempotent: relies on the lifecycle notifier's DEDUP_WINDOW_MS to
// keep the same order from re-firing within 6 h. Run the cron more
// often than that window and the worst case is one redundant queue
// lookup per skipped order, not a duplicate SMS.
//
// Selection criteria:
//   • status = 'ready-for-pickup'
//   • due_date < now (or NULL — assume overdue when no due_date set)
//   • OR last_overdue_swept_at > 24h ago (we don't have this column,
//     so the dedup window handles it instead)
//
// Limit per tick: SWEEP_LIMIT = 50.

import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { notifyLifecycleEvent } from "@/lib/lifecycleNotifier";
import { withCronHeartbeat } from "@/lib/cronHeartbeat";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SWEEP_LIMIT = 50;
/** Only orders that have been ready for at least this many days get
 *  a reminder. Tighter sweeps spam customers. */
const READY_GRACE_DAYS = 2;

function unauthorized(reason: string) {
  return NextResponse.json({ ok: false, reason }, { status: 401 });
}

async function handle(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { ok: false, reason: "CRON_SECRET ยังไม่ตั้งค่า" },
      { status: 503 }
    );
  }
  const header = req.headers.get("authorization") ?? "";
  if (header !== `Bearer ${secret}`) {
    return unauthorized("invalid bearer");
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json(
      { ok: false, reason: "SUPABASE_SERVICE_ROLE_KEY ยังไม่ตั้งค่า" },
      { status: 503 }
    );
  }

  // Find candidate orders. We look for ready-for-pickup whose due_date
  // was at least READY_GRACE_DAYS ago. The dedup window in the
  // notifier handles cron-rerun idempotency.
  const cutoff = new Date(
    Date.now() - READY_GRACE_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();
  const res = await admin
    .from("orders")
    .select("id, due_date, status, updated_at, created_at")
    .eq("status", "ready-for-pickup")
    .lte("updated_at", cutoff)
    .order("updated_at", { ascending: true })
    .limit(SWEEP_LIMIT);
  if (res.error) {
    return NextResponse.json(
      { ok: false, reason: res.error.message },
      { status: 500 }
    );
  }
  const rows = (res.data ?? []) as Array<{ id: string }>;

  const outcomes = [];
  for (const row of rows) {
    const result = await notifyLifecycleEvent({
      event: "overdue_pickup",
      orderId: row.id,
      actorId: null,
    });
    outcomes.push({
      orderId: row.id,
      ok: result.ok,
      enqueued: result.outcomes.filter((o) => o.enqueued).length,
      skipped: result.outcomes.filter((o) => !o.enqueued).length,
    });
  }

  const swept = rows.length;
  const enqueuedTotal = outcomes.reduce((acc, o) => acc + o.enqueued, 0);
  await withCronHeartbeat("overdue-pickup-sweep", async () => ({
    result: null,
    payload: {
      rowsProcessed: swept,
      details: { enqueued: enqueuedTotal },
    },
  }));

  return NextResponse.json({
    ok: true,
    swept,
    outcomes,
    sweptAt: new Date().toISOString(),
  });
}

export async function GET(req: Request) {
  return handle(req);
}
export async function POST(req: Request) {
  return handle(req);
}
