// GET/POST /api/cron/sync-customers — hourly customer sync.
//
// Bug-fix phase. The customer list used to require an operator clicking
// "Sync from Google Sheet" repeatedly. This cron does it automatically:
//
//   1. Import new customers from the Data_Center sheet (dedup by phone;
//      existing customers are never overwritten).
//   2. Recalculate visit count + lifetime spend + tier for every customer
//      from the order history (robust matcher, cancelled orders excluded).
//
// Auth: Bearer CRON_SECRET. Cadence: hourly (see lib/cronManifest.ts).
// The manual "Sync now" button (POST /api/sync-customers) still works.

import { NextResponse } from "next/server";
import { syncCustomersFromSheet } from "@/lib/customerSheetSync";
import { recalcCustomerStats } from "@/lib/customerRecalc";
import { withCronHeartbeat } from "@/lib/cronHeartbeat";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

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
    return NextResponse.json(
      { ok: false, reason: "invalid bearer" },
      { status: 401 }
    );
  }

  const result = await withCronHeartbeat(
    "sync-customers",
    async () => {
      // 1. Import new customers from the sheet.
      const sync = await syncCustomersFromSheet();
      // 2. Recalculate visit/spend/tier — runs even when the sheet import
      //    failed so an unreachable sheet never blocks the recalc.
      const recalc = await recalcCustomerStats();
      return {
        result: { sync, recalc },
        payload: {
          rowsProcessed: sync.inserted + recalc.updated,
          details: {
            syncOk: sync.ok,
            inserted: sync.inserted,
            matchedExisting: sync.matchedExisting,
            skipped: sync.skipped,
            syncError: sync.error,
            recalcOk: recalc.ok,
            customersRecalculated: recalc.updated,
            recalcFailed: recalc.failed,
            unmatchedOrders: recalc.unmatchedOrders,
            excludedOrders: recalc.excludedOrders,
          },
        },
      };
    },
    { lockName: "cron:sync-customers", lockTtlMs: 9 * 60 * 1000 }
  );

  if ("skipped" in result && result.skipped === true) {
    return NextResponse.json({ ok: true, skipped: true, reason: result.reason });
  }
  return NextResponse.json({ ok: true, ...result });
}

export async function GET(req: Request) {
  return handle(req);
}
export async function POST(req: Request) {
  return handle(req);
}
