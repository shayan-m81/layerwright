// Strict in-memory mock of the Figma Plugin API, shared by the executor tests.
// It enforces the rules that most often break real plugins: fonts must be loaded before text
// writes, FILL/ABSOLUTE/minWidth need an auto-layout parent, HUG needs auto-layout or text,
// setProperties rejects unknown keys, only available fonts load, createImage takes PNG/JPEG/GIF bytes, getImageByHash
// knows only this file's images, only a horizontal layout wraps and only a wrapping one has a row gap.
import { fixtureDs } from "../../../packages/core/test/fixture.ts";

let seq = 0;
export const AVAILABLE_FONTS: { family: string; style: string }[] = [
  ...["Regular", "Medium", "Semi Bold", "Bold", "Italic"].map((style) => ({ family: "Inter", style })),
  ...["Regular", "Medium", "SemiBold", "Bold"].map((style) => ({ family: "Vazirmatn", style })),
];
export const images = new Map<string, Uint8Array>();
export const nodes = new Map<string, any>();
export const loaded = new Set<string>();
const MIXED = Symbol("mixed");

export class N {
  id: string; parent: any = null; children: any[] = []; removed = false; visible = true; name = "";
  x = 0; y = 0; width = 100; height = 100; fills: any[] = []; strokes: any[] = []; boundVariables: any = {};
  private _mode = "NONE"; itemSpacing = 0;
  get layoutMode() { return this._mode; }
  // Like Figma: turning Auto Layout on moves the children into the flow right away.
  set layoutMode(v: string) { this._mode = v; if (v !== "NONE") for (const c of this.children) { c.x = 0; c.y = 0; } } paddingTop = 0; paddingRight = 0; paddingBottom = 0; paddingLeft = 0; cornerRadius = 0;
  private _lh = "FIXED"; private _lv = "FIXED"; private _pos = "AUTO"; private _minW: number | null = null; private _maxW: number | null = null;
  opacity = 1; effects: any[] = []; strokeWeight = 1; strokeAlign = "CENTER"; strokeTopWeight = 1; strokeRightWeight = 1; strokeBottomWeight = 1; strokeLeftWeight = 1; clipsContent = false;
  get layoutPositioning() { return this._pos; }
  set layoutPositioning(v: string) { if (v === "ABSOLUTE" && (!this.parent || this.parent.layoutMode === "NONE")) throw new Error("ABSOLUTE positioning needs an auto-layout parent"); this._pos = v; }
  get minWidth() { return this._minW; }
  set minWidth(v: number | null) { this.checkMinMax(); this._minW = v; }
  get maxWidth() { return this._maxW; }
  set maxWidth(v: number | null) { this.checkMinMax(); this._maxW = v; }
  private checkMinMax() { if (this.layoutMode === "NONE" && (!this.parent || this.parent.layoutMode === "NONE")) throw new Error("min/max width only apply to auto-layout frames and their children"); }
  findAll(fn: (n: any) => boolean): any[] { return this.children.flatMap((c) => [...(fn(c) ? [c] : []), ...(c.findAll ? c.findAll(fn) : [])]); }
  constructor(public type: string, id?: string) { this.id = id ?? `n:${++seq}`; nodes.set(this.id, this); }
  appendChild(c: any) { this.insertChild(this.children.length, c); }
  insertChild(i: number, c: any) { if (c.parent) c.parent.children = c.parent.children.filter((x: any) => x !== c); this.children.splice(i, 0, c); c.parent = this; }
  remove() { this.removed = true; if (this.parent) this.parent.children = this.parent.children.filter((x: any) => x !== this); }
  resize(w: number, h: number) { this.width = w; this.height = h; }
  rotation = 0;
  get absoluteBoundingBox() { let x = this.x, y = this.y; for (let p = this.parent; p && p.type !== "PAGE" && p.type !== "DOCUMENT"; p = p.parent) { x += p.x; y += p.y; } return { x, y, width: this.width, height: this.height }; }
  // Like Figma: the Scale Tool scales the node and everything in it from its top-left; the factor must be >= 0.01.
  rescale(s: number) {
    if (!(s >= 0.01)) throw new Error("in rescale: The scale factor must be >= 0.01");
    const scale = (n: any, top: boolean) => { if (!top) { n.x *= s; n.y *= s; } n.width *= s; n.height *= s; if (n.type === "TEXT") n.fontSize *= s; for (const c of n.children) scale(c, false); };
    scale(this, true);
  }
  async exportAsync(o?: { format?: string }) { if (o?.format === "SVG_STRING") return `<svg xmlns="http://www.w3.org/2000/svg" width="${this.width}" height="${this.height}"><path d="M0 0H${this.width}V${this.height}Z" fill="#000"/></svg>`; return new Uint8Array([0x89, 0x50]); }
  setBoundVariable(f: string, v: any) { this.boundVariables[f] = { type: "VARIABLE_ALIAS", id: v.id }; }
  findAllWithCriteria(q: any): any[] {
    if (q.pluginData) return this.findAllWithCriteriaPlugin(q.pluginData.keys);
    return this.children.flatMap((c) => [...(q.types.includes(c.type) ? [c] : []), ...c.findAllWithCriteria(q)]);
  }
  get layoutSizingHorizontal() { return this._lh; }
  set layoutSizingHorizontal(v: string) { this.checkSizing(v); this._lh = v; }
  get layoutSizingVertical() { return this._lv; }
  set layoutSizingVertical(v: string) { this.checkSizing(v); this._lv = v; }
  private checkSizing(v: string) {
    if (v === "FILL" && (!this.parent || this.parent.layoutMode === "NONE")) throw new Error("FILL can only be set on children of auto-layout frames");
    if (v === "HUG" && this.layoutMode === "NONE" && this.type !== "TEXT") throw new Error("HUG requires auto-layout or text");
    // Like Figma: layout sizing only exists on auto-layout frames and children of auto-layout frames.
    if (this.layoutMode === "NONE" && (!this.parent || this.parent.layoutMode === "NONE")) throw new Error("in set_layoutSizingHorizontal: node must be an auto-layout frame or a child of an auto-layout frame");
  }
  fillStyleId = ""; strokeStyleId = ""; effectStyleId = "";
  topLeftRadius = 0; topRightRadius = 0; bottomLeftRadius = 0; bottomRightRadius = 0;
  async setEffectStyleIdAsync(id: string) { this.effectStyleId = id; }
  async setFillStyleIdAsync(id: string) { this.fillStyleId = id; }
  async setStrokeStyleIdAsync(id: string) { this.strokeStyleId = id; }
  locked = false; primaryAxisSizingMode = "AUTO"; counterAxisSizingMode = "AUTO"; dashPattern: number[] = [];
  // Like Figma (plugin typings): only a horizontal Auto Layout can wrap; setting layoutWrap on anything else throws.
  private _wrap = "NO_WRAP"; private _cas: number | null = null;
  get layoutWrap() { return this._wrap; }
  set layoutWrap(v: string) { if (this.layoutMode !== "HORIZONTAL") throw new Error("in set_layoutWrap: layoutWrap can only be set on layers with layoutMode HORIZONTAL"); this._wrap = v; }
  // Like Figma: the gap between wrapped rows applies only to a wrapping layout (the mock refuses a write Figma would
  // ignore), can't be negative, and null makes it follow itemSpacing again (it never reads back as null).
  get counterAxisSpacing() { return this._cas ?? this.itemSpacing; }
  set counterAxisSpacing(v: number | null) {
    if (this.layoutWrap !== "WRAP") throw new Error("in set_counterAxisSpacing: counterAxisSpacing only applies to auto-layout frames with layoutWrap WRAP");
    if (v !== null && !(v >= 0)) throw new Error("in set_counterAxisSpacing: the value must be positive");
    this._cas = v;
  }
  private data = new Map<string, string>();
  setPluginData(k: string, v: string) { this.data.set(k, v); }
  getPluginData(k: string) { return this.data.get(k) ?? ""; }
  hasPluginData(k: string) { return this.data.has(k); }
  resizeWithoutConstraints(w: number, h: number) { if (this.type !== "SECTION") throw new Error("only sections here"); this.width = w; this.height = h; }
  clone(attach = true): any {
    const c: any = new (this.constructor as any)(...(this.type === "TEXT" ? [] : [this.type]));
    for (const k of ["name", "x", "y", "width", "height", "fills", "strokes", "layoutMode", "itemSpacing", "visible", "cornerRadius"]) c[k] = (this as any)[k];
    if (this.type === "TEXT") { c._f = (this as any)._f; c._s = (this as any)._s; c._c = (this as any)._c; }
    for (const ch of [...this.children]) c.appendChild(ch.clone(false));
    if (attach) this.parent?.appendChild(c);
    return c;
  }
  // Component properties on components and sets.
  componentPropertyDefinitions: Record<string, any> = {};
  addComponentProperty(name: string, type: string, defaultValue: unknown) {
    if (this.type !== "COMPONENT" && this.type !== "COMPONENT_SET") throw new Error("properties need a component or component set");
    const key = `${name}#${++seq}:0`; this.componentPropertyDefinitions[key] = { type, defaultValue }; return key;
  }
  componentPropertyReferences: any = null;
  reactions: any[] = []; overflowDirection = "NONE"; numberOfFixedChildren = 0; annotations: any[] = [];
  private _flows: any[] = [];
  get flowStartingPoints() { return this._flows; }
  set flowStartingPoints(v: any[]) { if (new Set(v.map((f) => f.nodeId)).size !== v.length) throw new Error("in set_flowStartingPoints: Found duplicate input nodeIds"); this._flows = v; }
  async setReactionsAsync(r: any[]) {
    for (const x of r) for (const a of x.actions ?? []) if (a.type === "NODE" && a.destinationId && !nodes.get(a.destinationId)) throw new Error(`destination ${a.destinationId} does not exist`);
    this.reactions = r;
    // Like Figma: the first interaction on a page without flows creates "Flow 1" at the top-level frame it starts in.
    let top: any = this; while (top.parent && top.parent.type !== "PAGE") top = top.parent;
    const page = top.parent;
    if (page && r.length && !page._flows.length) page._flows = [{ nodeId: top.id, name: "Flow 1" }];
  }
  findAllWithCriteriaPlugin(keys: string[]): any[] { return this.children.flatMap((c) => [...(keys.some((k) => c.hasPluginData(k)) ? [c] : []), ...c.findAllWithCriteriaPlugin(keys)]); }
}

