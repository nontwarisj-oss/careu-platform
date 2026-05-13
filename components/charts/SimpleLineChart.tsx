"use client";

import { formatCurrency } from "@/lib/utils";

export type LinePoint = {
  label: string;
  value: number;
};

interface SimpleLineChartProps {
  data: LinePoint[];
  /** Pixel height of the chart area. */
  height?: number;
  /** "currency" formats values as ฿X,XXX; "number" leaves them plain. */
  format?: "currency" | "number";
  emptyMessage?: string;
}

const WIDTH = 600; // viewBox width — scales to container

/**
 * Lightweight SVG line/area chart, no library deps. Renders an area gradient
 * underneath a green→yellow line + dots, with x-axis labels under each point.
 * Good enough for trend KPI tiles; replace with a real chart lib when the
 * exec dashboards need richer interactions.
 */
export function SimpleLineChart({
  data,
  height = 140,
  format = "currency",
  emptyMessage = "ยังไม่มีข้อมูล",
}: SimpleLineChartProps) {
  if (data.length === 0) {
    return (
      <p className="text-sm text-gray-500 text-center py-6">{emptyMessage}</p>
    );
  }

  const max = Math.max(1, ...data.map((d) => d.value));
  const min = Math.min(0, ...data.map((d) => d.value));
  const range = max - min || 1;

  const stepX = data.length > 1 ? WIDTH / (data.length - 1) : 0;
  const points = data.map((d, i) => {
    const x = data.length === 1 ? WIDTH / 2 : i * stepX;
    const y = height - ((d.value - min) / range) * (height - 16) - 8;
    return { x, y, d };
  });

  const linePath = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`)
    .join(" ");

  const areaPath =
    linePath +
    ` L${points[points.length - 1].x.toFixed(1)},${height} ` +
    `L${points[0].x.toFixed(1)},${height} Z`;

  const fmt = (n: number) =>
    format === "currency" ? formatCurrency(n) : n.toLocaleString();

  return (
    <div>
      <svg
        viewBox={`0 0 ${WIDTH} ${height}`}
        preserveAspectRatio="none"
        className="w-full"
        style={{ height }}
      >
        <defs>
          <linearGradient id="careu-area" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#10b981" stopOpacity="0.35" />
            <stop offset="100%" stopColor="#10b981" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="careu-stroke" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#15803d" />
            <stop offset="100%" stopColor="#facc15" />
          </linearGradient>
        </defs>
        <path d={areaPath} fill="url(#careu-area)" />
        <path
          d={linePath}
          fill="none"
          stroke="url(#careu-stroke)"
          strokeWidth={3}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {points.map((p) => (
          <circle
            key={`${p.x}-${p.y}`}
            cx={p.x}
            cy={p.y}
            r={3.5}
            fill="#15803d"
          />
        ))}
      </svg>
      <ul className="mt-2 grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-1 text-[11px] text-gray-500">
        {points.map((p) => (
          <li key={p.d.label} className="flex items-center justify-between gap-2">
            <span className="truncate">{p.d.label}</span>
            <span className="font-medium text-gray-700 whitespace-nowrap">
              {fmt(p.d.value)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
