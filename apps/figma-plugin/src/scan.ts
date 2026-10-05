// Design System scanner + compact inspector. Runs in the Figma plugin sandbox.
import { progress } from "./progress.ts";
import { readAnnotations } from "./annotate.ts";
import type { ComponentDefinition, ComponentSetDefinition, NodeSnapshot, PropertyDefinition, StyleDefinition, TypographyDefinition, VariableCollectionDefinition, VariableDefinition } from "@cde/core";
import { isOverlay } from "./cursor.ts";

const h2 = (n: number) => Math.round(Math.max(0, Math.min(1, n)) * 255).toString(16).padStart(2, "0");
export const toHex = (c: RGB | RGBA, opacity = 1) => {
  const a = ("a" in c ? c.a : 1) * opacity;
  return `#${h2(c.r)}${h2(c.g)}${h2(c.b)}${a < 0.999 ? h2(a) : ""}`;
};

function pageOf(n: BaseNode): string | undefined {
  let p: BaseNode | null = n;
  while (p && p.type !== "PAGE") p = p.parent;
  return p?.name;
}

function propDefs(defs: ComponentPropertyDefinitions): PropertyDefinition[] {
  return Object.entries(defs).map(([key, d]) => ({ key, name: key.split("#")[0], type: d.type as PropertyDefinition["type"], defaultValue: d.defaultValue, options: d.variantOptions }));
}

function layoutOf(n: FrameNode | ComponentNode | ComponentSetNode | InstanceNode) {
  if (!("layoutMode" in n)) return undefined;
  return { mode: n.layoutMode, gap: n.layoutMode === "NONE" ? undefined : n.itemSpacing, padding: n.layoutMode === "NONE" ? undefined : { top: n.paddingTop, right: n.paddingRight, bottom: n.paddingBottom, left: n.paddingLeft } };
}

/** What a variant looks like: the fill, stroke and radius of the layer that paints it (the root, or a nested base
 *  like "_Badge base"), and its first text colour. Used to pick the variant that looks like a drawn element. */
function lookOf(c: ComponentNode): ComponentDefinition["look"] {
  try {
    const solid = (ps: readonly Paint[] | typeof figma.mixed) => (Array.isArray(ps) ? (ps as Paint[]).find((p) => p.type === "SOLID" && p.visible !== false) as SolidPaint | undefined : undefined);
    const hex = (p?: SolidPaint) => (p ? toHex(p.color, p.opacity ?? 1) : undefined);
    // Breadth-first to depth 2: the first layer with a fill or stroke paints the element.
    let painter: SceneNode | undefined;
    let level: SceneNode[] = [c];
    for (let d = 0; d < 3 && !painter && level.length; d++) {
      painter = level.find((n) => "fills" in n && (solid((n as GeometryMixin).fills as readonly Paint[]) || solid((n as GeometryMixin).strokes)) && n.type !== "TEXT");
      level = level.flatMap((n) => ("children" in n ? [...(n as ChildrenMixin).children] as SceneNode[] : []));
    }
    const pn = (painter ?? c) as SceneNode & GeometryMixin & { cornerRadius?: number | typeof figma.mixed };
    const text = c.findOne((n) => n.type === "TEXT" && n.visible) as TextNode | null;
    return { fill: hex(solid(pn.fills as readonly Paint[])), stroke: hex(solid(pn.strokes)), radius: typeof pn.cornerRadius === "number" ? pn.cornerRadius : undefined, text: text ? hex(solid(text.fills as readonly Paint[])) : undefined };
  } catch { return undefined; }
}

