"use client";

// Visibility-aware polling hook for portal pages.
//
// Why polling (not Supabase realtime / WebSockets):
//   1. The portal traffic profile is "customer opens page, looks for
//      30–90 seconds, closes tab". WebSockets would burn server-side
//      connection slots for the entire mobile session. Polling the
//      same JSON endpoint every 30 s costs ~3 KB / cycle and naturally
//      stops when the user navigates away.
//   2. Supabase realtime requires an open WebSocket per tab and a
//      schema-level "broadcast" subscription per table. Our portal
//      surfaces aggregate multiple tables (orders, notifications,
//      timeline, photos) — polling one route hides that complexity.
//   3. The dispatch worker is itself polled by cron; the customer's
//      view doesn't need lower latency than the worker's tick.
//
// Bandwidth control:
//   • Default interval 30 s; configurable.
//   • Pauses entirely when document.visibilityState !== 'visible'.
//   • Cancels in-flight requests when the component unmounts.
//   • Skips firing if the previous fetch hasn't returned (no overlap).

import { useEffect, useRef } from "react";

export type UsePortalRefreshOptions = {
  /** Milliseconds between polls. Default 30 000 (30 s). */
  intervalMs?: number;
  /** Pause when document is hidden. Default true. */
  pauseWhenHidden?: boolean;
  /** Fire once on mount before scheduling the first tick. Default true. */
  fireOnMount?: boolean;
};

/**
 * Periodically invoke `refresh`. Caller is responsible for ensuring
 * `refresh` is stable (memoised with useCallback) — the hook re-binds
 * the timer if the function reference changes.
 *
 * Returns an object with a `refreshNow()` method the caller can use
 * to trigger an out-of-cycle refresh (e.g. after an optimistic update).
 */
export function usePortalRefresh(
  refresh: () => Promise<void> | void,
  options: UsePortalRefreshOptions = {}
): { refreshNow: () => void } {
  const intervalMs = Math.max(5_000, options.intervalMs ?? 30_000);
  const pauseWhenHidden = options.pauseWhenHidden !== false;
  const fireOnMount = options.fireOnMount !== false;

  const refreshRef = useRef(refresh);
  const inFlightRef = useRef(false);

  // Keep the latest callback reachable from the timer without
  // restarting it on every parent re-render.
  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  // Stable callback for the consumer.
  const runOnce = useRef(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      await refreshRef.current();
    } catch (err) {
      console.warn(
        "[portal-refresh] refresh threw",
        err instanceof Error ? err.message : String(err)
      );
    } finally {
      inFlightRef.current = false;
    }
  });

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      if (cancelled) return;
      if (
        pauseWhenHidden &&
        typeof document !== "undefined" &&
        document.visibilityState !== "visible"
      ) {
        // Don't burn provider quota for a hidden tab; restart on
        // visibilitychange below.
        return;
      }
      await runOnce.current();
      if (cancelled) return;
      timer = setTimeout(tick, intervalMs);
    };

    if (fireOnMount) {
      void runOnce.current();
    }
    timer = setTimeout(tick, intervalMs);

    const onVisibility = () => {
      if (
        typeof document !== "undefined" &&
        document.visibilityState === "visible"
      ) {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        void runOnce.current();
        timer = setTimeout(tick, intervalMs);
      }
    };

    if (pauseWhenHidden && typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibility);
    }

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      if (pauseWhenHidden && typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
    };
  }, [intervalMs, pauseWhenHidden, fireOnMount]);

  return {
    refreshNow: () => {
      void runOnce.current();
    },
  };
}
