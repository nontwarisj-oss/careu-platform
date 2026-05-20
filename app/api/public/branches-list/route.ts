import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type BranchRow = {
  id: string;
  code: string;
  short_code: string | null;
  name: string;
  brand: string | null;
  is_active: boolean | null;
};

export async function GET() {
  const admin = getSupabaseAdmin();

  if (!admin) {
    return NextResponse.json(
      { ok: false, branches: [], error: "service role not configured" },
      { status: 503 }
    );
  }

  const { data, error } = await admin
    .from("branches")
    .select("id, code, short_code, name, brand, is_active")
    .eq("is_active", true)
    .order("code", { ascending: true });

  if (error) {
    console.error("[public/branches-list] load failed", error);
    return NextResponse.json(
      { ok: false, branches: [], error: error.message },
      { status: 500 }
    );
  }

  const branches = ((data ?? []) as BranchRow[]).map((b) => ({
    id: b.id,
    code: b.code,
    short_code: b.short_code,
    name: b.name,
    label: b.name,
    brand: b.brand,
    status: "open",
    statusLabel: "เปิดให้บริการ",
  }));

  return NextResponse.json({ ok: true, branches });
}
