// Email Template Service — interpolation + render + version
// management.
//
// Design:
//   • Templates are stored in public.email_templates with a JSONB
//     `variables` array listing the required keys. Render fails fast
//     when a required key is missing.
//   • Interpolation uses `{{key}}` syntax. NO logic / loops / Turing-
//     complete behaviour — Phase 18 keeps templating tight to avoid
//     accidentally writing a customer-data leak via a typo.
//   • Whitespace inside `{{ key }}` is allowed. Unknown keys
//     reference are LEFT AS-IS in the output so a typo is visible
//     to the operator rather than being silently dropped.
//   • Version history: lib/emailTemplateService.ts handles
//     emit-version-on-save. The API layer calls saveTemplateWithHistory.
//
// Server-only.

import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

// ---------- Types -------------------------------------------------------

export type TemplateRow = {
  id: string;
  slug: string;
  name: string;
  subject: string;
  preview_text: string | null;
  body_plain: string;
  body_html: string | null;
  variables: string[];
  channels: string[];
  enabled: boolean;
  current_version: number;
  branch_id: string | null;
  updated_at: string;
};

export type RenderInput = {
  templateSlug: string;
  /** Map of variable name → value. Numbers / dates / nulls all become
   *  strings via String() during interpolation. */
  context: Record<string, string | number | null | undefined>;
  /** Channel — picks body_plain vs body_html. Defaults to 'plain'. */
  channel?: "sms" | "line" | "email";
};

export type RenderResult =
  | {
      ok: true;
      subject: string;
      preview: string | null;
      body: string;
      /** For email channel: the HTML body (or null if template had
       *  no HTML body — caller wraps body_plain). */
      bodyHtml: string | null;
      missingVariables: string[];
    }
  | { ok: false; reason: string; missingVariables: string[] };

// ---------- Interpolation ----------------------------------------------

const VAR_PATTERN = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

function interpolate(
  template: string,
  context: Record<string, string | number | null | undefined>,
  missing: Set<string>
): string {
  return template.replace(VAR_PATTERN, (full, key: string) => {
    const value = context[key];
    if (value === undefined || value === null) {
      missing.add(key);
      // Leave the placeholder visible — operator sees the gap.
      return full;
    }
    return String(value);
  });
}

// ---------- Render ------------------------------------------------------

/**
 * Render a template by slug. Loads the row (cached per-tick by the
 * caller via the optional `loadedTemplate` shortcut), validates
 * required variables, and returns the per-channel body.
 */
export async function renderTemplate(
  input: RenderInput,
  options: { loadedTemplate?: TemplateRow | null } = {}
): Promise<RenderResult> {
  let template = options.loadedTemplate ?? null;
  if (!template) {
    const admin = getSupabaseAdmin();
    if (!admin) {
      return { ok: false, reason: "no admin client", missingVariables: [] };
    }
    const res = await admin
      .from("email_templates")
      .select(
        "id, slug, name, subject, preview_text, body_plain, body_html, variables, channels, enabled, current_version, branch_id, updated_at"
      )
      .eq("slug", input.templateSlug)
      .maybeSingle();
    if (res.error || !res.data) {
      return {
        ok: false,
        reason: `template "${input.templateSlug}" not found`,
        missingVariables: [],
      };
    }
    template = res.data as TemplateRow;
  }
  if (!template.enabled) {
    return {
      ok: false,
      reason: `template "${template.slug}" is disabled`,
      missingVariables: [],
    };
  }

  const channel = input.channel ?? "email";
  if (!template.channels.includes(channel)) {
    return {
      ok: false,
      reason: `template "${template.slug}" not enabled for channel "${channel}"`,
      missingVariables: [],
    };
  }

  const missing = new Set<string>();
  const subject = interpolate(template.subject, input.context, missing);
  const preview = template.preview_text
    ? interpolate(template.preview_text, input.context, missing)
    : null;
  const bodyPlain = interpolate(template.body_plain, input.context, missing);
  const bodyHtml = template.body_html
    ? interpolate(template.body_html, input.context, missing)
    : null;

  // Strict validation: required variables present in `variables`
  // array MUST be in the context — even if they weren't used in the
  // body (operators might switch channels). Missing required vars
  // is a render failure.
  const requiredMissing = (template.variables ?? []).filter(
    (k) => input.context[k] === undefined || input.context[k] === null
  );
  if (requiredMissing.length > 0) {
    return {
      ok: false,
      reason: `missing required variables: ${requiredMissing.join(", ")}`,
      missingVariables: requiredMissing,
    };
  }

  const body = channel === "email" ? (bodyHtml ?? bodyPlain) : bodyPlain;

  return {
    ok: true,
    subject,
    preview,
    body,
    bodyHtml,
    missingVariables: Array.from(missing),
  };
}

// ---------- Save + Version history --------------------------------------

export type SaveTemplateInput = {
  /** When set, updates the existing template. When null, creates a new one. */
  id?: string | null;
  slug: string;
  name: string;
  subject: string;
  previewText?: string | null;
  bodyPlain: string;
  bodyHtml?: string | null;
  variables: string[];
  channels: string[];
  enabled?: boolean;
  branchId?: string | null;
  actorId?: string | null;
  editReason?: string | null;
};

export type SaveTemplateResult =
  | { ok: true; id: string; version: number }
  | { ok: false; reason: string };

/**
 * Persist a template + write an immutable version row capturing the
 * previous content. The "version" model: existing template at v=N
 * → save creates a v=N row in email_template_versions, then updates
 * the live row to v=N+1.
 */
