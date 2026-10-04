import type { AxisReading } from "../types";
import type { Reach } from "../lib/model";
import { normalize } from "../lib/model";

const SIZE = 150;
const HALF = SIZE / 2;
const SCALE = 58; // px for a full deflection (|1.0|); leaves room for overshoot

const pct = (v: number) => `${Math.round(v * 100)}%`;
// Below 98 % the edge is not reached: the declared range on that side is too large.
const reachColor = (v: number) => (v === 0 ? "rgba(255,255,255,0.45)" : v < 0.98 ? "#ff9f43" : "#4cd964");

export function StickPreview({ title, x, y, reachX, reachY, deadzone }: {
  title: string;
  x?: AxisReading;
  y?: AxisReading;
  reachX: Reach;
  reachY: Reach;
  deadzone: number;
}) {
  const nx = normalize(x);
  const ny = normalize(y);
  const dot = (v: number) => HALF + Math.max(-1.2, Math.min(1.2, v)) * SCALE;
  // The driver zeroes |raw| < deadzone per axis: show it as a cross-shaped band.
  const bandX = x && x.max ? (deadzone / x.max) * SCALE : 0;
  const bandY = y && y.max ? (deadzone / y.max) * SCALE : 0;
  const label = { fontSize: "11px", fontWeight: 600 } as const;
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", minWidth: 0 }}>
      <div style={{ fontSize: "14px", fontWeight: 600, marginBottom: "4px" }}>{title}</div>
      <div style={{ position: "relative", width: `${SIZE}px`, height: `${SIZE + 28}px` }}>
        <div style={{ ...label, position: "absolute", top: 0, width: "100%", textAlign: "center", color: reachColor(reachY.neg) }}>↑ {pct(reachY.neg)}</div>
        <svg width={SIZE} height={SIZE} style={{ position: "absolute", top: "14px", left: 0 }}>
          <rect x={HALF - SCALE} y={HALF - SCALE} width={SCALE * 2} height={SCALE * 2} fill="rgba(255,255,255,0.05)" stroke="rgba(255,255,255,0.3)" />
          <circle cx={HALF} cy={HALF} r={SCALE} fill="none" stroke="rgba(255,255,255,0.35)" strokeDasharray="4 3" />
          <rect x={HALF - bandX} y={HALF - SCALE} width={bandX * 2} height={SCALE * 2} fill="rgba(255,80,80,0.18)" />
          <rect x={HALF - SCALE} y={HALF - bandY} width={SCALE * 2} height={bandY * 2} fill="rgba(255,80,80,0.18)" />
          <line x1={HALF} y1={HALF - SCALE} x2={HALF} y2={HALF + SCALE} stroke="rgba(255,255,255,0.2)" />
          <line x1={HALF - SCALE} y1={HALF} x2={HALF + SCALE} y2={HALF} stroke="rgba(255,255,255,0.2)" />
          <circle cx={dot(nx)} cy={dot(ny)} r={7} fill="#1a9fff" stroke="#fff" strokeWidth={2} />
        </svg>
        <div style={{ ...label, position: "absolute", top: `${14 + HALF - 7}px`, left: "-34px", color: reachColor(reachX.neg) }}>← {pct(reachX.neg)}</div>
        <div style={{ ...label, position: "absolute", top: `${14 + HALF - 7}px`, right: "-38px", color: reachColor(reachX.pos) }}>{pct(reachX.pos)} →</div>
        <div style={{ ...label, position: "absolute", bottom: 0, width: "100%", textAlign: "center", color: reachColor(reachY.pos) }}>↓ {pct(reachY.pos)}</div>
      </div>
      <div style={{ fontSize: "12px", opacity: 0.8, marginTop: "4px", fontVariantNumeric: "tabular-nums" }}>
        X {pct(nx)} ({x?.value ?? "–"}) · Y {pct(ny)} ({y?.value ?? "–"})
      </div>
    </div>
  );
}
