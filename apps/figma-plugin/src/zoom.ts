// Zoom to the result. When a build lands, when a change lands off screen, and when a request from the window is
// finished, Figma's view glides to what was made or changed: centre and zoom ease together (the zoom in log space, so
// it feels even), instead of jumping. Settings → Zoom to the result turns it off.
//
// The view is the user's: while they're working in Figma (they selected, changed or moved something a moment ago),
// it never moves by itself. The result waits instead, and the window offers "Show the result" (showResult).
import { cursorsRescale, setOwnView, userActiveAt } from "./cursor.ts";

let enabled = true;
export function setZoomEnabled(on: boolean) { enabled = on; }
export function zoomEnabled() { return enabled; }

export const zoomTiming = { glide: 560, gap: 1200, respect: 4000 };
/** The user did something in Figma this recently: leave the view to them. */
const userBusy = () => Date.now() - userActiveAt() < zoomTiming.respect;

/** Requests that make new things: their result is always brought into view. */
const BUILDS = new Set(["executePlan", "importTree"]);
const CHANGES = new Set(["executePlan", "importTree", "editNodes", "applyTransformations"]);

/** Every layer a change made or touched (what to show when it's done). */
export function resultIds(method: string, r: any): string[] {
  if (!r) return [];
  const ids: unknown[] = [];
  if (method === "executePlan") ids.push(...(r.createdRootIds ?? []), ...(r.insertedIds ?? []));
  if (method === "importTree") ids.push(...(r.screens ?? []).map((s: any) => s?.id), r.sectionId);
  if (method === "editNodes") ids.push(...(r.applied ?? []).filter((a: any) => a?.kind !== "delete").map((a: any) => a?.nodeId));
  if (method === "applyTransformations") ids.push(...(r.applied ?? []).map((a: any) => a?.id));
  return [...new Set(ids.filter((x): x is string => typeof x === "string" && !!x))];
}

/** The view that shows a box with some air around it: never closer than 100 % (or the current zoom, if closer). */
export function fitView(box: Rect, screen: { w: number; h: number }, zoomNow: number): { center: Vector; zoom: number } {
  const pad = 1.3;
  const fit = Math.min(screen.w / Math.max(1, box.width * pad), screen.h / Math.max(1, box.height * pad));
  return { center: { x: box.x + box.width / 2, y: box.y + box.height / 2 }, zoom: Math.max(0.02, Math.min(fit, Math.max(1, zoomNow))) };
}

const union = (bs: Rect[]): Rect => {
  const x = Math.min(...bs.map((b) => b.x)), y = Math.min(...bs.map((b) => b.y));
  return { x, y, width: Math.max(...bs.map((b) => b.x + b.width)) - x, height: Math.max(...bs.map((b) => b.y + b.height)) - y };
};
const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

/** The boxes of these layers on the page that is open (a layer on another page isn't worth a page switch). */
async function boxes(ids: string[]): Promise<Rect[]> {
  const out: Rect[] = [];
  for (const id of ids.slice(0, 200)) {
    const n = await figma.getNodeByIdAsync(id).catch(() => null);
    if (!n || !("absoluteBoundingBox" in n)) continue;
    let p: BaseNode | null = n;
    while (p && p.type !== "PAGE") p = p.parent;
    if (!p || p.id !== figma.currentPage.id) continue;
    const b = (n as SceneNode).absoluteBoundingBox;
    if (b && b.width > 0 && b.height > 0) out.push(b);
  }
  return out;
}

let seq = 0;
let lastAt = 0;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/** Glide the view to these boxes; a newer glide cancels this one. */
export async function glideTo(bs: Rect[]): Promise<boolean> {
  if (!bs.length) return false;
  const my = ++seq;
  lastAt = Date.now();
  const v = figma.viewport;
  const z0 = v.zoom || 1;
  const screen = { w: v.bounds.width * z0, h: v.bounds.height * z0 };
  const to = fitView(union(bs), screen, z0);
  const from = { x: v.center.x, y: v.center.y };
  const lz0 = Math.log(z0), lz1 = Math.log(to.zoom);
  const start = Date.now();
  setOwnView(true);
  try {
    for (;;) {
      if (my !== seq) return false;
      const k = Math.min(1, (Date.now() - start) / Math.max(1, zoomTiming.glide)), t = ease(k);
      const z = Math.exp(lz0 + (lz1 - lz0) * t);
      figma.viewport.zoom = z;
      figma.viewport.center = { x: from.x + (to.center.x - from.x) * t, y: from.y + (to.center.y - from.y) * t };
      cursorsRescale(z); // the cursors keep their size on screen while the view moves
      if (k >= 1) return true;
      await sleep(16);
    }
  } finally { if (my === seq) setOwnView(false); }
}

/** "Show the result" in the window: glide to these layers now (the user asked). */
export async function showResult(ids: string[]) { return glideTo(await boxes(ids)); }

// Requests from the window, each on its own (several can run at once): what was changed for it, shown when it's done.
const working = new Map<string, { session: string; ids: Set<string> }>();

/** What happened to a result: shown (the view glided to it), held (the user is busy: the window offers it), or none. */
export type Shown = { shown: boolean; held?: string[] };

/** The window says a request was picked up, or finished (done: show everything that was changed for it). */
export async function zoomRequest(session: string, status: string, request?: string): Promise<Shown> {
  const key = request ?? session;
  if (["sending", "sent", "queued", "seen", "working"].includes(status)) { if (!working.has(key)) working.set(key, { session, ids: new Set() }); return { shown: false }; }
  const w = working.get(key);
  working.delete(key);
  if (!enabled || status !== "done" || !w?.ids.size) return { shown: false };
  if (userBusy()) return { shown: false, held: [...w.ids] };
  return { shown: await glideTo(await boxes([...w.ids])) };
}

/** A change from a session landed: remember it for its request (the task it named, else every open request of that
 *  session); bring a build (or a change off screen) into view, unless the user is busy (then it's held). */
export async function zoomAfter(session: string | undefined, method: string, r: unknown, task?: string): Promise<Shown> {
  if (!CHANGES.has(method)) return { shown: false };
  const ids = resultIds(method, r);
  if (!ids.length) return { shown: false };
  const mine = task && working.has(task) ? [working.get(task)!] : [...working.values()].filter((w) => w.session === session);
  for (const w of mine) for (const id of ids) w.ids.add(id);
  if (!enabled) return { shown: false };
  const bs = await boxes(ids);
  if (!bs.length) return { shown: false };
  const seen = bs.some((b) => overlaps(b, figma.viewport.bounds));
  if (BUILDS.has(method) ? false : seen) return { shown: false }; // a change the user can already see: leave the view alone
  if (!BUILDS.has(method) && Date.now() - lastAt < zoomTiming.gap) return { shown: false }; // not after every small step
  if (userBusy()) return { shown: false, held: ids };
  return { shown: await glideTo(bs) };
}
