import { call } from "@decky/api";
import type { Params, PluginState, PollResult, RestStats } from "./types";

export const getState = () => call<[], PluginState>("get_state");
export const poll = () => call<[], PollResult>("poll");
export const preview = (params: Params) => call<[Params], boolean>("preview", params);
export const revert = () => call<[], boolean>("revert");
export const applyParams = (params: Params) => call<[Params], PluginState>("apply_params", params);
export const applyPreset = (id: string) => call<[string], PluginState>("apply_preset", id);
export const savePreset = (name: string, params: Params) => call<[string, Params], PluginState>("save_preset", name, params);
export const deletePreset = (id: string) => call<[string], PluginState>("delete_preset", id);
export const startTest = (seconds: number) => call<[number], boolean>("start_test", seconds);
export const stopTest = () => call<[], boolean>("stop_test");
export const measureRest = (params: Params) => call<[Params], RestStats>("measure_rest", params);
