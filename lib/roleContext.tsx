"use client";

import React, {
  createContext,
  useContext,
  useEffect,
  useState,
} from "react";
import {
  DEFAULT_ROLE,
  ROLE_DEFINITIONS,
  getRoleDefinition,
  normalizeRole,
  type Role,
  type RoleDefinition,
} from "@/lib/roles";

interface RoleContextType {
  role: Role;
  setRole: (role: Role) => void;
  definition: RoleDefinition;
  roles: RoleDefinition[];
}

const RoleContext = createContext<RoleContextType | undefined>(undefined);

const STORAGE_KEY = "careu.role";

export const RoleProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [role, setRoleState] = useState<Role>(DEFAULT_ROLE);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (!stored) return;
    // Legacy codes (frontdesk, manager, …) survive a redeploy by being
    // translated to the new enterprise codes via normalizeRole.
    const normalized = normalizeRole(stored);
    if (normalized in ROLE_DEFINITIONS) {
      setRoleState(normalized);
    }
  }, []);

  const setRole = (next: Role) => {
    setRoleState(next);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_KEY, next);
    }
  };

  const definition = getRoleDefinition(role);
  const roles = Object.values(ROLE_DEFINITIONS);

  return (
    <RoleContext.Provider value={{ role, setRole, definition, roles }}>
      {children}
    </RoleContext.Provider>
  );
};

export const useRole = () => {
  const ctx = useContext(RoleContext);
  if (!ctx) {
    throw new Error("useRole must be used within RoleProvider");
  }
  return ctx;
};
