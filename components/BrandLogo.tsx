"use client";

import { useEffect, useState } from "react";
import { useBranch } from "@/lib/branchContext";

interface BrandLogoProps {
  size?: "sm" | "md" | "lg" | "xl";
  variant?: "onColor" | "onLight";
  showName?: boolean;
  className?: string;
}

const sizes: Record<NonNullable<BrandLogoProps["size"]>, string> = {
  sm: "h-8 w-8 text-sm",
  md: "h-10 w-10 text-base",
  lg: "h-14 w-14 text-lg",
  xl: "h-20 w-20 text-2xl",
};

// Drop a higher-fidelity logo into /public/logos/{c24-careu|ezy-repair}.{svg|png}
// (use the same filename in lib/brandConfig.ts logoPath) and it shows up everywhere
// the BrandLogo component is rendered — no further code changes needed.
export function BrandLogo({
  size = "md",
  variant = "onColor",
  showName = false,
  className = "",
}: BrandLogoProps) {
  const { branch } = useBranch();
  const [failed, setFailed] = useState(false);

  // Reset failure state when the branch (and therefore logoPath) changes so a
  // newly selected branch gets a fresh load attempt.
  useEffect(() => {
    setFailed(false);
  }, [branch.logoPath]);

  const fallbackInitial = branch.brand === "careu" ? "C" : "E";

  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      {!failed ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={branch.logoPath}
          alt={branch.receiptName}
          className={`${sizes[size]} rounded-full object-cover bg-green-700 ring-2 ring-white/20`}
          onError={() => setFailed(true)}
        />
      ) : (
        <span
          className={`${sizes[size]} rounded-full bg-green-700 inline-flex items-center justify-center text-yellow-300 font-extrabold ring-2 ring-white/20`}
          aria-label={branch.receiptName}
        >
          {fallbackInitial}
        </span>
      )}
      {showName && (
        <span
          className={`font-bold ${
            variant === "onColor" ? "text-white" : "text-green-800"
          }`}
        >
          {branch.shortName}
        </span>
      )}
    </span>
  );
}

export default BrandLogo;
