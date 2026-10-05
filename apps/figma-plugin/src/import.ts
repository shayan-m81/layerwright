// Builds node trees serialized from rendered HTML (see apps/mcp-server/src/html-import.ts), and manages pages.
import type { ImportNode, ImportPaint, ImportSwapRef } from "@cde/core";
import { ExecError, tag, withTimeout } from "./execute.ts";
import { progress } from "./progress.ts";
import { blurEffects, gradientPaint } from "./paints.ts";
import { commitUndo } from "./undo.ts";
import { isOverlay } from "./cursor.ts";
import { openPage, select, show } from "./own.ts";

const rgb = (hex: string) => ({ r: parseInt(hex.slice(1, 3), 16) / 255, g: parseInt(hex.slice(3, 5), 16) / 255, b: parseInt(hex.slice(5, 7), 16) / 255 });
const solid = (p: ImportPaint): SolidPaint => ({ type: "SOLID", color: rgb(p.hex), opacity: p.a });
const BLEND: Record<string, BlendMode> = { multiply: "MULTIPLY", screen: "SCREEN", overlay: "OVERLAY", darken: "DARKEN", lighten: "LIGHTEN", "color-burn": "COLOR_BURN", "color-dodge": "COLOR_DODGE", luminosity: "LUMINOSITY", color: "COLOR", hue: "HUE", saturation: "SATURATION" };
const FALLBACKS = ["Vazirmatn", "Noto Sans Arabic", "Inter"];

export async function ensurePages(names: string[]): Promise<{ pages: { name: string; id: string; created: boolean }[] }> {
  await figma.loadAllPagesAsync();
  const out = [];
  for (const [i, name] of names.entries()) {
    let page = figma.root.children.find((p) => p.name === name);
    const created = !page;
    if (!page) {
      // Reuse an empty default page ("Page 1") for the first entry instead of leaving it behind (an AI cursor on it
      // doesn't count: it isn't part of the design).
      const blank = i === 0 && figma.root.children.length === 1 && figma.root.children[0].children.every(isOverlay) ? figma.root.children[0] : null;
      // Plans with a page limit (Starter = 3): rename a page at this slot that isn't in the requested list.
      const spare = figma.root.children.slice(i).find((pg) => !names.includes(pg.name));
      try { page = blank ?? figma.createPage(); }
      catch (e) { if (!spare) throw e; page = spare; }
      page.name = name;
    }
    figma.root.insertChild(Math.min(i, figma.root.children.length - 1), page);
    out.push({ name, id: page.id, created });
  }
  return { pages: out };
}

async function pageByName(name?: string): Promise<PageNode> {
  if (!name) return figma.currentPage;
  await figma.loadAllPagesAsync();
  const page = figma.root.children.find((p) => p.name === name) ?? (await ensurePages([name]), figma.root.children.find((p) => p.name === name)!);
  await openPage(page);
  return page;
}

function collectFonts(n: ImportNode, set: Map<string, FontName>) {
  if (n.type === "text") set.set(`${n.font.family}|${n.font.style}`, n.font);
  if (n.type === "frame") n.children.forEach((c) => collectFonts(c, set));
}

/** Loads every font used, substituting unavailable families. Returns a resolver and warnings. */
async function loadFonts(trees: ImportNode[]) {
  const wanted = new Map<string, FontName>();
  trees.forEach((t) => collectFonts(t, wanted));
  const available = await figma.listAvailableFontsAsync();
  const has = (f: FontName) => available.some((a) => a.fontName.family === f.family && a.fontName.style === f.style);
  const styles = (family: string) => available.filter((a) => a.fontName.family === family).map((a) => a.fontName.style);
  const map = new Map<string, FontName>();
  const warnings = new Set<string>();
  for (const [key, f] of wanted) {
    let use: FontName | undefined = has(f) ? f : undefined;
    for (const fam of [f.family, ...FALLBACKS]) {
      if (use) break;
      const st = styles(fam);
      if (!st.length) continue;
      const style = st.find((s) => s.replace(/\s/g, "") === f.style) ?? st.find((s) => /regular/i.test(s)) ?? st[0];
      use = { family: fam, style };
    }
    use ??= { family: "Inter", style: "Regular" };
    if (use.family !== f.family) warnings.add(`Font "${f.family}" is not installed; used "${use.family}". Install it and re-run to match the design.`);
    await figma.loadFontAsync(use);
    map.set(key, use);
  }
  return { font: (f: FontName) => map.get(`${f.family}|${f.style}`)!, warnings: [...warnings] };
}

