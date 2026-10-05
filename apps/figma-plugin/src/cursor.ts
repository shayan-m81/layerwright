// The AI cursor: while a session changes the canvas, a pointer in its colour with its name shows where, the way a
// collaborator's does, and it moves like a hand on a mouse. It drag-selects the layer the change works on and keeps
// busy over it (small moves, clicks), follows the work op by op, and clicks where the work landed. Its tag says what
// is really happening: the text it types, the frame it builds and how far along it is.
//
// Work on several parts at once (edits to several layers, fixes across a screen, inserts into several frames) brings
// a crew: helper cursors split off the session's own, each in a nearby shade, each going to its own part.
//
// Figma has no API for real cursors, so they are drawn as a few locked, tagged layers on top of the page, and they
// live only inside the request that changes something. Reads, and the time between requests, draw nothing:
// - the request's undo step opens before the cursor is drawn and closes after it is erased (undo.ts), so its comings
//   and goings cancel out, and nothing of it is left in the file or in the undo history between requests;
// - the work never waits for it: the request runs at once while the cursor comes, and the cursor's ending (a click
//   where the work landed) lasts timing.end before it is erased and the request answers;
// - where it was is kept in memory only, so the next request's cursor comes back there;
// - layouts (where new frames go), inspects and scans skip them (isOverlay), and their own changes don't count as
//   changes to the design (isOverlayId);
// - they keep the same size on screen at any zoom, also when the user zooms while they work;
// - they carry the Figma user who drew them and when, so a window that closed mid-request clears its own leftovers
//   without touching another user's live cursor (removeLeftovers).
// What happens between requests (a session thinking, working on a request from the window, asking the user in its
// chat) is shown in the plugin window instead.
//
// The cursors work beside the user: they never get in the way (they are locked, and outlines are thin edges, so clicks
// reach the layers under them), and when the user moves the view meanwhile, the view is theirs (own.ts, zoom.ts).
import { watchView } from "./own.ts";

const KEY = "layerwrightCursor";
interface Who { id?: string; name?: string; color?: string }
interface Spot { id: string; point: { x: number; y: number }; box: Rect }
/** One request that changes the canvas: its cursors and outlines, which last only as long as it does. */
interface Run {
  curs: Map<string, Cur>;
  /** Outlines and clicks. */
  transient: Set<SceneNode>;
  /** Ended: everything is erased, and nothing more may be drawn. */
  over: boolean;
  /** The session's own cursor (helpers work for it). */
  lead?: Cur;
  ticker?: ReturnType<typeof setInterval>;
  tick: number;
  progressAt: number;
}
interface Cur {
  run: Run; key: string; name: string; color: string;
  x: number; y: number; z: number;
  /** What the tag says, and how much of it is typed so far. */
  text: string; shown: number;
  /** Smoothed speed on screen (px per ms): the pointer leans and the tag trails by it. */
  vx: number; vy: number;
  root?: FrameNode; arrow?: SceneNode; pill?: FrameNode; label?: TextNode; pillAt?: { x: number; y: number };
  /** How big it is drawn (helpers grow in), and the lean and tag offset last written. */
  s: number; rot: number; lag: { x: number; y: number };
  /** Moves: a newer one cancels an older one; between moves (motion === idleFrom) the life of the cursor goes on. */
  motion: number; idleFrom: number;
  /** The area it works on now: it keeps moving over it. When to make its next small move. */
  box?: Rect; hopAt: number;
  /** A helper: the key of the session cursor it works for. */
  lead?: string;
  /** The running request, op by op: which layer each step works on, and what the tag says there. */
  plan?: { id?: string; text: string }[];
}

let enabled = true;
let run: Run | undefined;
let font: FontName | undefined;
/** Where each session's cursor was when its last request ended: the next request's cursor comes back there. */
const last = new Map<string, { x: number; y: number }>();
/** How long moves, the drag-select and the typing of its tag take; how lively it is between moves (0: still); how
 *  many helpers at most; how long the ending lasts before the cursor is erased and the request answers. */
export const timing = { glide: 520, select: 240, type: 320, life: 1, crew: 3, end: 240 };
/** Frames: moves at ~60 fps, the life between moves at ~25 fps (every frame is a tiny canvas update). */
const FRAME = 16, LIFE_FRAME = 40;
/** An overlay older than this is a leftover, whoever drew it (no request draws for that long). */
const STALE_MS = 30 * 60_000;

export function setCursorEnabled(on: boolean) { enabled = on; if (!on) cursorsClear(); }
export function cursorEnabled() { return enabled; }

/** A Layerwright overlay (a cursor, an outline), never part of the design. */
export function isOverlay(n: BaseNode): boolean {
  try { return "getPluginData" in n && !!(n as SceneNode).getPluginData(KEY); } catch { return false; }
}

/** An overlay no running request of this window owns that is safe to remove: this user's (a window that closed or
 *  crashed mid-request), an older version's, or one older than STALE_MS. Another user's live cursor stays. */
export function isLeftover(n: BaseNode): boolean {
  if (!isOverlay(n) || drawing(n)) return false;
  let d: { user?: unknown; at?: unknown } | undefined;
  try { const v = JSON.parse((n as SceneNode).getPluginData(KEY)); d = v && typeof v === "object" ? v : undefined; } catch { /* an older version's mark */ }
  if (!d) return true;
  const me = figma.currentUser?.id;
  return (!!me && d.user === me) || !(typeof d.at === "number" && Date.now() - d.at < STALE_MS);
}

