// POST /api/admin/onboarding/create-branch — create a new branches row.
//
// Auth model:
//   • requireRole(owner / hq_admin). branch_manager is intentionally
//     excluded — onboarding adds a new branch to the chain, which is an
//     HQ concern.
//
// Safety rules:
//   • `code` and `short_code` must be non-empty.
//   • `code` must be unique — checked server-side and surfaced as a
//     friendly 409 conflict rather than a raw constraint violation.
//   • New branches default to `is_active = false`. The caller decides when
//     to activate (separate request).
//   • Optional `branch_line_configs` placeholder row is created so the
//     channel token can be set later without a separate insert.
//
// Body:
//   {
//     code: string,           // canonical slug, becomes branches.code
//     short_code: string,     // Ezy job-id prefix (3-letter)
//     name: string,           // human-readable shop name
//     type?: "care_u" | "ezy_repair" | "mixed",  // defaults to "mixed"
//     brand?: "careu" | "ezy" | null,
//     createLineConfig?: boolean,  // when true, also insert a stub
//                                  //   branch_line_configs row
//   }

import { NextResponse } from "next/server";
import { requireRole } from "@/lib/supabaseAuth";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Body = {
  code?: string;
  short_code?: string;
  name?: string;
  type?: "care_u" | "ezy_repair" | "mixed";
  brand?: string | null;
  createLineConfig?: boolean;
  /** UI-metadata mirror (post-`20260533`). All optional — branchContext
   *  falls back to lib/brandConfig.ts seed when a column is null, so the
   *  wizard MAY skip these and a sensible default still renders. */
  short_label?: string | null;
  short_name?: string | null;
  receipt_name?: string | null;
  tagline?: string | null;
  address?: string | null;
  phone?: string | null;
  logo_path?: string | null;
  accent_class?: string | null;
};

const CODE_REGEX = /^[a-z0-9][a-z0-9-]{1,63}$/;
const SHORT_CODE_REGEX = /^[A-Z0-9]{2,8}$/;
const ALLOWED_TYPES = new Set(["care_u", "ezy_repair", "mixed"]);

export async function POST(req: Request) {
  const guarded = await requireRole(["owner", "hq_admin"]);
  if (guarded instanceof NextResponse) return guarded;
  const profile = guarded.profile;

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json(
      { ok: false, reason: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const code = (body.code ?? "").trim();
  const shortCode = (body.short_code ?? "").trim().toUpperCase();
  const name = (body.name ?? "").trim();
  const type = body.type ?? "mixed";

  // Field-level validation — return one issue at a time so the UI can
  // surface a friendly Thai message.
  if (!code) {
    return NextResponse.json(
      { ok: false, reason: "ระบุ branch code (slug)" },
      { status: 400 }
    );
  }
  if (!CODE_REGEX.test(code)) {
    return NextResponse.json(
      {
        ok: false,
        reason:
          "branch code ใช้ได้เฉพาะตัวพิมพ์เล็ก a-z, ตัวเลข 0-9, และ - (ความยาว 2–64)",
      },
      { status: 400 }
    );
  }
  if (!shortCode || !SHORT_CODE_REGEX.test(shortCode)) {
    return NextResponse.json(
      {
        ok: false,
        reason: "short_code ใช้ตัวพิมพ์ใหญ่หรือเลข ความยาว 2–8 (เช่น SLM, C24)",
      },
      { status: 400 }
    );
  }
  if (!name) {
    return NextResponse.json(
      { ok: false, reason: "ระบุชื่อสาขา" },
      { status: 400 }
    );
  }
  if (!ALLOWED_TYPES.has(type)) {
    return NextResponse.json(
      { ok: false, reason: `type ต้องเป็น ${Array.from(ALLOWED_TYPES).join(" / ")}` },
      { status: 400 }
    );
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json(
      { ok: false, reason: "SUPABASE_SERVICE_ROLE_KEY ยังไม่ได้ตั้งค่า" },
      { status: 503 }
    );
  }

  // Duplicate-code check — surface as a friendly 409 rather than a raw
  // unique-constraint violation.
  const existing = await admin
    .from("branches")
    .select("id, code")
    .eq("code", code)
    .maybeSingle();
  if (!existing.error && existing.data) {
    return NextResponse.json(
      {
        ok: false,
        reason: `branch code "${code}" มีอยู่แล้ว — เลือกอันใหม่`,
        existingBranchId: (existing.data as { id: string }).id,
      },
      { status: 409 }
    );
  }

  // Sensible defaults for UI fields so the new branch renders correctly
  // immediately. Operator can refine later via SQL or a future "edit
  // branch" UI. short_label defaults to "<short_code> • <name>" which
  // matches the branchContext fallback rendering.
  const ui = {
    short_label:
      (body.short_label ?? "").trim() || `${shortCode} • ${name}`,
    short_name: (body.short_name ?? "").trim() || name,
    receipt_name: (body.receipt_name ?? "").trim() || name,
    tagline: (body.tagline ?? "").trim() || null,
    address: (body.address ?? "").trim() || null,
    phone: (body.phone ?? "").trim() || "N/A",
    logo_path:
      (body.logo_path ?? "").trim() ||
      (body.brand === "ezy"
        ? "/logos/ezy-repair.svg"
        : "/logos/c24-careu.svg"),
    accent_class:
      (body.accent_class ?? "").trim() ||
      (body.brand === "ezy"
        ? "from-green-800 to-lime-700"
        : "from-green-700 to-emerald-600"),
  };

  // Insert the new branch as inactive.
  const insert = await admin
    .from("branches")
    .insert({
      code,
      short_code: shortCode,
      name,
      type,
      brand: body.brand ?? null,
      is_active: false,
      ...ui,
    })
    .select(
      "id, code, short_code, name, type, brand, is_active, created_at, short_label, short_name, receipt_name, tagline, address, phone, logo_path, accent_class"
    )
    .single();
  if (insert.error || !insert.data) {
    return NextResponse.json(
      { ok: false, reason: insert.error?.message ?? "Insert failed" },
      { status: 500 }
    );
  }
  const branch = insert.data as {
    id: string;
    code: string;
    short_code: string;
    name: string;
    type: string;
    brand: string | null;
    is_active: boolean;
    created_at: string;
  };

  // Optional LINE-config placeholder. The token stays NULL until HQ
  // configures it via SQL or a future channel-config UI — having the
  // row in place makes that future write a plain UPDATE.
  if (body.createLineConfig) {
    const cfgRes = await admin
      .from("branch_line_configs")
      .insert({ branch_id: branch.id })
      .select("branch_id")
      .maybeSingle();
    if (cfgRes.error) {
      // Non-fatal — the branch is created, surface the warning.
      console.warn(
        "[onboarding] branch_line_configs insert failed:",
        cfgRes.error.message
      );
    }
  }

  return NextResponse.json({
    ok: true,
    branch,
    createdBy: profile.id,
    nextSteps: [
      "Set lib/brandConfig.ts entry (mirror of branches table) so the UI labels render.",
      "Add staff via /admin/staff and pin them to this branch.",
      "If applicable: insert branch_line_configs.channel_access_token.",
      "Activate the branch (separate request when ready).",
    ],
  });
}
