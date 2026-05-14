// GET /api/public/branches-list — public-facing list of active branches.
//
// Used by /quote (the customer picks which branch they want to use) and
// any future public dropdown. Returns only the columns the customer
// needs — no internal ids, no LINE channel tokens, no operational fields.
//
// No auth, no rate-limit on this endpoint — it's read-only and the
// payload is the same for everyone (the branches table contents are
// already public information).

import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type BranchRow = {
  code: string;
  short_label: string | null;
  short_name: string | null;
  name: string;
  brand: string | null;
};

export async function GET() {
  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json({ ok: false, branches: [] }, { status: 503 });
  }
  const { data, error } = await admin
    .from("branches")
    .select("code, short_label, short_name, name, brand, is_active")
    .eq("is_active", true)
    .order("code", { ascending: true });
  if (error || !data) {
    return NextResponse.json({ ok: false, branches: [] }, { status: 500 });
  }
  const branches = (data as BranchRow[]).map((b) => ({
    code: b.code,
    label: b.short_label ?? b.short_name ?? b.name,
    brand: b.brand,
  }));
  return NextResponse.json({ ok: true, branches });
}
