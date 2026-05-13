// Server-only Google Sheets client. Uses a service-account JWT exchanged for
// an access token — no SDK dependency. Caller is responsible for making sure
// this file never gets bundled into the client (always import from a route
// handler that declares `runtime = "nodejs"`).
//
// Two write modes:
//   • appendRow         — plain `values.append`. Fast, but does NOT copy
//                          per-row formatting from a template. Safe for tabs
//                          whose visual style comes from column-wide rules.
//   • insertFormattedRow — batchUpdate sequence that inserts a new row,
//                          inherits dimension + data-validation from the row
//                          above, copies cell formats / borders / formulas
//                          from a configurable template row, then writes the
//                          actual values. Use this for any tab where staff
//                          rely on dropdowns / checkboxes / colours.

import crypto from "node:crypto";

function base64url(input: string | Buffer): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function resolvePrivateKey(): string {
  const raw = process.env.GOOGLE_PRIVATE_KEY ?? "";
  // Vercel + GitHub typically store the key with literal "\n" sequences; turn
  // those back into real line breaks before crypto.createSign sees them.
  return raw.replace(/\\n/g, "\n");
}

export type GoogleSheetsConfig = {
  serviceAccountEmail: string;
  privateKey: string;
  sheetId: string;
};

export function readGoogleSheetsConfig(): GoogleSheetsConfig | null {
  const serviceAccountEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL ?? "";
  const privateKey = resolvePrivateKey();
  const sheetId = process.env.GOOGLE_SHEET_ID ?? "";
  if (!serviceAccountEmail || !privateKey || !sheetId) {
    return null;
  }
  return { serviceAccountEmail, privateKey, sheetId };
}

async function getAccessToken(config: GoogleSheetsConfig): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({
      iss: config.serviceAccountEmail,
      scope: "https://www.googleapis.com/auth/spreadsheets",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    })
  );
  const signingInput = `${header}.${payload}`;

  let signature: Buffer;
  try {
    signature = crypto
      .createSign("RSA-SHA256")
      .update(signingInput)
      .sign(config.privateKey);
  } catch (err) {
    throw new Error(
      `JWT signing failed — check GOOGLE_PRIVATE_KEY format: ${
        (err as Error).message
      }`
    );
  }

  const jwt = `${signingInput}.${base64url(signature)}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }).toString(),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Token exchange ${res.status}: ${body}`);
  }
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) {
    throw new Error("Token exchange returned no access_token");
  }
  return json.access_token;
}

// ---------- metadata cache -----------------------------------------------
//
// batchUpdate requires the numeric sheet id, not the tab name. We cache it
// for the lifetime of the Lambda / serverless function so each request only
// pays the metadata lookup once. Acceptable trade-off: if a tab is renamed
// while the function is warm, the cache will be stale; redeploy clears it.

const sheetIdCache = new Map<string, Map<string, number>>();

async function lookupTabSheetId(
  config: GoogleSheetsConfig,
  tabName: string,
  token: string
): Promise<number | null> {
  const perSpreadsheet =
    sheetIdCache.get(config.sheetId) ?? new Map<string, number>();
  const cached = perSpreadsheet.get(tabName);
  if (cached !== undefined) return cached;

  const url = `https://sheets.googleapis.com/v4/spreadsheets/${
    config.sheetId
  }?fields=${encodeURIComponent("sheets.properties(sheetId,title)")}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Sheets metadata ${res.status}: ${body}`);
  }
  const json = (await res.json()) as {
    sheets?: Array<{ properties?: { sheetId?: number; title?: string } }>;
  };

  let found: number | null = null;
  for (const s of json.sheets ?? []) {
    const props = s.properties;
    if (!props || typeof props.sheetId !== "number" || !props.title) continue;
    perSpreadsheet.set(props.title, props.sheetId);
    if (props.title === tabName) found = props.sheetId;
  }
  sheetIdCache.set(config.sheetId, perSpreadsheet);
  return found;
}

