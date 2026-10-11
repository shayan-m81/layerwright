// The AI cursor: while a session works in Figma, a pointer in its colour with its name shows it, the way a
// collaborator's does, from the first step of its task to the end of it. It moves like a hand on a mouse: it goes
// where the session looks and skims the layer it reads, drag-selects the layer it changes and keeps busy over it
// (small moves, clicks), follows the work op by op, clicks where the work landed, and between steps stays near,
// "thinking", until the session is done (its turn ends, the request from the window is finished) or goes quiet. Its
// tag says who it is and, briefly, what is really happening (the layer it reads, the text it types, the frame it
// builds and how far along it is).
//
// Work on several parts at once (edits to several layers, fixes across a screen, inserts into several frames) brings
// a crew: helper cursors split off the session's own, each in a nearby shade, each going to its own part, for as long
// as that change runs.
//
// Figma has no API for real cursors, so they are drawn as a few locked, tagged layers on top of the page. They must
// never become part of the design or of its history:
// - every undo step is closed with the cursors taken off the canvas and drawn again right after, in the same moment
//   (undo.ts), so no step holds any of them and every request stays exactly one step. (Figma takes what a plugin drew
//   since its last commit as the newest undo step, so the user's first ⌘Z after a step may take a cursor away: it then
//   stays away until its session's next step, and a redo that brings it back has it taken away again);
// - they step aside while the user works in Figma (selects, edits, changes page: cursorsYield) and come back with
//   their session's next step;
// - they go once their session is done or quiet, when it leaves, when the switch is turned off or the window closes,
//   and nothing of them (no layer, no timer) is left after that;
// - layouts (where new frames go), inspects and scans skip them (isOverlay), and their own changes don't count as
//   changes to the design (isOverlayId);
// - they keep the same size on screen at any zoom, also when the user zooms while they work;
// - they carry the Figma user who drew them and when, so a window that closed while one was drawn clears its own
//   leftovers without touching another user's live cursor (removeLeftovers).
//
// The cursors work beside the user: they never get in the way (they are locked, and outlines are thin edges, so clicks
// reach the layers under them), and when the user moves the view meanwhile, the view is theirs (own.ts, zoom.ts).
import { watchView } from "./own.ts";

const KEY = "layerwrightCursor";
type Mode = "look" | "work" | "think" | "ask";
/** Who a cursor is: a session, or one of its requests from the window. */
export interface Who { id?: string; name?: string; color?: string }
interface Spot { id: string; point: { x: number; y: number }; box: Rect }
interface Cur {
  key: string; name: string; color: string;
  x: number; y: number; z: number; mode: Mode;
  /** Its session's calls running now, and when the last one started or ended. */
  calls: number; lastAt: number;
  /** When it goes by itself (its session done or quiet), unless more work comes first. */
  leaveAt: number;
  /** When "done ✓" (or what a change did) gives way to "thinking". */
  thinkAt: number;
  /** What the tag says, how much of it is typed so far, and the thinking dots after it. */
  text: string; shown: number; dots: string;
  /** Smoothed speed on screen (px per ms): the pointer leans and the tag trails by it. */
  vx: number; vy: number;
  root?: FrameNode; arrow?: SceneNode; pill?: FrameNode; label?: TextNode; pillAt?: { x: number; y: number };
  /** How big it is drawn (helpers grow in), and the lean and tag offset last written. */
  s: number; rot: number; lag: { x: number; y: number };
  /** Moves: a newer one cancels an older one; between moves (motion === idleFrom) the life of the cursor goes on. */
  motion: number; idleFrom: number;
  /** The area it works on or reads now: it keeps moving over it. When to make its next small move; where a skim is. */
  box?: Rect; hopAt: number; scan: number;
  /** A helper: the key of the session cursor it works for. */
  lead?: string;
  /** The running change, op by op: which layer each step works on, and what the tag says there. */
  plan?: { id?: string; text: string }[];
  /** Fading out on its way: set to the moment it started (more work brings it back). */
  leaving?: number;
  /** The request from the window it works on ("polishing this"), while that is open. */
  busy?: string;
}

let enabled = true;
const curs = new Map<string, Cur>();
/** Outlines and clicks: they last as long as the change that drew them (or the click). */
const transient = new Set<SceneNode>();
/** Cursors an undo took off the canvas: a redo brings them back, and they're taken away again. */
const ghosts = new Set<SceneNode>();
let font: FontName | undefined;
let ticker: ReturnType<typeof setInterval> | undefined;
let tick = 0;
/** The change running now (the desk runs them one at a time): the cursor its progress moves, settled once that
 *  cursor is drawn (or never will be), and when it appeared. */
