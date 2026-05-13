// Diagnostic endpoint for Google Sheets sync. Returns a structured report on
// what credentials are present in the current environment AND, when all three
// vars are loaded, performs a live append to a "Debug" tab so the operator
// can confirm the JWT exchange + sheet write end-to-end without touching real
// orders.
//
// Safety: this endpoint NEVER returns raw secret values. It only reports
// length / shape / fingerprints so the caller can tell e.g. "the private key
// is present but only 200 chars — Vercel probably split it across two env
// var entries". Suitable to expose temporarily in production while debugging
// and then remove (or guard behind ADMIN role).

import { NextResponse } from "next/server";
import { readGoogleSheetsConfig } from "@/lib/googleSheets";
import { writeDebugRow } from "@/lib/sheetWriters";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function fingerprint(value: string | undefined | null): {
  present: boolean;
  length: number;
  prefix4: string | null;
  suffix4: string | null;
} {
  const v = value ?? "";
  if (!v) return { present: false, length: 0, prefix4: null, suffix4: null };
  return {
    present: true,
    length: v.length,
    prefix4: v.slice(0, 4),
    suffix4: v.slice(-4),
  };
}

function inspectPrivateKey(raw: string | undefined): {
  present: boolean;
  length: number;
  hasLiteralBackslashN: boolean;
  hasRealNewline: boolean;
  startsWithBegin: boolean;
  endsWithEnd: boolean;
  beginEndCount: number;
} {
  const v = raw ?? "";
  if (!v) {
    return {
      present: false,
      length: 0,
      hasLiteralBackslashN: false,
      hasRealNewline: false,
      startsWithBegin: false,
      endsWithEnd: false,
      beginEndCount: 0,
    };
  }
  const normalized = v.replace(/\\n/g, "\n");
  return {
    present: true,
    length: v.length,
    hasLiteralBackslashN: v.includes("\\n"),
    hasRealNewline: v.includes("\n"),
    startsWithBegin: normalized.trim().startsWith("-----BEGIN"),
    endsWithEnd: normalized.trim().endsWith("PRIVATE KEY-----"),
    beginEndCount:
      (normalized.match(/-----BEGIN PRIVATE KEY-----/g) ?? []).length,
  };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const dryRun = url.searchParams.get("dryRun") === "1";

  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY;
  const sheetId = process.env.GOOGLE_SHEET_ID;
  const orderTab = process.env.GOOGLE_SHEET_ORDER_TAB ?? "Front_Desk";

  const env = {
    GOOGLE_SERVICE_ACCOUNT_EMAIL: fingerprint(email),
    GOOGLE_PRIVATE_KEY: inspectPrivateKey(privateKey),
    GOOGLE_SHEET_ID: fingerprint(sheetId),
    GOOGLE_SHEET_ORDER_TAB: orderTab,
    runtime: "nodejs",
    nodeVersion: process.version,
    deployment: process.env.VERCEL ? "vercel" : "local",
  };

  const config = readGoogleSheetsConfig();
  if (!config) {
    return NextResponse.json({
      ok: false,
      stage: "config",
      reason:
        "Google credentials missing. Set GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY, and GOOGLE_SHEET_ID. On Vercel: Settings → Environment Variables (and re-deploy). Locally: .env.local. Then retry.",
      env,
    });
  }

  if (!dryRun) {
    return NextResponse.json({
      ok: true,
      stage: "config",
      message:
        "All three Google env vars are loaded. Re-call with ?dryRun=1 to append a test row to the Debug tab.",
      env,
    });
  }

  // Live dry-run append (Debug tab is intentionally formatting-free).
  const stamp = new Date().toISOString();
  try {
    await writeDebugRow([
      stamp,
      "careu-debug",
      "Diagnostic write from /api/debug-sheet",
    ]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      {
        ok: false,
        stage: "append",
        reason: message,
        env,
        hint:
          message.includes("DECODER") ||
          message.includes("PEM") ||
          message.includes("JWT signing failed")
            ? "Private key did not parse. Most common cause: stored without real newlines. In Vercel paste the key with literal \\n sequences; in .env.local wrap in double quotes so the runtime preserves newlines."
            : message.includes("403") || message.includes("PERMISSION_DENIED")
            ? "Service account does not have access to the sheet. Share the spreadsheet with GOOGLE_SERVICE_ACCOUNT_EMAIL as Editor."
            : message.includes("404")
            ? "Sheet id wrong, or the target tab does not exist. Confirm GOOGLE_SHEET_ID and create a tab named 'Debug' (or change the tab in this endpoint)."
            : message.includes("400")
            ? "Sheet API rejected the payload. Check that the target tab name is correct."
            : null,
      },
      { status: 502 }
    );
  }

  return NextResponse.json({
    ok: true,
    stage: "append",
    message: `Debug row appended at ${stamp} to tab 'Debug' of sheet ${config.sheetId.slice(
      0,
      6
    )}…`,
    env,
  });
}
