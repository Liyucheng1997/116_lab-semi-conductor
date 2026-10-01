import { ProcessState } from "../physics/process";
import { npn, pnp } from "./bjt";
import { diode } from "./diode";
import { nmos, pmos } from "./mosfet";
import type { DeviceDefinition, DeviceKey } from "./types";

export const devices: Record<DeviceKey, DeviceDefinition> = { diode, npn, pnp, nmos, pmos };
export const deviceOrder: DeviceKey[] = ["diode", "npn", "pnp", "nmos", "pmos"];

/** Replay the recipe up to and including step `index`. Optionally scale the last thermal step. */
export function runProcess(def: DeviceDefinition, index = def.recipe.length - 1, lastFraction = 1): ProcessState {
  const state = new ProcessState();
  for (let i = 0; i <= index && i < def.recipe.length; i += 1) {
    state.results = [];
    if (i === index && lastFraction < 1) {
      const original = state.anneal.bind(state);
      state.anneal = (tC: number, minutes: number) => original(tC, minutes, lastFraction);
      def.recipe[i].apply(state);
      state.anneal = original;
    } else {
      def.recipe[i].apply(state);
    }
    if (state.results.length) state.history.push({ step: i, results: [...state.results] });
  }
  return state;
}

const finalCache = new Map<DeviceKey, ProcessState>();

export function finalState(def: DeviceDefinition) {
  let s = finalCache.get(def.key);
  if (!s) {
    s = runProcess(def);
    finalCache.set(def.key, s);
  }
  return s;
}