/** The fields getStyledTextSegments accepts (plugin typings). */
const SEGMENT_FIELDS = ["fontSize", "fontName", "fontWeight", "fontStyle", "textDecoration", "textDecorationStyle", "textDecorationOffset", "textDecorationThickness", "textDecorationColor",
  "textDecorationSkipInk", "textCase", "lineHeight", "letterSpacing", "fills", "textStyleId", "fillStyleId", "listOptions", "listSpacing", "indentation", "paragraphIndent", "paragraphSpacing",
  "hyperlink", "boundVariables", "textStyleOverrides", "openTypeFeatures"];

export class T extends N {
  // Like Figma: a new font must be loaded before it is set, and the text's fonts before its size changes.
  _f: any = { family: "Inter", style: "Regular" }; _s = 12;
  get fontName() { return this._f; }
  set fontName(v: any) { if (v !== MIXED && !loaded.has(`${v.family}::${v.style}`)) throw new Error(`in set_fontName: Cannot use unloaded font "${v.family} ${v.style}". Please call figma.loadFontAsync({ family: "${v.family}", style: "${v.style}" }) and await the returned promise first.`); this._f = v; }
  get fontSize() { return this._s; }
  set fontSize(v: number) { for (const f of this.getRangeAllFontNames()) if (f !== MIXED && !loaded.has(`${f.family}::${f.style}`)) throw new Error(`in set_fontSize: Cannot write to node with unloaded font "${f.family} ${f.style}"`); this._s = v; }
  lineHeight: any = { unit: "AUTO" }; letterSpacing: any = { unit: "PERCENT", value: 0 }; textAutoResize = "NONE"; textAlignHorizontal = "LEFT"; textStyleId = ""; hyperlink: any = null;
  private _c = "";
  constructor(id?: string) { super("TEXT", id); }
  get characters() { return this._c; }
  set characters(v: string) { if (!loaded.has(`${this.fontName.family}::${this.fontName.style}`)) throw new Error(`Cannot write to node with unloaded font "${this.fontName.family} ${this.fontName.style}"`); this._c = v; }
  // Like Figma: inserting text needs the fonts of the text loaded, and the position must be inside it.
  insertCharacters(start: number, chars: string) {
    for (const f of this.getRangeAllFontNames()) if (!loaded.has(`${f.family}::${f.style}`)) throw new Error(`in insertCharacters: Cannot write to node with unloaded font "${f.family} ${f.style}"`);
    if (start < 0 || start > this._c.length) throw new Error("in insertCharacters: start is out of range");
    this._c = this._c.slice(0, start) + chars + this._c.slice(start);
  }
  ranges: any[] = [];
  getRangeAllFontNames() { return [this.fontName, ...this.ranges.filter((r) => r.font).map((r) => r.font)]; }
  getRangeFontName(start: number, end: number) { const r = this.ranges.find((x) => x.font && x.start <= start && x.end >= end); return r ? r.font : this.fontName; }
  setRangeFontName(start: number, end: number, font: any) { if (!loaded.has(`${font.family}::${font.style}`)) throw new Error("range font not loaded"); this.ranges.push({ start, end, font }); }
  setRangeFontSize(start: number, end: number, size: number) { this.ranges.push({ start, end, size }); }
  setRangeFills(start: number, end: number, fills: any[]) { this.ranges.push({ start, end, fills }); }
  setRangeHyperlink(start: number, end: number, link: any) { this.ranges.push({ start, end, link }); }
  // Like Figma: only known text fields can be asked for, `end` is required with `start`, the range must be inside the
  // text, and the text comes back in pieces where every asked field keeps one value (the last range set wins).
  getStyledTextSegments(fields: string[], start?: number, end?: number) {
    for (const f of fields) if (!SEGMENT_FIELDS.includes(f)) throw new Error(`in getStyledTextSegments: invalid field "${f}"`);
    if (start !== undefined && end === undefined) throw new Error("in getStyledTextSegments: end is required when start is given");
    const s = start ?? 0, e = end ?? this._c.length;
    if (s < 0 || e > this._c.length || s > e) throw new Error("in getStyledTextSegments: range out of bounds");
    const last = (i: number, k: string) => [...this.ranges].reverse().find((r) => r[k] !== undefined && r.start <= i && i < r.end)?.[k];
    const at = (i: number): Record<string, unknown> => Object.fromEntries(fields.map((f) => [f,
      f === "fontName" ? last(i, "font") ?? this._f : f === "fontSize" ? last(i, "size") ?? this._s : f === "fills" ? last(i, "fills") ?? this.fills
      : f === "hyperlink" ? last(i, "link") ?? this.hyperlink : f === "textStyleId" ? this.textStyleId : (this as any)[f]]));
    const out: any[] = [];
    for (let i = s; i < e; i++) {
      const v = at(i), prev = out.at(-1);
      if (prev && JSON.stringify(fields.map((f) => prev[f])) === JSON.stringify(fields.map((f) => v[f]))) { prev.end = i + 1; prev.characters += this._c[i]; }
      else out.push({ characters: this._c[i], start: i, end: i + 1, ...v });
    }
    return out;
  }
  async setTextStyleIdAsync(id: string) { const s = styles.get(id); const f = s.realFont ?? s.fontName; if (!s.silent && !loaded.has(`${f.family}::${f.style}`)) throw new Error(`in setTextStyleIdAsync: Cannot write to node with unloaded font "${f.family} ${f.style}". Please call figma.loadFontAsync({ family: "${f.family}", style: "${f.style}" }) and await the returned promise first.`); this.textStyleId = id; this._f = f; }
}