let change: { c: Cur; ready: Promise<void>; progressAt: number; shownAt?: number } | undefined;
/** Where each session's cursor was when it went: the next one comes back there. */
const last = new Map<string, { x: number; y: number }>();
/** Sessions that say when they wait for the user or end their turn (Claude Code's hooks): their cursor stays until then. */
const reports = new Set<string>();
/** The user's last selection, edit or page change while cursors were around: they stay off the canvas a moment. */
let awayAt = 0;
/** How long moves, the drag-select and the typing of its tag take; how lively it is between moves (0: still); how
 *  many helpers at most; how long a change's ending lasts; how long a cursor stays on screen at least in a change (a
 *  quick change is still seen being made); how long a change's ending waits at most for a cursor still being set up;
 *  how long it stays after its session's last step (quiet; one that says when its turn ends; one on a request from
 *  the window; one waiting for the user's answer; once it's done); how long the user must leave Figma alone before a
 *  cursor that stepped aside comes back; how long it takes to fade away. */
export const timing = { glide: 520, select: 240, type: 320, life: 1, crew: 3, end: 240, min: 700, drawWait: 1500,
  think: 45_000, turn: 180_000, busy: 180_000, ask: 120_000, done: 2_500, quiet: 3_000, fade: 380 };
/** Frames: moves at ~60 fps, the life between moves at ~25 fps (every frame is a tiny canvas update). */
const FRAME = 16, LIFE_FRAME = 40;
/** An overlay older than this is a leftover, whoever drew it (a live cursor is drawn again at every undo step). */
const STALE_MS = 30 * 60_000;
/** A call that never ends doesn't keep its cursor forever. */
const STUCK_MS = 10 * 60_000;

export function setCursorEnabled(on: boolean) { enabled = on; if (!on) cursorsClear(); }
export function cursorEnabled() { return enabled; }

/** A Layerwright overlay (a cursor, an outline), never part of the design. */
export function isOverlay(n: BaseNode): boolean {
  try { return "getPluginData" in n && !!(n as SceneNode).getPluginData(KEY); } catch { return false; }
}

/** An overlay this window isn't showing that is safe to remove: this user's (a window that closed or crashed while a
 *  cursor was drawn), an older version's, or one older than STALE_MS. Another user's live cursor stays. */
export function isLeftover(n: BaseNode): boolean {
  if (!isOverlay(n) || drawing(n)) return false;
  let d: { user?: unknown; at?: unknown } | undefined;
  try { const v = JSON.parse((n as SceneNode).getPluginData(KEY)); d = v && typeof v === "object" ? v : undefined; } catch { /* an older version's mark */ }
  if (!d) return true;
  const me = figma.currentUser?.id;
  return (!!me && d.user === me) || !(typeof d.at === "number" && Date.now() - d.at < STALE_MS);
}

