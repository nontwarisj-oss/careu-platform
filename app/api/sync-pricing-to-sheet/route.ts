// Dump the active pricing catalog to the workbook's "Pricing" tab so the
// finance team can audit / share the same numbers without opening the app.
// Direction: Supabase → Sheet (the /pricing UI is the master).
//
// The route APPENDS rows — it does not clear the tab first. The first time
// you run it, the Pricing tab should be empty (or only have a header row);
// subsequent runs add a fresh dated snapshot on top so you can see the
// price history accumulate alongside the in-DB version log.

import { NextResponse } from "next/server";
import supabase from "@/lib/supabase";
import { readGoogleSheetsConfig } from "@/lib/googleSheets";
import { writePricingRow } from "@/lib/sheetWriters";
import { logSyncFailure } from "@/lib/syncFailures";
import { SERVICE_CATEGORIES } from "@/lib/pricing";
import type { ServicePriceRow } from "@/lib/pricingDb";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SHEET_TARGET = process.env.GOOGLE_SHEET_PRICING_TAB ?? "Pricing";

function isCurrent(row: ServicePriceRow, now: Date): boolean {
  if (!row.is_active) return false;
  const from = new Date(row.effective_from);
  if (Number.isFinite(from.getTime()) && from > now) return false;
  if (row.effective_to) {
    const to = new Date(row.effective_to);
    if (Number.isFinite(to.getTime()) && to <= now) return false;
  }
  return true;
}

export async function POST() {
  if (!readGoogleSheetsConfig()) {
    const missing = [
      ["GOOGLE_SERVICE_ACCOUNT_EMAIL", process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL],
      ["GOOGLE_PRIVATE_KEY", process.env.GOOGLE_PRIVATE_KEY],
      ["GOOGLE_SHEET_ID", process.env.GOOGLE_SHEET_ID],
    ]
      .filter(([, v]) => !v)
      .map(([k]) => k);
    console.warn("[sync-pricing-to-sheet] missing env vars", missing);
    return NextResponse.json(
      {
        ok: false,
        reason: `Google Sheets sync ยังไม่ตั้งค่า credentials — ตัวแปรที่ขาด: ${missing.join(
          ", "
        )}`,
        missing,
      },
      { status: 503 }
    );
  }

  const res = await supabase
    .from("service_prices")
    .select(
      "id, service_code, category, business_type, display_name, description, base_price, pricing_type, urgent_fee_default, is_active, sort_order, branch_id, brand_id, effective_from, effective_to, created_at, created_by, updated_at, updated_by"
    );

  if (res.error) {
    console.error("[sync-pricing-to-sheet] db read failed", res.error.message);
    return NextResponse.json(
      {
        ok: false,
        reason: `อ่านตาราง service_prices ไม่สำเร็จ: ${res.error.message}`,
      },
      { status: 502 }
    );
  }

  const rows = (res.data ?? []) as ServicePriceRow[];
  const now = new Date();
  const active = rows.filter((r) => isCurrent(r, now));
  if (active.length === 0) {
    return NextResponse.json(
      {
        ok: false,
        reason:
          "ไม่มีรายการที่ใช้งานอยู่ใน service_prices — เพิ่มราคาที่หน้า /pricing ก่อน",
      },
      { status: 400 }
    );
  }

  const stamp = now.toLocaleString("th-TH", {
    dateStyle: "short",
    timeStyle: "short",
  });
  const categoryLabel = (code: string) =>
    SERVICE_CATEGORIES.find((c) => c.code === code)?.labelTh ?? code;

  let appended = 0;
  for (const row of active) {
    try {
      await writePricingRow({
        snapshotAt: stamp,
        serviceCode: row.service_code,
        categoryLabel: categoryLabel(row.category),
        displayName: row.display_name,
        description: row.description ?? "",
        pricingType: row.pricing_type,
        basePrice:
          row.pricing_type === "estimate_required"
            ? ""
            : Number(row.base_price ?? 0),
        urgentFeeDefault: Number(row.urgent_fee_default ?? 0),
        branchId: row.branch_id ?? "",
        brandId: row.brand_id ?? "",
        effectiveFrom: row.effective_from,
        effectiveTo: row.effective_to ?? "",
        createdBy: row.created_by ?? "",
      });
      appended += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logSyncFailure({
        kind: "pricing_to_sheet",
        targetId: row.service_code,
        reason: message,
        payload: { sheet: SHEET_TARGET, appended, remaining: active.length - appended },
      });
      return NextResponse.json(
        {
          ok: false,
          reason: message,
          appended,
          remaining: active.length - appended,
        },
        { status: 502 }
      );
    }
  }

  console.info("[sync-pricing-to-sheet] completed", {
    sheet: SHEET_TARGET,
    appended,
  });
  return NextResponse.json({
    ok: true,
    sheet: SHEET_TARGET,
    snapshotAt: stamp,
    appended,
  });
}