function componentDef(c: ComponentNode): ComponentDefinition {
  const inSet = c.parent?.type === "COMPONENT_SET";
  let properties: PropertyDefinition[] | undefined;
  try { if (!inSet) properties = propDefs(c.componentPropertyDefinitions); } catch { /* not accessible */ }
  let textLayers: string[] = [];
  try { textLayers = c.findAllWithCriteria({ types: ["TEXT"] }).slice(0, 12).map((t) => t.name); } catch { /* remote */ }
  let variants: Record<string, string> | undefined;
  if (inSet) {
    // A component set with errors (e.g. duplicate variants) throws here; fall back to the "Key=Value, …" name.
    try { variants = c.variantProperties ?? undefined; } catch {
      variants = Object.fromEntries(c.name.split(",").map((p) => p.split("=").map((s) => s.trim())).filter((kv) => kv.length === 2 && kv[0]));
    }
  }
  return {
    id: c.id, key: c.key, name: c.name, description: c.description || undefined, remote: c.remote, page: pageOf(c),
    componentSetId: inSet ? c.parent!.id : undefined, componentSet: inSet ? c.parent!.name : undefined,
    variants, properties,
    dimensions: { width: c.width, height: c.height }, layout: layoutOf(c), textLayers, look: lookOf(c),
  };
}

function setDef(s: ComponentSetNode): ComponentSetDefinition {
  let properties: PropertyDefinition[] = [];
  try { properties = propDefs(s.componentPropertyDefinitions); } catch { /* ignore */ }
  let defaultVariantId: string | undefined;
  try { defaultVariantId = s.defaultVariant?.id; } catch { /* ignore */ }
  return { id: s.id, key: s.key, name: s.name, description: s.description || undefined, remote: s.remote, page: pageOf(s), properties, variantIds: s.children.map((c) => c.id), defaultVariantId };
}


