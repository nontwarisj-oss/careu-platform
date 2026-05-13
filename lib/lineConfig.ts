// Branch-aware LINE OA configuration resolver. Server-only.
//
// Resolution order:
//   1. public.branch_line_configs row for the requested branch_uuid →
//      use those credentials (per-branch / per-franchise channel).
//   2. Otherwise fall back to the global env vars:
//        LINE_CHANNEL_ACCESS_TOKEN
//        LINE_CHANNEL_SECRET
//        LINE_OA_ID
//      These behave like the "HQ default" channel for shops that
//      haven't onboarded their own LINE OA yet.
//
// The DB read goes through the service-role client (lib/supabaseAdmin)
// because branch_line_configs has no read RLS policy — only service
// role can see the tokens. Callers without that client will silently
// fall back to env vars, which is the right thing for preview / dev.

import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

export type LineChannelConfig = {
  /** Origin: 'branch' = DB row; 'global' = env-var fallback. */
  origin: "branch" | "global";
  channelAccessToken: string;
  channelSecret: string | null;
  oaBasicId: string | null;
  oaDisplayName: string | null;
  /** branches.id (uuid) when origin='branch', null otherwise. */
  branchId: string | null;
};

export type LineAutoSendPreferences = {
  orderReceived: boolean;
  orderReady: boolean;
  pickupReminder: boolean;
};

const ENV_FALLBACK_PREFS: LineAutoSendPreferences = {
  orderReceived: false,
  orderReady: false,
  pickupReminder: false,
};

function readGlobalConfig(): LineChannelConfig | null {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN ?? "";
  if (!token) return null;
  return {
    origin: "global",
    channelAccessToken: token,
    channelSecret: process.env.LINE_CHANNEL_SECRET ?? null,
    oaBasicId: process.env.LINE_OA_ID ?? null,
    oaDisplayName: null,
    branchId: null,
  };
}

export function isGlobalLineConfigured(): boolean {
  return readGlobalConfig() !== null;
}

/**
 * Resolve the LINE channel config for a given branch. Returns null when
 * neither a branch-specific row nor the global env vars are configured —
 * callers should surface a "LINE OA not configured" reason in that case.
 *
 * Pass `branchUuid` = NULL for the global / HQ channel.
 */
export async function resolveLineChannelConfig(
  branchUuid: string | null
): Promise<LineChannelConfig | null> {
  if (branchUuid) {
    const admin = getSupabaseAdmin();
    if (admin) {
      const res = await admin
        .from("branch_line_configs")
        .select(
          "branch_id, channel_access_token, channel_secret, oa_basic_id, oa_display_name"
        )
        .eq("branch_id", branchUuid)
        .maybeSingle();
      if (!res.error && res.data) {
        const row = res.data as {
          branch_id: string;
          channel_access_token: string | null;
          channel_secret: string | null;
          oa_basic_id: string | null;
          oa_display_name: string | null;
        };
        if (row.channel_access_token) {
          return {
            origin: "branch",
            channelAccessToken: row.channel_access_token,
            channelSecret: row.channel_secret,
            oaBasicId: row.oa_basic_id,
            oaDisplayName: row.oa_display_name,
            branchId: row.branch_id,
          };
        }
      }
    }
  }
  return readGlobalConfig();
}

/**
 * Read per-branch auto-send preferences. Returns env-defaults (all off)
 * when no branch row exists.
 */
export async function resolveAutoSendPrefs(
  branchUuid: string | null
): Promise<LineAutoSendPreferences> {
  if (!branchUuid) return { ...ENV_FALLBACK_PREFS };
  const admin = getSupabaseAdmin();
  if (!admin) return { ...ENV_FALLBACK_PREFS };
  const res = await admin
    .from("branch_line_configs")
    .select(
      "auto_send_order_received, auto_send_order_ready, auto_send_pickup_reminder"
    )
    .eq("branch_id", branchUuid)
    .maybeSingle();
  if (res.error || !res.data) return { ...ENV_FALLBACK_PREFS };
  const row = res.data as {
    auto_send_order_received: boolean | null;
    auto_send_order_ready: boolean | null;
    auto_send_pickup_reminder: boolean | null;
  };
  return {
    orderReceived: row.auto_send_order_received ?? false,
    orderReady: row.auto_send_order_ready ?? false,
    pickupReminder: row.auto_send_pickup_reminder ?? false,
  };
}