/** The shared gradient builder, from an imported gradient. */
const gradientOf = (g: NonNullable<Extract<ImportNode, { type: "frame" }>["gradient"]>) =>
  gradientPaint(g.type ?? "linear", g.angle, g.stops.map((st) => ({ ...rgb(st.hex), a: st.a, position: st.pos })));

type Fonts = Awaited<ReturnType<typeof loadFonts>> & { components?: Map<string, ComponentNode | ComponentSetNode>; swapWarnings?: string[] };

const refKey = (r: ImportSwapRef) => (r.id ? `id:${r.id}` : r.key ? `key:${r.key}` : `name:${r.component}`);
/** "State=Open, Size=M" as a set of pairs, so the order of the properties doesn't matter. */
const pairs = (v: string) => v.split(",").map((p) => p.trim().toLowerCase().replace(/\s*=\s*/, "=")).filter(Boolean).sort().join(",");
const hasVariant = (c: ComponentNode | ComponentSetNode, v: string) => c.type === "COMPONENT" || c.children.some((k) => k.name === v || pairs(k.name) === pairs(v));

function pageName(n: BaseNode): string {
  let p: BaseNode | null = n;
  while (p && p.type !== "PAGE") p = p.parent;
  return p?.name ?? "?";
}

/** Resolve every swap's component once (by id, key or name, with the same rules as plans) and pre-load their fonts,
 *  so overrides can be applied synchronously. Duplicate names are never picked silently. */
async function componentIndex(trees: ImportNode[]) {
  const wanted = new Map<string, { ref: ImportSwapRef; variants: Set<string> }>();
  const visit = (n: ImportNode) => {
    if (n.type !== "frame") return;
    if (n.swap) { const k = refKey(n.swap); const e = wanted.get(k) ?? { ref: n.swap, variants: new Set<string>() }; if (n.swap.variant) e.variants.add(n.swap.variant); wanted.set(k, e); }
    n.children.forEach(visit);
  };
  trees.forEach(visit);
  const map = new Map<string, ComponentNode | ComponentSetNode>();
  if (!wanted.size) return map;
  await figma.loadAllPagesAsync();
  let local: (ComponentNode | ComponentSetNode)[] | undefined;
  for (const [k, { ref, variants }] of wanted) {
    let c: ComponentNode | ComponentSetNode | null = null;
    if (ref.id) {
      const n = await figma.getNodeByIdAsync(ref.id);
      if (n && (n.type === "COMPONENT" || n.type === "COMPONENT_SET")) c = n;
      else throw new ExecError({ type: "COMPONENT_NOT_FOUND", component: ref.component, message: `No component or component set with id ${ref.id}.` });
    } else if (ref.key) {
      try { c = await withTimeout(figma.importComponentSetByKeyAsync(ref.key)); } catch { try { c = await withTimeout(figma.importComponentByKeyAsync(ref.key)); } catch (e) {
        throw new ExecError({ type: "COMPONENT_NOT_FOUND", component: ref.component, message: `Could not import component key ${ref.key} (is the library enabled for this file?): ${(e as Error).message}` });
      } }
    } else {
      local ??= figma.root.findAllWithCriteria({ types: ["COMPONENT_SET", "COMPONENT"] }).filter((x) => !(x.type === "COMPONENT" && x.parent?.type === "COMPONENT_SET"));
      const named = local.filter((x) => x.name === ref.component);
      if (!named.length) throw new ExecError({ type: "COMPONENT_NOT_FOUND", component: ref.component, message: `No local component named "${ref.component}". For a library component pass its key.` });
      const fit = named.filter((x) => [...variants].every((v) => hasVariant(x, v)));
      if (fit.length === 1 || (named.length === 1 && !fit.length)) c = fit[0] ?? named[0];
      else {
        const describe = (x: ComponentNode | ComponentSetNode) => ({ id: x.id, page: pageName(x), variantCount: x.type === "COMPONENT_SET" ? x.children.length : 0 });
        throw new ExecError({ type: "AMBIGUOUS_COMPONENT", component: ref.component, candidates: (fit.length ? fit : named).map(describe),
          message: `${named.length} components are named "${ref.component}"${fit.length ? " and all have the requested variants" : " and none has all the requested variants"}. Pass the swap's id to choose one.` });
      }
    }
    map.set(k, c);
  }
  const fonts = new Set<string>();
  for (const c of map.values()) for (const t of c.findAllWithCriteria({ types: ["TEXT"] })) if (t.fontName !== figma.mixed) fonts.add(JSON.stringify(t.fontName));
  await Promise.all([...fonts].map((f) => figma.loadFontAsync(JSON.parse(f)).catch(() => undefined)));
  return map;
}

