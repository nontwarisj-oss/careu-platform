"use client";

import React, {
  createContext,
  useContext,
  useEffect,
  useState,
} from "react";
import {
  branches,
  defaultBranch,
  getBranchById,
  type BranchConfig,
} from "@/lib/brandConfig";

interface BranchContextType {
  branch: BranchConfig;
  setBranchId: (id: string) => void;
  branches: BranchConfig[];
}

const BranchContext = createContext<BranchContextType | undefined>(undefined);

const STORAGE_KEY = "careu.branchId";

export const BranchProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [branchId, setBranchIdState] = useState<string>(defaultBranch.id);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored && branches.some((b) => b.id === stored)) {
      setBranchIdState(stored);
    }
  }, []);

  const setBranchId = (id: string) => {
    setBranchIdState(id);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_KEY, id);
    }
  };

  const branch = getBranchById(branchId);

  return (
    <BranchContext.Provider value={{ branch, setBranchId, branches }}>
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
