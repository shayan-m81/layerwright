// "Claude is working": a Figma notification (the toast at the bottom of the canvas) while a session works in this
// file. Every Figma call but status checks renews it, so it stays up through a multi-step job (scanning the Design
// System, reading frames, taking pictures, building). Between steps it says the session is thinking, until its next
// step, until its turn ends (Claude Code's hooks tell the window: "done ✓"), or until it has been quiet for a while.
// A toast is not part of the document: no layers, no undo steps, nothing in the version history. (The AI cursor is
// drawn as layers, so it only shows during a step, never between steps: cursor.ts.)

/** Calls that don't show it: a status check, a link. */
const QUIET = new Set(["ping", "refs"]);
const SAYS: Record<string, string> = {
  executePlan: "building", importTree: "importing HTML", scanDesignSystem: "scanning the Design System", applyTransformations: "applying the Design System",
  editNodes: "editing layers", exportImage: "taking a picture", cleanup: "cleaning up", foundations: "creating variables and styles", ensurePages: "setting up pages",
  select: "showing it on the canvas",
};
/** How long a step's toast stays after the last call: long enough to cover the agent's next step. Then it says the
 *  session is thinking, for THINK_MS at most (TURN_MS for a session whose turn end Figma hears about), and a session
 *  whose turn ended says "done ✓" for DONE_MS. */
export const WORKING_MS = 6000, THINK_MS = 45_000, TURN_MS = 180_000, DONE_MS = 2500;
/** Another session's toast replaces this one no sooner than this (two sessions at once would make it flicker). */
export const FLICKER_MS = 1500;

let shown: NotificationHandler | undefined;
let text = "";
let by = "";
/** The session (or request) the toast is about. */
let key = "";
let kind: "step" | "thinking" | "done" = "step";
let at = 0;
/** Sessions whose turn end Figma hears about (Claude Code's hooks): their "thinking…" lasts until then. */
const reports = new Set<string>();
/** Sessions whose turn ended: no "thinking…" until their next step. */
const over = new Set<string>();

/** What the toast says for a call. */
export function workingText(who: string | undefined, method: string, params: any): string {
  const what = method === "inspect" ? (params?.target === "page" ? "reading the page" : "reading layers") : SAYS[method] ?? "working";
  return `✦ ${who || "Claude"} · ${what}…`;
}

/** A session's call starts: show (or renew) the toast. `on`: the user's "AI cursor" switch covers it too. `id`: the
 *  session (or the request) it's for, when it isn't its name. */
export function working(who: string | undefined, method: string, params: unknown, on: boolean, now = Date.now(), id = who || "Claude"): void {
  if (!on || QUIET.has(method)) return;
  over.delete(id);
  show(workingText(who, method, params), who || "Claude", id, "step", WORKING_MS, now);
}

/** A long call reports progress (a big build, a scan): the toast stays up as long as it runs. */
export function workingStill(now = Date.now()): void {
  if (shown && text && kind === "step") show(text, by, key, "step", WORKING_MS, now);
}

/** What the session does in its chat (the window hears it from the session's hooks): it waits for the user (the
 *  caller shows that notice instead), the user answered, or its turn ended: "done ✓", and no "thinking…" after it. */
export function workingTurn(id: string, name: string | undefined, waiting: boolean, state?: string, now = Date.now()): void {
  reports.add(id);
  if (waiting || state !== "done") return;
  over.add(id);
  if (shown && key === id) show(`✦ ${name || by || "Claude"} · done ✓`, name || by, id, "done", DONE_MS, now, true);
}

function show(t: string, who: string, id: string, k: typeof kind, timeout: number, now: number, force = false) {
  if (!force) {
    // The same words a moment ago: leave it up (renewing every call would make it jump); renew before it times out.
    if (shown && t === text && now - at < timeout / 2) return;
    // Another session's step right after this one's: this one stays a moment first.
    if (shown && who !== by && kind !== "thinking" && now - at < FLICKER_MS) return;
  }
  try {
    const old = shown;
    shown = undefined; // its dequeue is ours, not a timeout to follow up on
    old?.cancel();
    const h: NotificationHandler = figma.notify(t, { timeout, onDequeue: (reason) => {
      if (shown !== h) return;
      shown = undefined;
      text = "";
      // A step's toast ran out: the session is between steps, still on its task.
      if (reason === "timeout" && k === "step" && !over.has(id)) show(`✦ ${who} · thinking…`, who, id, "thinking", reports.has(id) ? TURN_MS : THINK_MS, Date.now(), true);
    } });
    shown = h;
    text = t;
    by = who;
    key = id;
    kind = k;
    at = now;
  } catch { /* a notice, nothing more */ }
}

/** The switch was turned off, or the window closes: take it down now. */
export function workingClear(): void {
  const old = shown;
  shown = undefined;
  text = "";
  try { old?.cancel(); } catch { /* already gone */ }
}
