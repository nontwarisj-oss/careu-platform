// Browser-side helper for triggering lifecycle notifications. Wraps
// the /api/internal/lifecycle-event endpoint so call sites don't have
// to inline the fetch / JSON / error handling.
//
// Fire-and-forget: callers should NOT await this in a way that blocks
// their primary UX. Pattern is:
//
//   void triggerLifecycleEvent('ready_for_pickup', orderId);
//
// The function always resolves — network failures are caught and
// logged, never thrown.

import type { LifecycleEvent } from "@/lib/lifecycleNotifier";

export type LifecycleClientResult = {
  ok: boolean;
  enqueued: number;
  skipped: number;
  reason?: string;
};

export async function triggerLifecycleEvent(
  event: LifecycleEvent,
  orderId: string
): Promise<LifecycleClientResult> {
  if (!orderId) return { ok: false, enqueued: 0, skipped: 0, reason: "no orderId" };
  try {
    const res = await fetch("/api/internal/lifecycle-event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event, orderId }),
    });
    if (!res.ok) {
      return {
        ok: false,
        enqueued: 0,
        skipped: 0,
        reason: `HTTP ${res.status}`,
      };
    }
    const json = (await res.json()) as {
      ok?: boolean;
      reason?: string;
      outcomes?: Array<{ enqueued: boolean }>;
    };
    const enqueued = (json.outcomes ?? []).filter((o) => o.enqueued).length;
    const skipped = (json.outcomes ?? []).filter((o) => !o.enqueued).length;
    return {
      ok: !!json.ok,
      enqueued,
      skipped,
      reason: json.reason,
    };
  } catch (err) {
    console.warn(
      "[lifecycle-client] trigger failed",
      err instanceof Error ? err.message : String(err)
    );
    return {
      ok: false,
      enqueued: 0,
      skipped: 0,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}
