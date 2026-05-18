// POST /api/admin/pricing-master/sync — Google Sheet → service_price_master.
//
// Direction: Sheet ("Service_Prices" tab) → Supabase. The sheet is the easy
// editing surface; this table is the system source of truth.
//
// Server-only: the service-role key never reaches the client, and the read
// uses the service-account Sheets credentials. The browser never syncs.
//
// Auth — OWNER / CEO (hq_admin) only. Best-effort, matching the platform's
// cookieless reality (cf. /api/orders/check-job-id): when a session cookie
// is present the role is enforced strictly (403 for anyone else); when the
// app runs cookieless there is no session to read, so the request proceeds
// — and the Pricing Master UI already restricts the Sync button to
// owner / hq_admin via canManagePricing. A hard requireRole() would 401 the
// owner too in cookieless mode, which would make the feature unusable.

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/supabaseAuth";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { readGoogleSheetsConfig, readSheetTab } from "@/lib/googleSheets";
import {
  SERVICE_PRICES_SHEET_NAME,
  parseSheetServicePriceRow,
  type ServicePriceUpsert,
} from "@/lib/servicePriceSheet";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

// Roles allowed to manage pricing — mirrors canManagePricing().
const PRICING_ROLES = ["owner", "hq_admin"];

export async function POST() {
  // ---- 1. Best-effort owner/CEO gate ------------------------------------
  const user = await getCurrentUser();
  if (user && !PRICING_ROLES.includes(user.role)) {
    console.error("[pricing-master/sync] role denied", { role: user.role });
    return NextResponse.json(
      { ok: false, error: "เฉพาะ Owner / CEO เท่านั้นที่ซิงค์ราคาได้" },
      { status: 403 }
    );
  }
  if (!user) {
    console.warn("[pricing-master/sync] no session — proceeding (cookieless)");
  }

  // ---- 2. Preconditions -------------------------------------------------
  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json(
      { ok: false, error: "service role ยังไม่ได้ตั้งค่า" },
      { status: 503 }
    );
  }
  if (!readGoogleSheetsConfig()) {
    const missing = [
      ["GOOGLE_SERVICE_ACCOUNT_EMAIL", process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL],
      ["GOOGLE_PRIVATE_KEY", process.env.GOOGLE_PRIVATE_KEY],
      ["GOOGLE_SHEET_ID", process.env.GOOGLE_SHEET_ID],
    ]
      .filter(([, v]) => !v)
      .map(([k]) => k);
    return NextResponse.json(
      {
        ok: false,
        error: `Google Sheets ยังไม่ตั้งค่า credentials — ตัวแปรที่ขาด: ${missing.join(
          ", "
        )}`,
      },
      { status: 503 }
    );
  }

  // ---- 3. Read the Service_Prices tab -----------------------------------
  let rows: string[][];
  try {
    rows = await readSheetTab(SERVICE_PRICES_SHEET_NAME);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[pricing-master/sync] sheet read failed", message);
    return NextResponse.json(
      { ok: false, error: `อ่าน Google Sheet ไม่สำเร็จ: ${message}` },
      { status: 502 }
    );
  }
  if (rows.length < 2) {
    return NextResponse.json(
      {
        ok: false,
        error: `แท็บ "${SERVICE_PRICES_SHEET_NAME}" ไม่มีข้อมูล (ต้องมีหัวคอลัมน์ + อย่างน้อย 1 แถว)`,
      },
      { status: 400 }
    );
  }

  const headers = rows[0].map((h) => h.trim().toLowerCase());
  if (!headers.includes("service_code")) {
    return NextResponse.json(
      {
        ok: false,
        error: `ไม่พบคอลัมน์ service_code ในหัวตาราง — พบ: ${headers.join(", ")}`,
      },
      { status: 400 }
    );
  }

  // ---- 4. Parse + validate every data row -------------------------------
  const errors: string[] = [];
  let skipped = 0;
  // Keyed by service_code so a duplicate within the sheet keeps the LAST
  // occurrence (a batch upsert cannot touch the same conflict key twice).
  const payloadByCode = new Map<string, ServicePriceUpsert>();

  for (let i = 1; i < rows.length; i++) {
    const cells = rows[i] ?? [];
    // A genuinely empty row (no service_code cell) is silently ignored.
    const record: Record<string, string> = {};
    headers.forEach((h, idx) => {
      record[h] = (cells[idx] ?? "").toString();
    });
    if (Object.values(record).every((v) => v.trim() === "")) continue;

    const rowNumber = i + 1; // 1-based sheet row (header = row 1)
    const parsed = parseSheetServicePriceRow(record, rowNumber);
    if (!parsed.ok) {
      errors.push(parsed.reason);
      skipped += 1;
      continue;
    }
    if (payloadByCode.has(parsed.payload.service_code)) {
      errors.push(
        `แถว ${rowNumber}: service_code "${parsed.payload.service_code}" ซ้ำในชีต — ใช้แถวล่าสุด`
      );
    }
    payloadByCode.set(parsed.payload.service_code, parsed.payload);
  }

  const payloads = Array.from(payloadByCode.values());
  if (payloads.length === 0) {
    return NextResponse.json({
      ok: false,
      error: "ไม่มีแถวที่ใช้งานได้ในชีต",
      inserted: 0,
      updated: 0,
      skipped,
      errors,
    });
  }

  // ---- 5. Insert vs update split (pre-fetch existing codes) -------------
  const existingRes = await admin
    .from("service_price_master")
    .select("service_code");
  if (existingRes.error) {
    return NextResponse.json(
      {
        ok: false,
        error: `อ่านตาราง service_price_master ไม่สำเร็จ: ${existingRes.error.message}`,
      },
      { status: 500 }
    );
  }
  const existingCodes = new Set(
    ((existingRes.data ?? []) as Array<{ service_code: string }>).map(
      (r) => r.service_code
    )
  );
  let inserted = 0;
  let updated = 0;
  for (const p of payloads) {
    if (existingCodes.has(p.service_code)) updated += 1;
    else inserted += 1;
  }

  // ---- 6. Upsert by service_code ----------------------------------------
  const upsertRes = await admin
    .from("service_price_master")
    .upsert(payloads, { onConflict: "service_code" });
  if (upsertRes.error) {
    console.error("[pricing-master/sync] upsert failed", upsertRes.error);
    return NextResponse.json(
      {
        ok: false,
        error: `บันทึกลงตารางไม่สำเร็จ: ${upsertRes.error.message}`,
        inserted: 0,
        updated: 0,
        skipped,
        errors,
      },
      { status: 500 }
    );
  }

  const summary = {
    ok: true,
    sheet: SERVICE_PRICES_SHEET_NAME,
    total_rows: rows.length - 1,
    inserted,
    updated,
    skipped,
    errors,
  };
  console.log("[pricing-master/sync] done", {
    inserted,
    updated,
    skipped,
    errorCount: errors.length,
  });
  return NextResponse.json(summary);
}