export async function scanDesignSystem(opts: { includeLibraries?: boolean; maxInstances?: number } = {}) {
  const timings: Record<string, number> = {};
  let t0 = Date.now();
  const lap = (k: string) => { const t = Date.now(); timings[k] = t - t0; t0 = t; };
  progress("Loading pages");
  await figma.loadAllPagesAsync();
  lap("loadPages");
  const components: ComponentDefinition[] = [];
  const componentSets: ComponentSetDefinition[] = [];
  const seen = new Set<string>();
  const addSet = (s: ComponentSetNode) => {
    if (seen.has(s.id)) return;
    seen.add(s.id);
    componentSets.push(setDef(s));
    for (const c of s.children) if (c.type === "COMPONENT" && !seen.has(c.id)) { seen.add(c.id); components.push(componentDef(c)); }
  };
  const addComp = (c: ComponentNode) => {
    if (c.parent?.type === "COMPONENT_SET") return addSet(c.parent);
    if (seen.has(c.id)) return;
    seen.add(c.id);
    components.push(componentDef(c));
  };
  progress("Reading local components");
  for (const n of figma.root.findAllWithCriteria({ types: ["COMPONENT_SET", "COMPONENT"] })) n.type === "COMPONENT_SET" ? addSet(n) : addComp(n);
  lap("localComponents");

  // Library components actually used in this file (reachable through instances).
  const warnings: string[] = [];
  // Current page first: the components the user is working with are the ones that must resolve.
  const onPage = figma.currentPage.findAllWithCriteria({ types: ["INSTANCE"] });
  const pageIds = new Set(onPage.map((i) => i.id));
  const instances = [...onPage, ...figma.root.findAllWithCriteria({ types: ["INSTANCE"] }).filter((i) => !pageIds.has(i.id))];
  const cap = opts.maxInstances ?? Math.max(3000, Math.min(onPage.length, 30000));
  lap("findInstances");
  // Main components in parallel batches: one await per instance in a row takes minutes on a big file.
  const mains = new Set<string>();
  const usage = new Map<string, number>();
  const todo = instances.slice(0, cap);
  const BATCH = 400;
  for (let i = 0; i < todo.length; i += BATCH) {
    progress("Finding library components", i, todo.length);
    const got = await Promise.all(todo.slice(i, i + BATCH).map((inst) => inst.getMainComponentAsync().catch(() => null)));
    for (const main of got) {
      if (!main) continue;
      const owner = main.parent?.type === "COMPONENT_SET" ? main.parent.id : main.id;
      usage.set(owner, (usage.get(owner) ?? 0) + 1);
      if (!main.remote || mains.has(main.id)) continue;
      mains.add(main.id);
      try { addComp(main); } catch { /* unreadable library component */ }
    }
  }
  lap("libraryComponents");
  for (const set of componentSets) set.usage = usage.get(set.id);
  if (instances.length > cap) warnings.push(`Only the first ${cap} of ${instances.length} instances were checked for library components (maxInstances).`);

  // Variables (local + optionally enabled libraries).
  const variableCollections: VariableCollectionDefinition[] = [];
  const variables: VariableDefinition[] = [];
  const locals = await figma.variables.getLocalVariablesAsync();
  const byId = new Map(locals.map((v) => [v.id, v]));
  const cols = await figma.variables.getLocalVariableCollectionsAsync();
  const colById = new Map(cols.map((c) => [c.id, c]));
  for (const c of cols) variableCollections.push({ id: c.id, name: c.name, remote: false, modes: c.modes.map((m) => ({ id: m.modeId, name: m.name })), defaultModeId: c.defaultModeId });
  const fmt = (val: VariableValue | undefined, type: string): unknown => {
    if (val === undefined) return undefined;
    if (typeof val === "object" && "type" in val && val.type === "VARIABLE_ALIAS") return { alias: val.id };
    if (type === "COLOR" && typeof val === "object" && "r" in val) return toHex(val as RGBA);
    return val;
  };
  const resolveValue = async (v: Variable, depth = 0): Promise<unknown> => {
    const col = colById.get(v.variableCollectionId);
    const raw = v.valuesByMode[col?.defaultModeId ?? Object.keys(v.valuesByMode)[0]];
    const f = fmt(raw, v.resolvedType);
    if (f && typeof f === "object" && "alias" in f && depth < 6) {
      const target = byId.get((f as { alias: string }).alias) ?? (await figma.variables.getVariableByIdAsync((f as { alias: string }).alias));
      return target ? resolveValue(target, depth + 1) : undefined;
    }
    return f;
  };
  for (const v of locals) {
    const col = colById.get(v.variableCollectionId);
    const valuesByMode: Record<string, unknown> = {};
    for (const m of col?.modes ?? []) {
      const f = fmt(v.valuesByMode[m.modeId], v.resolvedType);
      valuesByMode[m.name] = f && typeof f === "object" && "alias" in f ? `alias:${byId.get((f as { alias: string }).alias)?.name ?? "library"}` : f;
    }
    variables.push({ id: v.id, key: v.key, name: v.name, collection: col?.name ?? "", type: v.resolvedType as VariableDefinition["type"], remote: false, value: await resolveValue(v), valuesByMode: (col?.modes.length ?? 0) > 1 ? valuesByMode : undefined, scopes: v.scopes as string[], description: v.description || undefined });
  }
  if (opts.includeLibraries !== false) {
    try {
      progress("Reading library variables");
      const libs = await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync();
      const all = await Promise.all(libs.map((lc) => figma.teamLibrary.getVariablesInLibraryCollectionAsync(lc.key).then((vs) => ({ lc, vs })).catch(() => ({ lc, vs: [] as LibraryVariable[] }))));
      for (const { lc, vs } of all) {
        variableCollections.push({ id: `lib:${lc.key}`, name: `${lc.libraryName} / ${lc.name}`, remote: true, modes: [] });
        for (const v of vs) variables.push({ id: `lib:${v.key}`, key: v.key, name: v.name, collection: `${lc.libraryName} / ${lc.name}`, type: v.resolvedType as VariableDefinition["type"], remote: true });
      }
    } catch (e) { warnings.push(`Library variables unavailable: ${(e as Error).message}`); }
  }

  // Styles
  const styles: StyleDefinition[] = [];
  const typography: TypographyDefinition[] = [];
  for (const s of await figma.getLocalTextStylesAsync()) {
    const lh = s.lineHeight.unit === "AUTO" ? "AUTO" : s.lineHeight.unit === "PIXELS" ? s.lineHeight.value : `${s.lineHeight.value}%`;
    styles.push({ id: s.id, key: s.key, name: s.name, type: "TEXT", remote: s.remote, description: s.description || undefined, value: `${s.fontName.family} ${s.fontName.style} ${s.fontSize}/${lh}` });
    typography.push({ styleId: s.id, name: s.name, fontFamily: s.fontName.family, fontStyle: s.fontName.style, fontSize: s.fontSize, lineHeight: lh, letterSpacing: s.letterSpacing.unit === "PIXELS" ? s.letterSpacing.value : undefined });
  }
  for (const s of await figma.getLocalPaintStylesAsync()) {
    const p = s.paints[0];
    styles.push({ id: s.id, key: s.key, name: s.name, type: "PAINT", remote: s.remote, description: s.description || undefined, value: p?.type === "SOLID" ? toHex(p.color, p.opacity ?? 1) : p?.type });
  }
  for (const s of await figma.getLocalEffectStylesAsync()) styles.push({ id: s.id, key: s.key, name: s.name, type: "EFFECT", remote: s.remote, value: s.effects.map((e) => e.type).join(",") });
  lap("localStylesAndVariables");

  // Library styles and variables can't be listed, only reached through the layers that use them: collect the ids
  // used in the file (capped), then look them up in parallel.
  progress("Finding library styles and variables");
  const styleIds = new Set<string>(), varIds = new Set<string>();
  // A library text style reached by id may not report its font; a layer using it does.
  const sampleFont = new Map<string, FontName>();
  const known = new Set([...styles.map((x) => x.id), ...variables.map((v) => v.id)]);
  // Page by page, top-level layer by top-level layer, so the AI cursor's layers (always top-level) aren't walked.
  const types: ("TEXT" | "FRAME" | "RECTANGLE" | "ELLIPSE" | "VECTOR" | "COMPONENT" | "INSTANCE")[] = ["TEXT", "FRAME", "RECTANGLE", "ELLIPSE", "VECTOR", "COMPONENT", "INSTANCE"];
  const layers: ReturnType<typeof figma.root.findAllWithCriteria<typeof types>> = [];
  for (const page of figma.root.children) for (const top of page.children) {
    if (isOverlay(top)) continue;
    if ((types as string[]).includes(top.type)) layers.push(top as (typeof layers)[number]);
    if ("findAllWithCriteria" in top) for (const n of top.findAllWithCriteria({ types })) layers.push(n);
  }
  const sample = (n: TextNode) => {
    if (typeof n.textStyleId !== "string" || !n.textStyleId || sampleFont.has(n.textStyleId)) return;
    try {
      const f = n.fontName !== figma.mixed ? n.fontName : n.characters.length ? n.getRangeFontName(0, 1) : undefined;
      if (f && f !== figma.mixed && (f as FontName).family) sampleFont.set(n.textStyleId, f as FontName);
    } catch { /* unreadable */ }
  };
  for (const n of layers.slice(0, opts.maxInstances ?? 60000)) {
    const any = n as unknown as { textStyleId?: unknown; fillStyleId?: unknown; strokeStyleId?: unknown; effectStyleId?: unknown; boundVariables?: Record<string, unknown> };
    for (const id of [any.textStyleId, any.fillStyleId, any.strokeStyleId, any.effectStyleId]) if (typeof id === "string" && id && !known.has(id)) styleIds.add(id);
    if (n.type === "TEXT") sample(n);
    for (const v of Object.values(any.boundVariables ?? {})) for (const a of Array.isArray(v) ? v : [v]) { const id = (a as VariableAlias | undefined)?.id; if (id && !known.has(id)) varIds.add(id); }
  }
  // Fonts of the styles found: from every text in the file, past the cap (a style's first layers may not say it).
  for (const n of layers) if (n.type === "TEXT" && typeof n.textStyleId === "string" && styleIds.has(n.textStyleId)) sample(n);
  lap("findUsedStyles");
  const gotStyles = await Promise.all([...styleIds].map((id) => figma.getStyleByIdAsync(id).catch(() => null)));
  for (const st of gotStyles) {
    if (!st) continue;
    if (st.type === "TEXT") {
      const t = st as TextStyle;
      const lhv = t.lineHeight as LineHeight | undefined;
      const lh = !lhv || typeof lhv !== "object" ? undefined : lhv.unit === "AUTO" ? "AUTO" : lhv.unit === "PIXELS" ? lhv.value : `${lhv.value}%`;
      const font = typeof t.fontName === "object" && (t.fontName as FontName)?.family ? (t.fontName as FontName) : sampleFont.get(t.id);
      styles.push({ id: t.id, key: t.key, name: t.name, type: "TEXT", remote: t.remote, value: `${font?.family ?? "?"} ${font?.style ?? "?"} ${t.fontSize}/${lh}` });
      const ls = t.letterSpacing as LetterSpacing | undefined;
      typography.push({ styleId: t.id, name: t.name, fontFamily: font?.family as string, fontStyle: font?.style as string, fontSize: t.fontSize, lineHeight: lh, letterSpacing: ls && typeof ls === "object" && ls.unit === "PIXELS" ? ls.value : undefined });
    } else if (st.type === "PAINT") {
      const p = (st as PaintStyle).paints[0];
      styles.push({ id: st.id, key: st.key, name: st.name, type: "PAINT", remote: st.remote, value: p?.type === "SOLID" ? toHex(p.color, p.opacity ?? 1) : p?.type });
    } else if (st.type === "EFFECT") styles.push({ id: st.id, key: st.key, name: st.name, type: "EFFECT", remote: st.remote, value: (st as EffectStyle).effects.map((e) => e.type).join(",") });
  }
  const gotVars = await Promise.all([...varIds].map((id) => figma.variables.getVariableByIdAsync(id).catch(() => null)));
  const usedCols = new Map<string, VariableCollection | null>();
  for (const v of gotVars) if (v && !usedCols.has(v.variableCollectionId)) usedCols.set(v.variableCollectionId, null);
  await Promise.all([...usedCols.keys()].map(async (id) => usedCols.set(id, await figma.variables.getVariableCollectionByIdAsync(id).catch(() => null))));
  for (const [id, c] of usedCols) if (c && !variableCollections.some((x) => x.id === id)) variableCollections.push({ id, name: c.name, remote: c.remote, modes: c.modes.map((m) => ({ id: m.modeId, name: m.name })), defaultModeId: c.defaultModeId });
  for (const v of gotVars) {
    if (!v) continue;
    const c = usedCols.get(v.variableCollectionId);
    const raw = c ? v.valuesByMode[c.defaultModeId] : undefined;
    const value = raw && typeof raw === "object" && "r" in raw ? toHex(raw as RGBA) : typeof raw === "number" || typeof raw === "string" || typeof raw === "boolean" ? raw : undefined;
    variables.push({ id: v.id, key: v.key, name: v.name, collection: c?.name ?? "", type: v.resolvedType as VariableDefinition["type"], remote: v.remote, value, scopes: v.scopes as string[] });
  }
  lap("libraryStylesAndVariables");
  const missingFonts = typography.filter((t) => !t.fontFamily).length;
  if (missingFonts) warnings.push(`${missingFonts} library text style(s) report no font to the plugin. They are imported from the library when used; if that fails, the error says why (a library that isn't enabled for this file is one cause, a style that is no longer published another).`);
  progress("Design System scanned", 1, 1);
  return { fileName: figma.root.name, scannedAt: new Date().toISOString(), components, componentSets, variableCollections, variables, styles, typography, warnings, timings };
}