/** Drawn by the request running now in this window. */
function drawing(n: BaseNode): boolean {
  if (!run) return false;
  for (const c of run.curs.values()) if (c.root?.id === n.id) return true;
  for (const t of run.transient) if (t.id === n.id) return true;
  return false;
}

/** Remove leftovers (top level of each loaded page); how many went. */
export function removeLeftovers(): number {
  let gone = 0;
  for (const page of figma.root.children) {
    let kids: readonly SceneNode[];
    try { kids = page.children; } catch { continue; } // page not loaded
    for (const n of [...kids]) if (isLeftover(n)) { try { n.remove(); gone++; } catch { /* already gone */ } }
  }
  return gone;
}

/** Where a request will work, before it runs: the layers it edits, the parent it builds into, what it looks at. */
export function cursorTargets(method: string, p: any): string[] {
  const ids: string[] = [];
  const add = (v: unknown) => { if (typeof v === "string" && v && !v.startsWith("$") && v !== "selection" && v !== "page" && !ids.includes(v)) ids.push(v); };
  if (method === "editNodes") for (const op of p?.ops ?? []) { add(op?.node); for (const n of op?.nodes ?? []) add(n); add(op?.parent); }
  if (method === "applyTransformations") for (const t of p?.transformations ?? []) add(t?.nodeId);
  if (method === "executePlan") { add(p?.plan?.target?.parentId); for (const ins of p?.plan?.inserts ?? []) add(ins?.parentId); }
  if (method === "inspect") add(p?.target);
  if (method === "exportImage") add(p?.nodeId);
  if (method === "select") for (const n of p?.nodeIds ?? []) add(n);
  return ids.slice(0, 8);
}

/** Where the work ended up: the first new frame, or the first layer that changed. */
export function landingOf(method: string, r: any): string | undefined {
  if (!r) return undefined;
  if (method === "executePlan") return r.createdRootIds?.[0];
  if (method === "importTree") return r.sectionId ?? r.screens?.[0]?.id;
  if (method === "editNodes") return (r.applied ?? []).map((a: any) => a?.nodeId).find((x: unknown) => typeof x === "string");
  if (method === "applyTransformations") return r.applied?.[0]?.id;
  return undefined;
}

/** Requests that change the canvas: the cursor drag-selects what they touch and clicks where they land. */
const CHANGES = new Set(["executePlan", "importTree", "editNodes", "applyTransformations", "cleanup", "foundations"]);

// ---------- what the tag says ----------
const clip = (s: unknown, n = 22) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
const q = (s: unknown) => `“${clip(s)}”`;
const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;
type Names = (id: unknown) => string;

/** One edit op as a person would say it, with the layer's name. */
function opPhrase(o: any, nm: Names): string {
  const n = nm(o?.node ?? o?.nodes?.[0]);
  switch (o?.op) {
    case "rename": return `renaming ${n} → ${q(o.name)}`;
    case "move": return `moving ${n}`;
    case "duplicate": return `duplicating ${n}`;
    case "set":
      if (o.text !== undefined) return `typing ${q(o.text)}`;
      if (o.properties) return `setting ${clip(Object.keys(o.properties).join(", "), 26)} on ${n}`;
      if (o.width !== undefined || o.height !== undefined) return `resizing ${n}`;
      if (o.x !== undefined || o.y !== undefined) return `moving ${n}`;
      if (o.visible === false) return `hiding ${n}`;
      if (o.visible === true) return `showing ${n}`;
      if (o.opacity !== undefined) return `fading ${n} to ${Math.round(o.opacity * 100)}%`;
      return `adjusting ${n}`;
    case "delete": return `deleting ${n}`;
    case "resizeToFit": return `fitting ${n} to its content`;
    case "prototype": return `linking ${n} in the prototype`;
    case "swap": return `swapping ${n}`;
    case "annotate": return `annotating ${n}`;
    case "bind": return `binding a variable on ${n}`;
    case "style": return `styling ${n}`;
    case "group": return `grouping ${plural((o.nodes ?? []).length || 1, "layer")}`;
    case "ungroup": return `ungrouping ${n}`;
    case "boolean": return `combining ${plural((o.nodes ?? []).length || 2, "shape")}`;
    case "flow": return "setting a prototype flow";
    case "componentize": return `turning ${n} into a component`;
    default: return `editing ${n}`;
  }
}

const SAME: Record<string, string> = { rename: "renaming", move: "moving", duplicate: "duplicating", delete: "deleting", set: "adjusting", componentize: "componentizing", style: "styling", bind: "binding variables on" };

