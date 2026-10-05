// What Layerwright itself did in Figma, so that everything else is known to be the user's. The user comes first:
// when they select, change or move something the view stays where they have it (zoom.ts), a selection they make
// while a session works isn't credited to that session (sessions.ts), and a text Layerwright wrote is never read as a
// note on the canvas (code.ts).
//
// Figma doesn't say who made a change in this window (the plugin's own changes and the user's are both LOCAL), so
// Layerwright remembers what it did: the selection it set, the page it opened, the view it moved, the layers its
// requests made or changed. None of this writes to the file.

let lastUserAt = 0;
/** The user is working in Figma (selected, changed or moved something): nothing zooms the view meanwhile. */
export function userActed() { lastUserAt = Date.now(); }
/** When the user last did something in Figma. */
export function userActiveAt() { return lastUserAt; }

// ---------- requests ----------
/** Figma reports a request's own changes a moment after it ends: they still count as its own. */
export const LATE_MS = 400;
let runs = 0;
let endedAt = 0;
export function runStarted() { runs++; }
export function runEnded() { runs = Math.max(0, runs - 1); endedAt = Date.now(); }
/** A request is changing the document now, or just did. Requests that wait their turn, or only read, don't count. */
/** When the last request that changed the document ended (0: none yet). */
export function lastRunEnd() { return endedAt; }
export function inRun() { return runs > 0 || Date.now() - endedAt < LATE_MS; }

// ---------- the selection and the page ----------
const keyOf = (nodes: readonly { id: string }[]) => nodes.map((n) => n.id).sort().join(",");
/** The selection Layerwright set last, until the user selects something else. */
let ownSel: string | null = null;
/** A selection that came with a page Layerwright opened: not the user's doing, but not a session's either. */
let pageSel: string | null = null;
let ownPage: string | null = null;
let lastSel: readonly SceneNode[] = [];

/** Select layers on the current page, as Layerwright. */
export function select(nodes: readonly SceneNode[]) {
  figma.currentPage.selection = nodes;
  ownSel = nodes.length ? keyOf(nodes) : null; // selecting nothing: the user's next deselect is still theirs
}
/** Open a page, as Layerwright. */
export async function openPage(page: PageNode) {
  if (page.id === figma.currentPage.id) return;
  ownPage = page.id;
  await figma.setCurrentPageAsync(page);
  pageSel = keyOf(figma.currentPage.selection);
}
/** The selection Layerwright set, while it is still the selection (sorted ids). */
export function ownSelection(): string[] | null {
  return ownSel !== null && ownSel === keyOf(figma.currentPage.selection) ? (ownSel ? ownSel.split(",") : []) : null;
}

/** On selectionchange: did Layerwright make this one (it selected it, opened the page, or selected layers went away)?
 *  Anything else is the user's, and from then on the selection is theirs. */
export function selectionIsOwn(): boolean {
  const now = figma.currentPage.selection, k = keyOf(now), prev = lastSel;
  lastSel = now;
  if (k === ownSel || k === pageSel) return true;
  pageSel = null;
  const left = new Set(now.map((n) => n.id));
  // Layers a request deleted (or rolled back) leave the selection: that isn't the user picking something.
  if (now.length < prev.length && now.every((n) => prev.some((p) => p.id === n.id)) && prev.every((p) => left.has(p.id) || p.removed)) return true;
  ownSel = null;
  return false;
}
/** On currentpagechange: did Layerwright open this page? */
export function pageIsOwn(): boolean {
  const own = ownPage === figma.currentPage.id;
  ownPage = null;
  return own;
}

// ---------- the view ----------
let ownView = false;
let lastView = "";
const viewKey = () => { try { const v = figma.viewport; return `${Math.round(v.center.x)},${Math.round(v.center.y)},${v.zoom.toFixed(3)}`; } catch { return ""; } };
/** The view moves by itself (zoom.ts): that isn't the user moving it. */
export function setOwnView(on: boolean) { ownView = on; if (!on) lastView = viewKey(); }
/** Bring layers into view, as Layerwright. */
export function show(nodes: readonly SceneNode[]) {
  figma.viewport.scrollAndZoomIntoView(nodes);
  lastView = viewKey();
}
/** Remember the view as it is now (a request starts). */
export function lookAtView() { lastView = viewKey(); }
/** While a request runs (cursor.ts, a cheap read per frame): the user moved the view since the last look. */
export function watchView() {
  if (ownView) return;
  const v = viewKey();
  if (lastView && v !== lastView) userActed();
  lastView = v;
}

// ---------- what requests wrote ----------
const wrote = new Set<string>(); // layers a request changed
const made = new Set<string>(); // layers a request created (everything in them is its own)
const keep = (set: Set<string>, ids: Iterable<string>) => {
  for (const id of ids) { set.delete(id); set.add(id); }
  if (set.size > 5000) for (const id of [...set].slice(0, set.size - 4000)) set.delete(id);
};
/** What a request changed and what it created: texts it wrote are Layerwright's, never notes. */
export function wroteNodes(changed: Iterable<string>, created: Iterable<string> = []) { keep(wrote, changed); keep(made, created); }
/** A request changed this very layer (and the user hasn't written in it since). */
export function wroteByRequest(n: BaseNode): boolean { return wrote.has(n.id); }
/** The user wrote in this layer outside any request: from now on its text is theirs. */
export function userWrote(n: BaseNode) { wrote.delete(n.id); }
/** Made or written by Layerwright: a request changed this layer, or created it or a layer it's in, or it is in a
 *  layer that carries the plugin data Layerwright puts on what it creates. (The user's own text in a layer a request
 *  only changed, a renamed frame say, stays theirs.) */
export function byLayerwright(n: BaseNode): boolean {
  if (wrote.has(n.id)) return true;
  for (let p: BaseNode | null = n; p && p.type !== "PAGE" && p.type !== "DOCUMENT"; p = p.parent) {
    if (made.has(p.id)) return true;
    try { if ((p as SceneNode).getPluginData("layerwright")) return true; } catch { /* no plugin data here */ }
  }
  return false;
}
