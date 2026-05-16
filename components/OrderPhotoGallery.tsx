"use client";

// <OrderPhotoGallery> — Store Ops Hardening, order-level photo gallery.
//
// A consolidated, read-only view of every repair photo on a ticket,
// grouped by item (intake / damage reference / before-after all live on
// order_items.image_paths). One batched signed-URL fetch; tap a
// thumbnail for a full-screen preview. Mobile/tablet-first.
//
// Reuses /api/admin/order-images — no new storage system.

import { useEffect, useState } from "react";
import type { OrderItemRow } from "@/lib/orderItems";

export function OrderPhotoGallery({ items }: { items: OrderItemRow[] }) {
  const groups = items
    .map((it) => ({
      key: it.id,
      name: `${it.line_no}. ${it.service_name}`,
      paths: Array.isArray(it.image_paths) ? it.image_paths : [],
    }))
    .filter((g) => g.paths.length > 0);

  const allPaths = groups.flatMap((g) => g.paths);
  const pathKey = allPaths.join(",");

  const [resolved, setResolved] = useState<Record<string, string>>({});
  const [lightbox, setLightbox] = useState<string | null>(null);

  useEffect(() => {
    if (allPaths.length === 0) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/admin/order-images", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ paths: allPaths }),
        });
        const json = (await res.json()) as { urls?: Record<string, string> };
        if (!cancelled && json.urls) setResolved(json.urls);
      } catch {
        // Leave unresolved — thumbnails show a neutral placeholder.
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathKey]);

  if (groups.length === 0) return null;

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <p className="text-[10px] uppercase tracking-widest text-gray-500 font-semibold">
        รูปงานทั้งหมด ({allPaths.length})
      </p>
      <div className="mt-2 space-y-3">
        {groups.map((g) => (
          <div key={g.key}>
            <p className="text-xs font-medium text-gray-700">{g.name}</p>
            <div className="mt-1 flex flex-wrap gap-2">
              {g.paths.map((p) => (
                <button
                  type="button"
                  key={p}
                  onClick={() => resolved[p] && setLightbox(resolved[p])}
                  className="h-20 w-20 overflow-hidden rounded-lg border border-gray-200 bg-gray-100"
                >
                  {resolved[p] ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={resolved[p]}
                      alt="repair photo"
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <span className="flex h-full w-full items-center justify-center text-[10px] text-gray-400">
                      …
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      {lightbox && (
        <div
          onClick={() => setLightbox(null)}
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-4"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={lightbox}
            alt="repair photo"
            className="max-h-full max-w-full rounded-lg"
          />
        </div>
      )}
    </div>
  );
}

export default OrderPhotoGallery;