/** What a request is about to do, in the words the tag shows ("renaming “Header” → “Top bar”", "building “Checkout” +2"). */
export function describeRequest(method: string, p: any, nm: Names = (id) => (typeof id === "string" ? "a layer" : "it")): string {
  if (method === "editNodes") {
    const ops: any[] = p?.ops ?? [];
    if (!ops.length) return "editing";
    if (ops.length === 1) return opPhrase(ops[0], nm);
    const kinds = new Set(ops.map((o) => o?.op));
    if (kinds.size === 1 && SAME[ops[0]?.op]) return `${SAME[ops[0].op]} ${plural(ops.length, "layer")}`;
    return `${opPhrase(ops[0], nm)} · ${plural(ops.length, "change")}`;
  }
  if (method === "executePlan") {
    const roots: any[] = p?.plan?.roots ?? [];
    const ins: any[] = p?.plan?.inserts ?? [];
    if (roots.length) return `building ${q(roots[0]?.name ?? p?.plan?.name ?? "a frame")}${roots.length > 1 ? ` +${roots.length - 1}` : ""}`;
    if (ins.length) return `adding ${plural(ins.reduce((s, x) => s + (x?.roots?.length ?? 0), 0) || 1, "layer")} into ${nm(ins[0]?.parentId)}`;
    return "building";
  }
  if (method === "importTree") { const s: any[] = p?.screens ?? []; return s.length ? `importing ${q(s[0]?.name)}${s.length > 1 ? ` +${s.length - 1}` : ""}` : "importing"; }
  if (method === "applyTransformations") { const n = (p?.transformations ?? []).length; return n ? `applying ${plural(n, "design-system fix", "design-system fixes")}` : "applying the design system"; }
  if (method === "inspect") return !p?.target || p.target === "selection" ? "reading your selection" : p.target === "page" ? "scanning the page" : `reading ${nm(p.target)}`;
  if (method === "exportImage") return `taking a picture of ${nm(p?.nodeId)}`;
  if (method === "select") return `showing ${nm(p?.nodeIds?.[0])}`;
  if (method === "scanDesignSystem") return "reading the design system";
  if (method === "foundations") return "creating variables and styles";
  if (method === "cleanup") return p?.approved ? "removing leftovers" : "looking for leftovers";
  if (method === "ensurePages") return "setting up pages";
  return "working";
}

/** The request step by step: the layer each step works on and what a cursor there says (edits, design-system fixes). */
export function planOf(method: string, p: any, nm: Names): { id?: string; text: string }[] {
  const id = (v: unknown) => (typeof v === "string" && !v.startsWith("$") ? v : undefined);
  if (method === "editNodes") return (p?.ops ?? []).map((o: any) => ({ id: id(o?.node ?? o?.nodes?.[0]), text: opPhrase(o, nm) }));
  if (method === "applyTransformations") return (p?.transformations ?? []).map((t: any) => ({ id: id(t?.nodeId),
    text: t?.op === "replace_with_instance" && t?.componentName ? `swapping in ${q(t.componentName)}` : `fixing ${nm(t?.nodeId)}` }));
  if (method === "executePlan") return (p?.plan?.inserts ?? []).map((x: any) => ({ id: id(x?.parentId), text: `adding into ${nm(x?.parentId)}` }));
  return [];
}

/** What a finished change says on its tag for a moment. */
export function describeDone(method: string, p: any, r: any): string {
  if (method === "executePlan") { const n = (r?.createdRootIds ?? []).length; return n ? `built ${plural(n, "frame")} ✓` : "done ✓"; }
  if (method === "importTree") { const n = (r?.screens ?? []).length; return n ? `imported ${plural(n, "screen")} ✓` : "imported ✓"; }
  if (method === "editNodes") {
    const ops: any[] = p?.ops ?? [];
    if (ops.length === 1 && ops[0]?.op === "componentize") return "component ready ✓";
    const n = (r?.applied ?? []).length;
    return n ? `${plural(n, "change")} done ✓` : "done ✓";
  }
  if (method === "applyTransformations") { const n = (r?.applied ?? []).length; return n ? `applied ${plural(n, "fix", "fixes")} ✓` : "done ✓"; }
  return "done ✓";
}


/** Layer names for the tag, looked up once per request. */
async function namesFor(method: string, p: any): Promise<Names> {
  const ids = new Set<string>(cursorTargets(method, p));
  if (method === "editNodes") for (const o of p?.ops ?? []) { if (typeof o?.node === "string") ids.add(o.node); }
  if (method === "applyTransformations") for (const t of p?.transformations ?? []) { if (typeof t?.nodeId === "string") ids.add(t.nodeId); }
  const map = new Map<string, string>();
  await Promise.all([...ids].slice(0, 24).map(async (id) => { try { const n = await figma.getNodeByIdAsync(id); if (n && "name" in n) map.set(id, n.name); } catch { /* gone */ } }));
  return (id) => (typeof id === "string" && map.has(id) ? q(map.get(id)) : typeof id === "string" && id.startsWith("$") ? "the new layer" : "a layer");
}


// ---------- motion ----------
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
// A hand's reach: minimum jerk (how people really move a mouse: smooth start, smooth stop), with the smallest
// overshoot before it settles.
const minJerk = (t: number) => t * t * t * (10 - 15 * t + 6 * t * t);
const easeHand = (k: number) => minJerk(k) + (k > 0.72 ? 0.028 * Math.sin((Math.PI * (k - 0.72)) / 0.28) : 0);
const easeQuick = (k: number) => 1 - Math.pow(1 - k, 3);
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const keyOf = (s?: Who) => s?.id ?? "solo";
const zoomNow = () => Math.min(8, Math.max(0.02, figma.viewport.zoom || 1));
const rand = (a: number, b: number) => a + Math.random() * (b - a);

// ---------- what the cursors draw ----------
/** Every node the cursors draw (and their parts): their own changes are not changes to the design. */
const overlayIds = new Set<string>();
const own = <T extends BaseNode>(n: T): T => { try { if (n.id) overlayIds.add(n.id); } catch { /* no id */ } return n; };
export function isOverlayId(id: string | undefined): boolean { return !!id && overlayIds.has(id); }
/** A top-level overlay: tagged (with who drew it, and when) and locked, the moment it is made. */
function mark<T extends SceneNode>(n: T): T {
  own(n);
  n.setPluginData(KEY, JSON.stringify({ user: figma.currentUser?.id ?? "", at: Date.now() }));
  n.locked = true;
  return n;
}

