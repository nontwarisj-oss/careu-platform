"use client";

// Portal nav link for the notification centre — shows an unread
// count badge. Phase 27A. Self-contained client island so the portal
// layout can stay a server component.

import { useEffect, useState } from "react";
import Link from "next/link";

export function PortalNotificationsLink() {
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/portal/notifications", {
          cache: "no-store",
        });
        if (!res.ok) return;
        const json = (await res.json()) as { unreadCount?: number };
        if (!cancelled) setUnread(json.unreadCount ?? 0);
      } catch {
        // best-effort — a missing badge is harmless
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Link
      href="/portal/notifications"
      className="relative shrink-0 px-3 py-2 rounded-full text-gray-700 hover:bg-green-50 hover:text-green-800 font-medium"
    >
      แจ้งเตือน
      {unread > 0 && (
        <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] rounded-full bg-red-600 px-1 text-[10px] font-bold text-white flex items-center justify-center">
          {unread > 99 ? "99+" : unread}
        </span>
      )}
    </Link>
  );
}
