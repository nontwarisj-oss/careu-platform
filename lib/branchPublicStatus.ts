// Branch Public Status — computes a branch's open / closed state for
// the public website.
//
// Phase 27D. Resolution order:
//   1. manual_status = 'open' | 'closed' — an explicit operator
//      override always wins.
//   2. Today is in holiday_dates → closed.
//   3. operating_hours has a window for today's weekday →
//      open / closed by the current Bangkok time.
//   4. Nothing configured → 'unknown' (the page shows a neutral
//      "contact the branch" line — never a crash).
//
// Pure + dependency-free — usable from server components, the
// branches-list API, and the homepage.

export type BranchOpenStatus = "open" | "closed" | "unknown";

export type BranchStatusInput = {
  manualStatus?: string | null;
  /** { mon: "09:00-19:00", ..., note?: string } */
  operatingHours?: Record<string, string> | null;
  /** ISO date strings, e.g. ["2026-12-31"]. */
  holidayDates?: string[] | null;
};

export type BranchStatusResult = {
  status: BranchOpenStatus;
  /** Short Thai label for a badge. */
  label: string;
  /** Why — for tooltips / debugging. */
  reason: string;
};

const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function bangkokNow(now: Date): { dayKey: string; minutes: number; iso: string } {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Bangkok",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour12: false,
    }).formatToParts(now);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    const hour = Number(get("hour")) % 24;
    const minute = Number(get("minute"));
    // weekday short → index
    const wd = get("weekday").toLowerCase().slice(0, 3);
    const map: Record<string, string> = {
      sun: "sun",
      mon: "mon",
      tue: "tue",
      wed: "wed",
      thu: "thu",
      fri: "fri",
      sat: "sat",
    };
    const iso = `${get("year")}-${get("month")}-${get("day")}`;
    return { dayKey: map[wd] ?? "mon", minutes: hour * 60 + minute, iso };
  } catch {
    const d = new Date(now.getTime() + 7 * 60 * 60 * 1000);
    return {
      dayKey: DAY_KEYS[d.getUTCDay()],
      minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
      iso: d.toISOString().slice(0, 10),
    };
  }
}

/** Parse "09:00-19:00" → [540, 1140]. Returns null on a bad value. */
function parseWindow(raw: string): [number, number] | null {
  const m = /^(\d{1,2}):(\d{2})\s*[-–]\s*(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (!m) return null;
  const start = Number(m[1]) * 60 + Number(m[2]);
  const end = Number(m[3]) * 60 + Number(m[4]);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return [start, end];
}

export function computeBranchStatus(
  input: BranchStatusInput,
  now: Date = new Date()
): BranchStatusResult {
  // 1. Manual override.
  if (input.manualStatus === "open") {
    return { status: "open", label: "เปิดให้บริการ", reason: "manual override" };
  }
  if (input.manualStatus === "closed") {
    return { status: "closed", label: "ปิดชั่วคราว", reason: "manual override" };
  }

  const { dayKey, minutes, iso } = bangkokNow(now);

  // 2. Holiday.
  const holidays = Array.isArray(input.holidayDates)
    ? input.holidayDates
    : [];
  if (holidays.includes(iso)) {
    return { status: "closed", label: "ปิด (วันหยุด)", reason: "holiday" };
  }

  // 3. Operating hours for today.
  const hours = input.operatingHours;
  if (!hours || typeof hours !== "object") {
    return {
      status: "unknown",
      label: "ติดต่อสาขา",
      reason: "no operating hours configured",
    };
  }
  const todayRaw = hours[dayKey];
  if (!todayRaw || !todayRaw.trim()) {
    return { status: "closed", label: "ปิดวันนี้", reason: "no window today" };
  }
  const win = parseWindow(todayRaw);
  if (!win) {
    return {
      status: "unknown",
      label: "ติดต่อสาขา",
      reason: "unparseable hours",
    };
  }
  const [start, end] = win;
  if (minutes >= start && minutes < end) {
    return { status: "open", label: "เปิดให้บริการ", reason: "within hours" };
  }
  return { status: "closed", label: "ปิดแล้ววันนี้", reason: "outside hours" };
}