function rgb(hex: string): RGB {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  const v = m ? parseInt(m[1], 16) : 0x7c3aed;
  return { r: ((v >> 16) & 255) / 255, g: ((v >> 8) & 255) / 255, b: (v & 255) / 255 };
}

/** A nearby shade of a session's colour (a helper, another task): the hue turned a little, a touch lighter. */
export function shade(hex: string, turn: number): string {
  const { r, g, b } = rgb(hex);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = d === 0 ? 0 : max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (((h * 60 + turn) % 360) + 360) % 360;
  const l2 = Math.min(0.68, l + 0.06), c = (1 - Math.abs(2 * l2 - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l2 - c / 2;
  const [r1, g1, b1] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  const hx = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, "0");
  return `#${hx(r1)}${hx(g1)}${hx(b1)}`;
}

/** Figma's multiplayer arrow, filled with the session colour, outlined in white. */
const ARROW = (color: string) =>
  `<svg width="18" height="22" viewBox="0 0 18 22" xmlns="http://www.w3.org/2000/svg"><path d="M2.4 1.9 L2.4 18.6 L7 14.2 L14.6 13.8 Z" fill="${color}" stroke="#ffffff" stroke-width="1.7" stroke-linejoin="round"/></svg>`;
const SHADOW = (a: number, y: number, r: number): DropShadowEffect => ({ type: "DROP_SHADOW", color: { r: 0, g: 0, b: 0, a }, offset: { x: 0, y }, radius: r, spread: 0, visible: true, blendMode: "NORMAL" });

async function ensureFont() {
  if (font) return font;
  let f: FontName = { family: "Inter", style: "Semi Bold" };
  try { await figma.loadFontAsync(f); } catch { f = { family: "Inter", style: "Regular" }; await figma.loadFontAsync(f); }
  return (font = f);
}

/** Draw a cursor where it is (synchronous: fonts are already loaded). `appear`: it starts invisible and fades in. */
function draw(c: Cur, appear: boolean) {
  if (!font || c.run.over) return;
  const root = mark(figma.createFrame());
  root.name = `✦ ${c.name} (Layerwright cursor)`;
  root.fills = [];
  root.clipsContent = false;
  root.resize(1, 1);
  const arrow = own(figma.createNodeFromSvg(ARROW(c.color)));
  arrow.name = "Pointer";
  arrow.fills = [];
  arrow.effects = [SHADOW(0.3, 1, 3)];
  for (const k of arrow.findAll?.(() => true) ?? []) own(k);
  root.appendChild(arrow);
  const pill = own(figma.createFrame());
  pill.name = "Name";
  pill.layoutMode = "HORIZONTAL";
  pill.primaryAxisSizingMode = "AUTO";
  pill.counterAxisSizingMode = "AUTO";
  // Figma's name tag: a small rounded rectangle (not a pill) in the session colour, white text, just below and right
  // of the arrow, with only a faint shadow.
  pill.paddingLeft = pill.paddingRight = 6;
  pill.paddingTop = pill.paddingBottom = 3;
  pill.cornerRadius = 4;
  pill.fills = [{ type: "SOLID", color: rgb(c.color) }];
  pill.effects = [SHADOW(0.12, 1, 3)];
  const label = own(figma.createText());
  label.fontName = font;
  label.fontSize = 12;
  label.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];
  pill.appendChild(label);
  root.appendChild(pill);
  pill.x = 12;
  pill.y = 17;
  const scale = c.s / c.z;
  if (Math.abs(scale - 1) > 0.01) root.rescale(scale);
  root.x = c.x;
  root.y = c.y;
  if (appear) root.opacity = 0;
  c.root = root;
  c.arrow = arrow;
  c.pill = pill;
  c.label = label;
  c.pillAt = { x: pill.x, y: pill.y }; // after the rescale: in canvas units
  c.rot = 0; c.lag = { x: 0, y: 0 };
  paint(c);
  pose(c, true);
}

function erase(c: Cur) {
  try { if (c.root && !c.root.removed) c.root.remove(); } catch { /* already gone */ }
  c.root = c.arrow = c.pill = c.label = undefined;
}

/** Put what the tag says (as far as it is typed) on the canvas. */
function paint(c: Cur) {
  const l = c.label;
  if (!l || l.removed) return;
  const chars = `${c.name}  ·  ${c.text.slice(0, c.shown) || " "}`;
  if (l.characters === chars) return;
  l.characters = chars;
  // The session's name stands out; what it's doing reads quieter.
  try { l.setRangeFills(c.name.length, chars.length, [{ type: "SOLID", color: { r: 1, g: 1, b: 1 }, opacity: 0.8 }]); } catch { /* plain is fine */ }
}

/** A new line for the tag. What it shares with the old line stays; the rest types itself out. */
function say(c: Cur, text: string) {
  if (text !== c.text) {
    let k = 0;
    while (k < c.shown && k < text.length && text[k] === c.text[k]) k++;
    c.text = text;
    c.shown = timing.type > 0 ? k : text.length;
  }
  paint(c);
}

