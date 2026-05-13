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
    const stored = window.localStorage.getItem(STORAGE_KEY) as Role | null;
    if (stored && stored in ROLE_DEFINITIONS) {
      setRoleState(stored);
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