// 0-indexed row index of the last non-empty row in column A. Returns -1 if
// the tab has no data rows (header only or completely empty).
async function findLastDataRow(
  config: GoogleSheetsConfig,
  tabName: string,
  token: string
): Promise<number> {
  const range = `${tabName}!A:A`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${
    config.sheetId
  }/values/${encodeURIComponent(range)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Sheets values.get ${res.status}: ${body}`);
  }
  const json = (await res.json()) as { values?: string[][] };
  const rows = json.values ?? [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const cell = rows[i]?.[0];
    if (cell !== undefined && cell !== null && String(cell).trim() !== "") {
      return i;
    }
  }
  return -1;
}

// ---------- write helpers ------------------------------------------------

export type SheetCellValue = string | number | boolean | null;

/** Sparse map: only the listed columns are overwritten. */
export type SheetSparseRow = Record<number, SheetCellValue>;

export type SheetRowValues = SheetCellValue[] | SheetSparseRow;

function valueToUserEntered(v: SheetCellValue): {
  userEnteredValue: Record<string, unknown>;
} {
  if (v === null || v === undefined || v === "") {
    return { userEnteredValue: { stringValue: "" } };
  }
  if (typeof v === "number" && Number.isFinite(v)) {
    return { userEnteredValue: { numberValue: v } };
  }
  if (typeof v === "boolean") {
    return { userEnteredValue: { boolValue: v } };
  }
  const str = String(v);
  if (str.startsWith("=")) {
    return { userEnteredValue: { formulaValue: str } };
  }
  return { userEnteredValue: { stringValue: str } };
}

/**
 * Append a single row to the given sheet tab. Values are passed through with
 * USER_ENTERED parsing so dates/numbers land in their native cell types when
 * the sheet has the right formatting. Per-cell formatting from the row above
 * is NOT preserved — use `insertFormattedRow` for tabs that need it.
 */
export async function appendRow(
  sheetName: string,
  row: Array<string | number | null>
): Promise<void> {
  const config = readGoogleSheetsConfig();
  if (!config) {
    throw new Error(
      "Google Sheets sync ยังไม่ตั้งค่า — เพิ่ม GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_PRIVATE_KEY / GOOGLE_SHEET_ID ใน environment"
    );
  }

  const token = await getAccessToken(config);
  const range = `${sheetName}!A:Z`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${
    config.sheetId
  }/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ values: [row.map((v) => v ?? "")] }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Sheets append ${res.status}: ${body}`);
  }
}

export type InsertFormattedRowOptions = {
  /**
   * 0-indexed row whose cell-level formatting + data validation should be
   * copied to the new row. When omitted, `inheritFromBefore` alone handles
   * preservation — that's safe for tabs whose data validation lives on the
   * column range, less safe when validation is per-row.
   *
   * Pass a fixed index (typically `1`, the first data row beneath the
   * header) for tabs where staff configured dropdowns / checkboxes
   * one-cell-at-a-time.
   */
  templateRowIndex?: number;
  /** Number of columns the row contract covers. Defaults to values.length. */
  columnCount?: number;
};

export type InsertFormattedRowResult = {
  /** 0-indexed row where the data landed. */
  rowIndex: number;
  /** Numeric sheet id (handy for follow-up batchUpdates by the caller). */
  sheetId: number;
};

/**
 * Insert a row using `batchUpdate` so the resulting cell retains the
 * dropdowns / checkboxes / borders / colours configured on the template
 * row. Three requests in order:
 *
 *   1. `insertDimension` with `inheritFromBefore: true`
 *        → expands the grid; inherits row height + data validation rules
 *          from the row above.
 *   2. `copyPaste` with `pasteType: PASTE_NORMAL` from the template
 *        → propagates the per-cell visual properties + formulas. The
 *          values will be overwritten in step 3 — only the formats survive
 *          where columns receive a fresh value.
 *   3. `updateCells` with `fields: 'userEnteredValue'`
 *        → writes our actual data. Columns NOT listed in the sparse map
 *          retain whatever the template's copyPaste put there (use this to
 *          preserve formulas: omit that column index from the values map).
 *
 * Returns the row index where the data was written so the caller can build
 * a follow-up reference (e.g. a dashboard link).
 */