/** The requested variant, matched by name (property order doesn't matter). Unknown variants are an error. */
function variantOf(c: ComponentNode | ComponentSetNode, variant?: string): ComponentNode {
  if (c.type === "COMPONENT") return c;
  const kids = c.children as ComponentNode[];
  if (!variant) return (c.defaultVariant as ComponentNode) ?? kids[0];
  const hit = kids.find((k) => k.name === variant) ?? kids.find((k) => pairs(k.name) === pairs(variant));
  if (!hit) throw new ExecError({ type: "INVALID_VARIANT", component: c.name, message: `Variant "${variant}" not found on "${c.name}".`, suggestions: kids.slice(0, 12).map((k) => k.name) });
  return hit;
}

/** Copy the serialized element's content onto an instance: match children by type and position and set text.
 *  "match" also hides instance layers the element doesn't have (e.g. a missing price); fills only when asked. */
function override(inst: SceneNode, src: ImportNode, mode: "text" | "match", fills: boolean) {
  if (inst.type === "TEXT" && src.type === "text") { if (inst.characters !== src.content) inst.characters = src.content; return; }
  if (src.type !== "frame" || !("children" in inst)) return;
  if (fills && "fills" in inst && (src.fill || src.gradient)) {
    const f: Paint[] = [];
    if (src.fill) f.push(solid(src.fill));
    if (src.gradient) f.push(gradientOf(src.gradient));
    if (JSON.stringify((inst as FrameNode).fills) !== JSON.stringify(f)) (inst as FrameNode).fills = f;
  }
  const used = new Set<ImportNode>();
  for (const c of inst.children) {
    const kind = c.type === "TEXT" ? ["text"] : ["frame", "svg"];
    let best: ImportNode | undefined, d = 8;
    for (const s of src.children) {
      if (used.has(s) || !kind.includes(s.type)) continue;
      const dist = Math.abs(s.x - c.x) + Math.abs(s.y - c.y) - (s.type === "svg" ? 0 : 0.5);
      if (dist < d) { d = dist; best = s; }
    }
    if (!best) { if (mode === "match" && (c.type === "TEXT" || c.type === "FRAME")) c.visible = false; continue; }
    used.add(best);
    if (best.type !== "svg") override(c, best, mode, fills);
  }
}

