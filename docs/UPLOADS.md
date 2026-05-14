# CareU OPS Platform — Upload Pipeline

> **Status:** **client-optimized**. Signed-URL uploads against a private Supabase Storage bucket; two routes (anonymous quote, authenticated portal); MIME + size + path validation. Client-side compression + retry + progress live via `lib/uploadClient.ts`. Server-side re-encoding (HEIC → JPEG) is still deferred.

---

## 1. Why signed-URL uploads

Three options were on the table:

1. **Customer POSTs bytes to our API → we stream to Storage.** Doubles our bandwidth bill; serverless time limits cap file size.
2. **Bucket is public-readable + we issue plain URLs.** Photos meant for one customer leak to anyone who guesses the URL.
3. **Signed PUT URLs minted by our API.** Customer uploads directly to Storage; bucket stays private; the URL expires in 5 minutes; our API is the gate that decides which path the customer can write.

Option 3 wins. `lib/uploadService.ts::issueUploadUrl` is the helper; two routes wrap it.

---

## 2. Bucket: `customer-uploads`

Created by migration `20260535_customer_portal_and_crm_progression.sql` (via `storage.buckets`). Private — no anon reads, no anon writes except via signed URLs. The migration is idempotent and safe to re-run; if the `storage` extension isn't installed yet the insert is a no-op.

**Folder layout:**

```
<branch-code>/
├── quotes/<quote-request-id-or-pending>/<uuid>.<ext>
├── customers/<customer-id>/<uuid>.<ext>
└── orders/<order-id>/<uuid>.<ext>
```

Branch slug + nested id keep blast radius narrow: a leaked signed URL can write only that one path before expiring.

---

## 3. Issuing URLs

### 3.1 `POST /api/public/upload-url`

Anonymous. Rate-limited **10/hour/IP**. Body:

```ts
{
  mime: string;
  size?: number;
  branchCode?: string;        // validated against active branches
  groupingToken?: string;     // optional client grouping id
}
```

Scope is always `quote` — anonymous callers cannot target customer / order paths. If the branch doesn't exist or is inactive, the path lands in `no-branch/quotes/...` (a safe sink). The response includes `path`, `signedUrl`, `token`, `mime`, `maxBytes`, `expiresAt`.

### 3.2 `POST /api/portal/upload-url`

Authenticated (customer cookie). Rate-limited **30/10 min/IP**. Body:

```ts
{
  mime: string;
  size?: number;
  scope?: "customer" | "order";   // default "customer"
  orderId?: string;
}
```

Branch slug is resolved server-side from `customers.branch_id` (with `"self-portal"` as a fallback for customers who signed up portal-first). The customer cannot pick the branch.

When `scope === "order"`, the route hard-checks that `orders.customer_id === session.customerId` — wrong-owner gets the same 404 as a missing id.

### 3.3 MIME + size validation

| Constant | Value |
|---|---|
| `ALLOWED_MIME` | `image/jpeg`, `image/png`, `image/webp`, `image/heic`, `image/heif` |
| `MAX_DECLARED_SIZE_BYTES` | 8 MB |
| Signed URL TTL | 5 minutes |

The `size` field is a declaration — Storage's own per-bucket policy enforces the real byte cap. We reject before signing when the customer self-declares too large; otherwise the Storage layer rejects the actual PUT.

---

## 4. Reading uploaded files

`lib/uploadService.ts::issueReadUrl(path, ttlSeconds)` mints a short-lived signed GET URL. Used by:

- The portal order detail (future) — render a customer's uploaded photos via `<img src={signedUrl}>`.
- The admin triage UI (future) — review `quote_requests.photos[]`.

Read URLs default to 60 s TTL — long enough for the browser to load + cache the image, short enough that copy-pasting the URL to a friend doesn't share access permanently. Callers tune up to longer TTLs when warranted (e.g. for a downloadable PDF link, 5 min is fine).

---

## 5. Storage RLS

We intentionally **don't add per-folder Storage RLS policies** in this phase. The route handler is the gate — every URL is minted via the service-role admin client, scoped by the route's auth check. Adding Storage RLS would require duplicating that logic in Postgres against `storage.objects` joined back to our tables; the marginal security benefit is small and the maintenance cost of keeping the policy in sync would be high.

Future phase: if Storage RLS becomes useful (e.g. for direct anon reads on truly-public marketing assets), it slots in alongside the route gate.

---

## 6. Where uploaded paths live

| Path | Stored where |
|---|---|
| Quote photos | `public.quote_requests.photos` (JSONB array of `path` strings) |
| Customer photos | Future: a `customer_uploads` table or `customer_activity.payload.path[]` |
| Order photos | Future: `public.order_attachments` (table exists from `20260513` but isn't wired yet) |

`quote_requests.photos` is the only wired writer today. The admin triage UI / portal viewer reads `path`, calls `issueReadUrl(path)`, and renders.

---

## 7. Client helper — `lib/uploadClient.ts`

`uploadFile({ file, scope, onProgress, signal })` is the browser-side entry point that pairs with the server's `issueUploadUrl`. It bundles three behaviours every consumer otherwise reinvents:

| Step | Behaviour |
|---|---|
| Compress | `createImageBitmap` → `OffscreenCanvas` re-encode → JPEG @ quality 0.82 capped at 1920 px (longer side). Skipped for HEIC / HEIF / GIF (canvas can't decode) and for already-small images. Falls back to the original blob if the re-encoded version would be *larger* than the input. |
| Signed URL | POSTs to `/api/portal/upload-url` or `/api/public/upload-url` depending on scope. |
| PUT with retry | XHR-based, emits `onProgress({ bytesSent, bytesTotal, percent })`. Retries on status 0/408/429/5xx with exponential backoff (600 ms → 1.8 s → 5.4 s). Non-retryable failures (400 MIME, 403 expired) bail immediately. |

The helper is currently *unused by any page* — it ships alongside the existing intake / quote upload flows as a drop-in upgrade. The wiring to call it from those pages is a UX-layer follow-up so the upgrade can land without re-testing every intake form. New surfaces (portal "upload a photo for this job") should consume this helper directly.

`AbortController.signal` is honoured throughout — wire it to a cancel button if the upload runs on the user's slow network.

---

## 8. Future enhancements (not this phase)

| Step | Why |
|---|---|
| Image re-encode / compress | Storage trigger or edge function. Cuts the byte bill + normalises HEIC to JPEG so older browsers can display. |
| `order_attachments` writer | The table from `20260513` is empty — wire intake + post-completion photos through it. |
| Storage RLS for direct branch-manager reads | When OPS pages render a customer's uploaded photo, an RLS policy joining `storage.objects` to `orders` could let the existing bridge-JWT do the work. |
| Per-file content-type sniff | The MIME check is on the declaration only. Real sniff via `file-type` or a sidecar service. |
| Virus scan | Not a foundation concern, but worth adding before a big launch. |
| Resumable uploads | Supabase Storage supports TUS via the JS SDK; the signed-URL path doesn't expose it. Add when files routinely exceed 10 MB. |

---

**Last updated:** 2026-05-14 (signed-URL upload pipeline + portal/public routes)
