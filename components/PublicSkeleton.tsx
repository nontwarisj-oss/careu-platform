// Shared loading skeleton for public route segments — Phase 27C.
//
// Rendered by the per-segment `loading.tsx` files while a server
// component awaits its DB read. A single shape keeps every public
// page's loading state visually consistent. Server-safe — no hooks.

export function PublicPageSkeleton({
  cards = 6,
  variant = "grid",
}: {
  /** How many placeholder cards to draw. */
  cards?: number;
  /** "grid" — index pages; "detail" — a single record page. */
  variant?: "grid" | "detail";
}) {
  return (
    <div role="status" aria-busy="true" className="animate-pulse">
      <span className="sr-only">กำลังโหลด…</span>

      {/* Hero band */}
      <div className="bg-gradient-to-r from-gray-200 to-gray-100">
        <div className="max-w-6xl mx-auto px-4 py-10">
          <div className="h-8 w-2/3 max-w-sm rounded-lg bg-gray-300" />
          <div className="mt-3 h-4 w-1/2 max-w-xs rounded bg-gray-300/80" />
        </div>
      </div>

      {/* Body */}
      <div
        className={
          variant === "detail"
            ? "max-w-3xl mx-auto px-4 py-8 space-y-4"
            : "max-w-6xl mx-auto px-4 py-8 grid sm:grid-cols-2 lg:grid-cols-3 gap-4"
        }
      >
        {Array.from({ length: cards }).map((_, i) => (
          <div
            key={i}
            className="rounded-2xl border border-gray-200 bg-white p-5"
          >
            <div className="h-5 w-1/2 rounded bg-gray-200" />
            <div className="mt-3 h-3 w-full rounded bg-gray-100" />
            <div className="mt-2 h-3 w-3/4 rounded bg-gray-100" />
            <div className="mt-4 h-3 w-1/3 rounded bg-gray-200" />
          </div>
        ))}
      </div>
    </div>
  );
}