function build(n: ImportNode, parent: BaseNode & ChildrenMixin, fonts: Fonts): SceneNode {
  if (n.type === "svg") {
    const node = figma.createNodeFromSvg(n.svg);
    node.name = n.name;
    parent.appendChild(node);
    node.x = n.x; node.y = n.y;
    if (n.w > 0 && n.h > 0) node.resize(n.w, n.h);
    return node;
  }
  if (n.type === "text") {
    const t = figma.createText();
    parent.appendChild(t);
    t.fontName = fonts.font(n.font);
    t.characters = n.content;
    t.name = n.name;
    t.fontSize = n.size;
    if (n.lineHeight) t.lineHeight = { unit: "PIXELS", value: n.lineHeight };
    if (n.letterSpacing) t.letterSpacing = { unit: "PIXELS", value: n.letterSpacing };
    if (n.color) t.fills = [{ type: "SOLID", color: rgb(n.color), opacity: n.opacity ?? 1 }];
    t.textAlignHorizontal = n.wrap ? n.align : n.align === "CENTER" ? "CENTER" : n.align;
    // Single lines get a little slack so a substituted font doesn't wrap; the anchor edge stays put.
    const slack = n.wrap ? 1 : 4;
    t.textAutoResize = "HEIGHT";
    t.resize(Math.max(1, n.w + slack), Math.max(1, n.h));
    t.x = n.align === "RIGHT" ? n.x - slack : n.align === "CENTER" ? n.x - slack / 2 : n.x;
    t.y = n.y;
    return t;
  }
  if (n.swap && fonts.components?.has(refKey(n.swap))) {
    const inst = variantOf(fonts.components.get(refKey(n.swap))!, n.swap.variant).createInstance();
    parent.appendChild(inst);
    inst.x = n.x; inst.y = n.y;
    if (Math.abs(inst.width - n.w) > 0.5 || Math.abs(inst.height - n.h) > 0.5) inst.resize(n.w, n.h);
    const mode = n.swap.overrides ?? "text";
    if (mode !== "none") override(inst, n, mode, !!n.swap.fills);
    return inst;
  }
  const f = figma.createFrame();
  parent.appendChild(f);
  f.name = n.placeholder ? `image · ${n.placeholder}` : n.name;
  f.x = n.x; f.y = n.y;
  f.resize(Math.max(0.01, n.w), Math.max(0.01, n.h));
  const fills: Paint[] = [];
  if (n.fill) fills.push(solid(n.fill));
  if (n.gradient) fills.push(gradientOf(n.gradient));
  f.fills = fills;
  if (n.stroke) {
    f.strokes = [solid(n.stroke)];
    f.strokeAlign = "INSIDE";
    const [top, right, bottom, left] = n.stroke.weights;
    f.strokeTopWeight = top; f.strokeRightWeight = right; f.strokeBottomWeight = bottom; f.strokeLeftWeight = left;
  }
  if (n.radius) [f.topLeftRadius, f.topRightRadius, f.bottomRightRadius, f.bottomLeftRadius] = n.radius.map((r) => Math.min(r, n.w / 2, n.h / 2));
  f.clipsContent = !!n.clip;
  if (n.blend && BLEND[n.blend]) f.blendMode = BLEND[n.blend];
  if (n.opacity !== undefined) f.opacity = n.opacity;
  if (n.shadows?.length || n.blur || n.backdropBlur) {
    f.effects = [...(n.shadows ?? []).map((s) => ({
      type: s.inset ? "INNER_SHADOW" : "DROP_SHADOW", color: { ...rgb(s.hex), a: s.a }, offset: { x: s.x, y: s.y },
      radius: s.blur, spread: s.spread, visible: true, blendMode: "NORMAL", ...(s.inset ? {} : { showShadowBehindNode: false }),
    }) as Effect), ...blurEffects(n.blur, n.backdropBlur)];
  }
  for (const c of n.children) build(c, f, fonts);
  return f;
}

export async function importTree(p: { page?: string; section?: string; gap?: number; components?: boolean; replace?: boolean; screens: { name: string; tree: ImportNode }[]; meta?: { session?: string; run?: string } }) {
  const page = await pageByName(p.page);
  const fonts: Fonts = await loadFonts(p.screens.map((s) => s.tree));
  fonts.components = await componentIndex(p.screens.map((s) => s.tree));
  // Only the importer's own previous output is replaced: a section with exactly this name.
  let old: SectionNode | undefined;
  if (p.replace && p.section) old = page.children.find((c): c is SectionNode => c.type === "SECTION" && c.name === p.section);
  const oldPos = old && { x: old.x, y: old.y };
  const gap = p.gap ?? 80, pad = 80;
  const content = page.children.filter((c) => !isOverlay(c)); // not the AI cursor
  const right = content.reduce((m, c) => Math.max(m, c.x + c.width), 0);
  const top = content.length ? Math.min(...content.map((c) => c.y)) : 0;
  let container: BaseNode & ChildrenMixin = page;
  let section: SectionNode | undefined;
  if (p.section) {
    section = figma.createSection();
    section.name = p.section;
    section.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }]; // the API default is dark grey
    page.appendChild(section);
    section.x = oldPos ? oldPos.x : content.length ? right + 200 : 0;
    section.y = oldPos ? oldPos.y : top;
    container = section;
  }
  const created: SceneNode[] = [];
  try {
    let x = section ? pad : content.length ? right + 200 : 0;
    const y0 = section ? pad : top;
    // Components: "Set/Prop=Value" roots become variants of one component set, laid out in a row.
    const groups = new Map<string, SceneNode[]>();
    for (const [i, s] of p.screens.entries()) {
      progress(`Importing "${s.name}"`, i, p.screens.length);
      let node = build(s.tree, container, fonts);
      const slash = s.name.lastIndexOf("/");
      if (p.components) {
        node = figma.createComponentFromNode(node);
        const key = slash > 0 && s.name.includes("=") ? s.name.slice(0, slash) : s.name;
        node.name = slash > 0 && s.name.includes("=") ? s.name.slice(slash + 1) : s.name;
        groups.set(key, [...(groups.get(key) ?? []), node]);
      } else {
        node.name = s.name;
        node.x = x; node.y = y0;
        x += node.width + gap;
        created.push(node);
      }
    }
    for (const [key, nodes] of groups) {
      let out: SceneNode;
      if (nodes.length > 1 || nodes[0].name.includes("=")) {
        let vx = 0;
        for (const n of nodes) { n.x = vx; n.y = 0; vx += n.width + 40; }
        const set = figma.combineAsVariants(nodes as ComponentNode[], container);
        set.name = key;
        set.layoutMode = "HORIZONTAL"; set.itemSpacing = 40; set.paddingLeft = set.paddingRight = set.paddingTop = set.paddingBottom = 32;
        set.primaryAxisSizingMode = "AUTO"; set.counterAxisSizingMode = "AUTO"; set.counterAxisAlignItems = "MIN";
        set.fills = []; set.strokes = [{ type: "SOLID", color: { r: 0.59, g: 0.28, b: 1 } }]; set.dashPattern = [6, 4]; set.cornerRadius = 16;
        out = set;
      } else { out = nodes[0]; out.name = key; }
      out.x = x; out.y = y0;
      x += out.width + gap;
      created.push(out);
    }
    if (section) section.resizeWithoutConstraints(x - gap + pad, Math.max(...created.map((c) => c.height)) + pad * 2);
  } catch (e) {
    (section ? [section] : created).forEach((n) => n.remove());
    throw new ExecError({ type: "FIGMA_API_ERROR", message: `Import failed and was rolled back: ${(e as Error).message}` });
  }
  old?.remove();
  tag(section ? [section] : created, p.meta);
  commitUndo();
  const shown = section ? [section] : created;
  select(shown);
  show(shown);
  return { page: page.name, sectionId: section?.id, screens: created.map((c) => ({ id: c.id, name: c.name, width: c.width, height: c.height })), warnings: fonts.warnings };
}

