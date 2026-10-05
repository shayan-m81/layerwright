// The AI cursor: each session working in Figma gets a pointer in its colour with its name, the way a collaborator
// does, and it moves like a hand on a mouse. It goes where the session looks and skims the layer as it reads,
// drag-selects the layer it changes and keeps busy over it (small moves, clicks) while the change runs, follows the
// work op by op, and between steps stays near, "thinking", until the session goes quiet. Its tag says what is really
// happening: the layer it reads, the text it types, the frame it builds and how far along it is.
//
// Work on several parts at once (edits to several layers, fixes across a screen, several new frames) brings a crew:
// helper cursors split off the session's own, each in a nearby shade, each going to its own part. When a build
// lands they fan out over the new frames, then fade away.
//
// When the session asks the user something in its chat, its cursor comes into view and waves, with a "?" bubble and
// pulses, until the user answers there.
//
// The cursors work beside the user: when the user selects, changes or moves something they carry on at full colour,
// the way a collaborator would. They never get in the way: they are locked, and outlines are thin edges, so clicks
// reach the layers under them.
//
// Figma has no API for real cursors, so they are drawn as a few locked, tagged layers on top of the page:
// - layouts (where new frames go), inspects and scans skip them (isOverlay), and their own changes don't count as
//   changes to the design (isOverlayId);
// - they never end up in an undo step: commits are held while a cursor is drawn, and at the end of each change the
//   cursors are taken off, the step is committed, and they are drawn again (undo.ts);
// - they keep the same size on screen at any zoom (cursorsRescale follows the view when it moves).
import { setDeferring, takeCommitRequest } from "./undo.ts";

const KEY = "layerwrightCursor";
type Mode = "work" | "look" | "think" | "ask";
interface Who { id?: string; name?: string; color?: string }
interface Spot { id: string; point: { x: number; y: number }; box: Rect }
interface Cur {
  key: string; name: string; color: string;
  x: number; y: number; z: number; mode: Mode; busy: boolean;
  /** What the tag says, how much of it is typed so far, and the thinking dots after it. */
  text: string; shown: number; dots: string;
  /** Smoothed speed on screen (px per ms): the pointer leans and the tag trails by it. */
  vx: number; vy: number;
  root?: FrameNode; arrow?: SceneNode; pill?: FrameNode; label?: TextNode; pillAt?: { x: number; y: number };
  /** The "?" bubble while it waits for the user's answer, and where it rests. */
  bubble?: FrameNode; bubbleAt?: number;
  /** How big it is drawn (helpers grow in and shrink away), and the lean and tag offset last written. */
  s: number; rot: number; lag: { x: number; y: number };
  /** Set while it fades away (going back, or leaving). */
  fading?: number;
  leave?: ReturnType<typeof setTimeout>; motion: number; idleFrom: number; ask?: string;
  /** The area it works on or reads now: it keeps moving over it. When to make its next small move; where a skim is. */
  box?: Rect; hopAt: number; scan: number;
  /** A helper: the key of the session cursor it works for. */
  lead?: string;
  /** The running request, op by op: which layer each step works on, and what the tag says there. */
  plan?: { id?: string; text: string }[];
}

let enabled = true;
const curs = new Map<string, Cur>();
const transient = new Set<SceneNode>(); // outlines and click ripples
let font: FontName | undefined;
let ticker: ReturnType<typeof setInterval> | undefined;
let tick = 0;
/** The cursor of the request running now: progress from the plugin goes on its tag (and moves its crew). */
let active: Cur | undefined;
let progressAt = 0;
/** How long a cursor stays "thinking" after a session's last step, and while it works on a request from the window;
 *  how long moves, the drag-select and the typing of its tag take; how lively it is between moves (0: still);
 *  how many helpers at most. */
export const timing = { think: 14_000, busy: 180_000, afterDone: 2_500, glide: 520, select: 240, type: 320, life: 1, crew: 3, fade: 380 };
/** Frames: moves at ~60 fps, the idle life at ~25 fps (every frame is a tiny canvas update). */
const FRAME = 16, IDLE_FRAME = 40;

export function setCursorEnabled(on: boolean) { enabled = on; if (!on) cursorsClear(); }
export function cursorEnabled() { return enabled; }

