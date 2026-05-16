// GET / PATCH /api/portal/profile — customer's own profile.
//
// GET returns name + email + branch label + tier + lifecycle stage +
// lifetime spend + total orders. PATCH lets the customer update name +
// email only (phone change goes through a separate OTP-on-new-number
// flow in a future phase — too sensitive to allow without re-verification).

import { NextResponse } from "next/server";
import { readCustomerSessionFromCookies } from "@/lib/customerSession";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PROFILE_COLUMNS =
  "id, name, phone, email, address, customer_tier, lifecycle_stage, branch_id, last_visit_at, total_orders, lifetime_spend, birth_date, birth_month_verified, preferred_branch_id, preferred_language, preferred_contact_channel, preferred_pickup_time";

// Phase 27A — accepted values for the saved-preference fields.
const PREF_LANGUAGES = new Set(["th", "en"]);
const PREF_CHANNELS = new Set(["sms", "line", "email"]);
const PREF_PICKUP = new Set(["morning", "afternoon", "evening"]);

export async function GET() {
  const session = await readCustomerSessionFromCookies();
  if (!session) {
    return NextResponse.json(
      { ok: false, reason: "ยังไม่ได้เข้าสู่ระบบ" },
      { status: 401 }
    );
  }
  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json(
      { ok: false, reason: "SERVICE_ROLE_KEY ยังไม่ตั้งค่า" },
      { status: 503 }
    );
  }
  const res = await admin
    .from("customers")
    .select(PROFILE_COLUMNS)
    .eq("id", session.customerId)
    .maybeSingle();
  if (res.error || !res.data) {
    return NextResponse.json(
      { ok: false, reason: "ไม่พบโปรไฟล์" },
      { status: 404 }
    );
  }
  const row = res.data as Record<string, unknown>;
  return NextResponse.json({
    ok: true,
    profile: {
      id: row.id,
      name: row.name ?? "",
      phone: row.phone ?? "",
      email: row.email === "N/A" ? "" : (row.email as string) ?? "",
      address: row.address === "N/A" ? "" : (row.address as string) ?? "",
      tier: row.customer_tier ?? null,
      lifecycle: row.lifecycle_stage ?? null,
      branchId: row.branch_id ?? null,
      lastVisitAt: row.last_visit_at ?? null,
      totalOrders: Number(row.total_orders ?? 0),
      lifetimeSpend: Number(row.lifetime_spend ?? 0),
      birthDate: (row.birth_date as string | null) ?? null,
      birthMonthVerified: !!row.birth_month_verified,
      preferredBranchId: (row.preferred_branch_id as string | null) ?? null,
      preferredLanguage: (row.preferred_language as string | null) ?? null,
      preferredContactChannel:
        (row.preferred_contact_channel as string | null) ?? null,
      preferredPickupTime:
        (row.preferred_pickup_time as string | null) ?? null,
    },
  });
}

type PatchBody = {
  name?: string;
  email?: string;
  /** ISO date string YYYY-MM-DD. Optional + customer-supplied — when
   *  set, also flips birth_month_verified=true so the birthday
   *  trigger knows it can use this DOB. */
  birthDate?: string | null;
  /** Phase 27A saved preferences — each independently optional;
   *  null clears the preference. */
  preferredBranchId?: string | null;
  preferredLanguage?: string | null;
  preferredContactChannel?: string | null;
  preferredPickupTime?: string | null;
};

export async function PATCH(req: Request) {
  const session = await readCustomerSessionFromCookies();
  if (!session) {
    return NextResponse.json(
      { ok: false, reason: "ยังไม่ได้เข้าสู่ระบบ" },
      { status: 401 }
    );
  }
  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json(
      { ok: false, reason: "SERVICE_ROLE_KEY ยังไม่ตั้งค่า" },
      { status: 503 }
    );
  }
  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json(
      { ok: false, reason: "Invalid JSON body" },
      { status: 400 }
    );
  }
  const name = (body.name ?? "").trim().slice(0, 200);
  const email = (body.email ?? "").trim().slice(0, 200);
  const patch: Record<string, unknown> = {};
  if (name) patch.name = name;
  if (email) patch.email = email;

  // Phase 19 — DOB is optional and customer-supplied. Setting it
  // flips birth_month_verified=true. Clearing it (null) sets the
  // flag back to false. Year is required by Postgres date but the
  // birthday trigger only uses the MONTH part, so a privacy-conscious
  // customer can put year=1900.
  if (body.birthDate !== undefined) {
    if (body.birthDate === null || body.birthDate === "") {
      patch.birth_date = null;
      patch.birth_month_verified = false;
    } else {
      // Defensive parse — refuse anything that doesn't look like a
      // valid ISO date.
      const parsed = new Date(body.birthDate);
      if (Number.isNaN(parsed.getTime())) {
        return NextResponse.json(
          { ok: false, reason: "วันเกิดไม่ถูกต้อง" },
          { status: 400 }
        );
      }
      patch.birth_date = body.birthDate;
      patch.birth_month_verified = true;
    }
  }

  // Phase 27A — saved preferences. Each is validated against its
  // allow-list; an empty string / null clears it.
  if (body.preferredBranchId !== undefined) {
    patch.preferred_branch_id =
      body.preferredBranchId?.trim() || null;
  }
  if (body.preferredLanguage !== undefined) {
    const v = body.preferredLanguage?.trim() ?? "";
    if (v && !PREF_LANGUAGES.has(v)) {
      return NextResponse.json(
        { ok: false, reason: "ภาษาที่เลือกไม่ถูกต้อง" },
        { status: 400 }
      );
    }
    patch.preferred_language = v || null;
  }
  if (body.preferredContactChannel !== undefined) {
    const v = body.preferredContactChannel?.trim() ?? "";
    if (v && !PREF_CHANNELS.has(v)) {
      return NextResponse.json(
        { ok: false, reason: "ช่องทางติดต่อไม่ถูกต้อง" },
        { status: 400 }
      );
    }
    patch.preferred_contact_channel = v || null;
  }
  if (body.preferredPickupTime !== undefined) {
    const v = body.preferredPickupTime?.trim() ?? "";
    if (v && !PREF_PICKUP.has(v)) {
      return NextResponse.json(
        { ok: false, reason: "ช่วงเวลารับงานไม่ถูกต้อง" },
        { status: 400 }
      );
    }
    patch.preferred_pickup_time = v || null;
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json(
      { ok: false, reason: "ไม่มีฟิลด์ให้บันทึก" },
      { status: 400 }
    );
  }
  const res = await admin
    .from("customers")
    .update(patch)
    .eq("id", session.customerId);
  if (res.error) {
    return NextResponse.json(
      { ok: false, reason: res.error.message },
      { status: 500 }
    );
  }
  return NextResponse.json({ ok: true });
}