/** The pointer leans into the move and its tag trails behind, by the cursor's speed on screen. Tiny changes aren't
 *  written: every write is a change on the canvas. */
function pose(c: Cur, force = false) {
  const rot = clamp(-c.vx * 7, -11, 11) + clamp(c.vy * 3, -4, 4);
  const lag = { x: clamp(c.vx * 9, -14, 14), y: clamp(c.vy * 6, -9, 9) };
  if (c.arrow && !c.arrow.removed && (force || Math.abs(rot - c.rot) > 0.3)) { try { (c.arrow as FrameNode).rotation = rot; c.rot = rot; } catch { /* decoration */ } }
  if (c.pill && !c.pill.removed && c.pillAt && (force || Math.abs(lag.x - c.lag.x) > 0.3 || Math.abs(lag.y - c.lag.y) > 0.3)) {
    c.pill.x = c.pillAt.x - (lag.x * c.s) / c.z;
    c.pill.y = c.pillAt.y - (lag.y * c.s) / c.z;
    c.lag = lag;
  }
}

function place(c: Cur, x: number, y: number) {
  c.x = x; c.y = y;
  if (c.root && !c.root.removed) { c.root.x = x; c.root.y = y; }
}

/** Speed on screen, smoothed so the lean grows and settles instead of jumping. */
function feel(c: Cur, x: number, y: number, px: number, py: number, dt: number) {
  c.vx += (((x - px) * c.z) / Math.max(1, dt) - c.vx) * 0.3;
  c.vy += (((y - py) * c.z) / Math.max(1, dt) - c.vy) * 0.3;
  pose(c);
}

/** Grow or shrink the cursor smoothly (a helper splitting off). */
async function scaleTo(c: Cur, to: number, ms: number) {
  const from = c.s, start = Date.now();
  for (;;) {
    if (c.run.over) return;
    const k = Math.min(1, (Date.now() - start) / Math.max(1, ms));
    const s = from + (to - from) * easeQuick(k);
    if (c.root && !c.root.removed && Math.abs(s / c.s - 1) > 0.002) {
      const f = s / c.s;
      try { c.root.rescale(f); } catch { /* decoration */ }
      if (c.pillAt) c.pillAt = { x: c.pillAt.x * f, y: c.pillAt.y * f };
    }
    c.s = s;
    if (k >= 1) return;
    await sleep(FRAME);
  }
}

/** Glide along an uneven arc (a wrist turns, a hand doesn't move in straight lines); a newer move cancels this one. */
async function glide(c: Cur, to: { x: number; y: number }, ms: number, ease = easeHand) {
  const my = ++c.motion;
  c.idleFrom = -1; // the life between moves waits until this move is done
  const from = { x: c.x, y: c.y };
  const dx = to.x - from.x, dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 0.5) { c.idleFrom = c.motion; return; }
  const nx = -dy / dist, ny = dx / dist;
  const bend = Math.min(70 / c.z, dist * 0.17) * (dx >= 0 ? 1 : -1) * (0.7 + Math.random() * 0.6);
  const c1 = { x: from.x + dx * 0.28 + nx * bend, y: from.y + dy * 0.28 + ny * bend };
  const c2 = { x: from.x + dx * 0.74 + nx * bend * 0.45, y: from.y + dy * 0.74 + ny * bend * 0.45 };
  // Longer trips take a little longer, like a real hand (Fitts), within bounds.
  const dur = Math.min(ms * 1.7, Math.max(ms * 0.5, ms * (0.5 + 0.5 * Math.log10(1 + dist * c.z / 40))));
  const start = Date.now();
  let last = start, px = c.x, py = c.y;
  for (;;) {
    if (my !== c.motion || c.run.over) return;
    const now = Date.now();
    const k = Math.min(1, (now - start) / dur); // by the clock: a slow frame never makes it stutter
    const t = ease(k), s = Math.min(1, t), u = 1 - s;
    // A cubic Bézier for the path; past its end (the overshoot), straight on along the last stretch.
    const x = u * u * u * from.x + 3 * u * u * s * c1.x + 3 * u * s * s * c2.x + s * s * s * to.x + (t - s) * (to.x - c2.x);
    const y = u * u * u * from.y + 3 * u * u * s * c1.y + 3 * u * s * s * c2.y + s * s * s * to.y + (t - s) * (to.y - c2.y);
    place(c, x, y);
    feel(c, x, y, px, py, now - last);
    px = x; py = y; last = now;
    if (k >= 1) break;
    await sleep(FRAME);
  }
  place(c, to.x, to.y);
  if (my === c.motion) c.idleFrom = c.motion; // the ticker eases the lean back to rest
}

/** A layer on the current page: a point a little inside its top-left, and its box. */
async function spot(id: string | undefined, z: number): Promise<Spot | undefined> {
  if (!id) return undefined;
  const n = await figma.getNodeByIdAsync(id).catch(() => null);
  if (!n || !("absoluteBoundingBox" in n)) return undefined;
  let p: BaseNode | null = n;
  while (p && p.type !== "PAGE") p = p.parent;
  if (!p || p.id !== figma.currentPage.id) return undefined;
  const b = (n as SceneNode).absoluteBoundingBox;
  if (!b) return undefined;
  return { id, point: { x: b.x + Math.min(28 / z, b.width * 0.2), y: b.y + Math.min(28 / z, b.height * 0.2) }, box: b };
}

