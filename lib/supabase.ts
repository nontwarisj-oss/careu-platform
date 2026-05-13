// Browser-safe Supabase client. The anon key authenticates the API itself;
// the `Authorization: Bearer <bridge JWT>` header (when present) is what
// PostgREST uses to populate auth.uid() and evaluate RLS policies.
//
// The bridge JWT comes from /api/auth/me — see lib/supabaseJwt.ts. When the
// app is in preview mode (no SUPABASE_JWT_SECRET) the JWT is null and queries
// run as anon — which after 20260522 means RLS-protected tables return 0
// rows. That is the intended behaviour for an unauthenticated session.

import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl) {
  throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL");
}

if (!supabaseAnonKey) {
  throw new Error("Missing NEXT_PUBLIC_SUPABASE_ANON_KEY");
}

// Single module-level holder for the bridge JWT. AuthProvider calls
// setBridgeJwt() after every /api/auth/me response.
let currentBridgeJwt: string | null = null;

export function setBridgeJwt(jwt: string | null): void {
  currentBridgeJwt = jwt;
}

export function getBridgeJwt(): string | null {
  return currentBridgeJwt;
}

const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  global: {
    // Override Authorization on every request while leaving apikey untouched.
    // The supabase-js client always sets `apikey` from the constructor; when
    // we don't override Authorization it defaults to "Bearer <anon_key>".
    // Replacing it with the bridge JWT makes PostgREST treat the request as
    // an authenticated user with role='authenticated' and auth.uid()=<sub>.
    fetch: (input, init = {}) => {
      const jwt = currentBridgeJwt;
      if (!jwt) return fetch(input as RequestInfo, init);
      const headers = new Headers(init.headers ?? {});
      headers.set("Authorization", `Bearer ${jwt}`);
      return fetch(input as RequestInfo, { ...init, headers });
    },
  },
});

export default supabase;
