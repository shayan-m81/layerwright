// "Claude is working": a Figma notification (the toast at the bottom of the canvas) while a session works in this
// file. Every Figma call but status checks renews it, so it stays up through a multi-step job (scanning the Design
// System, reading frames, taking pictures, building) and goes by itself a few seconds after the last call. A toast is
// not part of the document: no layers, no undo steps, nothing in the version history. (The AI cursor is drawn as
// layers, so it only shows inside a change, where it shares the change's own undo step: cursor.ts.)

/** Calls that don't show it: a status check, a link. */
const QUIET = new Set(["ping", "refs"]);
const SAYS: Record<string, string> = {
  executePlan: "building", importTree: "importing HTML", scanDesignSystem: "scanning the Design System", applyTransformations: "applying the Design System",
  editNodes: "editing layers", exportImage: "taking a picture", cleanup: "cleaning up", foundations: "creating variables and styles", ensurePages: "setting up pages",
  select: "showing it on the canvas",
};
/** How long it stays after the last call: long enough to cover the agent's next step, short enough to go soon after. */
export const WORKING_MS = 6000;
/** Another session's toast replaces this one no sooner than this (two sessions at once would make it flicker). */
export const FLICKER_MS = 1500;

let shown: NotificationHandler | undefined;
let text = "";
let by = "";
let at = 0;

/** What the toast says for a call. */
export function workingText(who: string | undefined, method: string, params: any): string {
  const what = method === "inspect" ? (params?.target === "page" ? "reading the page" : "reading layers") : SAYS[method] ?? "working";
  return `✦ ${who || "Claude"} · ${what}…`;
}

/** A session's call starts: show (or renew) the toast. `on`: the user's "AI cursor" switch covers it too. */
export function working(who: string | undefined, method: string, params: unknown, on: boolean, now = Date.now()): void {
  if (!on || QUIET.has(method)) return;
  show(workingText(who, method, params), who || "Claude", now);
}

/** A long call reports progress (a big build, a scan): the toast stays up as long as it runs. */
export function workingStill(now = Date.now()): void {
  if (shown && text) show(text, by, now);
}

function show(t: string, who: string, now: number) {
  // The same words a moment ago: leave it up (renewing every call would make it jump); renew before it times out.
  if (shown && t === text && now - at < WORKING_MS / 2) return;
  // Another session's step right after this one's: this one stays a moment first.
  if (shown && who !== by && now - at < FLICKER_MS) return;
  try {
    shown?.cancel();
    const h: NotificationHandler = figma.notify(t, { timeout: WORKING_MS, onDequeue: () => { if (shown === h) shown = undefined; } });
    shown = h;
    text = t;
    by = who;
    at = now;
  } catch { /* a notice, nothing more */ }
}

/** The switch was turned off, or the window closes: take it down now. */
export function workingClear(): void {
  try { shown?.cancel(); } catch { /* already gone */ }
  shown = undefined;
  text = "";
}
