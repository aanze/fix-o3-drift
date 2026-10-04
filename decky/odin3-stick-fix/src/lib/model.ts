import type { AxisName, AxisReading, Params, RestStats } from "../types";

export type StickKey = "left" | "right";
export type Field = "centerX" | "centerY" | "deadzone" | "left" | "right" | "up" | "down";

export interface StickEdit {
  centerX: number;
  centerY: number;
  deadzone: number;
  left: number;
  right: number;
  up: number;
  down: number;
  symmetric: boolean;
}

export type EditState = Record<StickKey, StickEdit>;

export const LIMITS: Record<Field, [number, number]> = {
  centerX: [-300, 300],
  centerY: [-300, 300],
  deadzone: [0, 300],
  left: [200, 1600],
  right: [200, 1600],
  up: [200, 1600],
  down: [200, 1600],
};

const MIRROR: Partial<Record<Field, Field>> = { left: "right", right: "left", up: "down", down: "up" };

export const AXES: Record<StickKey, { x: AxisName; y: AxisName }> = {
  left: { x: "leftx", y: "lefty" },
  right: { x: "rightx", y: "righty" },
};

const num = (params: Params, name: string, fallback: number) =>
  Number.isFinite(params[name]) ? Number(params[name]) : fallback;

// Linux gamepad convention, kept by rsinput: negative X = left, negative Y = up (forward).
export function stickFromParams(params: Params, stick: StickKey): StickEdit {
  const { x, y } = AXES[stick];
  const edit: StickEdit = {
    centerX: num(params, `axis_${x}_center`, 0),
    centerY: num(params, `axis_${y}_center`, 0),
    deadzone: Math.max(num(params, `axis_${x}_deadzone`, 0), num(params, `axis_${y}_deadzone`, 0)),
    left: Math.abs(num(params, `axis_${x}_min`, -1408)),
    right: num(params, `axis_${x}_max`, 1408),
    up: Math.abs(num(params, `axis_${y}_min`, -1408)),
    down: num(params, `axis_${y}_max`, 1408),
    symmetric: true,
  };
  edit.symmetric = edit.left === edit.right && edit.up === edit.down;
  return edit;
}

export function fromParams(params: Params): EditState {
  return { left: stickFromParams(params, "left"), right: stickFromParams(params, "right") };
}

export function toParams(edit: EditState): Params {
  const params: Params = {};
  for (const stick of ["left", "right"] as StickKey[]) {
    const { x, y } = AXES[stick];
    const s = edit[stick];
    params[`axis_${x}_min`] = -s.left;
    params[`axis_${x}_max`] = s.right;
    params[`axis_${x}_center`] = s.centerX;
    params[`axis_${x}_deadzone`] = s.deadzone;
    params[`axis_${y}_min`] = -s.up;
    params[`axis_${y}_max`] = s.down;
    params[`axis_${y}_center`] = s.centerY;
    params[`axis_${y}_deadzone`] = s.deadzone;
  }
  return params;
}

export function clamp(field: Field, value: number): number {
  const [low, high] = LIMITS[field];
  return Math.max(low, Math.min(high, Math.round(value)));
}

export function setField(edit: EditState, stick: StickKey, field: Field, value: number): EditState {
  const next: StickEdit = { ...edit[stick], [field]: clamp(field, value) };
  const mirror = MIRROR[field];
  if (next.symmetric && mirror) next[mirror] = next[field];
  return { ...edit, [stick]: next };
}

export function setSymmetric(edit: EditState, stick: StickKey, symmetric: boolean): EditState {
  const s = { ...edit[stick], symmetric };
  if (symmetric) {
    // Fold onto the weaker side: the stronger side would never be fully reached otherwise.
    s.left = s.right = Math.min(s.left, s.right);
    s.up = s.down = Math.min(s.up, s.down);
  }
  return { ...edit, [stick]: s };
}

// Consumers (InputPlumber, SDL, Steam) take the rest position as (min+max)/2,
// so an asymmetric range moves it off zero by this fraction of the half-range.
export function restShift(s: StickEdit): { x: number; y: number } {
  const shift = (neg: number, pos: number) => (pos - neg) / (pos + neg);
  return { x: shift(s.left, s.right), y: shift(s.up, s.down) };
}

export function normalize(reading: AxisReading | undefined): number {
  if (!reading) return 0;
  const side = reading.value < 0 ? Math.abs(reading.min) : reading.max;
  return side ? reading.value / side : 0;
}

export interface Reach {
  neg: number;
  pos: number;
}

export function emptyReach(): Record<AxisName, Reach> {
  return { leftx: { neg: 0, pos: 0 }, lefty: { neg: 0, pos: 0 }, rightx: { neg: 0, pos: 0 }, righty: { neg: 0, pos: 0 } };
}

export function trackReach(reach: Record<AxisName, Reach>, axes: Record<AxisName, AxisReading>): Record<AxisName, Reach> {
  const next = { ...reach };
  for (const axis of Object.keys(next) as AxisName[]) {
    const n = normalize(axes[axis]);
    next[axis] = { neg: Math.max(next[axis].neg, -n), pos: Math.max(next[axis].pos, n) };
  }
  return next;
}

// Suggested center/deadzone from a rest measurement: center cancels the mean
// offset, deadzone covers the largest excursion at rest plus a margin.
export function applyRest(edit: EditState, rest: RestStats, margin = 20): EditState {
  let next = edit;
  for (const stick of ["left", "right"] as StickKey[]) {
    const { x, y } = AXES[stick];
    const rx = rest[x];
    const ry = rest[y];
    if (!rx || !ry) continue;
    const noise = Math.max(Math.abs(rx.max - rx.mean), Math.abs(rx.min - rx.mean), Math.abs(ry.max - ry.mean), Math.abs(ry.min - ry.mean));
    const s = { ...next[stick] };
    s.centerX = clamp("centerX", rx.center);
    s.centerY = clamp("centerY", ry.center);
    s.deadzone = clamp("deadzone", Math.max(s.deadzone, Math.ceil(noise) + margin));
    next = { ...next, [stick]: s };
  }
  return next;
}