/** A Layerwright overlay (a cursor, an outline), never part of the design. */
export function isOverlay(n: BaseNode): boolean {
  try { return "getPluginData" in n && !!(n as SceneNode).getPluginData(KEY); } catch { return false; }
}

/** Remove overlays a closed or crashed plugin window left behind (top level of each loaded page). */
export function removeLeftovers() {
  for (const page of figma.root.children) {
    let kids: readonly SceneNode[];
    try { kids = page.children; } catch { continue; } // page not loaded
    for (const n of [...kids]) if (isOverlay(n)) { try { n.remove(); } catch { /* already gone */ } }
  }
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
const BUILDS = new Set(["executePlan", "importTree"]);

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
const ASK: Record<string, string> = { code: "building it in code", polish: "polishing this", component: "making a component", mobile: "making a mobile version", ask: "on your question" };

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
const crewOf = (c: Cur) => [...curs.values()].filter((h) => h.lead === c.key);
const rand = (a: number, b: number) => a + Math.random() * (b - a);

// ---------- the user comes first ----------
/** Every node the cursors draw (and their parts): their own changes are not changes to the design. */
const overlayIds = new Set<string>();
const own = <T extends BaseNode>(n: T): T => { try { if (n.id) overlayIds.add(n.id); } catch { /* no id */ } return n; };
export function isOverlayId(id: string | undefined): boolean { return !!id && overlayIds.has(id); }

let lastUserAt = 0;
/** The user is working in Figma (selected, changed or moved something): nothing zooms the view meanwhile (zoom.ts).
 *  The cursors carry on beside them. */
export function userActed() { lastUserAt = Date.now(); }
/** When the user last did something in Figma. */
export function userActiveAt() { return lastUserAt; }
/** The view moves by itself (zoom.ts): that isn't the user moving it. */
let ownView = false;
let lastView = "";
export function setOwnView(on: boolean) { ownView = on; if (!on) lastView = viewKey(); }
const viewKey = () => { try { const v = figma.viewport; return `${Math.round(v.center.x)},${Math.round(v.center.y)},${v.zoom.toFixed(3)}`; } catch { return ""; } };

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

/** The "?" bubble over the pointer while the session waits for the user's answer in its chat. */
function drawBubble(c: Cur, root: FrameNode): FrameNode | undefined {
  if (!font) return undefined;
  const b = own(figma.createFrame());
  b.name = "Asking";
  b.layoutMode = "HORIZONTAL";
  b.primaryAxisSizingMode = b.counterAxisSizingMode = "AUTO";
  b.paddingLeft = b.paddingRight = 6;
  b.paddingTop = b.paddingBottom = 1;
  b.cornerRadius = 10;
  b.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];
  b.strokes = [{ type: "SOLID", color: rgb(c.color) }];
  b.strokeWeight = 1.5;
  b.effects = [SHADOW(0.25, 2, 6)];
  const t = own(figma.createText());
  t.fontName = font;
  t.fontSize = 13;
  t.characters = "?";
  t.fills = [{ type: "SOLID", color: rgb(c.color) }];
  b.appendChild(t);
  root.appendChild(b);
  b.x = 9; b.y = -22;
  c.bubble = b;
  return b;
}

/** Draw a cursor where it is (synchronous: fonts are already loaded). A new one starts invisible and fades in. */
function draw(c: Cur, appear = false) {
  if (!font) return;
  const root = own(figma.createFrame());
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
  if (c.mode === "ask") drawBubble(c, root);
  root.setPluginData(KEY, "1");
  root.locked = true;
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
  c.bubbleAt = c.bubble ? c.bubble.y : undefined;
  c.rot = 0; c.lag = { x: 0, y: 0 };
  paint(c);
  pose(c, true);
}

function erase(c: Cur) {
  if (c.root && !c.root.removed) c.root.remove();
  c.root = c.arrow = c.pill = c.label = c.bubble = undefined;
}

/** Put what the tag says (as far as it is typed) on the canvas. */
function paint(c: Cur) {
  const l = c.label;
  if (!l || l.removed) return;
  const said = c.text.slice(0, c.shown) + (c.shown >= c.text.length ? c.dots : "");
  const chars = `${c.name}  ·  ${said || " "}`;
  if (l.characters === chars) return;
  l.characters = chars;
  // The session's name stands out; what it's doing reads quieter.
  try { l.setRangeFills(c.name.length, chars.length, [{ type: "SOLID", color: { r: 1, g: 1, b: 1 }, opacity: 0.8 }]); } catch { /* plain is fine */ }
}

