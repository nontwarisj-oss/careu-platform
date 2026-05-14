"use client";

// Worker Health Banner — polls /api/admin/system/workers on a slow
// schedule and renders an inline banner when the overall status is
// not healthy. Used on the admin landing + dispatch / broadcasts
// pages to give operators an at-a-glance "something needs attention"
// signal.
//
// Auto-hides on healthy. Operator can dismiss via session storage —
// suppression lasts for the session only.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

type Snapshot = {
  ok?: boolean;
  generatedAt?: string;
  overall?: "healthy" | "warning" | "critical";
  alerts?: Array<{
    ruleId: string;
    ruleName: string;
    severity: "warning" | "critical";
  }>;
  crons?: Array<{ cronName: string; status: string; silentForMinutes: number | null }>;
  queue?: {
    oldestQueuedAgeMinutes: number | null;
    stuckSendingTotal: number;
    deadLetterTotal: number;
  };
};

const STORAGE_KEY = "worker-banner-dismissed-at";
const DISMISS_TTL_MS = 30 * 60 * 1000;

export function WorkerHealthBanner() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [dismissed, setDismissed] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/system/workers", {
        cache: "no-store",
      });
      if (res.status === 401 || res.status === 403) {
        // Not authorized — don't render the banner at all.
        setSnap({ overall: "healthy" });
        return;
      }
      const json = (await res.json()) as Snapshot;
      setSnap(json);
    } catch {
      // Network errors keep the last known snapshot; do nothing.
    }
  }, []);

  useEffect(() => {
    if (typeof window !== "undefined") {
      const dismissedAt = window.sessionStorage.getItem(STORAGE_KEY);
      if (dismissedAt) {
        const dismissedMs = Number(dismissedAt);
        if (
          Number.isFinite(dismissedMs) &&
          Date.now() - dismissedMs < DISMISS_TTL_MS
        ) {
          setDismissed(true);
        } else {
          window.sessionStorage.removeItem(STORAGE_KEY);
        }
      }
    }
    void load();
    const t = setInterval(() => void load(), 60_000);
    return () => clearInterval(t);
  }, [load]);

  if (!snap || snap.overall === "healthy" || dismissed) return null;

  const critical = snap.overall === "critical";
  const summary = summarise(snap);

  return (
    <div
      className={`rounded-2xl border px-4 py-3 ${
        critical
          ? "border-red-300 bg-red-50 text-red-900"
          : "border-amber-300 bg-amber-50 text-amber-900"
      }`}
      role="alert"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold">
            {critical ? "⚠ Workers ไม่ปกติ" : "Workers ต้องการความสนใจ"}
          </p>
          <p className="mt-0.5 text-[11px]">{summary}</p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/admin/system/workers"
            className={`rounded-xl border px-3 py-1.5 text-xs font-semibold whitespace-nowrap ${
              critical
                ? "border-red-300 bg-white text-red-900 hover:bg-red-100"
                : "border-amber-300 bg-white text-amber-900 hover:bg-amber-100"
            }`}
          >
            ดูรายละเอียด →
          </Link>
          <button
            type="button"
            onClick={() => {
              setDismissed(true);
              if (typeof window !== "undefined") {
                window.sessionStorage.setItem(
                  STORAGE_KEY,
                  String(Date.now())
                );
              }
            }}
            className="text-[11px] text-gray-700 hover:text-gray-900 underline"
          >
            ซ่อน 30 นาที
          </button>
        </div>
      </div>
    </div>
  );
}

function summarise(snap: Snapshot): string {
  const bits: string[] = [];
  const silentCron = (snap.crons ?? []).find(
    (c) => c.status === "critical" || c.status === "warning"
  );
  if (silentCron) {
    bits.push(
      `cron "${silentCron.cronName}" silent ${silentCron.silentForMinutes ?? "?"}m`
    );
  }
  if (snap.queue) {
    if (snap.queue.stuckSendingTotal > 0) {
      bits.push(`${snap.queue.stuckSendingTotal} stuck sending`);
    }
    if ((snap.queue.oldestQueuedAgeMinutes ?? 0) > 10) {
      bits.push(`oldest queued ${snap.queue.oldestQueuedAgeMinutes}m`);
    }
    if (snap.queue.deadLetterTotal > 0) {
      bits.push(`${snap.queue.deadLetterTotal} dead-letter`);
    }
  }
  const criticalAlerts = (snap.alerts ?? []).filter(
    (a) => a.severity === "critical"
  ).length;
  const warningAlerts = (snap.alerts ?? []).filter(
    (a) => a.severity === "warning"
  ).length;
  if (criticalAlerts > 0) bits.push(`${criticalAlerts} critical alert`);
  if (warningAlerts > 0) bits.push(`${warningAlerts} warning alert`);
  return bits.length > 0 ? bits.join(" · ") : "ดูรายละเอียดที่ workers";
}