// ---------------- Inspector ----------------

const CONTAINER_TYPES = new Set(["FRAME", "GROUP", "SECTION", "COMPONENT", "COMPONENT_SET", "PAGE", "BOOLEAN_OPERATION"]);

function paints(p: readonly Paint[] | typeof figma.mixed | undefined): string[] | undefined {
  if (!p || p === figma.mixed || !Array.isArray(p)) return undefined;
  const out = (p as Paint[]).filter((x) => x.visible !== false).map((x) => (x.type === "SOLID" ? toHex(x.color, x.opacity ?? 1) : x.type.toLowerCase()));
  return out.length ? out : undefined;
}

const GRADIENT = { GRADIENT_LINEAR: "linear", GRADIENT_RADIAL: "radial", GRADIENT_ANGULAR: "angular", GRADIENT_DIAMOND: "diamond" } as const;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** The top visible gradient, as the DSL writes it (the inverse of paints.ts: CSS angle from the transform). */
export function gradientOf(p: readonly Paint[] | typeof figma.mixed | undefined): NodeSnapshot["gradient"] {
  if (!p || p === figma.mixed || !Array.isArray(p)) return undefined;
  const g = [...(p as Paint[])].reverse().find((x) => x.visible !== false && x.type in GRADIENT) as GradientPaint | undefined;
  if (!g) return undefined;
  const type = GRADIENT[g.type as keyof typeof GRADIENT];
  const m = g.gradientTransform;
  const angle = type === "linear" || type === "angular" ? (((Math.atan2(m[0][1], m[0][0]) * 180) / Math.PI + 90) % 360 + 360) % 360 : 180;
  return { type, angle: Math.round(angle * 10) / 10, stops: g.gradientStops.map((st) => ({ color: toHex(st.color, g.opacity ?? 1), position: r3(st.position) })) };
}

