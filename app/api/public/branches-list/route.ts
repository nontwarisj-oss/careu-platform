// GET /api/public/branches-list — public-facing list of active branches.
//
// Used by /quote (customer picks which branch), /mobile-intake (front-
// counter staff resolves the active branch's real UUID without needing
// direct supabase access), and any future public dropdown.
//
// Returns only the columns a public caller needs. id is the branches.id
// uuid — exposing it is safe: branches are public information and the
// uuid is already returned by every order/customer endpoint that joins
// against it. No LINE channel tokens, no operational fields.
//
// No auth, no rate-limit — read-only, identical payload for everyone.

import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { computeBranchStatus } from "@/lib/branchPublicStatus";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type BranchRow = {
  id: string;
  code: string;
  short_code: string | null;
  short_label: string | null;
  short_name: string | null;
  name: string;
  brand: string | null;
  operating_hours: Record<string, string> | null;
  manual_status: "open" | "closed" | null;
  holiday_dates: string[] | null;
};

export async function GET() {
  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json({ ok: false, branches: [] }, { status: 503 });
  }
  const { data, error } = await admin
    .from("branches")
    .select(
      "id, code, short_code, short_label, short_name, name, brand, is_active, operating_hours, manual_status, holiday_dates"
    )
    .eq("is_active", true)
    .order("code", { ascending: true });
  if (error || !data) {
    return NextResponse.json({ ok: false, branches: [] }, { status: 500 });
  }
  const branches = (data as BranchRow[]).map((b) => {
    const status = computeBranchStatus({
      manualStatus: b.manual_status,
      operatingHours: b.operating_hours,
      holidayDates: b.holiday_dates,
    });
    return {
      // Identifiers the mobile-intake page matches against — id is the
      // canonical handle to send to /api/mobile-intake/draft, which
      // converts it to branches.code for intake_drafts.branch_id.
      id: b.id,
      code: b.code,
      short_code: b.short_code,
      name: b.name,
      // Display + status fields preserved for the existing /quote consumer.
      label: b.short_label ?? b.short_name ?? b.name,
      brand: b.brand,
      status: status.status,
      statusLabel: status.label,
    };
  });
  return NextResponse.json({ ok: true, branches });
}
