"use client";

// /admin/customers/[id] — unified admin view of one customer.
//
// Read-only this phase. Surfaces the data already collected by the
// platform in a single page so operators can answer questions like
// "what notifications has this customer received?" without bouncing
// between recovery / dispatch / customers tabs.
//
// Auth via RouteGuard page="customers" — owner / hq_admin /
// branch_manager / front_staff are allowed; the API additionally
// enforces branch scope so a branch_manager can't read a customer
// outside their branch even if they URL-hop.

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { RouteGuard } from "@/components/RouteGuard";

type Customer = {
  id: string;
  name: string | null;
  phone: string | null;
  normalized_phone: string | null;
  email: string | null;
  branch_id: string | null;
  customer_type: string | null;
  customer_tier: string | null;
  lifecycle_stage: string | null;
  retention_score: number | null;
  total_orders: number | null;
  lifetime_spend: number | null;
  last_visit_at: string | null;
  created_at: string;
};

type Prefs = {
  sms_enabled: boolean;
  line_enabled: boolean;
  email_enabled: boolean;
  pickup_reminders: boolean;
  order_status_alerts: boolean;
  payment_alerts: boolean;
  promotional: boolean;
  last_updated_at: string | null;
};

type OrderRow = {
  id: string;
  job_id: string | null;
  status: string;
  payment_status: string | null;
  service_name: string | null;
  item_name: string | null;
  price: number | null;
  due_date: string | null;
  created_at: string;
  branch_id: string | null;
};

type ActivityRow = {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  created_at: string;
  branch_id: string | null;
};

type NotificationRow = {
  id: string;
  channel: string;
  kind: string;
  status: string;
  attempts: number;
  sent_at: string | null;
  error_reason: string | null;
  created_at: string;
};

type DispatchRow = {
  id: string;
  channel: string;
  kind: string;
  outcome: string;
  retryable: boolean;
  attempt: number;
  latency_ms: number | null;
  provider: string | null;
  reason: string | null;
  created_at: string;
};

type LineLink = {
  id: string;
  line_user_id: string;
  display_name: string | null;
  consented_at: string | null;
  unsubscribed_at: string | null;
  created_at: string;
};

type PageData = {
  customer: Customer;
  prefs: Prefs | null;
  orders: OrderRow[];
  activity: ActivityRow[];
  notifications: NotificationRow[];
  dispatchLog: DispatchRow[];
  lineLink: LineLink | null;
  uploadCount: number;
};

const STATUS_PILL: Record<string, string> = {
  pending: "border-yellow-200 bg-yellow-50 text-yellow-800",
  "in-progress": "border-blue-200 bg-blue-50 text-blue-800",
  "ready-for-pickup": "border-purple-200 bg-purple-50 text-purple-900",
  completed: "border-green-200 bg-green-50 text-green-800",
  cancelled: "border-red-200 bg-red-50 text-red-800",
};

const OUTCOME_PILL: Record<string, string> = {
  sent: "border-green-200 bg-green-50 text-green-800",
  failed: "border-red-200 bg-red-50 text-red-800",
  skipped: "border-gray-200 bg-gray-50 text-gray-700",
};

function fmt(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("th-TH", {
      dateStyle: "short",
      timeStyle: "short",
    });
  } catch {
    return iso;
  }
}

export default function AdminCustomerPage() {
  return (
    <RouteGuard page="customers">
      <Inner />
    </RouteGuard>
  );
}

