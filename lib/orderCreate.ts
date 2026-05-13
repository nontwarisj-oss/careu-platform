import supabase from "@/lib/supabase";

export type SmartOrderInput = {
  customerId: string;
  customerName: string;
  customerType?: string | null;
  branchId: string;
  serviceCategory?: string | null;
  serviceCode?: string | null;
  /** Human-readable service name; lands in item_name when extended columns are missing. */
  serviceName: string;
  templateText?: string | null;
  quantity: number;
  subtotal: number;
  urgent: boolean;
  urgentFee: number;
  promotionCode?: string | null;
  discount: number;
  total: number;
  notes?: string | null;
  status?: string;
};

type InsertResult = { orderId: string | null; error: string | null };

const isMissingColumn = (msg: string | undefined): boolean =>
  !!msg &&
  /column .* does not exist|could not find.*column|cache.*schema|unknown column|schema cache/i.test(
    msg
  );

async function attempt(payload: object): Promise<InsertResult> {
  const res = await supabase
    .from("orders")
    .insert(payload)
    .select("id")
    .maybeSingle();
  if (res.error) {
    return { orderId: null, error: res.error.message };
  }
  if (!res.data) {
    return { orderId: null, error: "Insert returned no row" };
  }
  return { orderId: String((res.data as { id: string }).id), error: null };
}

/**
 * Insert a smart order with progressive fallback so the form keeps working
 * across migration states:
 *   v3 = subtotal, discount, service_category/code/name, quantity, promotion_code, customer_type, template_text
 *   v2 = urgent/urgent_fee/notes/branch_id columns
 *   v1 = legacy (customer_id, customer_name, item_name, price, status)
 *
 * Urgent intent is suffixed onto item_name in the v1 fallback so it's not lost.
 */
export async function createSmartOrder(input: SmartOrderInput): Promise<InsertResult> {
  const quantity = Math.max(1, Math.floor(input.quantity || 1));
  const itemNameBase =
    input.serviceName + (quantity > 1 ? ` x${quantity}` : "");

  const legacy = {
    customer_id: input.customerId,
    customer_name: input.customerName,
    item_name: itemNameBase,
    price: input.total,
    status: input.status ?? "pending",
  };

  const v2 = {
    ...legacy,
    branch_id: input.branchId,
    urgent: input.urgent,
    urgent_fee: input.urgent ? input.urgentFee : 0,
    notes: input.notes || null,
  };

  const v3 = {
    ...v2,
    subtotal: input.subtotal,
    discount: input.discount,
    service_category: input.serviceCategory ?? null,
    service_code: input.serviceCode ?? null,
    service_name: input.serviceName,
    quantity,
    template_text: input.templateText ?? null,
    customer_type: input.customerType ?? null,
    promotion_code: input.promotionCode ?? null,
  };

  // Tier 3 — full smart schema
  let result = await attempt(v3);
  if (!isMissingColumn(result.error ?? undefined)) return result;

  // Tier 2 — intake-extension schema
  result = await attempt(v2);
  if (!isMissingColumn(result.error ?? undefined)) return result;

  // Tier 1 — legacy schema. Preserve urgent intent in the item name.
  const legacyWithUrgent = {
    ...legacy,
    item_name: itemNameBase + (input.urgent ? " [ด่วน]" : ""),
  };
  return await attempt(legacyWithUrgent);
}