/** Drawn by this window now. */
function drawing(n: BaseNode): boolean {
  for (const c of curs.values()) if (c.root?.id === n.id) return true;
  for (const t of transient) if (t.id === n.id) return true;
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
/** Calls that bring no cursor: a status check, a link, setting up pages (an empty first page is reused as it is). */
const QUIET = new Set(["ping", "refs", "ensurePages"]);

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

/** The request the user sent from the window, as the tag says it while the session works on it. */
const ASK: Record<string, string> = { code: "building it in code", polish: "polishing this", component: "making a component", mobile: "making a mobile version", ask: "your question", update: "updating Layerwright", skill: "writing a skill" };

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
/** The session a cursor belongs to (a request's cursor is "<session>~<request>"). */
const sessionOf = (key: string) => key.split("~")[0];
const zoomNow = () => Math.min(8, Math.max(0.02, figma.viewport.zoom || 1));
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const live = (c: Cur) => curs.get(c.key) === c;
const crewOf = (c: Cur) => [...curs.values()].filter((h) => h.lead === c.key);
/** The user selected, edited or changed page a moment ago: cursors stay off the canvas. */
const away = () => Date.now() - awayAt < timing.quiet;

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
const WHITE = (opacity = 1): SolidPaint => ({ type: "SOLID", color: { r: 1, g: 1, b: 1 }, opacity });

async function ensureFont() {
  if (font) return font;
  let f: FontName = { family: "Inter", style: "Semi Bold" };
  try { await figma.loadFontAsync(f); } catch { f = { family: "Inter", style: "Regular" }; await figma.loadFontAsync(f); }
  return (font = f);
}

/** Draw a cursor where it is (synchronous: fonts are already loaded). `appear`: it starts invisible and fades in. */
function draw(c: Cur, appear: boolean) {
  if (!font || c.root || !live(c)) return;
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
  label.fills = [WHITE()];
  pill.appendChild(label);
  root.appendChild(pill);
  pill.x = 12;
  pill.y = 17;
  const scale = c.s / c.z;
  if (Math.abs(scale - 1) > 0.01) root.rescale(scale);
  root.x = c.x;
  root.y = c.y;
  if (appear) root.opacity = 0;
  else if (c.leaving !== undefined) root.opacity = 0.5;
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

/** Put what the tag says (as far as it is typed) on the canvas: the name, and briefly what it's doing. */
function paint(c: Cur) {
  const l = c.label;
  if (!l || l.removed) return;
  const said = clip(c.text.slice(0, c.shown), 34) + (c.shown >= c.text.length ? c.dots : "");
  const chars = `${c.name}  ·  ${said || " "}`;
  if (l.characters === chars) return;
  l.characters = chars;
  // The session's name stands out; what it's doing reads quieter.
  try { l.setRangeFills(c.name.length, chars.length, [WHITE(0.8)]); } catch { /* plain is fine */ }
}

/** A new line for the tag. What it shares with the old line stays; the rest types itself out. */
function say(c: Cur, text: string, dots = "") {
  if (text !== c.text) {
    let k = 0;
    while (k < c.shown && k < text.length && text[k] === c.text[k]) k++;
    c.text = text;
    c.shown = timing.type > 0 ? k : text.length;
  }
  c.dots = dots;
  paint(c);
}

/** The pointer leans into the move and its tag trails behind, by the cursor's speed on screen. Tiny changes aren't
 *  written: every write is a change on the canvas. `wave`: an extra turn of the pointer (asking the user). */
function pose(c: Cur, force = false, wave = 0) {
  const rot = clamp(-c.vx * 7, -11, 11) + clamp(c.vy * 3, -4, 4) + wave;
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
    if (!live(c)) return;
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
    if (my !== c.motion || !live(c)) return;
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

/** Where a request works: its layers, or for a read of "the selection", the layer selected. */
function targetsOf(method: string, params: any, z: number) {
  const ids = cursorTargets(method, params);
  if (method === "inspect" && (!params?.target || params.target === "selection")) ids.push(...figma.currentPage.selection.slice(0, 1).map((n) => n.id));
  return spotsOf(ids, z, 1 + timing.crew);
}

interface Outline { group: GroupNode; tint?: RectangleNode; set(b: Rect): void }

/** The outline Figma draws around a collaborator's selection, in the session's colour: four thin edges in a group,
 *  so nothing covers the layer (a click on it still reaches it). `tint`: a see-through fill while it's dragged. */
function outline(c: Cur, box: Rect, tint = 0): Outline | undefined {
  if (!live(c) || !c.root || c.mode !== "work") return undefined; // only while its change runs
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
    transient.add(group);
    // Bring the cursors back on top of the outline.
    for (const k of curs.values()) if (k.root && !k.root.removed) figma.currentPage.appendChild(k.root);
    return { group, tint: fill, set };
  } catch { return undefined; } // decoration
}

/** Figma's selection handles: four small white squares on the corners. */
function handles(c: Cur, o: Outline, box: Rect) {
  if (!live(c) || o.group.removed) return;
  try {
    const d = 6 / c.z;
    for (const [hx, hy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      const h = own(figma.createRectangle());
      h.name = "Handle";
      h.resize(d, d);
      h.fills = [WHITE()];
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
    if (my !== c.motion || o.group.removed || !live(c)) return;
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
  if (o.group.removed || !live(c)) return;
  o.set(box);
  if (o.tint && !o.tint.removed) o.tint.remove();
  handles(c, o, box);
  c.idleFrom = c.motion;
}

/** One expanding ring that fades: a click. */
async function ring(c: Cur, at: { x: number; y: number }, grow: number, weight: number, steps = 8) {
  if (!live(c) || !c.root) return;
  try {
    const e = mark(figma.createEllipse());
    e.name = "Click (Layerwright)";
    e.fills = [];
    e.strokes = [{ type: "SOLID", color: rgb(c.color) }];
    transient.add(e);
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
    transient.delete(e);
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

/** Reading a layer: left to right along a few lines, top to bottom, the way eyes and hand skim it. */
function skim(c: Cur, b: Rect): { x: number; y: number } {
  const lines = clamp(Math.round((b.height * c.z) / 70), 2, 6), stops = 3;
  const i = c.scan++ % (lines * stops), row = Math.floor(i / stops), col = i % stops;
  return { x: b.x + b.width * (0.14 + 0.36 * col) + rand(-4, 4) / c.z, y: b.y + b.height * ((row + 0.5) / lines) + rand(-3, 3) / c.z };
}

/** Fade a cursor towards an opacity (on its way out). */
async function fadeTo(c: Cur, to: number, ms: number, on: () => boolean) {
  const from = c.root?.opacity ?? 1, start = Date.now();
  for (;;) {
    if (!on() || !c.root || c.root.removed) return;
    const k = Math.min(1, (Date.now() - start) / Math.max(1, ms));
    c.root.opacity = from + (to - from) * easeQuick(k);
    if (k >= 1) return;
    await sleep(FRAME * 2);
  }
}

/** The life of the cursors between moves: the tag types itself out, the lean settles, and each one keeps busy:
 *  working cursors move and click over their layer, reading ones skim it, thinking ones sway and now and then look
 *  around, asking ones wave. Each frame also looks at the view (cheap reads): the cursors keep their size on screen
 *  when the user zooms, and the user moving the view counts as them working. A cursor whose session is done or quiet
 *  goes. */
function animate() {
  tick++;
  watchView();
  cursorsRescale(figma.viewport.zoom);
  const now = Date.now(), t = now / 1000;
  for (const n of transient) if (n.removed) transient.delete(n);
  // A redo brought back a cursor an undo took away: it goes again.
  for (const g of ghosts) { if (g.removed) continue; ghosts.delete(g); try { g.remove(); } catch { /* gone */ } }
  for (const c of [...curs.values()]) {
    // Taken off the canvas by someone else (an undo, a delete): it stays off until its session's next step.
    if (c.root?.removed) { ghosts.add(c.root); c.root = c.arrow = c.pill = c.label = undefined; awayAt = now; }
    if (!c.lead && c.leaving === undefined && (c.calls ? now - c.lastAt > STUCK_MS : now >= c.leaveAt)) { void retire(c); continue; }
    if (!c.root) continue;
    // Its session opened another page: the cursor goes along.
    if (c.root.parent && c.root.parent.id !== figma.currentPage.id) { try { figma.currentPage.appendChild(c.root); } catch { /* decoration */ } }
    if (c.leaving === undefined && c.root.opacity < 0.99) c.root.opacity = Math.min(1, c.root.opacity + 0.1);
    if (c.shown < c.text.length) {
      const step = Math.max(1, Math.ceil(c.text.length / Math.max(1, timing.type / LIFE_FRAME)));
      c.shown = Math.min(c.text.length, c.shown + step);
      paint(c);
    }
    if (c.mode === "think" && now >= c.thinkAt) { c.thinkAt = Infinity; say(c, c.busy ? `on it: ${c.busy}` : "thinking"); }
    if (c.motion !== c.idleFrom) continue; // a move is running: leave the position to it
    if (c.mode === "ask") { askLife(c, now); continue; }
    if (Math.abs(c.vx) > 0.01 || Math.abs(c.vy) > 0.01) { c.vx *= 0.6; c.vy *= 0.6; pose(c); } // settle the lean
    else if (c.vx || c.vy) { c.vx = c.vy = 0; pose(c, true); }
    const lively = timing.life > 0;
    if (lively && c.box && (c.mode === "work" || c.mode === "look") && now >= c.hopAt) {
      const look = c.mode === "look";
      const to = look ? skim(c, c.box) : poke(c, c.box);
      c.hopAt = now + (look ? rand(380, 620) : rand(340, 900)) / timing.life;
      void glide(c, to, look ? 260 : rand(170, 260), look ? minJerk : easeHand).then(() => { if (!look && c.mode === "work" && Math.random() < 0.5) void tap(c, to); });
      continue;
    }
    if (tick % 2) continue; // the drift needs only half the frames
    if (c.mode === "think") {
      if (tick % 10 === 0 && c.shown >= c.text.length) { c.dots = c.thinkAt === Infinity ? ".".repeat((tick / 10) % 4) : ""; paint(c); } // the dots, every 0.4 s
      if (lively && now >= c.hopAt) { // now and then, a glance a little way off and back
        c.hopAt = now + rand(2600, 4800) / timing.life;
        const home = { x: c.x, y: c.y };
        void glide(c, { x: c.x + rand(-40, 40) / c.z, y: c.y + rand(-26, 26) / c.z }, 380, minJerk).then(() => sleep(rand(300, 700))).then(() => { if (c.mode === "think" && c.motion === c.idleFrom) void glide(c, home, 420, minJerk); });
        continue;
      }
      if (!lively) continue;
      // A slow figure-eight, the way a hand rests on a mouse while its owner thinks.
      c.root.x = c.x + Math.sin(t * 1.4 + c.key.length) * (4 / c.z);
      c.root.y = c.y + Math.sin(t * 2.8 + c.key.length) * (1.8 / c.z);
    } else if (c.mode === "look") {
      c.root.x = c.x + (Math.sin(t * 2.1) + 0.4 * Math.sin(t * 5.3)) * (1.4 / c.z);
      c.root.y = c.y + Math.cos(t * 1.7) * (1 / c.z);
    } else {
      c.root.x = c.x + Math.sin(t * 7.3) * (0.8 / c.z); // working: the small tremor of a hand on the mouse
      c.root.y = c.y + Math.cos(t * 6.1) * (0.6 / c.z);
    }
  }
}

/** Waiting for the user's answer in the chat: it waves (a quick back-and-forth every two seconds), and a ring pulses
 *  from it now and then, so it's seen without being in the way. */
function askLife(c: Cur, now: number) {
  const phase = (now % 2200) / 2200;
  const wave = phase < 0.3 ? Math.sin((phase / 0.3) * Math.PI * 4) * 14 * (1 - phase / 0.3) : 0;
  pose(c, false, wave);
  if (now >= c.hopAt) { c.hopAt = now + 1600; void ring(c, { x: c.x + 2 / c.z, y: c.y + 2 / c.z }, 30, 2, 14); }
}

function ensureTicker() { if (curs.size && !ticker) ticker = setInterval(animate, LIFE_FRAME); }

/** A cursor (not drawn yet): where its session's last one was, else nowhere yet (drawn once its place is known). */
function make(key: string, name: string, color: string, lead?: string): Cur {
  const was = lead ? undefined : last.get(key);
  const now = Date.now();
  const c: Cur = { key, name, color, x: was?.x ?? NaN, y: was?.y ?? NaN, z: zoomNow(), mode: "think", calls: 0, lastAt: now,
    leaveAt: now + timing.think, thinkAt: Infinity, text: "", shown: 0, dots: "", vx: 0, vy: 0,
    motion: 0, idleFrom: 0, hopAt: now + 900, scan: 0, lead, s: 1, rot: 0, lag: { x: 0, y: 0 } };
  curs.set(key, c);
  ensureTicker();
  return c;
}

/** The session's cursor, made if it has none. Its name and colour follow the session's. */
function cur(s: Who | undefined): Cur {
  const key = keyOf(s);
  const name = s?.name || "Claude", color = s?.color || "#7c3aed";
  const c = curs.get(key) ?? make(key, name, color);
  if (c.name !== name || c.color !== color) {
    const drawn = !!c.root;
    c.name = name; c.color = color;
    if (drawn) { erase(c); draw(c, false); } // renamed (its title), or a new colour: drawn again as it is now
  }
  c.leaving = undefined; // a cursor that was on its way out stays (the ticker brings its colour back)
  return c;
}

/** Draw the cursor if it isn't on the canvas: where it was, near where the work is, or in the middle of the view.
 *  A cursor stays off while the user is busy in Figma, unless a change brings it (`force`). */
function show(c: Cur, near: { x: number; y: number } | undefined, force: boolean) {
  if (c.root || !live(c) || (!force && away())) return;
  const z = zoomNow(), v = figma.viewport.bounds;
  if (!Number.isFinite(c.x) || !Number.isFinite(c.y)) {
    const start = near ? { x: near.x - 90 / z, y: near.y - 70 / z } : { x: v.x + v.width * 0.5, y: v.y + v.height * 0.45 };
    c.x = start.x; c.y = start.y;
  }
  c.z = z;
  try { draw(c, true); } catch { /* decoration */ }
}

/** How long a cursor stays after its session's last step. */
function stay(c: Cur) {
  return c.mode === "ask" ? timing.ask : c.busy ? timing.busy : reports.has(sessionOf(c.key)) ? timing.turn : timing.think;
}

/** A helper for the session's cursor: it splits off from it (small, growing as it goes), in a nearby shade. */
function helper(c: Cur, i: number): Cur {
  const key = `${c.key}#${i + 2}`;
  let h = curs.get(key);
  if (!h) {
    h = make(key, `${c.name} ${i + 2}`, shade(c.color, (i % 2 ? -1 : 1) * (26 + 12 * Math.floor(i / 2))), c.key);
    h.x = c.x; h.y = c.y; h.s = 0.55; h.mode = "work";
    if (c.root) { try { draw(h, false); } catch { /* decoration */ } void scaleTo(h, 1, 340); }
  }
  return h;
}

/** Send a crew to work: each helper goes to its part, drag-selects it and keeps busy over it. */
function dispatch(c: Cur, parts: { spot: Spot; text: string }[]) {
  parts.slice(0, timing.crew).forEach((p, i) => {
    const h = helper(c, i);
    say(h, p.text);
    void (async () => { await sleep(i * 110); if (!live(h)) return; await dragSelect(h, p.spot.box); h.box = p.spot.box; h.hopAt = Date.now() + rand(150, 500); })();
  });
}

/** On its way out: it fades, then goes (unless more work comes first: then it stays). */
async function retire(c: Cur) {
  const stamp = (c.leaving = Date.now());
  const on = () => c.leaving === stamp && live(c);
  await fadeTo(c, 0, timing.fade, on);
  if (on()) leave(c);
}

/** A cursor goes: erased, forgotten (its last place remembered), its helpers with it. With no cursor left, nothing
 *  of them is: no outline, no timer. */
function leave(c: Cur) {
  if (!live(c)) return;
  c.motion++;
  erase(c);
  curs.delete(c.key);
  if (!c.lead && Number.isFinite(c.x)) last.set(c.key, { x: c.x, y: c.y });
  if (change?.c === c) change = undefined;
  for (const h of crewOf(c)) leave(h);
  if (curs.size) return;
  for (const n of transient) { try { if (!n.removed) n.remove(); } catch { /* already gone */ } }
  transient.clear();
  ghosts.clear();
  clearInterval(ticker);
  ticker = undefined;
  if (overlayIds.size > 20_000) overlayIds.clear();
}

/** The view zoomed (zoom.ts, or the user): every cursor keeps its size on screen. */
export function cursorsRescale(z: number) {
  const zz = Math.min(8, Math.max(0.02, z || 1));
  for (const c of curs.values()) {
    const f = c.z / zz;
    if (Math.abs(f - 1) < 0.001) continue;
    if (c.root && !c.root.removed) { try { c.root.rescale(f); } catch { /* decoration */ } }
    if (c.pillAt) c.pillAt = { x: c.pillAt.x * f, y: c.pillAt.y * f };
    c.z = zz;
  }
}

/** A session's call starts. Its cursor comes (back where it last was) or wakes, says what it is about to do and goes
 *  there: a read skims the layer it looks at, a change drag-selects the layer it changes, and work on several layers
 *  brings helpers, one per layer. It returns at once: the call runs while the cursor comes. A change's caller has
 *  opened the change's undo step. */
export function cursorBegin(s: Who | undefined, method: string, params: unknown): void {
  if (!enabled) return;
  if (QUIET.has(method)) { const c = curs.get(keyOf(s)); if (c && !c.calls) c.leaveAt = Math.max(c.leaveAt, Date.now() + stay(c)); return; }
  const c = cur(s);
  const works = CHANGES.has(method);
  c.calls++;
  c.lastAt = Date.now();
  if (c.mode !== "work" || works) c.mode = works ? "work" : "look";
  let ready: (() => void) | undefined;
  const run: typeof change = works ? (change = { c, ready: new Promise<void>((ok) => { ready = ok; }), progressAt: 0 }) : undefined;
  void (async () => {
    const z = zoomNow();
    const [spots, names] = await Promise.all([targetsOf(method, params, z), namesFor(method, params).catch(() => undefined), ensureFont()]);
    if ((run && change !== run) || !live(c)) return; // the change was over first, or the cursor went
    const t = spots[0];
    show(c, t?.point, works);
    if (run && c.root) run.shownAt ??= Date.now();
    ready?.();
    const nm: Names = names ?? ((id) => (typeof id === "string" ? "a layer" : "it"));
    if (works) c.plan = planOf(method, params, nm);
    c.scan = 0;
    c.thinkAt = Infinity;
    say(c, describeRequest(method, params, nm));
    if (!t) {
      // A build with nowhere known to land yet: it works over the middle of the view while the frames are made.
      const v = figma.viewport.bounds;
      if (works) c.box = { x: v.x + v.width * 0.3, y: v.y + v.height * 0.3, width: v.width * 0.4, height: v.height * 0.4 };
      return;
    }
    // One part per cursor: the session's own takes the first, helpers the rest, each saying what it does there.
    if (works && spots.length > 1 && c.root) dispatch(c, spots.slice(1).map((sp) => ({ spot: sp, text: c.plan?.find((p) => p.id === sp.id)?.text ?? "helping" })));
    c.box = t.box;
    c.hopAt = Date.now() + 250;
    if (works) await dragSelect(c, t.box);
    else void glide(c, t.point, timing.glide);
  })().catch(() => { /* decoration */ }).finally(() => ready?.());
}

/** Progress of the running change: the tag follows it ("building “Hero” · 2/5"), and step by step the crew moves to
 *  the layer each step works on, says what it does there and clicks. */
export function cursorProgress(label: string, done?: number, total?: number) {
  const r = change, c = r?.c;
  if (!enabled || !r || !c || !live(c) || !label) return;
  const step = done !== undefined ? c.plan?.[done] : undefined;
  if (step?.id && c.root) {
    const crew = [c, ...crewOf(c)];
    const w = crew[done! % crew.length];
    void (async () => {
      const sp = await spot(step.id, w.z);
      if (!sp || !live(w) || change !== r) return;
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

/** A session's call is done. A change says what it did and clicks where the work landed (a change quicker than the
 *  cursor's setup still shows it: the ending waits for it a moment, never long), all inside the change's undo step.
 *  Then the cursor stays near, thinking, until its session's next step, or goes once the session is done or quiet. */
export async function cursorEnd(s: Who | undefined, ok: boolean, method: string, result?: unknown, params?: unknown): Promise<void> {
  if (!enabled || QUIET.has(method)) return;
  const c = curs.get(keyOf(s));
  if (!c) return;
  const run = CHANGES.has(method) && change?.c === c ? change : undefined;
  if (run) {
    if (!c.root) {
      let t: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([run.ready, new Promise<void>((done) => { t = setTimeout(done, timing.drawWait); })]);
      clearTimeout(t);
    }
    const left = run.shownAt ? run.shownAt + timing.min - Date.now() : 0;
    if (left > 0 && c.root && change === run) await sleep(left);
    c.box = undefined; c.plan = undefined;
    for (const h of crewOf(c)) { h.box = undefined; h.plan = undefined; }
    if (c.root && change === run) {
      if (ok) {
        say(c, describeDone(method, params, result));
        void (async () => {
          const land = await spot(landingOf(method, result), c.z);
          if (!land || !live(c)) return;
          await glide(c, land.point, timing.end * 0.6, easeQuick);
          void ring(c, land.point, 30, 2.2, 6);
        })();
      } else say(c, "hit a problem");
      await sleep(timing.end);
    }
  }
  if (!live(c)) return;
  c.calls = Math.max(0, c.calls - 1);
  c.lastAt = Date.now();
  if (c.calls) return;
  if (c.mode !== "ask") c.mode = "think";
  c.box = undefined;
  c.hopAt = Date.now() + 1500;
  c.thinkAt = Date.now() + (run ? timing.done : 0); // what a change did stays a moment on its tag
  c.leaveAt = Date.now() + stay(c);
}

/** The change is over: its outlines, clicks and helpers go (its cursor stays, thinking). Before its undo step closes. */
export function cursorWorkEnd() {
  const r = change;
  change = undefined;
  for (const n of transient) { try { if (!n.removed) n.remove(); } catch { /* already gone */ } }
  transient.clear();
  if (r) for (const h of crewOf(r.c)) leave(h);
}

/** From the window: a session started on a request from it (its cursor goes to the request's layers and says what
 *  it's on until the request is finished), or finished one. */
export async function cursorBusy(s: Who | undefined, busy: boolean, nodeIds: string[] = [], kind?: string): Promise<void> {
  if (!enabled) return;
  if (!busy) {
    const c = curs.get(keyOf(s));
    if (!c || !c.busy) return;
    c.busy = undefined;
    if (c.calls) return;
    if (c.mode !== "ask") { c.mode = "think"; c.thinkAt = Infinity; say(c, "finished your request ✓"); }
    c.leaveAt = Date.now() + timing.done;
    return;
  }
  const c = cur(s);
  const first = !c.busy;
  c.busy = ASK[kind ?? ""] ?? ASK.ask;
  if (!c.calls) { c.mode = c.mode === "ask" ? "ask" : "think"; c.leaveAt = Date.now() + stay(c); }
  if (!first) return;
  const z = zoomNow();
  let t: Spot | undefined;
  await ensureFont();
  for (const id of nodeIds.slice(0, 8)) if ((t = await spot(id, z))) break;
  if (!live(c)) return;
  show(c, t?.point, false);
  if (!c.calls && c.mode !== "ask") { c.thinkAt = Infinity; say(c, `on it: ${c.busy}`); }
  if (t && !c.calls) void glide(c, t.point, timing.glide);
}

/** The session asked the user something in its chat (a question, a permission), got the answer, or ended its turn
 *  (`kind` "done"). While it waits, its cursor says so ("asks you in Claude Code") and waves, in view. */
export async function cursorAsk(s: Who | undefined, waiting: boolean, kind?: string): Promise<void> {
  if (!enabled) return;
  const key = keyOf(s);
  reports.add(sessionOf(key)); // it says when its turn ends: its cursor waits for that
  const c = curs.get(key);
  if (!waiting) {
    if (!c) return;
    if (kind === "done") {
      // Its turn is over. With a request from the window still open, it may be back on it: it waits for that a while.
      if (c.calls) return;
      c.mode = "think";
      c.thinkAt = Infinity;
      say(c, c.busy ? `on it: ${c.busy}` : "done ✓");
      c.leaveAt = Date.now() + (c.busy ? timing.busy : timing.done);
      return;
    }
    if (c.mode !== "ask") return;
    c.mode = c.calls ? "look" : "think";
    pose(c, true);
    say(c, "thanks! back to work");
    c.thinkAt = Date.now() + timing.done;
    c.leaveAt = Date.now() + stay(c);
    return;
  }
  if (!c) return; // a session with no cursor here asks in its chat: the window says so
  c.leaving = undefined;
  c.mode = "ask";
  c.box = undefined;
  c.hopAt = Date.now(); // the first pulse at once
  c.thinkAt = Infinity;
  c.leaveAt = Date.now() + timing.ask;
  for (const h of crewOf(c)) leave(h);
  await ensureFont();
  if (!live(c)) return;
  show(c, undefined, false);
  say(c, kind === "permission" ? "needs your OK in Claude Code" : kind === "turn" ? "waiting for you in Claude Code" : "asks you in Claude Code");
  // Come into view to say it: from off screen to a clear spot in the view.
  const v = figma.viewport.bounds;
  const inView = c.x > v.x && c.x < v.x + v.width * 0.9 && c.y > v.y && c.y < v.y + v.height * 0.9;
  if (!inView && c.root) await glide(c, { x: v.x + v.width * 0.6, y: v.y + v.height * 0.3 }, timing.glide * 1.3);
}

/** The user selected, edited or changed page: the cursors step off the canvas, and come back with their session's
 *  next step once the user leaves Figma alone a moment. While a change runs, its cursor finishes it first (the undo
 *  step then closes without drawing them again). */
export function cursorsYield() {
  awayAt = Date.now();
  if (change) return;
  for (const n of transient) { try { if (!n.removed) n.remove(); } catch { /* already gone */ } }
  transient.clear();
  for (const c of curs.values()) { c.motion++; erase(c); }
}

/** Before an undo step closes (undo.ts): every cursor and outline comes off the canvas, so the step holds none of
 *  them. Call what it returns right after the commit: the cursors are drawn again where they were, in the same moment,
 *  so nothing flickers (unless the user is busy in Figma: then they stay off until their session's next step). */
export function cursorsStash(): () => void {
  for (const n of transient) { try { if (!n.removed) n.remove(); } catch { /* already gone */ } }
  transient.clear();
  const drawn = [...curs.values()].filter((c) => c.root);
  for (const c of drawn) erase(c);
  return () => {
    if (away()) return;
    for (const c of drawn) { try { draw(c, false); } catch { /* decoration */ } }
  };
}

/** A session left: its cursors go (and its helpers, and the cursors of its requests), and where they were is forgotten. */
export function cursorGone(sessionId: string) {
  const mine = (k: string) => k === sessionId || k.startsWith(`${sessionId}~`) || k.startsWith(`${sessionId}#`);
  for (const c of [...curs.values()]) if (mine(c.key)) leave(c);
  for (const k of [...last.keys()]) if (mine(k)) last.delete(k);
  reports.delete(sessionId);
}

/** Erase the cursors now and forget them (the window closes, or the switch is turned off). */
export function cursorsClear() {
  change = undefined;
  for (const c of [...curs.values()]) leave(c);
  for (const n of transient) { try { if (!n.removed) n.remove(); } catch { /* already gone */ } }
  transient.clear();
}