async function spotsOf(ids: string[], z: number, max = 4): Promise<Spot[]> {
  const out: Spot[] = [];
  for (const id of ids) { if (out.length >= max) break; const s = await spot(id, z); if (s) out.push(s); }
  return out;
}

interface Outline { group: GroupNode; tint?: RectangleNode; set(b: Rect): void }

/** The outline Figma draws around a collaborator's selection, in the session's colour: four thin edges in a group,
 *  so nothing covers the layer (a click on it still reaches it). `tint`: a see-through fill while it's dragged. */
function outline(c: Cur, box: Rect, tint = 0): Outline | undefined {
  if (c.run.over) return undefined;
  try {
    const w = 1.5 / c.z;
    const edges = [0, 1, 2, 3].map(() => { const r = own(figma.createRectangle()); r.name = "Edge"; r.fills = [{ type: "SOLID", color: rgb(c.color) }]; return r; });
    const fill = tint ? own(figma.createRectangle()) : undefined;
    if (fill) { fill.name = "Marquee"; fill.fills = [{ type: "SOLID", color: rgb(c.color), opacity: tint }]; }
    const set = (b: Rect) => {
      const W = Math.max(0.01, b.width), H = Math.max(0.01, b.height);
      const [t, btm, l, r] = edges;
      t.resize(W + 2 * w, w); t.x = b.x - w; t.y = b.y - w;
      btm.resize(W + 2 * w, w); btm.x = b.x - w; btm.y = b.y + H;
      l.resize(w, H); l.x = b.x - w; l.y = b.y;
      r.resize(w, H); r.x = b.x + W; r.y = b.y;
      if (fill && !fill.removed) { fill.resize(W, H); fill.x = b.x; fill.y = b.y; }
    };
    set(box);
    const group = mark(figma.group(fill ? [fill, ...edges] : edges, figma.currentPage));
    group.name = `${c.name} is here (Layerwright)`;
    c.run.transient.add(group);
    // Bring the cursors back on top of the outline.
    for (const k of c.run.curs.values()) if (k.root && !k.root.removed) figma.currentPage.appendChild(k.root);
    return { group, tint: fill, set };
  } catch { return undefined; } // decoration
}

/** Figma's selection handles: four small white squares on the corners. */
function handles(c: Cur, o: Outline, box: Rect) {
  if (c.run.over || o.group.removed) return;
  try {
    const d = 6 / c.z;
    for (const [hx, hy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      const h = own(figma.createRectangle());
      h.name = "Handle";
      h.resize(d, d);
      h.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];
      h.strokes = [{ type: "SOLID", color: rgb(c.color) }];
      h.strokeWeight = 1 / c.z;
      o.group.appendChild(h);
      h.x = box.x + hx * box.width - d / 2; h.y = box.y + hy * box.height - d / 2;
    }
  } catch { /* decoration */ }
}

/** Select the layer the way a person does: from the cursor, drag a marquee over it, let go, the outline stays. */
async function dragSelect(c: Cur, box: Rect) {
  const v = figma.viewport.bounds;
  const small = box.width * c.z < 900 && box.height * c.z < 700 && box.width > 0 && box.height > 0;
  const seen = box.x < v.x + v.width && box.x + box.width > v.x && box.y < v.y + v.height && box.y + box.height > v.y;
  if (!small || !seen || timing.select <= 0) { const o = outline(c, box); if (o) handles(c, o, box); return; }
  const from = { x: box.x - 6 / c.z, y: box.y - 6 / c.z };
  await glide(c, from, timing.glide * 0.6);
  const o = outline(c, { x: from.x, y: from.y, width: 1, height: 1 }, 0.08);
  if (!o) return;
  const my = c.motion;
  c.idleFrom = -1; // the drag owns the position until it lets go
  const start = Date.now();
  const to = { x: box.x + box.width, y: box.y + box.height };
  let px = c.x, py = c.y, last = start;
  for (;;) {
    if (my !== c.motion || o.group.removed || c.run.over) return;
    const now = Date.now();
    const k = Math.min(1, (now - start) / timing.select), t = minJerk(k);
    const x = from.x + (to.x - from.x) * t, y = from.y + (to.y - from.y) * t;
    o.set({ x: Math.min(from.x, x), y: Math.min(from.y, y), width: Math.abs(x - from.x), height: Math.abs(y - from.y) });
    place(c, x, y);
    feel(c, x, y, px, py, now - last);
    px = x; py = y; last = now;
    if (k >= 1) break;
    await sleep(FRAME);
  }
  // Let go: the marquee snaps to the layer, its tint goes and the handles appear.
  if (o.group.removed || c.run.over) return;
  o.set(box);
  if (o.tint && !o.tint.removed) o.tint.remove();
  handles(c, o, box);
  c.idleFrom = c.motion;
}

/** One expanding ring that fades: a click. */
async function ring(c: Cur, at: { x: number; y: number }, grow: number, weight: number, steps = 8) {
  if (c.run.over) return;
  try {
    const e = mark(figma.createEllipse());
    e.name = "Click (Layerwright)";
    e.fills = [];
    e.strokes = [{ type: "SOLID", color: rgb(c.color) }];
    c.run.transient.add(e);
    for (let i = 1; i <= steps; i++) {
      if (e.removed) return;
      const k = easeQuick(i / steps);
      const d = (4 + k * grow) / c.z;
      e.resize(d, d);
      e.x = at.x - d / 2; e.y = at.y - d / 2;
      e.strokeWeight = Math.max(0.3, weight * (1 - k * 0.8)) / c.z;
      e.opacity = 1 - k;
      await sleep(FRAME);
    }
    if (!e.removed) e.remove();
    c.run.transient.delete(e);
  } catch { /* decoration */ }
}

