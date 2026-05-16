// POST /api/sync-customers — manual "Sync from Google Sheet" button.
//
// Bug-fix phase: the sheet fetch + parse + import logic moved into
// lib/customerSheetSync so the hourly cron (/api/cron/sync-customers)
// runs the EXACT same code path. This route stays as the operator's
// on-demand "Sync now" trigger.

import { NextResponse } from "next/server";
import { syncCustomersFromSheet } from "@/lib/customerSheetSync";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST() {
  const result = await syncCustomersFromSheet();
  const { status, ...body } = result;
  return NextResponse.json(body, { status });
}
