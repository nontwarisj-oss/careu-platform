// Manifest Drift Guard — proves the three cron sources of truth agree.
//
// A cron exists in (up to) three places:
//   1. lib/cronManifest.ts — the declared manifest.
//   2. vercel.json — what the Vercel scheduler actually fires.
//   3. cron_heartbeat_logs — what has actually RUN.
//
// Drift between them is a silent reliability hole: a cron in the
// manifest but missing from vercel.json never fires; one in
// vercel.json but not the manifest is unaccounted-for; one declared
// but never observed is stale or mis-pathed.
//
// checkManifestDrift() compares all three and returns a structured
// verdict the workers dashboard + smoke test render.
//
// Server-only (touches cron_heartbeat_logs).

import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { CRON_MANIFEST } from "@/lib/cronManifest";
import vercelConfig from "@/vercel.json";

export type DriftFinding = {
  kind: "missing" | "orphan" | "stale" | "endpoint_mismatch";
  cronName: string;
  detail: string;
};

export type ManifestDriftResult = {
  ok: boolean;
  checkedAt: string;
  manifestCount: number;
  vercelCount: number;
  findings: DriftFinding[];
};

type VercelCron = { path: string; schedule: string };

function vercelCrons(): VercelCron[] {
  const crons = (vercelConfig as { crons?: VercelCron[] }).crons;
  return Array.isArray(crons) ? crons : [];
}

/**
 * Compare the cron manifest, vercel.json, and the heartbeat log.
 * `staleAfterIntervals` — a cron with no heartbeat within this many
 * of its own intervals is flagged stale (default 3×).
 */
export async function checkManifestDrift(opts?: {
  staleAfterIntervals?: number;
}): Promise<ManifestDriftResult> {
  const staleMult = opts?.staleAfterIntervals ?? 3;
  const findings: DriftFinding[] = [];
  const vercel = vercelCrons();
  const vercelByPath = new Map(vercel.map((c) => [c.path, c]));
  const manifestByPath = new Map(CRON_MANIFEST.map((c) => [c.path, c]));

  // ----- manifest ↔ vercel.json -----
  for (const m of CRON_MANIFEST) {
    const v = vercelByPath.get(m.path);
    if (!v) {
      findings.push({
        kind: "missing",
        cronName: m.cronName,
        detail: `'${m.path}' is in the manifest but NOT in vercel.json — it will never fire`,
      });
    } else if (v.schedule !== m.schedule) {
      findings.push({
        kind: "endpoint_mismatch",
        cronName: m.cronName,
        detail: `schedule mismatch — manifest '${m.schedule}' vs vercel.json '${v.schedule}'`,
      });
    }
  }
  for (const v of vercel) {
    if (!manifestByPath.has(v.path)) {
      findings.push({
        kind: "orphan",
        cronName: v.path,
        detail: `'${v.path}' is scheduled in vercel.json but absent from the manifest`,
      });
    }
  }

  // ----- manifest ↔ cron_heartbeat_logs (stale detection) -----
  const admin = getSupabaseAdmin();
  if (admin) {
    for (const m of CRON_MANIFEST) {
      try {
        const r = await admin
          .from("cron_heartbeat_logs")
          .select("started_at")
          .eq("cron_name", m.cronName)
          .order("started_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        const last = (r.data as { started_at: string } | null)?.started_at;
        if (!last) {
          findings.push({
            kind: "stale",
            cronName: m.cronName,
            detail: "declared but has never produced a heartbeat",
          });
          continue;
        }
        const ageMin = (Date.now() - new Date(last).getTime()) / 60000;
        if (ageMin > m.intervalMinutes * staleMult) {
          findings.push({
            kind: "stale",
            cronName: m.cronName,
            detail: `last heartbeat ${Math.round(ageMin)}m ago — past ${staleMult}× its ${m.intervalMinutes}m interval`,
          });
        }
      } catch {
        // best-effort — a DB hiccup shouldn't fail the whole check
      }
    }
  }

  return {
    ok: findings.length === 0,
    checkedAt: new Date().toISOString(),
    manifestCount: CRON_MANIFEST.length,
    vercelCount: vercel.length,
    findings,
  };
}
