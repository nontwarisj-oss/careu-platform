// LINE Login (v2.1) client — server-only.
// Docs: https://developers.line.biz/en/docs/line-login/integrate-line-login/
//
// Env vars (all required for live auth):
//   LINE_LOGIN_CHANNEL_ID
//   LINE_LOGIN_CHANNEL_SECRET
//   LINE_LOGIN_CALLBACK_URL   (e.g. https://app.example.com/api/auth/line/callback)
//
// When any of the three are missing, isLineLoginConfigured() returns false
// and the /login page renders a clear "ยังไม่ตั้งค่า LINE Login" state
// instead of redirecting to a broken OAuth URL.

import crypto from "node:crypto";

const AUTHORIZE_URL = "https://access.line.me/oauth2/v2.1/authorize";
const TOKEN_URL = "https://api.line.me/oauth2/v2.1/token";
const PROFILE_URL = "https://api.line.me/v2/profile";

export type LineConfig = {
  channelId: string;
  channelSecret: string;
  callbackUrl: string;
};

export function readLineConfig(): LineConfig | null {
  const channelId = process.env.LINE_LOGIN_CHANNEL_ID ?? "";
  const channelSecret = process.env.LINE_LOGIN_CHANNEL_SECRET ?? "";
  const callbackUrl = process.env.LINE_LOGIN_CALLBACK_URL ?? "";
  if (!channelId || !channelSecret || !callbackUrl) return null;
  return { channelId, channelSecret, callbackUrl };
}

export function isLineLoginConfigured(): boolean {
  return readLineConfig() !== null;
}

/** Generate a CSRF state token; the caller stores it in a short-lived cookie. */
export function generateState(): string {
  return crypto.randomBytes(24).toString("base64url");
}

/** Build the URL to redirect the browser to. */
export function buildAuthorizeUrl(state: string, opts?: { nonce?: string }): string | null {
  const cfg = readLineConfig();
  if (!cfg) return null;
  const params = new URLSearchParams({
    response_type: "code",
    client_id: cfg.channelId,
    redirect_uri: cfg.callbackUrl,
    state,
    scope: "profile openid",
  });
  if (opts?.nonce) params.set("nonce", opts.nonce);
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

export type LineTokenResponse = {
  access_token: string;
  expires_in: number;
  id_token?: string;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
};

export type LineProfile = {
  userId: string;
  displayName: string;
  pictureUrl?: string;
  statusMessage?: string;
};

export async function exchangeCodeForToken(code: string): Promise<LineTokenResponse> {
  const cfg = readLineConfig();
  if (!cfg) throw new Error("LINE login not configured");
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: cfg.callbackUrl,
    client_id: cfg.channelId,
    client_secret: cfg.channelSecret,
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LINE token exchange ${res.status}: ${text}`);
  }
  return (await res.json()) as LineTokenResponse;
}

export async function fetchLineProfile(accessToken: string): Promise<LineProfile> {
  const res = await fetch(PROFILE_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LINE profile fetch ${res.status}: ${text}`);
  }
  return (await res.json()) as LineProfile;
}
