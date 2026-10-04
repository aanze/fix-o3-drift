export type Params = Record<string, number>;

export interface Preset {
  id: string;
  name: string;
  builtin: boolean;
  params: Params;
}

export interface PluginState {
  armada: boolean;
  moduleLoaded: boolean;
  deviceFound: boolean;
  live: Params;
  stored: Params | null;
  presets: Preset[];
  active: string | null;
  testing: boolean;
}

export interface AxisReading {
  value: number;
  min: number;
  max: number;
}

export type AxisName = "leftx" | "lefty" | "rightx" | "righty";

export interface PollResult {
  axes: Record<AxisName, AxisReading> | null;
  testing: boolean;
  testRemaining: number;
}

export interface RestAxis {
  mean: number;
  min: number;
  max: number;
  noise: number;
  center: number;
}

export type RestStats = Partial<Record<AxisName, RestAxis>>;