export async function insertFormattedRow(
  sheetName: string,
  values: SheetRowValues,
  options: InsertFormattedRowOptions = {}
): Promise<InsertFormattedRowResult> {
  const config = readGoogleSheetsConfig();
  if (!config) {
    throw new Error(
      "Google Sheets sync ยังไม่ตั้งค่า — เพิ่ม GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_PRIVATE_KEY / GOOGLE_SHEET_ID ใน environment"
    );
  }
  const token = await getAccessToken(config);

  const sheetId = await lookupTabSheetId(config, sheetName, token);
  if (sheetId === null) {
    throw new Error(`Sheet tab "${sheetName}" not found in spreadsheet`);
  }

  // Normalize to a sparse map. Empty array becomes empty map (nothing to write).
  const sparse: SheetSparseRow = Array.isArray(values)
    ? values.reduce<SheetSparseRow>((acc, v, i) => {
        acc[i] = v;
        return acc;
      }, {})
    : { ...values };

  const columnCount =
    options.columnCount ??
    (Array.isArray(values)
      ? values.length
      : Math.max(0, ...Object.keys(values).map((k) => Number(k) + 1)));

  const lastDataRow = await findLastDataRow(config, sheetName, token);
  const insertAtRow = lastDataRow + 1;
  // inheritFromBefore is only meaningful when there's a row above to inherit
  // from. If the tab is empty (lastDataRow=-1) we just insert at the top.
  const canInherit = lastDataRow >= 0;

  const templateRow =
    options.templateRowIndex !== undefined && options.templateRowIndex >= 0
      ? options.templateRowIndex
      : null;
  const canCopyTemplate =
    templateRow !== null && templateRow !== insertAtRow && columnCount > 0;

  const requests: Array<Record<string, unknown>> = [];

  if (canInherit) {
    requests.push({
      insertDimension: {
        range: {
          sheetId,
          dimension: "ROWS",
          startIndex: insertAtRow,
          endIndex: insertAtRow + 1,
        },
        inheritFromBefore: true,
      },
    });
  }

  if (canCopyTemplate) {
    requests.push({
      copyPaste: {
        source: {
          sheetId,
          startRowIndex: templateRow,
          endRowIndex: templateRow + 1,
          startColumnIndex: 0,
          endColumnIndex: columnCount,
        },
        destination: {
          sheetId,
          startRowIndex: insertAtRow,
          endRowIndex: insertAtRow + 1,
          startColumnIndex: 0,
          endColumnIndex: columnCount,
        },
        pasteType: "PASTE_NORMAL",
        pasteOrientation: "NORMAL",
      },
    });
  }

  // updateCells needs a `rows[].values[]` matrix. Build a row of length
  // columnCount where unmapped columns are left untouched. The supabase /
  // PostgREST style of "fields" is `userEnteredValue` — we set ONLY the
  // value, never the format (the copyPaste above is the format source).
  const rowValues: Array<{ userEnteredValue?: Record<string, unknown> }> = [];
  for (let col = 0; col < columnCount; col++) {
    if (Object.prototype.hasOwnProperty.call(sparse, col)) {
      rowValues.push(valueToUserEntered(sparse[col] ?? null));
    } else {
      // No value supplied → leave the cell as-is (whatever PASTE_NORMAL
      // dropped in). Empty object means "no update for this cell".
      rowValues.push({});
    }
  }

  if (rowValues.length > 0) {
    requests.push({
      updateCells: {
        rows: [{ values: rowValues }],
        fields: "userEnteredValue",
        start: {
          sheetId,
          rowIndex: insertAtRow,
          columnIndex: 0,
        },
      },
    });
  }

  if (requests.length === 0) {
    // Nothing to do — caller passed an empty values map and no template.
    return { rowIndex: insertAtRow, sheetId };
  }

  const url = `https://sheets.googleapis.com/v4/spreadsheets/${config.sheetId}:batchUpdate`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ requests }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Sheets batchUpdate ${res.status}: ${body}`);
  }

  return { rowIndex: insertAtRow, sheetId };
}