export async function saveTemplateWithHistory(
  input: SaveTemplateInput
): Promise<SaveTemplateResult> {
  const admin = getSupabaseAdmin();
  if (!admin) return { ok: false, reason: "no admin client" };

  // Slug is only required when CREATING. Updates keep the existing
  // slug intact unless the caller passes a new one.
  const cleanedSlug = input.slug.trim().toLowerCase();
  if (!input.id) {
    if (!cleanedSlug || !/^[a-z0-9_-]+$/.test(cleanedSlug)) {
      return {
        ok: false,
        reason: "slug ต้องเป็น a-z, 0-9, _, - เท่านั้น",
      };
    }
  } else if (cleanedSlug && !/^[a-z0-9_-]+$/.test(cleanedSlug)) {
    return {
      ok: false,
      reason: "slug ต้องเป็น a-z, 0-9, _, - เท่านั้น",
    };
  }
  if (!input.bodyPlain.trim()) {
    return { ok: false, reason: "body_plain ห้ามว่าง" };
  }
  if (input.channels.length === 0) {
    return { ok: false, reason: "ต้องเลือกอย่างน้อย 1 channel" };
  }

  if (input.id) {
    // Update path.
    const existing = await admin
      .from("email_templates")
      .select(
        "id, slug, name, subject, preview_text, body_plain, body_html, variables, channels, current_version"
      )
      .eq("id", input.id)
      .maybeSingle();
    if (existing.error || !existing.data) {
      return { ok: false, reason: "template not found" };
    }
    const e = existing.data as {
      id: string;
      slug: string;
      name: string;
      subject: string;
      preview_text: string | null;
      body_plain: string;
      body_html: string | null;
      variables: string[];
      channels: string[];
      current_version: number;
    };
    // 1. Snapshot current row to email_template_versions BEFORE
    //    overwriting.
    await admin.from("email_template_versions").insert({
      template_id: e.id,
      version: e.current_version,
      name: e.name,
      subject: e.subject,
      preview_text: e.preview_text,
      body_plain: e.body_plain,
      body_html: e.body_html,
      variables: e.variables,
      channels: e.channels,
      edited_by: input.actorId ?? null,
      edit_reason: input.editReason ?? null,
    });
    // 2. Update the live row with the new content + incremented
    //    version. slug only changes if the caller passed a new one.
    const newVersion = e.current_version + 1;
    const updatePayload: Record<string, unknown> = {
      name: input.name.trim(),
      subject: input.subject,
      preview_text: input.previewText ?? null,
      body_plain: input.bodyPlain,
      body_html: input.bodyHtml ?? null,
      variables: input.variables,
      channels: input.channels,
      enabled: input.enabled ?? true,
      branch_id: input.branchId ?? null,
      current_version: newVersion,
      updated_by: input.actorId ?? null,
    };
    if (cleanedSlug) updatePayload.slug = cleanedSlug;
    const upd = await admin
      .from("email_templates")
      .update(updatePayload)
      .eq("id", e.id);
    if (upd.error) {
      return { ok: false, reason: upd.error.message };
    }
    return { ok: true, id: e.id, version: newVersion };
  }

  // Insert path — brand new template.
  const ins = await admin
    .from("email_templates")
    .insert({
      slug: cleanedSlug,
      name: input.name.trim(),
      subject: input.subject,
      preview_text: input.previewText ?? null,
      body_plain: input.bodyPlain,
      body_html: input.bodyHtml ?? null,
      variables: input.variables,
      channels: input.channels,
      enabled: input.enabled ?? true,
      branch_id: input.branchId ?? null,
      current_version: 1,
      created_by: input.actorId ?? null,
      updated_by: input.actorId ?? null,
    })
    .select("id")
    .single();
  if (ins.error || !ins.data) {
    return { ok: false, reason: ins.error?.message ?? "Insert failed" };
  }
  return { ok: true, id: (ins.data as { id: string }).id, version: 1 };
}

// ---------- Restore from version ----------------------------------------

export type RestoreInput = {
  templateId: string;
  versionId: string;
  actorId?: string | null;
  reason?: string | null;
};

export async function restoreTemplateVersion(
  input: RestoreInput
): Promise<SaveTemplateResult> {
  const admin = getSupabaseAdmin();
  if (!admin) return { ok: false, reason: "no admin client" };

  const verRes = await admin
    .from("email_template_versions")
    .select(
      "id, template_id, name, subject, preview_text, body_plain, body_html, variables, channels"
    )
    .eq("id", input.versionId)
    .eq("template_id", input.templateId)
    .maybeSingle();
  if (verRes.error || !verRes.data) {
    return { ok: false, reason: "version not found" };
  }
  const v = verRes.data as {
    template_id: string;
    name: string;
    subject: string;
    preview_text: string | null;
    body_plain: string;
    body_html: string | null;
    variables: string[];
    channels: string[];
  };

  // Use the regular save path — it captures the current content as a
  // new version BEFORE overwriting, so the restore itself is fully
  // audited.
  return saveTemplateWithHistory({
    id: v.template_id,
    slug: "", // ignored on update — saveTemplateWithHistory reads existing
    name: v.name,
    subject: v.subject,
    previewText: v.preview_text,
    bodyPlain: v.body_plain,
    bodyHtml: v.body_html,
    variables: v.variables,
    channels: v.channels,
    actorId: input.actorId,
    editReason: input.reason ?? "restored from version",
  });
}