/** A small click while working: the pointer dips, one quick ring. */
async function tap(c: Cur, at: { x: number; y: number }) {
  c.vy = 1.6; pose(c);
  await ring(c, at, 14, 1.4, 6);
}

/** Working over a layer: the next small move, near where it is (a big layer is worked on a part at a time). */
function poke(c: Cur, b: Rect): { x: number; y: number } {
  const reach = 150 / c.z;
  const x = clamp(c.x + rand(-reach, reach), b.x + b.width * 0.08, b.x + b.width * 0.92);
  const y = clamp(c.y + rand(-reach * 0.7, reach * 0.7), b.y + b.height * 0.08, b.y + b.height * 0.92);
  return { x, y };
}

/** The life of the cursors between moves, while the request runs: the tag types itself out, the lean settles, and
 *  each one keeps busy, moving and clicking over its layer. Each frame also looks at the view (cheap reads): the
 *  cursors keep their size on screen when the user zooms, and the user moving the view counts as them working. */
function animate(r: Run) {
  if (r.over) return;
  r.tick++;
  watchView();
  cursorsRescale(figma.viewport.zoom);
  const now = Date.now(), t = now / 1000;
  for (const c of r.curs.values()) {
    if (!c.root || c.root.removed) continue;
    // The request opened another page: the cursor goes along.
    if (c.root.parent && c.root.parent.id !== figma.currentPage.id) { try { figma.currentPage.appendChild(c.root); } catch { /* decoration */ } }
    if (c.root.opacity < 0.99) c.root.opacity = Math.min(1, c.root.opacity + 0.1);
    if (c.shown < c.text.length) {
      const step = Math.max(1, Math.ceil(c.text.length / Math.max(1, timing.type / LIFE_FRAME)));
      c.shown = Math.min(c.text.length, c.shown + step);
      paint(c);
    }
    if (c.motion !== c.idleFrom) continue; // a move is running: leave the position to it
    if (Math.abs(c.vx) > 0.01 || Math.abs(c.vy) > 0.01) { c.vx *= 0.6; c.vy *= 0.6; pose(c); } // settle the lean
    else if (c.vx || c.vy) { c.vx = c.vy = 0; pose(c, true); }
    if (timing.life > 0 && c.box && now >= c.hopAt) {
      const to = poke(c, c.box);
      c.hopAt = now + rand(340, 900) / timing.life;
      void glide(c, to, rand(170, 260)).then(() => { if (c.box && Math.random() < 0.5) void tap(c, to); });
      continue;
    }
    if (r.tick % 2) continue; // the tremor needs only half the frames
    c.root.x = c.x + Math.sin(t * 7.3) * (0.8 / c.z); // the small tremor of a hand on the mouse
    c.root.y = c.y + Math.cos(t * 6.1) * (0.6 / c.z);
  }
}

function make(r: Run, key: string, name: string, color: string, at: { x: number; y: number }, appear: boolean, lead?: string, s = 1): Cur {
  const c: Cur = { run: r, key, name, color, x: at.x, y: at.y, z: zoomNow(), text: "", shown: 0, vx: 0, vy: 0,
    motion: 0, idleFrom: 0, hopAt: Date.now() + 900, lead, s, rot: 0, lag: { x: 0, y: 0 } };
  r.curs.set(key, c);
  r.ticker ??= setInterval(() => animate(r), LIFE_FRAME);
  try { draw(c, appear); } catch { /* decoration */ }
  return c;
}

/** A helper for the session's cursor: it splits off from it (small, growing as it goes), in a nearby shade. */
function helper(c: Cur, i: number): Cur {
  const key = `${c.key}#${i + 2}`;
  let h = c.run.curs.get(key);
  if (!h) {
    h = make(c.run, key, `${c.name} ${i + 2}`, shade(c.color, (i % 2 ? -1 : 1) * (26 + 12 * Math.floor(i / 2))), { x: c.x, y: c.y }, false, c.key, 0.55);
    void scaleTo(h, 1, 340);
  }
  return h;
}

/** Send a crew to work: each helper goes to its part, drag-selects it and keeps busy over it. */
function dispatch(c: Cur, parts: { spot: Spot; text: string }[]) {
  parts.slice(0, timing.crew).forEach((p, i) => {
    const h = helper(c, i);
    say(h, p.text);
    void (async () => { await sleep(i * 110); if (c.run.over) return; await dragSelect(h, p.spot.box); h.box = p.spot.box; h.hopAt = Date.now() + rand(150, 500); })();
  });
}

/** The request is over: erase everything it drew and stop its life (its last place is remembered). */
function finish(r: Run) {
  if (r.over) return;
  r.over = true;
  if (run === r) run = undefined;
  clearInterval(r.ticker);
  if (r.lead) last.set(r.lead.key, { x: r.lead.x, y: r.lead.y });
  for (const c of r.curs.values()) { c.motion++; erase(c); }
  for (const n of r.transient) { try { if (!n.removed) n.remove(); } catch { /* already gone */ } }
  r.curs.clear();
  r.transient.clear();
  if (overlayIds.size > 20_000) overlayIds.clear();
}