/** A new line for the tag. What it shares with the old line stays; the rest types itself out (at once while the
 *  user is working: no flicker of small changes then). */
function say(c: Cur, text: string, dots = "") {
  if (text !== c.text) {
    let k = 0;
    while (k < c.shown && k < text.length && text[k] === c.text[k]) k++;
    c.text = text;
    c.shown = timing.type > 0 ? k : text.length;
  }
  c.dots = dots;
  paint(c);
  ensureTicker();
}

/** The pointer leans into the move and its tag trails behind, by the cursor's speed on screen. Tiny changes aren't
 *  written: every write is a change on the canvas. */
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

/** Grow or shrink the cursor smoothly (a helper splitting off, or going back). `on`: stop when it turns false. */
async function scaleTo(c: Cur, to: number, ms: number, on: () => boolean = () => true) {
  const from = c.s, start = Date.now();
  for (;;) {
    if (!on()) return;
    const k = Math.min(1, (Date.now() - start) / Math.max(1, ms));
    const s = from + (to - from) * easeQuick(k);
    if (c.root && !c.root.removed && Math.abs(s / c.s - 1) > 0.002) {
      const f = s / c.s;
      try { c.root.rescale(f); } catch { /* decoration */ }
      if (c.pillAt) c.pillAt = { x: c.pillAt.x * f, y: c.pillAt.y * f };
      if (c.bubbleAt !== undefined) c.bubbleAt *= f;
    }
    c.s = s;
    if (k >= 1) return;
    await sleep(FRAME);
  }
}

/** Fade the cursor towards an opacity (a helper splitting off or leaving). */
async function fadeTo(c: Cur, to: number, ms: number, on: () => boolean = () => true) {
  const r = c.root;
  if (!r || r.removed) return;
  const from = r.opacity, start = Date.now();
  for (;;) {
    if (!on()) return;
    const k = Math.min(1, (Date.now() - start) / Math.max(1, ms));
    if (!c.root || c.root.removed) return;
    c.root.opacity = from + (to - from) * easeQuick(k);
    if (k >= 1) return;
    await sleep(FRAME * 2);
  }
}

/** Glide along an uneven arc (a wrist turns, a hand doesn't move in straight lines); a newer move cancels this one. */
async function glide(c: Cur, to: { x: number; y: number }, ms: number, ease = easeHand) {
  const my = ++c.motion;
  c.idleFrom = -1; // the idle life waits until this move is done
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
    if (my !== c.motion) return;
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

async function targetOf(method: string, params: any, z: number) {
  const ids = cursorTargets(method, params);
  if (method === "inspect" && (!params?.target || params.target === "selection")) ids.push(...figma.currentPage.selection.slice(0, 1).map((n) => n.id));
  return spotsOf(ids, z, 1 + timing.crew);
}

interface Outline { group: GroupNode; tint?: RectangleNode; set(b: Rect): void }

/** The outline Figma draws around a collaborator's selection, in the session's colour: four thin edges in a group,
 *  so nothing covers the layer (a click on it still reaches it). `tint`: a see-through fill while it's dragged. */
function outline(c: Cur, box: Rect, tint = 0): Outline | undefined {
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
    const group = own(figma.group(fill ? [fill, ...edges] : edges, figma.currentPage));
    group.name = `${c.name} is here (Layerwright)`;
    group.setPluginData(KEY, "1");
    group.locked = true;
    transient.add(group);
    // Bring the cursors back on top of the outline.
    for (const k of curs.values()) if (k.root && !k.root.removed) figma.currentPage.appendChild(k.root);
    return { group, tint: fill, set };
  } catch { return undefined; } // decoration
}

/** Figma's selection handles: four small white squares on the corners. */
function handles(c: Cur, o: Outline, box: Rect) {
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
    if (my !== c.motion || o.group.removed) return;
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
  if (o.group.removed) return;
  o.set(box);
  if (o.tint && !o.tint.removed) o.tint.remove();
  handles(c, o, box);
  c.idleFrom = c.motion;
}