function Inner() {
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const [data, setData] = useState<PageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    setError(null);
    try {
      const res = await fetch(`/api/admin/customers/${id}`, {
        cache: "no-store",
      });
      if (res.status === 403 || res.status === 404) {
        setError(
          res.status === 403
            ? "ไม่มีสิทธิ์ดูลูกค้ารายนี้ (อยู่นอกสาขาคุณ)"
            : "ไม่พบลูกค้า"
        );
        setLoading(false);
        return;
      }
      const json = (await res.json()) as PageData & { ok?: boolean; reason?: string };
      if (!json.ok) {
        setError(json.reason ?? `โหลดล้มเหลว (HTTP ${res.status})`);
        return;
      }
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <div className="flex-1 min-h-screen bg-gradient-to-br from-green-50/40 via-white to-yellow-50/40 p-4 md:p-8 pt-20 md:pt-8">
        <div className="mx-auto max-w-5xl space-y-4">
          <div className="h-7 w-1/3 bg-gray-200 rounded animate-pulse" />
          <div className="h-32 rounded-2xl bg-white animate-pulse" />
          <div className="h-32 rounded-2xl bg-white animate-pulse" />
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex-1 min-h-screen p-4 md:p-8 pt-20 md:pt-8">
        <div className="mx-auto max-w-md rounded-2xl border border-red-200 bg-red-50 p-5 text-sm text-red-700">
          {error ?? "ไม่พบข้อมูล"}
          <div className="mt-3">
            <Link
              href="/customers"
              className="text-green-700 underline"
            >
              กลับไปหน้ารายการลูกค้า
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const c = data.customer;

  return (
    <div className="flex-1 min-h-screen bg-gradient-to-br from-green-50/40 via-white to-yellow-50/40 p-4 md:p-8 pt-20 md:pt-8">
      <div className="mx-auto max-w-5xl space-y-5">
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <Link href="/customers" className="hover:text-green-700">
            ลูกค้า
          </Link>
          <span>/</span>
          <span className="text-gray-700 font-medium">
            {c.name ?? "(ไม่มีชื่อ)"}
          </span>
        </div>

        <section className="rounded-2xl border border-gray-200 bg-white p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="text-2xl font-extrabold text-gray-900">
                {c.name ?? "(ไม่มีชื่อ)"}
              </h1>
              <p className="mt-1 text-sm text-gray-600">
                {c.phone ?? "—"}
                {c.email ? ` · ${c.email}` : ""}
              </p>
              <p className="mt-0.5 text-[11px] text-gray-500">
                สาขา {c.branch_id ?? "—"} · เปิดบัญชี {fmt(c.created_at)}
              </p>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {c.customer_tier && (
                <Pill text={`Tier: ${c.customer_tier}`} tone="border-amber-200 bg-amber-50 text-amber-900" />
              )}
              {c.lifecycle_stage && (
                <Pill text={`Stage: ${c.lifecycle_stage}`} tone="border-blue-200 bg-blue-50 text-blue-900" />
              )}
              {typeof c.retention_score === "number" && (
                <Pill
                  text={`Retention: ${Math.round(c.retention_score)}`}
                  tone={
                    c.retention_score >= 60
                      ? "border-green-200 bg-green-50 text-green-900"
                      : "border-red-200 bg-red-50 text-red-900"
                  }
                />
              )}
            </div>
          </div>

          <dl className="mt-4 grid sm:grid-cols-4 gap-3 text-sm">
            <Stat label="งานทั้งหมด" value={String(c.total_orders ?? 0)} />
            <Stat
              label="ยอดใช้รวม"
              value={`฿${Math.round(c.lifetime_spend ?? 0).toLocaleString()}`}
            />
            <Stat
              label="เข้าใช้ล่าสุด"
              value={c.last_visit_at ? fmt(c.last_visit_at) : "—"}
            />
            <Stat label="รูปอัปโหลด" value={String(data.uploadCount)} />
          </dl>
        </section>

        <section className="rounded-2xl border border-gray-200 bg-white p-5">
          <h2 className="text-base font-bold text-gray-900">ช่องทาง + การยินยอม</h2>
          <div className="mt-3 grid sm:grid-cols-2 gap-3 text-sm">
            <PrefRow
              label="SMS"
              enabled={data.prefs?.sms_enabled ?? true}
              defaultsApplied={!data.prefs}
            />
            <PrefRow
              label="LINE"
              enabled={data.prefs?.line_enabled ?? true}
              defaultsApplied={!data.prefs}
              subtext={
                data.lineLink
                  ? data.lineLink.unsubscribed_at
                    ? `ยกเลิกแล้ว ${fmt(data.lineLink.unsubscribed_at)}`
                    : `link: ${data.lineLink.line_user_id.slice(0, 8)}...`
                  : "ยังไม่ผูกบัญชี LINE"
              }
            />
            <PrefRow
              label="อีเมล"
              enabled={data.prefs?.email_enabled ?? false}
              defaultsApplied={!data.prefs}
            />
            <PrefRow
              label="โปรโมชั่น"
              enabled={data.prefs?.promotional ?? false}
              defaultsApplied={!data.prefs}
            />
          </div>
          <p className="mt-3 text-[11px] text-gray-500">
            {data.prefs?.last_updated_at
              ? `ลูกค้าแก้ไขล่าสุด: ${fmt(data.prefs.last_updated_at)}`
              : "ลูกค้ายังไม่เคยแก้ไข — กำลังใช้ค่าเริ่มต้น"}
          </p>
        </section>

        <section className="rounded-2xl border border-gray-200 bg-white">
          <div className="p-4 border-b border-gray-100">
            <h2 className="text-base font-bold text-gray-900">งานล่าสุด (10)</h2>
          </div>
          {data.orders.length === 0 ? (
            <div className="p-6 text-sm text-gray-500 text-center">
              ยังไม่มีงาน
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-left text-[10px] uppercase tracking-wider text-gray-600">
                  <tr>
                    <Th>Job</Th>
                    <Th>งาน</Th>
                    <Th>สถานะ</Th>
                    <Th>ยอด</Th>
                    <Th>วันที่</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {data.orders.map((o) => (
                    <tr key={o.id} className="hover:bg-gray-50">
                      <Td>
                        <Link
                          href={`/orders/${o.id}/document`}
                          className="font-mono text-xs text-green-700 hover:underline"
                        >
                          {o.job_id ?? o.id.slice(0, 8).toUpperCase()}
                        </Link>
                      </Td>
                      <Td className="text-xs text-gray-700">
                        {o.service_name ?? o.item_name ?? "—"}
                      </Td>
                      <Td>
                        <Pill
                          text={o.status}
                          tone={STATUS_PILL[o.status] ?? STATUS_PILL.pending}
                        />
                      </Td>
                      <Td className="text-xs text-gray-700">
                        ฿{Math.round(o.price ?? 0).toLocaleString()}
                      </Td>
                      <Td className="text-xs text-gray-500">
                        {fmt(o.created_at)}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="rounded-2xl border border-gray-200 bg-white">
          <div className="p-4 border-b border-gray-100">
            <h2 className="text-base font-bold text-gray-900">
              ข้อความที่ส่งไป (15)
            </h2>
            <p className="text-[11px] text-gray-500">
              จาก customer_notifications — queued + sent + failed
            </p>
          </div>
          {data.notifications.length === 0 ? (
            <div className="p-6 text-sm text-gray-500 text-center">
              ยังไม่มีข้อความถูกส่ง
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-left text-[10px] uppercase tracking-wider text-gray-600">
                  <tr>
                    <Th>Channel</Th>
                    <Th>Kind</Th>
                    <Th>Status</Th>
                    <Th>Attempts</Th>
                    <Th>Sent</Th>
                    <Th>Error</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {data.notifications.map((n) => (
                    <tr key={n.id} className="hover:bg-gray-50">
                      <Td className="text-xs">{n.channel}</Td>
                      <Td className="font-mono text-xs">{n.kind}</Td>
                      <Td>
                        <Pill
                          text={n.status}
                          tone={
                            n.status === "sent"
                              ? "border-green-200 bg-green-50 text-green-800"
                              : n.status === "failed"
                              ? "border-red-200 bg-red-50 text-red-800"
                              : "border-yellow-200 bg-yellow-50 text-yellow-800"
                          }
                        />
                      </Td>
                      <Td className="text-xs text-gray-700">{n.attempts}</Td>
                      <Td className="text-xs text-gray-500">
                        {fmt(n.sent_at ?? n.created_at)}
                      </Td>
                      <Td className="text-xs text-red-700 max-w-xs truncate">
                        {n.error_reason ?? "—"}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="rounded-2xl border border-gray-200 bg-white">
          <div className="p-4 border-b border-gray-100">
            <h2 className="text-base font-bold text-gray-900">
              dispatch log (15)
            </h2>
            <p className="text-[11px] text-gray-500">
              บันทึกการพยายามส่งจริง — provider + latency
            </p>
          </div>
          {data.dispatchLog.length === 0 ? (
            <div className="p-6 text-sm text-gray-500 text-center">
              ยังไม่มี attempt
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-left text-[10px] uppercase tracking-wider text-gray-600">
                  <tr>
                    <Th>Channel</Th>
                    <Th>Kind</Th>
                    <Th>Outcome</Th>
                    <Th>Attempt</Th>
                    <Th>Latency</Th>
                    <Th>Provider</Th>
                    <Th>เวลา</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {data.dispatchLog.map((d) => (
                    <tr key={d.id} className="hover:bg-gray-50">
                      <Td className="text-xs">{d.channel}</Td>
                      <Td className="font-mono text-xs">{d.kind}</Td>
                      <Td>
                        <Pill
                          text={d.outcome}
                          tone={OUTCOME_PILL[d.outcome] ?? OUTCOME_PILL.skipped}
                        />
                      </Td>
                      <Td className="text-xs">{d.attempt}</Td>
                      <Td className="text-xs">
                        {d.latency_ms != null ? `${d.latency_ms}ms` : "—"}
                      </Td>
                      <Td className="text-xs">{d.provider ?? "—"}</Td>
                      <Td className="text-xs text-gray-500">
                        {fmt(d.created_at)}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="rounded-2xl border border-gray-200 bg-white p-5">
          <h2 className="text-base font-bold text-gray-900">
            กิจกรรมล่าสุด (25)
          </h2>
          {data.activity.length === 0 ? (
            <p className="mt-3 text-sm text-gray-500">ยังไม่มีกิจกรรม</p>
          ) : (
            <ul className="mt-3 divide-y divide-gray-100">
              {data.activity.map((a) => (
                <li key={a.id} className="py-2 flex items-start gap-3">
                  <span className="mt-1 inline-block h-2 w-2 rounded-full bg-green-500 flex-shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-xs text-gray-700">
                        {a.kind}
                      </span>
                      <span className="text-[10px] text-gray-500">
                        {fmt(a.created_at)}
                      </span>
                    </div>
                    {a.payload && Object.keys(a.payload).length > 0 && (
                      <details className="mt-1">
                        <summary className="text-[10px] text-gray-500 cursor-pointer">
                          payload
                        </summary>
                        <pre className="mt-1 text-[10px] text-gray-600 whitespace-pre-wrap">
                          {JSON.stringify(a.payload, null, 2)}
                        </pre>
                      </details>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function Pill({ text, tone }: { text: string; tone: string }) {
  return (
    <span
      className={`inline-block rounded-full border px-2 py-0.5 text-[10px] font-semibold ${tone}`}
    >
      {text}
    </span>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-gray-100 bg-gray-50 px-3 py-2">
      <dt className="text-[10px] uppercase tracking-widest text-gray-500">
        {label}
      </dt>
      <dd className="mt-0.5 font-semibold text-gray-900">{value}</dd>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-3 py-2 font-semibold">{children}</th>;
}

function Td({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <td className={`px-3 py-2 ${className ?? ""}`}>{children}</td>;
}

function PrefRow({
  label,
  enabled,
  defaultsApplied,
  subtext,
}: {
  label: string;
  enabled: boolean;
  defaultsApplied: boolean;
  subtext?: string;
}) {
  return (
    <div className="rounded-xl border border-gray-100 bg-gray-50 px-3 py-2 flex items-center justify-between gap-3">
      <div className="min-w-0">
        <div className="text-sm font-semibold text-gray-900">{label}</div>
        {subtext && (
          <div className="text-[10px] text-gray-500 truncate">{subtext}</div>
        )}
      </div>
      <span
        className={`rounded-full px-2.5 py-0.5 text-[10px] font-semibold ${
          enabled
            ? "bg-green-100 text-green-800"
            : "bg-gray-200 text-gray-700"
        }`}
        title={defaultsApplied ? "ค่าเริ่มต้น" : "ลูกค้าตั้งเอง"}
      >
        {enabled ? "เปิด" : "ปิด"}
      </span>
    </div>
  );
}
