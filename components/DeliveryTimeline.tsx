"use client";

// <DeliveryTimeline notificationId=...> — renders the unified
// delivery audit trail for one notification: queued → dispatched →
// provider accepted → delivered → opened / clicked / failed →
// retried → cancelled.
//
// Phase 24. Self-contained — fetches /api/admin/system/delivery-
// timeline on mount. Drop it anywhere a notification id is known
// (customer detail, campaign detail, worker detail).

import { useEffect, useState } from "react";

type TimelineEvent = {
  at: string;
  stage: string;
  source: "notification" | "dispatch_log" | "comm_event";
  detail: string;
};

type Timeline = {
  notificationId: string;
  channel: string | null;
  kind: string | null;
  status: string | null;
  events: TimelineEvent[];
};

const STAGE_TONE: Record<string, string> = {
  queued: "bg-gray-300",
  dispatched: "bg-blue-400",
  provider_accepted: "bg-blue-500",
  delivered: "bg-green-500",
  opened: "bg-emerald-500",
  clicked: "bg-emerald-600",
  retried: "bg-amber-400",
  failed: "bg-red-500",
  bounced: "bg-red-500",
  cancelled: "bg-gray-400",
  skipped: "bg-gray-400",
};

function fmt(iso: string): string {
  try {
    return new Date(iso).toLocaleString("th-TH", {
      dateStyle: "short",
      timeStyle: "medium",
    });
  } catch {
    return iso;
  }
}

export function DeliveryTimeline({
  notificationId,
}: {
  notificationId: string;
}) {
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/admin/system/delivery-timeline?notificationId=${encodeURIComponent(
            notificationId
          )}`,
          { cache: "no-store" }
        );
        const json = (await res.json()) as {
          ok?: boolean;
          reason?: string;
          timeline?: Timeline;
        };
        if (cancelled) return;
        if (!res.ok || !json.ok || !json.timeline) {
          setError(json.reason ?? `HTTP ${res.status}`);
          return;
        }
        setTimeline(json.timeline);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Network error");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [notificationId]);

  if (loading) {
    return <p className="text-[11px] text-gray-500">โหลด timeline...</p>;
  }
  if (error || !timeline) {
    return (
      <p className="text-[11px] text-red-600">
        {error ?? "โหลด timeline ไม่สำเร็จ"}
      </p>
    );
  }
  if (timeline.events.length === 0) {
    return <p className="text-[11px] text-gray-500">ยังไม่มีเหตุการณ์</p>;
  }

  return (
    <ol className="space-y-1.5">
      {timeline.events.map((e, i) => (
        <li key={`${e.at}-${i}`} className="flex items-start gap-2">
          <span
            className={`mt-1 h-2 w-2 shrink-0 rounded-full ${
              STAGE_TONE[e.stage] ?? "bg-gray-300"
            }`}
          />
          <div className="min-w-0">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="text-[11px] font-semibold text-gray-900">
                {e.stage}
              </span>
              <span className="text-[10px] text-gray-400">{fmt(e.at)}</span>
              <span className="text-[9px] uppercase tracking-wider text-gray-400">
                {e.source}
              </span>
            </div>
            <p className="text-[11px] text-gray-600 break-words">{e.detail}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}
