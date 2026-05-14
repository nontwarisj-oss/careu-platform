"use client";

import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import supabase from "@/lib/supabase";
import {
  branches as STATIC_BRANCHES,
  defaultBranch,
  getBranchById,
  type BranchConfig,
  type BrandKey,
} from "@/lib/brandConfig";

interface BranchContextType {
  branch: BranchConfig;
  setBranchId: (id: string) => void;
  branches: BranchConfig[];
  /**
   * "db" — branches sourced from public.branches.
   * "fallback" — DB fetch failed or returned 0 rows; reading from the
   * hardcoded list in lib/brandConfig.ts.
   * "loading" — first fetch hasn't landed yet (still serving static seed).
   */
  source: "db" | "fallback" | "loading";
}

const BranchContext = createContext<BranchContextType | undefined>(undefined);

const STORAGE_KEY = "careu.branchId";

type DbBranchRow = {
  id: string;
  code: string;
  short_code: string | null;
  name: string;
  type: string | null;
  brand: string | null;
  is_active: boolean;
  short_label: string | null;
  short_name: string | null;
  receipt_name: string | null;
  tagline: string | null;
  address: string | null;
  phone: string | null;
  logo_path: string | null;
  accent_class: string | null;
};

/**
 * Map a DB row to the in-memory BranchConfig shape. Falls back per-field to
 * the matching hardcoded row when a DB column is null — so a partial
 * migration (or a new branch the operator just created without filling in
 * the optional UI fields) still renders.
 *
 * `branchId` for the in-memory shape uses `branches.code` (text slug) because
 * orders.branch_id / customers.branch_id are already keyed by slug, and the
 * sidebar selector + every existing consumer expects the slug.
 */
function mapDbRow(row: DbBranchRow): BranchConfig {
  const seed = STATIC_BRANCHES.find((b) => b.id === row.code);
  return {
    id: row.code,
    shortLabel:
      row.short_label ??
      seed?.shortLabel ??
      `${row.short_code ?? "—"} • ${row.name}`,
    name: row.name,
    branchCode: row.short_code ?? seed?.branchCode ?? "—",
    brand: (row.brand as BrandKey) ?? seed?.brand ?? "careu",
    shortName: row.short_name ?? seed?.shortName ?? row.name,
    receiptName: row.receipt_name ?? seed?.receiptName ?? row.name,
    tagline: row.tagline ?? seed?.tagline ?? "",
    address: row.address ?? seed?.address ?? "",
    phone: row.phone ?? seed?.phone ?? "N/A",
    logoPath: row.logo_path ?? seed?.logoPath ?? "/logos/c24-careu.svg",
    accentClass:
      row.accent_class ?? seed?.accentClass ?? "from-green-700 to-emerald-600",
  };
}

export const BranchProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [branchId, setBranchIdState] = useState<string>(defaultBranch.id);
  const [dbBranches, setDbBranches] = useState<BranchConfig[] | null>(null);
  const [source, setSource] = useState<BranchContextType["source"]>("loading");

  // Hydrate the active branch id from localStorage on first mount.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored) {
      setBranchIdState(stored);
    }
  }, []);

  // Fetch the branch list from the DB. On error or empty result, fall
  // back to the static seed in lib/brandConfig.ts so the platform stays
  // usable even when the migration hasn't run yet or the DB is briefly
  // unreachable.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { data, error } = await supabase
        .from("branches")
        .select(
          "id, code, short_code, name, type, brand, is_active, short_label, short_name, receipt_name, tagline, address, phone, logo_path, accent_class"
        )
        .eq("is_active", true)
        .order("code", { ascending: true });
      if (cancelled) return;
      if (error || !data || data.length === 0) {
        setSource("fallback");
        setDbBranches(null);
        return;
      }
      const mapped = (data as DbBranchRow[]).map(mapDbRow);
      setDbBranches(mapped);
      setSource("db");
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const branches = useMemo<BranchConfig[]>(() => {
    if (dbBranches && dbBranches.length > 0) return dbBranches;
    return STATIC_BRANCHES;
  }, [dbBranches]);

  const branch = useMemo<BranchConfig>(() => {
    const found = branches.find((b) => b.id === branchId);
    if (found) return found;
    // If the stored branchId points at a row that's no longer active (or
    // never existed), reset to the first available branch. Don't call
    // setBranchId here — let useEffect handle the side-effect.
    return branches[0] ?? defaultBranch;
  }, [branches, branchId]);

  // If the loaded list doesn't include the stored branchId (e.g. the
  // operator deactivated it), reset the persisted value to the first
  // available branch so the next refresh keeps a valid selection.
  useEffect(() => {
    if (branches.length === 0) return;
    if (branches.some((b) => b.id === branchId)) return;
    const next = branches[0].id;
    setBranchIdState(next);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_KEY, next);
    }
  }, [branches, branchId]);

  const setBranchId = (id: string) => {
    setBranchIdState(id);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_KEY, id);
    }
  };

  return (
    <BranchContext.Provider value={{ branch, setBranchId, branches, source }}>
      {children}
    </BranchContext.Provider>
  );
};

export const useBranch = () => {
  const ctx = useContext(BranchContext);
  if (!ctx) {
    throw new Error("useBranch must be used within BranchProvider");
  }
  return ctx;
};

// Re-export the lookup helper so existing callers don't break — they get
// the static seed view, which is still correct for the hardcoded branches.
// Components that need DB-mirrored values should read from useBranch().
export { getBranchById };