class C extends N {
  constructor(id: string, public name2: string, public defs: Record<string, any>, public texts: string[]) { super("COMPONENT", id); this.name = name2; }
  createInstance() {
    const i: any = new N("INSTANCE");
    i.name = this.name;
    i.mainComponent = this;
    i.componentProperties = Object.fromEntries(Object.entries(this.defs).map(([k, d]) => [k, { type: d.type, value: d.defaultValue }]));
    i.setProperties = (p: Record<string, unknown>) => { for (const k of Object.keys(p)) { if (!(k in i.componentProperties)) throw new Error(`unknown property ${k}`); const lbl = i.children.find((c: any) => c.name === k.split("#")[0]); if (lbl && !loaded.has("Inter::Regular")) throw new Error("font"); i.componentProperties[k].value = p[k]; } };
    i.getMainComponentAsync = async () => i.mainComponent;
    // Like Figma: swapping keeps the instance and its overridden text.
    i.swapComponent = (c: any) => { if (c.type !== "COMPONENT") throw new Error("not a component"); i.mainComponent = c; };
    for (const t of this.texts) { const tn = new T(); tn.name = t; i.appendChild(tn); }
    return i;
  }
}

export const styles = new Map<string, any>([
  ["S:h1", { id: "S:h1", type: "TEXT", fontName: { family: "Inter", style: "Bold" } }],
  ["S:body", { id: "S:body", type: "TEXT", fontName: { family: "Inter", style: "Regular" } }],
  ["S:cap", { id: "S:cap", type: "TEXT", fontName: { family: "Inter", style: "Regular" } }],
]);

