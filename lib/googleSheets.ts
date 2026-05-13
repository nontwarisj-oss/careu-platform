// Server-only Google Sheets append. Uses a service-account JWT exchanged for
// an access token, no SDK dependency. Caller is responsible for making sure
// this file never gets bundled into the client (always import from a
// route handler that declares `runtime = "nodejs"`).

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

/**
 * Append a single row to the given sheet tab. Values are passed through with
 * USER_ENTERED parsing so dates/numbers land in their native cell types when
 * the sheet has the right formatting.
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