/** The view zoomed (zoom.ts, or the user): every cursor keeps its size on screen. */
export function cursorsRescale(z: number) {
  if (!run) return;
  const zz = Math.min(8, Math.max(0.02, z || 1));
  for (const c of run.curs.values()) {
    const f = c.z / zz;
    if (Math.abs(f - 1) < 0.001) continue;
    if (c.root && !c.root.removed) { try { c.root.rescale(f); } catch { /* decoration */ } }
    if (c.pillAt) c.pillAt = { x: c.pillAt.x * f, y: c.pillAt.y * f };
    c.z = zz;
  }
}

/** A request that changes the canvas starts: the session's cursor comes (back where it last was), says what it is
 *  about to do and drag-selects the layer; work on several layers brings helpers, one per layer. It returns at once:
 *  the request runs while the cursor comes. Reads draw nothing. The caller has opened the request's undo step. */
export function cursorBegin(s: Who | undefined, method: string, params: unknown): void {
  if (!enabled || !CHANGES.has(method)) return;
  if (run) finish(run);
  const r: Run = { curs: new Map(), transient: new Set(), over: false, tick: 0, progressAt: 0 };
  run = r;
  void (async () => {
    const z = zoomNow();
    const [spots, names] = await Promise.all([spotsOf(cursorTargets(method, params), z, 1 + timing.crew), namesFor(method, params).catch(() => undefined), ensureFont()]);
    if (r.over) return; // the request was over first
    const t = spots[0];
    const key = keyOf(s), was = last.get(key);
    const v = figma.viewport.bounds;
    const start = was ?? (t ? { x: t.point.x - 90 / z, y: t.point.y - 70 / z } : { x: v.x + v.width * 0.5, y: v.y + v.height * 0.45 });
    const c = (r.lead = make(r, key, s?.name || "Claude", s?.color || "#7c3aed", start, !was));
    const nm: Names = names ?? ((id) => (typeof id === "string" ? "a layer" : "it"));
    c.plan = planOf(method, params, nm);
    say(c, describeRequest(method, params, nm));
    if (!t) {
      // A build with nowhere known to land yet: it works over the middle of the view while the frames are made.
      c.box = { x: v.x + v.width * 0.3, y: v.y + v.height * 0.3, width: v.width * 0.4, height: v.height * 0.4 };
      return;
    }
    // One part per cursor: the session's own takes the first, helpers the rest, each saying what it does there.
    if (spots.length > 1) dispatch(c, spots.slice(1).map((sp) => ({ spot: sp, text: c.plan?.find((p) => p.id === sp.id)?.text ?? "helping" })));
    c.box = t.box;
    c.hopAt = Date.now() + 250;
    await dragSelect(c, t.box);
  })().catch(() => { /* decoration */ });
}

/** Progress of the running request: the tag follows it ("building “Hero” · 2/5"), and step by step the crew moves to
 *  the layer each step works on, says what it does there and clicks. */
export function cursorProgress(label: string, done?: number, total?: number) {
  const c = run?.lead;
  if (!enabled || !c || c.run.over || !label) return;
  const r = c.run;
  const step = done !== undefined ? c.plan?.[done] : undefined;
  if (step?.id) {
    const crew = [...r.curs.values()];
    const w = crew[done! % crew.length];
    void (async () => {
      const sp = await spot(step.id, w.z);
      if (!sp || r.over) return;
      if (w !== c) say(w, step.text);
      w.box = sp.box;
      w.hopAt = Date.now() + 500;
      await glide(w, sp.point, 240, easeQuick);
      void tap(w, sp.point);
    })();
  }
  const now = Date.now();
  const end = total !== undefined && done !== undefined && done >= total;
  if (now - r.progressAt < 120 && !end) return; // a few updates a second are enough
  r.progressAt = now;
  const words = step && !/[“"]/.test(label) ? step.text : label.replace(/"([^"]*)"/g, (_m, x) => q(x));
  const how = total && total > 1 ? (total > 20 ? ` · ${Math.round(((done ?? 0) / total) * 100)}%` : ` · ${Math.min(total, (done ?? 0) + 1)}/${total}`) : "";
  say(c, words.charAt(0).toLowerCase() + words.slice(1) + how);
}

/** The request is done: the cursor says what it did and clicks where the work landed, for timing.end at most; then
 *  everything it drew is erased, before the caller closes the undo step. */
export async function cursorEnd(ok: boolean, method: string, result?: unknown, params?: unknown): Promise<void> {
  const r = run;
  if (!r) return;
  const c = r.lead;
  if (c && !r.over) {
    for (const k of r.curs.values()) { k.box = undefined; k.plan = undefined; }
    if (ok) {
      say(c, describeDone(method, params, result));
      void (async () => {
        const land = await spot(landingOf(method, result), c.z);
        if (!land || r.over) return;
        await glide(c, land.point, timing.end * 0.6, easeQuick);
        void ring(c, land.point, 30, 2.2, 6);
      })();
    } else say(c, "hit a problem");
    await sleep(timing.end);
  }
  finish(r);
}

/** A session left: forget where its cursors were. */
export function cursorGone(sessionId: string) {
  for (const k of [...last.keys()]) if (k === sessionId || k.startsWith(`${sessionId}~`)) last.delete(k);
}

/** Erase the cursors now (the window closes, or the switch is turned off). */
export function cursorsClear() { if (run) finish(run); }