/** One expanding ring that fades. */
async function ring(c: Cur, at: { x: number; y: number }, grow: number, weight: number, steps = 12) {
  try {
    const e = own(figma.createEllipse());
    e.name = "Click (Layerwright)";
    e.fills = [];
    e.strokes = [{ type: "SOLID", color: rgb(c.color) }];
    e.setPluginData(KEY, "1");
    e.locked = true;
    transient.add(e);
    for (let i = 1; i <= steps; i++) {
      if (e.removed) return;
      const k = easeQuick(i / steps);
      const d = (4 + k * grow) / c.z;
      e.resize(d, d);
      e.x = at.x - d / 2; e.y = at.y - d / 2;
      e.strokeWeight = Math.max(0.3, weight * (1 - k * 0.8)) / c.z;
      e.opacity = 1 - k;
      await sleep(22);
    }
    if (!e.removed) e.remove();
    transient.delete(e);
  } catch { /* decoration */ }
}

/** A small click while working: the pointer dips, one quick ring. */
async function tap(c: Cur, at: { x: number; y: number }) {
  c.vy = 1.6; pose(c);
  await ring(c, at, 14, 1.4, 8);
}

/** A click where the work landed: the pointer presses, two rings open and fade, a dot flashes. */
async function ripple(c: Cur, at: { x: number; y: number }) {
  try {
    const dot = own(figma.createEllipse());
    dot.name = "Click (Layerwright)";
    dot.fills = [{ type: "SOLID", color: rgb(c.color), opacity: 0.35 }];
    dot.setPluginData(KEY, "1");
    dot.locked = true;
    const d = 14 / c.z;
    dot.resize(d, d); dot.x = at.x - d / 2; dot.y = at.y - d / 2;
    transient.add(dot);
    c.vy = 2.2; pose(c);
    await Promise.all([ring(c, at, 34, 2.4), (async () => { await sleep(110); await ring(c, at, 24, 1.6); })(), (async () => {
      for (let i = 1; i <= 6; i++) { await sleep(28); if (dot.removed) return; dot.opacity = 1 - i / 6; }
      if (!dot.removed) dot.remove();
      transient.delete(dot);
    })()]);
  } catch { /* decoration */ }
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

/** The life of cursors between moves: the tag types itself out, the lean settles, and each one keeps busy: working
 *  cursors move and click over their layer, reading ones skim it, thinking ones sway and now and then look around,
 *  asking ones wave and pulse. They keep at it while the user works beside them. */
function animate() {
  tick++;
  const now = Date.now(), t = now / 1000;
  // The user moved the view: they're looking at something, so the view isn't zoomed away from them (zoom.ts).
  if (!ownView) { const v = viewKey(); if (lastView && v !== lastView) userActed(); lastView = v; }
  for (const c of curs.values()) {
    if (!c.root || c.root.removed) continue;
    if (c.fading === undefined && c.root.opacity < 0.99) c.root.opacity = Math.min(1, c.root.opacity + 0.1);
    if (c.shown < c.text.length) {
      const step = Math.max(1, Math.ceil(c.text.length / Math.max(1, timing.type / IDLE_FRAME)));
      c.shown = Math.min(c.text.length, c.shown + step);
      paint(c);
    }
    if (c.motion !== c.idleFrom) continue; // a move is running: leave the position to it
    if (c.mode === "ask") { askLife(c, now, t); continue; }
    if (Math.abs(c.vx) > 0.01 || Math.abs(c.vy) > 0.01) { c.vx *= 0.6; c.vy *= 0.6; pose(c); } // settle the lean
    else if (c.vx || c.vy) { c.vx = c.vy = 0; pose(c, true); }
    const live = timing.life > 0;
    if (live && c.box && (c.mode === "work" || c.mode === "look") && now >= c.hopAt) {
      const look = c.mode === "look";
      const to = look ? skim(c, c.box) : poke(c, c.box);
      c.hopAt = now + (look ? rand(380, 620) : rand(340, 900)) / timing.life;
      void glide(c, to, look ? 260 : rand(170, 260), look ? minJerk : easeHand).then(() => { if (!look && c.mode === "work" && Math.random() < 0.5) void tap(c, to); });
      continue;
    }
    if (tick % 2) continue; // the drift needs only half the frames
    if (c.mode === "think") {
      if (tick % 10 === 0 && c.shown >= c.text.length) { c.dots = ".".repeat((tick / 10) % 4); paint(c); } // the dots, every 0.4 s
      if (live && now >= c.hopAt) { // now and then, a glance a little way off and back
        c.hopAt = now + rand(2600, 4800) / timing.life;
        const home = { x: c.x, y: c.y };
        void glide(c, { x: c.x + rand(-40, 40) / c.z, y: c.y + rand(-26, 26) / c.z }, 380, minJerk).then(() => sleep(rand(300, 700))).then(() => { if (c.mode === "think" && c.motion === c.idleFrom) void glide(c, home, 420, minJerk); });
        continue;
      }
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

/** Waiting for the user's answer: it waves (a quick back-and-forth every two seconds), its "?" bobs, and a ring pulses
 *  from it now and then, so it's seen without being in the way. */
function askLife(c: Cur, now: number, t: number) {
  const phase = (now % 2200) / 2200;
  const wave = phase < 0.3 ? Math.sin(phase / 0.3 * Math.PI * 4) * 14 * (1 - phase / 0.3) : 0;
  pose(c, false, wave);
  if (c.bubble && !c.bubble.removed && c.bubbleAt !== undefined) c.bubble.y = c.bubbleAt - Math.abs(Math.sin(t * 3.2)) * (4 * c.s) / c.z;
  if (now >= c.hopAt) { c.hopAt = now + 1600; void ring(c, { x: c.x + 2 / c.z, y: c.y + 2 / c.z }, 30, 2, 14); }
}

function ensureTicker() { if (curs.size && !ticker) { lastView = viewKey(); ticker = setInterval(animate, IDLE_FRAME); } }
function syncDeferring() {
  setDeferring(curs.size > 0);
  ensureTicker();
  if (!curs.size && ticker) { clearInterval(ticker); ticker = undefined; }
}

function make(key: string, name: string, color: string, at: { x: number; y: number }, lead?: string, s = 1): Cur {
  const c: Cur = { key, name, color, x: at.x, y: at.y, z: zoomNow(), mode: "think", busy: false, text: "thinking", shown: 0, dots: "", vx: 0, vy: 0,
    motion: 0, idleFrom: 0, hopAt: Date.now() + 900, scan: 0, lead, s, rot: 0, lag: { x: 0, y: 0 } };
  if (timing.type <= 0) c.shown = c.text.length;
  curs.set(key, c);
  syncDeferring();
  try { draw(c, true); } catch { /* decoration */ }
  return c;
}

async function ensure(s: Who | undefined, near?: { x: number; y: number }): Promise<Cur | undefined> {
  const key = keyOf(s);
  let c = curs.get(key);
  if (c) return c;
  await ensureFont();
  if ((c = curs.get(key))) return c; // made while the font loaded
  const z = zoomNow();
  const v = figma.viewport.bounds;
  const start = near ? { x: near.x - 90 / z, y: near.y - 70 / z } : { x: v.x + v.width * 0.5, y: v.y + v.height * 0.45 };
  return make(key, s?.name || "Claude", s?.color || "#7c3aed", start);
}

/** A helper for a session's cursor: it splits off from it (small and see-through, growing as it goes), in a nearby
 *  shade. Reused while the session works. */
function helper(c: Cur, i: number): Cur {
  const key = `${c.key}#${i + 2}`;
  let h = curs.get(key);
  if (!h) {
    h = make(key, `${c.name} ${i + 2}`, shade(c.color, (i % 2 ? -1 : 1) * (26 + 12 * Math.floor(i / 2))), { x: c.x, y: c.y }, c.key, 0.55);
    void scaleTo(h, 1, 340);
  }
  h.fading = undefined;
  scheduleLeave(h, timing.busy); // only a safety net: cursorEnd sends the crew away
  return h;
}

/** Send a crew to work: each helper goes to its part, drag-selects it and keeps busy over it. */
function dispatch(c: Cur, parts: { spot: Spot; text: string }[]) {
  parts.slice(0, timing.crew).forEach((p, i) => {
    const h = helper(c, i);
    h.mode = "work";
    say(h, p.text);
    void (async () => { await sleep(i * 110); await dragSelect(h, p.spot.box); h.box = p.spot.box; h.hopAt = Date.now() + rand(150, 500); })();
  });
}

/** Helpers go back: each glides home to the session's cursor, shrinking and fading as it merges into it. */
async function dismiss(c: Cur, after = 0) {
  if (!crewOf(c).length) return;
  await sleep(after);
  await Promise.all(crewOf(c).map(async (h, i) => {
    if (h.fading !== undefined) return;
    const stamp = (h.fading = Date.now() + i);
    const on = () => h.fading === stamp; // put back to work meanwhile: it stays
    h.mode = "think"; h.box = undefined;
    await sleep(i * 70);
    const home = curs.has(c.key) ? { x: c.x, y: c.y } : { x: h.x, y: h.y };
    await Promise.all([glide(h, home, timing.fade * 1.2, minJerk), scaleTo(h, 0.5, timing.fade * 1.2, on), fadeTo(h, 0, timing.fade * 1.2, on)]);
    if (on()) leave(h.key); else void comeBack(h);
  }));
}

/** A cursor that was fading away got work again: back to full size and colour. */
async function comeBack(c: Cur) { await Promise.all([scaleTo(c, 1, 200), fadeTo(c, 1, 200)]); }

/** A cursor whose session went quiet: it fades and shrinks away instead of vanishing (unless work comes back). */
async function retire(key: string) {
  const c = curs.get(key);
  if (!c || c.fading !== undefined) return;
  const stamp = (c.fading = Date.now());
  const on = () => c.fading === stamp;
  await Promise.all([scaleTo(c, 0.7, timing.fade, on), fadeTo(c, 0, timing.fade, on)]);
  if (on()) leave(key); else void comeBack(c);
}

function scheduleLeave(c: Cur, ms: number) {
  clearTimeout(c.leave);
  c.leave = setTimeout(() => { void retire(c.key); }, ms);
}

function leave(key: string) {
  const c = curs.get(key);
  if (!c) return;
  clearTimeout(c.leave);
  c.motion++;
  erase(c);
  curs.delete(key);
  if (active === c) active = undefined;
  for (const h of crewOf(c)) leave(h.key); // a session's helpers go with it
  if (!curs.size) for (const n of transient) if (!n.removed) n.remove();
  if (!curs.size) transient.clear();
  syncDeferring();
  // Its drawing and removal cancel out; a commit a handler asked for meanwhile still happens.
  if (!curs.size && takeCommitRequest()) figma.commitUndo();
  if (!curs.size && overlayIds.size > 20_000) overlayIds.clear();
}

/** End of a change: take the cursors off, commit the step, draw them again (all in one go: nothing flickers). */
function commitPoint() {
  if (!takeCommitRequest()) return;
  for (const n of transient) if (!n.removed) n.remove();
  transient.clear();
  for (const c of curs.values()) erase(c);
  figma.commitUndo();
  for (const c of curs.values()) { try { draw(c); if (c.fading !== undefined && c.root) c.root.opacity = 0.5; } catch { /* decoration */ } }
}

/** The view zoomed (zoom.ts): every cursor keeps its size on screen. */
export function cursorsRescale(z: number) {
  const zz = Math.min(8, Math.max(0.02, z));
  for (const c of curs.values()) {
    const f = c.z / zz;
    if (Math.abs(f - 1) < 0.001) continue;
    if (c.root && !c.root.removed) { try { c.root.rescale(f); } catch { /* decoration */ } }
    if (c.pillAt) c.pillAt = { x: c.pillAt.x * f, y: c.pillAt.y * f };
    if (c.bubbleAt !== undefined) c.bubbleAt *= f;
    c.z = zz;
  }
}

/** A request from a session starts: its cursor comes (or wakes), says what it is about to do, and goes there; work on
 *  several layers brings helpers, one per layer. */
export async function cursorBegin(s: Who | undefined, method: string, params: unknown): Promise<void> {
  if (!enabled || method === "ping") return;
  const z = zoomNow();
  const [spots, names] = await Promise.all([targetOf(method, params, z), namesFor(method, params).catch(() => undefined)]);
  const t = spots[0];
  const c = await ensure(s, t?.point);
  if (!c) return;
  clearTimeout(c.leave);
  c.fading = undefined; // a cursor that was leaving stays (its fade stops, the ticker brings its colour back)
  active = c;
  progressAt = 0;
  const changes = CHANGES.has(method);
  const nm: Names = names ?? ((id) => (typeof id === "string" ? "a layer" : "it"));
  if (c.mode !== "ask") c.mode = changes ? "work" : "look";
  c.plan = changes ? planOf(method, params, nm) : undefined;
  c.scan = 0;
  if (c.mode !== "ask") say(c, describeRequest(method, params, nm));
  if (!t) {
    // A build with nowhere known to land yet: it works over the middle of the view while the frames are made.
    const v = figma.viewport.bounds;
    c.box = changes ? { x: v.x + v.width * 0.3, y: v.y + v.height * 0.3, width: v.width * 0.4, height: v.height * 0.4 } : undefined;
    return;
  }
  // One part per cursor: the session's own takes the first, helpers the rest, each saying what it does there.
  if (changes && spots.length > 1) dispatch(c, spots.slice(1).map((sp) => ({ spot: sp, text: c.plan?.find((p) => p.id === sp.id)?.text ?? "helping" })));
  c.box = t.box;
  c.hopAt = Date.now() + 250;
  if (changes) await dragSelect(c, t.box); // a change waits until the cursor has it selected
  else void glide(c, t.point, timing.glide);
}

/** Progress of the running request: the tag follows it ("building “Hero” · 2/5"), and step by step the crew moves to
 *  the layer each step works on, says what it does there and clicks. */
export function cursorProgress(label: string, done?: number, total?: number) {
  const c = active;
  if (!enabled || !c || !curs.has(c.key) || !label) return;
  const step = done !== undefined ? c.plan?.[done] : undefined;
  if (step?.id) {
    const crew = [c, ...crewOf(c).filter((h) => h.fading === undefined)];
    const w = crew[done! % crew.length];
    void (async () => {
      const sp = await spot(step.id, w.z);
      if (!sp || !curs.has(w.key)) return;
      if (w !== c) say(w, step.text);
      w.box = sp.box;
      w.hopAt = Date.now() + 500;
      await glide(w, sp.point, 240, easeQuick);
      void tap(w, sp.point);
    })();
  }
  const now = Date.now();
  const end = total !== undefined && done !== undefined && done >= total;
  if (now - progressAt < 120 && !end) return; // a few updates a second are enough
  progressAt = now;
  if (c.mode === "ask") return;
  const words = step && !/[“"]/.test(label) ? step.text : label.replace(/"([^"]*)"/g, (_m, x) => q(x));
  const how = total && total > 1 ? (total > 20 ? ` · ${Math.round(((done ?? 0) / total) * 100)}%` : ` · ${Math.min(total, (done ?? 0) + 1)}/${total}`) : "";
  say(c, words.charAt(0).toLowerCase() + words.slice(1) + how);
}

/** The request ended: a change clicks where it landed and says what it did; a build's crew fans out over the new
 *  frames and then goes back; the cursor thinks until the next step. */
export async function cursorEnd(s: Who | undefined, method: string, result: unknown, ok: boolean, params?: unknown): Promise<void> {
  const c = curs.get(keyOf(s));
  if (c && active === c) active = undefined;
  if (c) { c.box = undefined; c.plan = undefined; for (const h of crewOf(c)) { h.box = undefined; h.mode = "think"; } }
  const asking = c?.mode === "ask";
  if (c && CHANGES.has(method) && ok) {
    const land = await spot(landingOf(method, result), c.z);
    if (!asking) say(c, describeDone(method, params, result));
    const made = BUILDS.has(method) ? ((result as any)?.createdRootIds ?? (result as any)?.screens?.map((x: any) => x?.id) ?? []).slice(1, 1 + timing.crew) : [];
    const more = made.length ? await spotsOf(made, c.z, timing.crew) : [];
    if (more.length) dispatch(c, more.map((sp: Spot) => ({ spot: sp, text: "checking it ✓" })));
    if (land && !asking) { await glide(c, land.point, 320); void ripple(c, land.point); const o = outline(c, land.box); if (o) handles(c, o, land.box); }
    await sleep(420);
  } else if (c && !ok && !asking) {
    say(c, "hit a problem");
    await sleep(300);
  }
  if (CHANGES.has(method)) commitPoint();
  if (!c) return;
  void dismiss(c, BUILDS.has(method) ? 1500 : 300);
  if (asking) return;
  c.mode = "think";
  c.hopAt = Date.now() + 1500;
  say(c, c.busy ? c.ask ?? "working on your request" : "thinking");
  scheduleLeave(c, c.busy ? timing.busy : timing.think);
}

/** From the window: a session got a request (it shows up on the layers right away) or finished one. */
export async function cursorBusy(s: Who | undefined, busy: boolean, nodeIds: string[] = [], kind?: string) {
  if (!enabled) return;
  if (!busy) {
    const c = curs.get(keyOf(s));
    if (c) { c.busy = false; c.ask = undefined; if (c.mode !== "ask") say(c, "finished your request ✓"); scheduleLeave(c, timing.afterDone); }
    return;
  }
  const z = zoomNow();
  let t: Awaited<ReturnType<typeof spot>>;
  for (const id of nodeIds) if ((t = await spot(id, z))) break;
  const c = await ensure(s, t?.point);
  if (!c) return;
  const first = !c.busy;
  c.busy = true;
  c.fading = undefined;
  if (kind && ASK[kind]) c.ask = `on it: ${ASK[kind]}`;
  if (c.mode === "ask") return;
  c.mode = "think";
  if (first || kind) say(c, c.ask ?? "reading your request");
  if (t) void glide(c, t.point, timing.glide);
  scheduleLeave(c, timing.busy);
}

/** The session asked the user something in its chat (a question, a permission), or got the answer. While it waits,
 *  its cursor comes into view, says so ("asks you in Claude Code ↗ …") and waves with a "?" bubble. */
export async function cursorAsk(s: Who | undefined, waiting: boolean, kind?: string, text?: string) {
  if (!enabled) return;
  const key = keyOf(s);
  if (!waiting) {
    const c = curs.get(key);
    if (!c || c.mode !== "ask") return;
    c.mode = "think";
    if (c.bubble && !c.bubble.removed) c.bubble.remove();
    c.bubble = undefined; c.bubbleAt = undefined;
    pose(c, true);
    say(c, "thanks! back to work");
    c.hopAt = Date.now() + 1500;
    scheduleLeave(c, c.busy ? timing.busy : timing.think);
    return;
  }
  const c = await ensure(s);
  if (!c) return;
  c.fading = undefined;
  clearTimeout(c.leave);
  void dismiss(c);
  c.mode = "ask";
  c.box = undefined;
  c.hopAt = Date.now(); // the first pulse at once
  if (!c.bubble && c.root && !c.root.removed) {
    // Added to a cursor already drawn at this zoom: the bubble is scaled to match it.
    const b = drawBubble(c, c.root), f = c.s / c.z;
    if (b) { if (Math.abs(f - 1) > 0.01) b.rescale(f); b.x = 9 * f; b.y = -22 * f; c.bubbleAt = b.y; }
  }
  say(c, kind === "permission" ? "needs your OK in Claude Code ↗" : kind === "turn" ? "waiting for you in Claude Code ↗" : text ? `asks you in Claude Code ↗ ${q(text)}` : "asks you in Claude Code ↗");
  if (c.root) void fadeTo(c, 1, 200);
  // Come into view to say it: from off screen to a clear spot in the view.
  const v = figma.viewport.bounds;
  const inView = c.x > v.x && c.x < v.x + v.width * 0.9 && c.y > v.y && c.y < v.y + v.height * 0.9;
  if (!inView) await glide(c, { x: v.x + v.width * 0.6, y: v.y + v.height * 0.3 }, timing.glide * 1.3);
  scheduleLeave(c, 30 * 60_000);
}

/** A session left: its cursor goes (and its helpers, and the cursors of its other tasks). */
export function cursorGone(sessionId: string) {
  leave(sessionId);
  for (const k of [...curs.keys()]) if (k.startsWith(`${sessionId}~`)) leave(k);
}

/** Take every cursor off (the window closes, or the switch is turned off). */
export function cursorsClear() {
  for (const key of [...curs.keys()]) leave(key);
  for (const n of transient) if (!n.removed) n.remove();
  transient.clear();
}