/** Shadows and blurs, as the DSL writes them. */
export function effectsOf(list: readonly Effect[]): NodeSnapshot["effects"] {
  const on = list.filter((e) => e.visible !== false);
  const shadows = on.filter((e): e is DropShadowEffect | InnerShadowEffect => e.type === "DROP_SHADOW" || e.type === "INNER_SHADOW")
    .map((e) => ({ type: e.type === "INNER_SHADOW" ? "inner" as const : "drop" as const, x: e.offset.x, y: e.offset.y, blur: e.radius, spread: e.spread ?? 0, color: toHex(e.color) }));
  const blur = (on.find((e) => e.type === "LAYER_BLUR") as BlurEffect | undefined)?.radius;
  const backgroundBlur = (on.find((e) => e.type === "BACKGROUND_BLUR") as BlurEffect | undefined)?.radius;
  if (!shadows.length && !blur && !backgroundBlur) return undefined;
  return { ...(shadows.length ? { shadows } : {}), ...(blur ? { blur } : {}), ...(backgroundBlur ? { backgroundBlur } : {}) };
}

const isAutoParent = (n: SceneNode) => !!n.parent && "layoutMode" in n.parent && n.parent.layoutMode !== "NONE";

/** svg: also export vectors and boolean shapes as SVG markup (for the plan export). */
export async function snapshot(node: BaseNode, opts: { depth?: number; maxNodes?: number; expandInstances?: boolean; svg?: boolean } = {}): Promise<NodeSnapshot> {
  let budget = opts.maxNodes ?? 400;
  const varNames = new Map<string, string>();
  const varName = async (id: string) => {
    if (!varNames.has(id)) varNames.set(id, (await figma.variables.getVariableByIdAsync(id))?.name ?? id);
    return varNames.get(id)!;
  };
  const walk = async (n: BaseNode, depth: number, parentAbs?: { x: number; y: number }, inInstance = false): Promise<NodeSnapshot> => {
    budget--;
    const s: NodeSnapshot = { id: n.id, type: n.type, name: n.name };
    const sn = n as SceneNode;
    if ("x" in sn) { s.x = Math.round(sn.x); s.y = Math.round(sn.y); s.w = Math.round(sn.width); s.h = Math.round(sn.height); }
    if ("visible" in sn && !sn.visible) s.visible = false;
    if ("layoutMode" in sn) {
      const f = sn as FrameNode;
      s.layout = { mode: f.layoutMode, primaryAlign: f.primaryAxisAlignItems, counterAlign: f.counterAxisAlignItems, sizingH: f.layoutSizingHorizontal, sizingV: f.layoutSizingVertical };
      if (f.layoutMode !== "NONE") { s.layout.gap = f.itemSpacing; s.layout.padding = { top: f.paddingTop, right: f.paddingRight, bottom: f.paddingBottom, left: f.paddingLeft }; }
    }
    if ("fills" in sn) s.fills = paints(sn.fills as readonly Paint[]);
    if ("strokes" in sn) s.strokes = paints(sn.strokes);
    if ("fills" in sn) { const g = gradientOf(sn.fills as readonly Paint[]); if (g) s.gradient = g; }
    if ("effects" in sn && sn.effects.length) { const e = effectsOf(sn.effects); if (e) s.effects = e; }
    if ("effectStyleId" in sn && typeof sn.effectStyleId === "string" && sn.effectStyleId) s.effectStyle = sn.effectStyleId;
    // Not inside instances: the export refers to their component, so their icons' SVG would never be used.
    if (opts.svg && !inInstance && (n.type === "VECTOR" || n.type === "BOOLEAN_OPERATION")) {
      try { const svg = await sn.exportAsync({ format: "SVG_STRING" }); if (svg.length <= 200_000) s.svg = svg; } catch { /* left out; the export warns */ }
    }
    if ("cornerRadius" in sn && typeof sn.cornerRadius === "number" && sn.cornerRadius > 0) s.radius = sn.cornerRadius;
    if ("strokeWeight" in sn && typeof sn.strokeWeight === "number" && s.strokes) s.strokeWeight = sn.strokeWeight;
    // Shapes have no Auto Layout of their own, but they can fill their parent's (a divider line across a column).
    if ((n.type === "LINE" || n.type === "ELLIPSE" || n.type === "POLYGON" || n.type === "STAR") && isAutoParent(n)) s.layout = { mode: "NONE", sizingH: n.layoutSizingHorizontal, sizingV: n.layoutSizingVertical };
    if (n.type === "POLYGON" || n.type === "STAR") s.shape = { pointCount: n.pointCount, ...(n.type === "STAR" ? { innerRadius: Math.round(n.innerRadius * 1000) / 1000 } : {}) };
    if (n.type === "ELLIPSE") {
      const a = n.arcData, deg = (r: number) => Math.round((r * 180) / Math.PI * 10) / 10;
      if (a && (Math.abs(a.endingAngle - a.startingAngle - 2 * Math.PI) > 1e-3 || a.innerRadius > 0)) s.shape = { arc: { start: deg(a.startingAngle), end: deg(a.endingAngle), innerRadius: Math.round(a.innerRadius * 1000) / 1000 } };
    }
    if ("opacity" in sn && sn.opacity < 1) s.opacity = Math.round(sn.opacity * 100) / 100;
    if ("clipsContent" in sn && (sn as FrameNode).clipsContent && n.type !== "INSTANCE") s.clip = true;
    if ("fillStyleId" in sn && typeof sn.fillStyleId === "string" && sn.fillStyleId) s.fillStyle = sn.fillStyleId;
    const notes = await readAnnotations(n).catch(() => undefined);
    if (notes) s.annotations = notes;
    if ("reactions" in sn && (sn as ReactionMixin).reactions.length) {
      const out: NonNullable<NodeSnapshot["reactions"]> = [];
      for (const r of (sn as ReactionMixin).reactions) {
        const a = r.actions?.[0] ?? r.action;
        const trig = r.trigger as { type: string; timeout?: number; delay?: number } | null;
        const item: NonNullable<NodeSnapshot["reactions"]>[number] = { trigger: trig?.type, delay: trig?.timeout ?? (trig?.delay || undefined), action: a?.type === "NODE" ? a.navigation : a?.type };
        if (a?.type === "NODE" && a.destinationId) { item.to = a.destinationId; item.toName = (await figma.getNodeByIdAsync(a.destinationId))?.name; }
        if (a?.type === "URL") item.url = a.url;
        if (a?.type === "NODE" && a.transition) item.transition = { type: a.transition.type, direction: "direction" in a.transition ? a.transition.direction : undefined, duration: Math.round(a.transition.duration * 1000), easing: a.transition.easing.type };
        out.push(item);
      }
      s.reactions = out;
    }
    if ("boundVariables" in sn && sn.boundVariables) {
      const b: Record<string, string> = {};
      for (const [k, v] of Object.entries(sn.boundVariables)) {
        const alias = Array.isArray(v) ? v[0] : v;
        if (alias && typeof alias === "object" && "id" in alias) b[k] = await varName((alias as VariableAlias).id);
      }
      if (Object.keys(b).length) s.bound = b;
    }
    if (n.type === "TEXT") {
      const t = n as TextNode;
      s.text = { chars: t.characters.length > 300 ? `${t.characters.slice(0, 300)}…` : t.characters, fontSize: typeof t.fontSize === "number" ? t.fontSize : undefined, font: t.fontName !== figma.mixed ? `${t.fontName.family} ${t.fontName.style}` : "mixed",
        lineHeight: t.lineHeight === figma.mixed ? "mixed" : t.lineHeight.unit === "AUTO" ? "AUTO" : t.lineHeight.unit === "PIXELS" ? Math.round(t.lineHeight.value * 10) / 10 : `${t.lineHeight.value}%` };
      s.text.align = t.textAlignHorizontal;
      s.text.autoResize = t.textAutoResize;
      if (t.letterSpacing !== figma.mixed && t.letterSpacing.value) s.text.letterSpacing = t.letterSpacing.unit === "PIXELS" ? t.letterSpacing.value : Math.round((t.letterSpacing.value / 100) * (typeof t.fontSize === "number" ? t.fontSize : 16) * 100) / 100;
      if (typeof t.textStyleId === "string" && t.textStyleId) { s.text.styleId = t.textStyleId; s.text.style = (await figma.getStyleByIdAsync(t.textStyleId))?.name; }
    }
    if (n.type === "INSTANCE") {
      const i = n as InstanceNode;
      let main: ComponentNode | null = null;
      try { main = await i.getMainComponentAsync(); } catch { /* unavailable library */ }
      const props: Record<string, unknown> = {};
      const variants: Record<string, string> = {};
      try {
        for (const [k, p] of Object.entries(i.componentProperties)) (p.type === "VARIANT" ? (variants[k] = String(p.value)) : (props[k] = p.value));
      } catch {
        // A component set with errors (e.g. duplicate variants) can't report properties: read "Key=Value, …" from the name.
        for (const kv of (main?.name ?? "").split(",")) { const [k, v] = kv.split("=").map((x) => x.trim()); if (k && v) variants[k] = v; }
        s.warnings = [...(s.warnings ?? []), "component set has errors; variants read from the component name"];
      }
      s.instance = { componentId: main?.id, component: main?.name, componentSet: main?.parent?.type === "COMPONENT_SET" ? main.parent.name : undefined, componentSetId: main?.parent?.type === "COMPONENT_SET" ? main.parent.id : undefined, variants: Object.keys(variants).length ? variants : undefined, props: Object.keys(props).length ? props : undefined };
      if (!opts.expandInstances || depth <= 0) return s; // instance internals only on request
      // What differs from the main component: which layers have overrides, and which fields.
      const ov: Record<string, string[]> = {};
      try { for (const o of i.overrides) { const t = await figma.getNodeByIdAsync(o.id); ov[t && t.id !== i.id ? t.name : "(self)"] = o.overriddenFields as string[]; } } catch { /* not available */ }
      if (Object.keys(ov).length) s.instance.overrides = ov;
    }
    if ("children" in n && (CONTAINER_TYPES.has(n.type) || n.type === "INSTANCE")) {
      const kids = n.type === "PAGE" ? (n as PageNode).children.filter((c) => !isOverlay(c)) : (n as ChildrenMixin).children; // not the AI cursor
      if (depth <= 0 || budget <= 0) { if (kids.length) s.truncated = kids.length; return s; }
      s.children = [];
      for (const c of kids) {
        if (budget <= 0) { s.truncated = kids.length - s.children.length; break; }
        s.children.push(await walk(c, depth - 1, parentAbs, inInstance || n.type === "INSTANCE"));
      }
    }
    return s;
  };
  return walk(node, opts.depth ?? 6);
}