type ShadowIn = { type?: "drop" | "inner"; x?: number; y?: number; blur?: number; spread?: number; color: string };
const alpha = (hex: string) => (hex.length >= 9 ? parseInt(hex.slice(7, 9), 16) / 255 : 1);

export async function foundations(p: { collection?: string; colors?: Record<string, string>; numbers?: Record<string, number>;
  textStyles?: { name: string; family: string; style: string; size: number; lineHeight?: number; letterSpacing?: number }[];
  paintStyles?: { name: string; color?: string; variable?: string; gradient?: { type?: "linear" | "radial" | "angular" | "diamond"; angle?: number; stops: { color: string; position: number }[] } }[];
  effectStyles?: { name: string; shadows?: ShadowIn[]; blur?: { type: "layer" | "background"; radius: number } }[];
  gridStyles?: { name: string; columns?: { count: number; gutter?: number; margin?: number; alignment?: "STRETCH" | "CENTER" | "MIN" | "MAX"; color?: string }; rows?: { count: number; gutter?: number; margin?: number; alignment?: "STRETCH" | "CENTER" | "MIN" | "MAX"; color?: string }; grid?: { size: number; color?: string } }[] }) {
  const cols = await figma.variables.getLocalVariableCollectionsAsync();
  const name = p.collection ?? "Tokens";
  const col = cols.find((c) => c.name === name) ?? figma.variables.createVariableCollection(name);
  const mode = col.modes[0].modeId;
  const existing = await figma.variables.getLocalVariablesAsync();
  const upsert = (vname: string, type: VariableResolvedDataType, value: VariableValue) => {
    let v = existing.find((e) => e.name === vname && e.variableCollectionId === col.id);
    if (!v) v = figma.variables.createVariable(vname, col, type);
    v.setValueForMode(mode, value);
    if (type === "FLOAT") v.scopes = vname.startsWith("radius") ? ["CORNER_RADIUS"] : vname.startsWith("spacing") ? ["GAP", "WIDTH_HEIGHT"] : ["ALL_SCOPES"];
    return v;
  };
  let colors = 0, numbers = 0, styles = 0;
  for (const [k, hex] of Object.entries(p.colors ?? {})) { upsert(k, "COLOR", { ...rgb(hex), a: alpha(hex) }); colors++; }
  for (const [k, n] of Object.entries(p.numbers ?? {})) { upsert(k, "FLOAT", n); numbers++; }
  const local = await figma.getLocalTextStylesAsync();
  const warnings: string[] = [];
  for (const t of p.textStyles ?? []) {
    const font = { family: t.family, style: t.style };
    try { await figma.loadFontAsync(font); } catch { warnings.push(`Font ${t.family} ${t.style} not available; skipped style "${t.name}".`); continue; }
    const st = local.find((l) => l.name === t.name) ?? figma.createTextStyle();
    st.name = t.name; st.fontName = font; st.fontSize = t.size;
    if (t.lineHeight) st.lineHeight = { unit: "PIXELS", value: t.lineHeight };
    if (t.letterSpacing) st.letterSpacing = { unit: "PERCENT", value: t.letterSpacing };
    styles++;
  }
  // Colour, effect and grid styles: upserted by name, like variables and text styles.
  const findVar = async (name: string) => {
    const all = [...existing, ...(await figma.variables.getLocalVariablesAsync())];
    return all.find((v) => v.name === name && v.resolvedType === "COLOR");
  };
  let paint = 0, effect = 0, grid = 0;
  const localPaint = await figma.getLocalPaintStylesAsync();
  for (const ps of p.paintStyles ?? []) {
    const st = localPaint.find((l) => l.name === ps.name) ?? figma.createPaintStyle();
    st.name = ps.name;
    if (ps.gradient) st.paints = [gradientPaint(ps.gradient.type ?? "linear", ps.gradient.angle ?? 180, ps.gradient.stops.map((x) => ({ ...rgb(x.color), a: alpha(x.color), position: x.position })))];
    else if (ps.variable) {
      const v = await findVar(ps.variable);
      if (!v) { warnings.push(`Colour style "${ps.name}": no colour variable "${ps.variable}"; skipped.`); continue; }
      st.paints = [figma.variables.setBoundVariableForPaint({ type: "SOLID", color: { r: 0, g: 0, b: 0 } }, "color", v)];
    } else if (ps.color) st.paints = [{ type: "SOLID", color: rgb(ps.color), opacity: alpha(ps.color) }];
    else { warnings.push(`Colour style "${ps.name}" needs color, variable or gradient; skipped.`); continue; }
    paint++;
  }
  const localEffect = await figma.getLocalEffectStylesAsync();
  for (const es of p.effectStyles ?? []) {
    const st = localEffect.find((l) => l.name === es.name) ?? figma.createEffectStyle();
    st.name = es.name;
    const effects: Effect[] = (es.shadows ?? []).map((sh) => ({ type: sh.type === "inner" ? "INNER_SHADOW" : "DROP_SHADOW", color: { ...rgb(sh.color), a: alpha(sh.color) }, offset: { x: sh.x ?? 0, y: sh.y ?? 0 },
      radius: sh.blur ?? 0, spread: sh.spread ?? 0, visible: true, blendMode: "NORMAL", ...(sh.type === "inner" ? {} : { showShadowBehindNode: false }) }) as Effect);
    if (es.blur) effects.push({ type: es.blur.type === "background" ? "BACKGROUND_BLUR" : "LAYER_BLUR", radius: es.blur.radius, visible: true } as Effect);
    st.effects = effects;
    effect++;
  }
  const localGrid = await figma.getLocalGridStylesAsync();
  for (const gs of p.gridStyles ?? []) {
    const st = localGrid.find((l) => l.name === gs.name) ?? figma.createGridStyle();
    st.name = gs.name;
    const c = (hex?: string) => ({ ...(hex ? rgb(hex) : { r: 1, g: 0, b: 0 }), a: hex ? alpha(hex) : 0.1 });
    const lanes: LayoutGrid[] = [];
    for (const [pattern, g] of [["COLUMNS", gs.columns], ["ROWS", gs.rows]] as const) {
      if (!g) continue;
      const align = g.alignment ?? "STRETCH";
      lanes.push({ pattern, count: g.count, gutterSize: g.gutter ?? 20, alignment: align, ...(align === "CENTER" ? { sectionSize: 64 } : { offset: g.margin ?? 0 }), visible: true, color: c(g.color) } as LayoutGrid);
    }
    if (gs.grid) lanes.push({ pattern: "GRID", sectionSize: gs.grid.size, visible: true, color: c(gs.grid.color) });
    st.layoutGrids = lanes;
    grid++;
  }
  commitUndo();
  return { collection: col.name, colors, numbers, textStyles: styles, paintStyles: paint, effectStyles: effect, gridStyles: grid, warnings };
}
