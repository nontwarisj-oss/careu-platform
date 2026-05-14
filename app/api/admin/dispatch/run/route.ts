// POST /api/admin/dispatch/run — manual notification dispatch trigger.
//
// Owner / hq_admin only. Mirrors /api/admin/recovery/run-worker for the
// retry queue. Useful when an operator wants to flush the queue without
// waiting for the next cron tick.

import { NextResponse } from "next/server";
import { requireRole } from "@/lib/supabaseAuth";
import {
  runDispatchTick,
  type DispatchTickOptions,
} from "@/lib/notificationDispatchWorker";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Body = {
  limit?: number;
  channels?: Array<"line" | "sms" | "email" | "in_app">;
};

export async function POST(req: Request) {
  const guarded = await requireRole(["owner", "hq_admin"]);
  if (guarded instanceof NextResponse) return guarded;
  const profile = guarded.profile;

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    body = {};
  }

  const opts: DispatchTickOptions = {
    limit: body.limit,
    channels: body.channels,
    actorId: profile.id,
  };
  const result = await runDispatchTick(opts);
  return NextResponse.json({ ok: true, actorId: profile.id, ...result });
}
