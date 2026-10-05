// The user's own preferences, the same in every project (~/.layerwright/prefs.json): the language Layerwright
// explains things in, and when a Figma window was last connected (a new session starts watching for requests from
// it even before the window is open again).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { layerwrightHome } from "./meta.ts";

export interface Prefs {
  /** The language to explain things in, as the user named it ("Persian", "English", "فارسی"…). */
  language?: string;
  /** When a paired Figma window last said hello (ISO). */
  figmaSeenAt?: string;
}

const file = () => join(layerwrightHome(), "prefs.json");

export function readPrefs(): Prefs {
  try { const p = JSON.parse(readFileSync(file(), "utf8")); return p && typeof p === "object" ? p : {}; } catch { return {}; }
}

export function writePrefs(patch: Partial<Prefs>): Prefs {
  const next = { ...readPrefs(), ...patch };
  for (const k of Object.keys(next) as (keyof Prefs)[]) if (next[k] === undefined || next[k] === "") delete next[k];
  try { mkdirSync(layerwrightHome(), { recursive: true }); writeFileSync(file(), JSON.stringify(next, null, 2) + "\n"); } catch { /* read-only home */ }
  return next;
}

/** A Figma window was used on this computer within this many days: new sessions watch for its requests. */
export const FIGMA_RECENT_DAYS = 14;
export function figmaUsedRecently(p: Prefs = readPrefs(), now = Date.now()): boolean {
  const t = p.figmaSeenAt ? Date.parse(p.figmaSeenAt) : NaN;
  return Number.isFinite(t) && now - t < FIGMA_RECENT_DAYS * 86_400_000;
}
