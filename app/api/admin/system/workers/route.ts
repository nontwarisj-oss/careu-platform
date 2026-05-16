// GET /api/admin/system/workers — worker telemetry dashboard payload.
//
// Owner / hq_admin only — system-level surface. Returns:
//   • per-cron status (last run, success rate, silence, expected interval)
//   • queue health (totals, oldest queued, stuck sending)
//   • alert hits (rules that breached their threshold)
//   • overall: healthy | warning | critical
//   • Phase 25: manifestDrift, webhookMetrics, providerMetrics
//
// Read-only; no side effects. The dashboard polls this on a slow
// schedule (30 s default).

import { NextResponse } from "next/server";
import { requireRole } from "@/lib/supabaseAuth";
import { computeWorkerHealth } from "@/lib/workerHealth";
import { checkManifestDrift } from "@/lib/manifestDriftCheck";
import { webhookMetrics } from "@/lib/webhookAudit";
import { computeProviderMetrics } from "@/lib/providerMetrics";
import { webhookRetryMetrics } from "@/lib/webhookRetryQueue";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const guarded = await requireRole(["owner", "hq_admin"]);
  if (guarded instanceof NextResponse) return guarded;

  const [snapshot, manifestDrift, webhooks, providers, retryQueue] =
    await Promise.all([
      computeWorkerHealth(),
      checkManifestDrift(),
      webhookMetrics(24),
      computeProviderMetrics({ windowHours: 24 }),
      webhookRetryMetrics(24),
    ]);

  return NextResponse.json({
    ok: true,
    ...snapshot,
    manifestDrift,
    webhooks,
    providers,
    retryQueue,
  });
}