/** The plugin's side of Figma: what it showed and said (window messages, notifications, links opened, settings
 *  saved), the event handlers it registered, and the window's size. */
export const host = { posted: [] as any[], notified: [] as string[], opened: [] as string[], storage: new Map<string, unknown>(), handlers: new Map<string, ((e?: any) => void)[]>(), ui: { width: 0, height: 0 } };
/** Fire a Figma event at the plugin (Figma sends them after the plugin's code yields). */
export function emit(type: string, e?: any) { for (const fn of host.handlers.get(type) ?? []) fn(e); }
const EVENTS = ["selectionchange", "currentpagechange", "close", "run", "drop", "documentchange", "stylechange", "textreview", "slidesviewchange", "canvasviewchange", "timerstart", "timerstop", "timerpause", "timerresume", "timeradjust", "timerdone"];
/** The screen the canvas is shown on, in pixels: the viewport's bounds follow its centre and zoom. */
export const SCREEN = { w: 2000, h: 1600 };

/** Like Figma: a node made with figma.create… is added to the current page. */
const onPage = <X extends N>(n: X): X => { (globalThis as any).figma.currentPage.appendChild(n); return n; };

export function resetFigma() {
  nodes.clear(); loaded.clear(); seq = 0;
  host.posted.length = 0; host.notified.length = 0; host.opened.length = 0; host.storage.clear(); host.handlers.clear();
  let pagesLoaded = false;
  let zoom = 1, center = { x: 500, y: 400 };
  const page = new N("PAGE", "0:1");
  page.name = "Page 1";
  const page2 = new N("PAGE", "0:2");
  page2.name = "Playground";
  const root = new N("DOCUMENT", "0:0");
  root.name = "TEST";
  root.appendChild(page); root.appendChild(page2);
  new C("1:2", "Type=Primary, Size=Medium", { "Label#10:0": { type: "TEXT", defaultValue: "Button" }, "Show icon#10:1": { type: "BOOLEAN", defaultValue: false } }, ["Label"]);
  new C("1:3", "Type=Secondary, Size=Medium", { "Label#10:0": { type: "TEXT", defaultValue: "Button" } }, ["Label"]);
  new C("2:2", "State=Default", { "Label#20:0": { type: "TEXT", defaultValue: "Label" }, "Placeholder#20:1": { type: "TEXT", defaultValue: "" } }, ["Label", "Placeholder"]);
  new C("3:1", "Link", {}, ["Text"]);
  const vars = new Map(fixtureDs().variables.map((v) => [v.id, { id: v.id, name: v.name }]));
  const cols: any[] = [], made: any[] = [];
  const local = { text: [] as any[], paint: [] as any[], effect: [] as any[], grid: [] as any[] };
  (globalThis as any).figma = {
    mixed: MIXED,
    currentPage: Object.assign(page, { selection: [] }),
    root,
    fileKey: "file1",
    currentUser: { id: "u:1", name: "Tester", photoUrl: null, color: "#0d99ff", sessionId: 1 },
    loadAllPagesAsync: async () => { pagesLoaded = true; },
    // Like Figma: only known events; with "documentAccess": "dynamic-page", documentchange needs loadAllPagesAsync first.
    on: (type: string, fn: (e?: any) => void) => {
      if (!EVENTS.includes(type)) throw new Error(`in on: Unknown event type "${type}"`);
      if (type === "documentchange" && !pagesLoaded) throw new Error("in on: Cannot register documentchange handler in incremental mode. Call figma.loadAllPagesAsync() first.");
      host.handlers.set(type, [...(host.handlers.get(type) ?? []), fn]);
    },
    // Like Figma: the window is at least 70 px wide.
    showUI: (_html: string, o?: { width?: number; height?: number }) => { host.ui = { width: o?.width ?? 300, height: o?.height ?? 200 }; },
    ui: {
      postMessage: (m: any) => { host.posted.push(m); },
      onmessage: undefined as ((m: any) => unknown) | undefined,
      resize: (w: number, h: number) => { if (w < 70 || h < 0) throw new Error("in resize: the window must be at least 70 wide"); host.ui = { width: w, height: h }; },
    },
    // Like Figma: values are stored as copies (structured clone), per user, and read back asynchronously.
    clientStorage: {
      getAsync: async (k: string) => structuredClone(host.storage.get(k)),
      setAsync: async (k: string, v: unknown) => { host.storage.set(k, structuredClone(v)); },
    },
    notify: (m: string) => { host.notified.push(m); return { cancel() {} }; },
    openExternal: (url: string) => { host.opened.push(url); },
    base64Encode: (b: Uint8Array) => Buffer.from(b).toString("base64"),
    createPage: () => { const p = Object.assign(new N("PAGE"), { selection: [] }); p.name = "Page"; root.appendChild(p); return p; },
    setCurrentPageAsync: async (p: any) => { (globalThis as any).figma.currentPage = Object.assign(p, { selection: p.selection ?? [] }); },
    createSection: () => { const s = onPage(new N("SECTION")); s.fills = []; return s; },
    createComponentFromNode: (n: any) => {
      if (["COMPONENT", "COMPONENT_SET", "INSTANCE"].includes(n.type)) throw new Error(`cannot create a component from ${n.type}`);
      const c = new N("COMPONENT");
      for (const k of ["name", "x", "y", "width", "height", "fills", "strokes", "layoutMode", "itemSpacing", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "primaryAxisSizingMode", "counterAxisSizingMode", "cornerRadius"]) (c as any)[k] = n[k];
      for (const ch of [...n.children]) c.appendChild(ch);
      const parent = n.parent; if (parent) parent.insertChild(parent.children.indexOf(n), c); n.remove();
      return c;
    },
    combineAsVariants: (comps: any[], parent: any) => {
      if (!comps.length || comps.some((c) => c.type !== "COMPONENT")) throw new Error("combineAsVariants needs components");
      if (new Set(comps.map((c) => c.name)).size !== comps.length) throw new Error("duplicate variant names");
      const set = new N("COMPONENT_SET"); parent.appendChild(set);
      for (const c of comps) set.appendChild(c);
      return set;
    },
    // Like Figma: the bounds follow the centre and the zoom (read-only); the zoom must be a positive number.
    viewport: {
      get zoom() { return zoom; },
      set zoom(z: number) { if (!(z > 0) || !Number.isFinite(z)) throw new Error("in set_zoom: zoom must be a positive number"); zoom = z; },
      get center() { return { ...center }; },
      set center(c: { x: number; y: number }) { center = { x: c.x, y: c.y }; },
      get bounds() { return { x: center.x - SCREEN.w / 2 / zoom, y: center.y - SCREEN.h / 2 / zoom, width: SCREEN.w / zoom, height: SCREEN.h / zoom }; },
      scrollAndZoomIntoView() {},
    },
    commitUndo() {},
    createFrame: () => { const f = onPage(new N("FRAME")); f.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }]; return f; },
    createText: () => onPage(new T()),
    createRectangle: () => onPage(new N("RECTANGLE")),
    createEllipse: () => Object.assign(onPage(new N("ELLIPSE")), { arcData: { startingAngle: 0, endingAngle: 2 * Math.PI, innerRadius: 0 } }),
    createPolygon: () => Object.assign(onPage(new N("POLYGON")), { pointCount: 3 }),
    createStar: () => Object.assign(onPage(new N("STAR")), { pointCount: 5, innerRadius: 0.382 }),
    // Like Figma: a line is created with a black stroke and its height must stay 0.
    createLine: () => { const l = onPage(new N("LINE")); l.height = 0; l.strokes = [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }]; const resize = l.resize.bind(l); l.resize = (w: number, h: number) => { if (h !== 0) throw new Error("Line height must be 0"); resize(w, h); }; return l; },
    // Like Figma: grouping moves the layers into a new node at the index; booleans need shapes or vectors.
    group: (ns: any[], parent: any, index?: number) => { if (!ns.length) throw new Error("group needs nodes"); const g = new N("GROUP"); parent.insertChild(index ?? parent.children.length, g); for (const n of ns) g.appendChild(n); return g; },
    ungroup: (g: any) => { const p = g.parent, at = p.children.indexOf(g), kids = [...g.children]; kids.forEach((k, j) => p.insertChild(at + j, k)); g.remove(); Object.defineProperty(g, "name", { get() { throw new Error(`in get_name: The node with id "${g.id}" does not exist`); } }); return kids; },
    ...Object.fromEntries(["union", "subtract", "intersect", "exclude", "flatten"].map((op) => [op, (ns: any[], parent: any, index?: number) => {
      const bad = ns.find((n) => !["RECTANGLE", "ELLIPSE", "POLYGON", "STAR", "LINE", "VECTOR", "BOOLEAN_OPERATION", "TEXT"].includes(n.type));
      if (bad) throw new Error(`in ${op}: ${bad.type} can't be used in a boolean operation`);
      const b = new N(op === "flatten" ? "VECTOR" : "BOOLEAN_OPERATION"); b.fills = [{ type: "SOLID", color: { r: 0.85, g: 0.85, b: 0.85 } }]; if (op !== "flatten") (b as any).booleanOperation = op.toUpperCase();
      parent.insertChild(index ?? parent.children.length, b); for (const n of ns) b.appendChild(n); return b;
    }])),
    getNodeByIdAsync: async (id: string) => nodes.get(id) ?? null,
    getStyleByIdAsync: async (id: string) => styles.get(id) ?? null,
    loadFontAsync: async (f: any) => {
      if (!AVAILABLE_FONTS.some((a) => a.family === f.family && a.style === f.style)) throw new Error(`The font "${f.family} ${f.style}" could not be loaded.`);
      loaded.add(`${f.family}::${f.style}`);
    },
    listAvailableFontsAsync: async () => AVAILABLE_FONTS.map((fontName) => ({ fontName })),
    base64Decode: (s: string) => Uint8Array.from(Buffer.from(s, "base64")),
    createImage: (bytes: Uint8Array) => {
      const png = bytes[0] === 0x89 && bytes[1] === 0x50, jpg = bytes[0] === 0xff && bytes[1] === 0xd8, gif = bytes[0] === 0x47 && bytes[1] === 0x49;
      if (!png && !jpg && !gif) throw new Error("Image type is unsupported");
      const hash = `img:${images.size + 1}`; images.set(hash, bytes); return { hash };
    },
    // Like Figma: an image is found by hash only when this file has it; otherwise null.
    getImageByHash: (hash: string) => (images.has(hash) ? { hash, getBytesAsync: async () => images.get(hash)! } : null),
    createNodeFromSvg: (svg: string) => {
      if (!/^\s*<svg[\s>]/.test(svg) || !/<\/svg>\s*$/.test(svg)) throw new Error("Invalid SVG");
      const f = onPage(new N("FRAME")); f.fills = [];
      for (const m of svg.matchAll(/<(path|circle|rect)\b([^>]*)>/g)) {
        const v = new N("VECTOR"); v.fills = /fill="none"/.test(m[2]) ? [] : [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }];
        v.strokes = /stroke="/.test(m[2]) && !/stroke="none"/.test(m[2]) ? [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }] : [];
        f.appendChild(v);
      }
      return f;
    },
    importComponentByKeyAsync: async () => { throw new Error("no library"); },
    annotations: (() => {
      const cats: any[] = [];
      return {
        getAnnotationCategoriesAsync: async () => [...cats],
        addAnnotationCategoryAsync: async (c: any) => { const x = { id: `cat${cats.length + 1}`, ...c }; cats.push(x); return x; },
        getAnnotationCategoryByIdAsync: async (id: string) => cats.find((c) => c.id === id) ?? null,
      };
    })(),
    variables: {
      getVariableByIdAsync: async (id: string) => vars.get(id) ?? made.find((v) => v.id === id) ?? null,
      setBoundVariableForPaint: (p: any, _f: string, v: any) => ({ ...p, boundVariables: { color: { type: "VARIABLE_ALIAS", id: v.id } } }),
      getLocalVariableCollectionsAsync: async () => cols,
      getLocalVariablesAsync: async () => made,
      createVariableCollection: (name: string) => { const c = { id: `col${cols.length + 1}`, name, modes: [{ modeId: "m1", name: "Mode 1" }] }; cols.push(c); return c; },
      createVariable: (name: string, col: any, resolvedType: string) => { const v: any = { id: `var${made.length + 1}`, name, variableCollectionId: col.id, resolvedType, values: {}, setValueForMode(m: string, x: unknown) { this.values[m] = x; } }; made.push(v); return v; },
    },
    // Local styles, created and looked up by name (like Figma).
    getLocalTextStylesAsync: async () => local.text, getLocalPaintStylesAsync: async () => local.paint,
    getLocalEffectStylesAsync: async () => local.effect, getLocalGridStylesAsync: async () => local.grid,
    createTextStyle: () => { const x: any = { id: `S:t${local.text.length + 1}`, type: "TEXT" }; local.text.push(x); styles.set(x.id, x); return x; },
    createPaintStyle: () => { const x: any = { id: `S:p${local.paint.length + 1}`, type: "PAINT", paints: [] }; local.paint.push(x); styles.set(x.id, x); return x; },
    createEffectStyle: () => { const x: any = { id: `S:e${local.effect.length + 1}`, type: "EFFECT", effects: [] }; local.effect.push(x); styles.set(x.id, x); return x; },
    createGridStyle: () => { const x: any = { id: `S:g${local.grid.length + 1}`, type: "GRID", layoutGrids: [] }; local.grid.push(x); styles.set(x.id, x); return x; },
  };
  return page;
}


