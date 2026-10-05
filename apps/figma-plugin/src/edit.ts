// Edits on existing nodes: rename, move, duplicate, set, delete, resize to fit, group / ungroup / boolean, and
// turning layers into components / component sets. One call = one undo step. Fixed Plugin API calls only.
import type { AnnotationSpec, ResolvedInteraction } from "@cde/core";
import { annotate } from "./annotate.ts";
import { progress } from "./progress.ts";
import { ExecError, checkDestination, clearStyleLookups, findPage, fitSection, getComponent, loose, pageOf, setTextStyle, styleOf, tag, textStyleOf, toReaction, variableOf } from "./execute.ts";
import { commitUndo } from "./undo.ts";

export type NodeRef = string; // a node id, or "$n": the node produced by op n of this call

export type EditOp =
  | { op: "rename"; node: NodeRef; name: string }
  | { op: "move"; node: NodeRef; parent?: NodeRef; page?: string; index?: number; x?: number; y?: number }
  | { op: "duplicate"; node: NodeRef; parent?: NodeRef; x?: number; y?: number; name?: string }
  | { op: "set"; node: NodeRef; visible?: boolean; locked?: boolean; x?: number; y?: number; width?: number; height?: number; opacity?: number; text?: string; properties?: Record<string, string | boolean> }
  | { op: "delete"; node: NodeRef }
  | { op: "resizeToFit"; node: NodeRef; padding?: number }
  | { op: "prototype"; node: NodeRef; interactions: ResolvedInteraction[]; replace?: boolean }
  /** Swap an instance to another component or variant; Figma keeps its overrides. (Resolved by the server.) */
  | { op: "swap"; node: NodeRef; componentId: string; componentKey?: string; remote?: boolean; componentName?: string }
  | { op: "annotate"; node: NodeRef; annotations: AnnotationSpec[]; replace?: boolean }
  /** Bind a variable to a field (resolved by the server). */
  | { op: "bind"; node: NodeRef; field: BindField; variableId: string; variableKey?: string; variableName?: string }
  /** Apply a fill / stroke / text / effect style (resolved by the server). */
  | { op: "style"; node: NodeRef; kind: "fill" | "stroke" | "text" | "effect"; styleId: string; styleKey?: string; styleName?: string; font?: FontName }
  | { op: "group"; nodes: NodeRef[]; name?: string }
  | { op: "ungroup"; node: NodeRef }
  /** Combine shapes or vectors into one boolean shape, or flatten them into one vector. */
  | { op: "boolean"; nodes: NodeRef[]; operation: "union" | "subtract" | "intersect" | "exclude" | "flatten"; name?: string }
  | { op: "flow"; name: string; start?: NodeRef; description?: string; remove?: boolean }
  | { op: "componentize"; nodes: NodeRef[]; mode?: "single" | "multiple" | "variants"; name?: string; variants?: Record<string, string>[];
      duplicate?: boolean; exposeText?: boolean | string[]; autoLayout?: boolean; parent?: NodeRef; x?: number; y?: number };

export type BindField = "fills" | "strokes" | "itemSpacing" | "paddingTop" | "paddingRight" | "paddingBottom" | "paddingLeft" | "padding" | "cornerRadius" | "width" | "height" | "opacity" | "strokeWeight";

export interface EditResult { op: number; kind: EditOp["op"]; nodeId?: string; nodeIds?: string[]; note?: string }


async function resolve(ref: NodeRef, results: EditResult[]): Promise<SceneNode> {
  let id = ref;
  const m = /^\$(\d+)$/.exec(ref);
  if (m) {
    const r = results[+m[1]];
    if (!r?.nodeId) throw new ExecError({ type: "INVALID_PLAN", message: `"${ref}" refers to op ${m[1]}, which produced no node.` });
    id = r.nodeId;
  }
  const n = await figma.getNodeByIdAsync(id);
  if (!n || n.removed || n.type === "PAGE" || n.type === "DOCUMENT") throw new ExecError({ type: "NODE_NOT_FOUND", message: `Node ${ref} not found.` });
  return n as SceneNode;
}

async function container(ref: NodeRef | undefined, page: string | undefined, results: EditResult[]): Promise<BaseNode & ChildrenMixin | undefined> {
  if (ref) {
    const p = await resolve(ref, results);
    if (!("appendChild" in p)) throw new ExecError({ type: "INVALID_PLAN", message: `${ref} (${p.type}) can't have children.` });
    return p as unknown as BaseNode & ChildrenMixin;
  }
  return page ? await findPage(page) : undefined;
}

/** Layers that share one parent, in layer order, and where the first one sits (group and boolean ops need that). */
async function siblings(refs: NodeRef[], results: EditResult[], op: string) {
  const ns: SceneNode[] = [];
  for (const r of refs) ns.push(await resolve(r, results));
  const host = ns[0].parent as (BaseNode & ChildrenMixin) | null;
  if (!host || ns.some((n) => n.parent !== host)) throw new Error(`${op} needs layers with the same parent; move them into one frame first.`);
  ns.sort((a, b) => host.children.indexOf(a) - host.children.indexOf(b));
  return { ns, host, index: host.children.indexOf(ns[0]) };
}

/** Load every font used in these nodes so text can be written. */
async function loadFontsIn(nodes: SceneNode[]) {
  const fonts = new Map<string, FontName>();
  for (const n of nodes) {
    const texts = n.type === "TEXT" ? [n] : "findAllWithCriteria" in n ? (n as FrameNode).findAllWithCriteria({ types: ["TEXT"] }) : [];
    for (const t of texts) for (const f of t.characters.length ? t.getRangeAllFontNames(0, t.characters.length) : t.fontName === figma.mixed ? [] : [t.fontName]) fonts.set(`${f.family}|${f.style}`, f);
  }
  await Promise.all([...fonts.values()].map((f) => figma.loadFontAsync(f)));
}

/** Absolutely positioned children that stack cleanly (evenly spaced, no overlap) become Auto Layout, deepest
 *  frames first, so a component made from them adapts to new text. Frames that don't stack stay as they are. */
export function stackify(f: FrameNode | ComponentNode): boolean {
  for (const c of f.children) if ((c.type === "FRAME") && c.layoutMode === "NONE") stackify(c);
  if (f.layoutMode !== "NONE") return false;
  const kids = f.children.filter((c) => c.visible);
  if (!kids.length) return false;
  const tryAxis = (vertical: boolean) => {
    const pos = (c: SceneNode) => (vertical ? c.y : c.x), len = (c: SceneNode) => (vertical ? c.height : c.width);
    const s = [...kids].sort((a, b) => pos(a) - pos(b));
    const gaps = s.slice(1).map((c, i) => pos(c) - (pos(s[i]) + len(s[i])));
    if (gaps.some((g) => g < -0.5) || (gaps.length && Math.max(...gaps) - Math.min(...gaps) > 4)) return undefined;
    return { s, gap: gaps.length ? Math.round(gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)]) : 0 };
  };
  // One child (a badge label, an icon in a tile) is a row that hugs it; more children stack vertically if they can.
  const single = kids.length === 1;
  const v = single ? undefined : tryAxis(true), h = v ? undefined : tryAxis(false);
  const pick = v ?? h;
  if (!pick) return false;
  const minX = Math.min(...kids.map((c) => c.x)), minY = Math.min(...kids.map((c) => c.y));
  const maxX = Math.max(...kids.map((c) => c.x + c.width)), maxY = Math.max(...kids.map((c) => c.y + c.height));
  const w = f.width, hh = f.height;
  // Measure before turning Auto Layout on: Figma moves the children as soon as layoutMode is set.
  const leftAligned = kids.every((c) => Math.abs(c.x - minX) < 1);
  pick.s.forEach((c, i) => f.insertChild(i, c));
  f.layoutMode = v ? "VERTICAL" : "HORIZONTAL";
  f.itemSpacing = pick.gap;
  let [pt, pl, pr, pb] = [Math.round(minY), Math.round(minX), Math.max(0, Math.round(w - maxX)), Math.max(0, Math.round(hh - maxY))];
  // A left-aligned column: the right padding mirrors the left one (the content's right edge is just its current text).
  if (v && leftAligned) pr = pl;
  // Nearly symmetric padding (text boxes carry a few px of slack) is made symmetric.
  if (single && Math.abs(pl - pr) <= 6) pr = pl;
  if (single && Math.abs(pt - pb) <= 6) pb = pt;
  f.paddingTop = pt; f.paddingLeft = pl; f.paddingRight = pr; f.paddingBottom = pb;
  // Keep the width, hug the height (vertical); a horizontal row hugs both.
  f.primaryAxisSizingMode = "AUTO"; f.counterAxisSizingMode = v ? "FIXED" : "AUTO";
  if (v) f.resize(w, f.height);
  // Text in a column fills its width and wraps (new text never overflows the card); in a row it grows sideways.
  for (const c of pick.s) {
    if (c.type !== "TEXT") continue;
    if (v) { c.layoutSizingHorizontal = "FILL"; c.textAutoResize = "HEIGHT"; }
    else c.textAutoResize = "WIDTH_AND_HEIGHT";
  }
  return true;
}

/** "State=Open, Step=2" from { State: "Open", Step: "2" }; property order follows the first variant for every variant. */
const variantName = (props: Record<string, string>, order: string[]) => order.map((k) => `${k}=${props[k]}`).join(", ");

async function componentize(o: Extract<EditOp, { op: "componentize" }>, results: EditResult[], meta?: { session?: string; run?: string }): Promise<EditResult & { setId?: string; properties?: string[] }> {
  const mode = o.mode ?? (o.variants ? "variants" : o.nodes.length > 1 ? "multiple" : "single");
  const sources = await Promise.all(o.nodes.map((r) => resolve(r, results)));
  if (mode === "single" && sources.length !== 1) throw new ExecError({ type: "INVALID_PLAN", message: `mode "single" takes one node; got ${sources.length}. Use "multiple" or "variants".` });
  let order: string[] = [];
  if (mode === "variants") {
    if (!o.variants || o.variants.length !== sources.length) throw new ExecError({ type: "INVALID_PLAN", message: `mode "variants" needs one variants entry (e.g. { State: "Open" }) per node: ${sources.length} nodes, ${o.variants?.length ?? 0} entries.` });
    order = Object.keys(o.variants[0]);
    const seen = new Set<string>();
    for (const [i, v] of o.variants.entries()) {
      const keys = Object.keys(v);
      if (keys.length !== order.length || !order.every((k) => k in v)) throw new ExecError({ type: "INVALID_PLAN", message: `variants[${i}] has properties ${keys.join(", ")}; every variant needs exactly ${order.join(", ")}.` });
      const name = variantName(v, order);
      if (seen.has(name)) throw new ExecError({ type: "INVALID_PLAN", message: `Two nodes would both be the variant "${name}". Every variant needs a unique combination.` });
      seen.add(name);
    }
  }
  for (const s of sources) if (s.type === "COMPONENT" || s.type === "COMPONENT_SET") throw new ExecError({ type: "INVALID_PLAN", message: `${s.name} (${s.id}) is already a ${s.type.toLowerCase().replace("_", " ")}.` });
  const duplicate = o.duplicate !== false;
  // Copies go next to the originals' top-level frame (on its page or section), never into an Auto Layout flow.
  let anchor: SceneNode = sources[0];
  while (anchor.parent && anchor.parent.type !== "PAGE" && anchor.parent.type !== "SECTION") anchor = anchor.parent as SceneNode;
  const dest = (await container(o.parent, undefined, results)) ?? (duplicate ? (anchor.parent as BaseNode & ChildrenMixin) : undefined);
  const right = anchor.x + anchor.width;
  const comps: ComponentNode[] = [];
  for (const [i, s] of sources.entries()) {
    let n: SceneNode = duplicate ? s.clone() : s;
    if (n.type === "INSTANCE") {
      // Keep a Design System instance linked: wrap it in a hugging frame instead of detaching it.
      const inst = n;
      const w = inst.width, h = inst.height;
      const wrap = figma.createFrame();
      wrap.name = inst.name; wrap.fills = []; wrap.clipsContent = false;
      const host = inst.parent as BaseNode & ChildrenMixin;
      host.insertChild(host.children.indexOf(inst), wrap);
      // A plain frame of the instance's size: an Auto Layout wrapper re-lays the instance and, in real Figma, can
      // throw its right-aligned text out of place.
      wrap.resize(w, h);
      wrap.x = inst.x; wrap.y = inst.y;
      wrap.appendChild(inst);
      inst.x = 0; inst.y = 0;
      n = wrap;
    }
    if (dest && n.parent !== dest) dest.appendChild(n);
    if (o.autoLayout !== false && n.type === "FRAME") { await loadFontsIn([n]); stackify(n); }
    const c = figma.createComponentFromNode(n);
    c.name = mode === "variants" ? variantName(o.variants![i], order) : mode === "single" && o.name ? o.name : s.name;
    comps.push(c);
  }
  let out: ComponentNode | ComponentSetNode = comps[0];
  if (mode === "variants") {
    const parent = (dest ?? comps[0].parent ?? figma.currentPage) as BaseNode & ChildrenMixin;
    const set = figma.combineAsVariants(comps, parent);
    set.name = o.name ?? sources[0].name;
    // Lay variants out in a wrapping grid, like a hand-made component set.
    const cols = Math.min(4, comps.length);
    const colW = Math.max(...comps.map((c) => c.width));
    set.layoutMode = "HORIZONTAL"; set.layoutWrap = "WRAP"; set.itemSpacing = 40; set.counterAxisSpacing = 40;
    set.paddingLeft = set.paddingRight = set.paddingTop = set.paddingBottom = 32;
    set.primaryAxisSizingMode = "FIXED"; set.counterAxisSizingMode = "AUTO";
    set.resize(cols * colW + (cols - 1) * 40 + 64, set.height);
    set.fills = []; set.strokes = [{ type: "SOLID", color: { r: 0.59, g: 0.28, b: 1 } }]; set.dashPattern = [6, 4]; set.cornerRadius = 16;
    out = set;
  }
  // Place the result next to the originals (or where asked), not on top of them.
  const place = mode === "variants" ? [out] : comps;
  if (duplicate || o.x !== undefined) {
    let x = o.x ?? (o.parent ? 0 : right + 120);
    for (const n of place) { if (n.parent?.type === "COMPONENT_SET") continue; n.x = x; n.y = o.y ?? (o.parent ? 0 : anchor.y); x += n.width + 80; }
  }
  // Text properties: every text layer named in exposeText (or all uniquely named ones) becomes a TEXT property,
  // so instances are filled with props: { Title: "…" } instead of layer overrides.
  const exposed: string[] = [];
  if (o.exposeText) {
    await loadFontsIn(comps);
    const owner = out;
    const textsOf = (c: ComponentNode) => c.findAllWithCriteria({ types: ["TEXT"] });
    const names = Array.isArray(o.exposeText) ? o.exposeText : [...new Set(comps.flatMap((c) => { const t = textsOf(c).map((x) => x.name); return t.filter((n, i) => t.indexOf(n) === i); }))];
    for (const name of names) {
      const layers = comps.map((c) => textsOf(c).find((t) => loose(t.name) === loose(name))).filter((t): t is TextNode => !!t);
      if (!layers.length) { if (Array.isArray(o.exposeText)) throw new ExecError({ type: "INVALID_PLAN", message: `No text layer "${name}" in the new component(s).` }); continue; }
      const key = owner.addComponentProperty(layers[0].name, "TEXT", layers[0].characters);
      for (const t of layers) t.componentPropertyReferences = { ...(t.componentPropertyReferences ?? {}), characters: key };
      exposed.push(layers[0].name);
    }
  }
  tag(place as SceneNode[], meta);
  return { op: 0, kind: "componentize", nodeId: out.id, nodeIds: comps.map((c) => c.id), setId: mode === "variants" ? out.id : undefined, properties: exposed.length ? exposed : undefined,
    note: `${mode === "variants" ? `component set "${out.name}" with ${comps.length} variants` : `${comps.length} component(s)`}${duplicate ? " (from copies; originals untouched)" : ""}` };
}

export async function editNodes(p: { ops: EditOp[]; approved?: boolean; meta?: { session?: string; run?: string } }) {
  clearStyleLookups();
  const results: EditResult[] = [];
  const touchedSections = new Set<SectionNode>();
  const noteSection = (n: BaseNode | null) => { if (n?.type === "SECTION") touchedSections.add(n as SectionNode); };
  let failed: { op: number; error: string } | undefined;
  for (const [i, o] of p.ops.entries()) {
    if (p.ops.length > 3) progress(`Editing layers (${o.op})`, i, p.ops.length);
    try {
      let r: EditResult;
      switch (o.op) {
        case "rename": { const n = await resolve(o.node, results); const from = n.name; n.name = o.name; r = { op: i, kind: o.op, nodeId: n.id, note: `"${from}" → "${o.name}"` }; break; }
        case "move": {
          const n = await resolve(o.node, results);
          const dest = await container(o.parent, o.page, results);
          noteSection(n.parent);
          if (dest) { if (o.index !== undefined) dest.insertChild(Math.min(o.index, dest.children.length), n); else dest.appendChild(n); }
          else if (o.index !== undefined && n.parent) { const host = n.parent as BaseNode & ChildrenMixin; host.insertChild(Math.min(o.index, host.children.length - 1), n); }
          if (o.x !== undefined) n.x = o.x;
          if (o.y !== undefined) n.y = o.y;
          noteSection(n.parent);
          r = { op: i, kind: o.op, nodeId: n.id, note: `into ${n.parent?.name ?? "?"}${pageOf(n) ? ` on "${pageOf(n)!.name}"` : ""}` };
          break;
        }
        case "duplicate": {
          const n = await resolve(o.node, results);
          const c = n.clone();
          const dest = await container(o.parent, undefined, results);
          if (dest) dest.appendChild(c);
          c.x = o.x ?? (dest ? c.x : n.x + n.width + 80); c.y = o.y ?? (dest ? c.y : n.y);
          if (o.name) c.name = o.name;
          noteSection(c.parent);
          tag([c], p.meta);
          r = { op: i, kind: o.op, nodeId: c.id };
          break;
        }
        case "set": {
          const n = await resolve(o.node, results);
          if (o.visible !== undefined) n.visible = o.visible;
          if (o.locked !== undefined) n.locked = o.locked;
          if (o.x !== undefined) n.x = o.x;
          if (o.y !== undefined) n.y = o.y;
          if (o.width !== undefined || o.height !== undefined) {
            const w = o.width ?? n.width, h = o.height ?? n.height;
            if (n.type === "SECTION") (n as SectionNode).resizeWithoutConstraints(w, h);
            else if ("resize" in n) (n as FrameNode).resize(w, h);
          }
          if (o.opacity !== undefined && "opacity" in n) (n as FrameNode).opacity = o.opacity;
          if (o.text !== undefined) {
            if (n.type !== "TEXT") throw new Error(`"text" needs a text layer; ${n.name} is a ${n.type}.`);
            await loadFontsIn([n]);
            n.characters = o.text;
          }
          if (o.properties) {
            if (n.type !== "INSTANCE") throw new Error(`"properties" needs an instance; ${n.name} is a ${n.type}.`);
            await loadFontsIn([n]);
            const avail = n.componentProperties;
            const set: Record<string, string | boolean> = {};
            for (const [k, v] of Object.entries(o.properties)) {
              const key = Object.keys(avail).find((a) => loose(a) === loose(k));
              if (!key) throw new Error(`"${k}" is not a property of ${n.name}. Available: ${Object.keys(avail).map((a) => a.split("#")[0]).join(", ") || "none"}.`);
              set[key] = avail[key].type === "BOOLEAN" ? v === true || v === "true" : String(v);
            }
            n.setProperties(set);
          }
          noteSection(n.parent);
          r = { op: i, kind: o.op, nodeId: n.id };
          break;
        }
        case "delete": {
          const n = await resolve(o.node, results);
          noteSection(n.parent);
          // Without approval nothing is removed: the node is hidden and labelled, so the user can check and delete it.
          if (p.approved) { const name = n.name; n.remove(); r = { op: i, kind: o.op, note: `removed "${name}"` }; }
          else { n.visible = false; if (!n.name.startsWith("🗑")) n.name = `🗑 ${n.name}`; r = { op: i, kind: o.op, nodeId: n.id, note: "hidden and renamed (pass approved: true to remove)" }; }
          break;
        }
        case "resizeToFit": {
          const n = await resolve(o.node, results);
          if (n.type === "SECTION") fitSection(n as SectionNode, o.padding ?? 80, false);
          else if ((n.type === "FRAME" || n.type === "COMPONENT") && (n as FrameNode).layoutMode !== "NONE") { (n as FrameNode).layoutSizingHorizontal = "HUG"; (n as FrameNode).layoutSizingVertical = "HUG"; }
          else if (n.type === "FRAME" && n.children.length) {
            const kids = n.children, pad = o.padding ?? 0;
            const minX = Math.min(...kids.map((c) => c.x)), minY = Math.min(...kids.map((c) => c.y));
            for (const c of kids) { c.x += pad - minX; c.y += pad - minY; }
            n.resize(Math.max(...kids.map((c) => c.x + c.width)) + pad, Math.max(...kids.map((c) => c.y + c.height)) + pad);
          } else throw new Error(`${n.name} (${n.type}) can't be resized to fit.`);
          r = { op: i, kind: o.op, nodeId: n.id, note: `${Math.round(n.width)}×${Math.round(n.height)}` };
          break;
        }
        case "prototype": {
          const n = await resolve(o.node, results);
          if (!("setReactionsAsync" in n)) throw new Error(`${n.name} (${n.type}) can't have interactions.`);
          const warnings: string[] = [];
          const reactions: Reaction[] = [];
          for (const it of o.interactions) {
            let dest: string | null = null;
            if (it.to) dest = "path" in it.to ? (await resolve(it.to.path, results)).id : it.to.nodeId;
            if (it.to && !checkDestination(it, n, dest ? await figma.getNodeByIdAsync(dest) : null, n.name, warnings)) continue;
            reactions.push(toReaction(it, dest));
          }
          if (warnings.length && !reactions.length) throw new Error(warnings.join(" "));
          const keep = o.replace === false ? [...(n as SceneNode & ReactionMixin).reactions] : [];
          await (n as SceneNode & ReactionMixin).setReactionsAsync([...keep, ...reactions]);
          r = { op: i, kind: o.op, nodeId: n.id, note: `${reactions.length} interaction(s)${warnings.length ? `; ${warnings.join(" ")}` : ""}` };
          break;
        }
        case "swap": {
          const n = await resolve(o.node, results);
          if (n.type !== "INSTANCE") throw new Error(`${n.name} is a ${n.type.toLowerCase()}, not an instance; only instances can be swapped.`);
          const from = (await n.getMainComponentAsync())?.name;
          const comp = await getComponent(o.componentId, o.componentKey, !!o.remote, n.name);
          n.swapComponent(comp);
          r = { op: i, kind: o.op, nodeId: n.id, note: `${from ?? "?"} → ${o.componentName ?? comp.name} (overrides kept)` };
          break;
        }
        case "annotate": {
          const n = await resolve(o.node, results);
          await annotate(n, o.annotations, o.replace);
          r = { op: i, kind: o.op, nodeId: n.id, note: `${o.annotations.length} annotation(s)` };
          break;
        }
        case "bind": {
          const n = await resolve(o.node, results);
          const v = await variableOf(o.variableId, o.variableKey);
          if (o.field === "fills" || o.field === "strokes") {
            if (!(o.field in n)) throw new Error(`${n.name} has no ${o.field}.`);
            const paints = [...((n as GeometryMixin)[o.field] as Paint[])];
            const first = paints[0]?.type === "SOLID" ? (paints[0] as SolidPaint) : ({ type: "SOLID", color: { r: 0, g: 0, b: 0 } } as SolidPaint);
            paints[0] = figma.variables.setBoundVariableForPaint(first, "color", v);
            (n as GeometryMixin)[o.field] = paints;
          } else {
            const fields = o.field === "padding" ? ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"] : o.field === "cornerRadius" ? ["topLeftRadius", "topRightRadius", "bottomLeftRadius", "bottomRightRadius"] : [o.field];
            if (fields.some((f) => !(f in n))) throw new Error(`${n.name} (${n.type}) has no ${o.field}.`);
            for (const f of fields) (n as SceneNode & { setBoundVariable(f: string, v: Variable): void }).setBoundVariable(f, v);
          }
          r = { op: i, kind: o.op, nodeId: n.id, note: `${o.field} → ${o.variableName ?? v.name}` };
          break;
        }
        case "style": {
          const n = await resolve(o.node, results);
          if (o.kind === "text") {
            if (n.type !== "TEXT") throw new Error(`A text style needs a text layer; ${n.name} is a ${n.type}.`);
            const found = await textStyleOf(o.styleId, o.styleKey, o.font);
            if (!found.style) throw new Error(`Text style "${o.styleName ?? o.styleId}" can't be applied: ${found.reason}.`);
            for (const f of n.characters.length ? n.getRangeAllFontNames(0, n.characters.length) : n.fontName === figma.mixed ? [] : [n.fontName]) await figma.loadFontAsync(f);
            await setTextStyle(n, found).catch((e) => { throw new Error(`Text style "${o.styleName ?? o.styleId}" can't be applied: ${e instanceof Error ? e.message : e}.`); });
          } else {
            const st = await styleOf(o.styleId, o.styleKey);
            const setter = { fill: "setFillStyleIdAsync", stroke: "setStrokeStyleIdAsync", effect: "setEffectStyleIdAsync" }[o.kind];
            if (!(setter in n)) throw new Error(`${n.name} (${n.type}) can't take a ${o.kind} style.`);
            await (n as unknown as Record<string, (id: string) => Promise<void>>)[setter](st.id);
          }
          r = { op: i, kind: o.op, nodeId: n.id, note: `${o.kind} style → ${o.styleName ?? o.styleId}` };
          break;
        }
        case "group": {
          const { ns, host, index } = await siblings(o.nodes, results, "group");
          const g = figma.group(ns, host, index);
          if (o.name) g.name = o.name;
          noteSection(host);
          r = { op: i, kind: o.op, nodeId: g.id, note: `${ns.length} layer(s) grouped` };
          break;
        }
        case "ungroup": {
          const n = await resolve(o.node, results);
          if (n.type !== "GROUP" && n.type !== "FRAME" && n.type !== "BOOLEAN_OPERATION") throw new Error(`${n.name} is a ${n.type}; only groups, frames and boolean shapes can be ungrouped.`);
          noteSection(n.parent);
          // Figma removes the group; read what the note needs first.
          const name = n.name;
          const kids = figma.ungroup(n as GroupNode);
          r = { op: i, kind: o.op, nodeIds: kids.map((k) => k.id), note: `${kids.length} layer(s) moved out of "${name}"` };
          break;
        }
        case "boolean": {
          const { ns, host, index } = await siblings(o.nodes, results, "boolean");
          if (o.operation !== "flatten" && ns.length < 2) throw new Error(`${o.operation} needs at least two layers.`);
          const base = ns[0] as GeometryMixin;
          const fills = base.fills, strokes = base.strokes, weight = base.strokeWeight;
          const b = o.operation === "flatten" ? figma.flatten(ns, host, index) : figma[o.operation](ns, host, index);
          // The plugin API gives a new boolean Figma's default grey; like the editor, it takes the base layer's look.
          if (fills !== figma.mixed) b.fills = fills;
          if (strokes.length) { b.strokes = strokes; if (weight !== figma.mixed) b.strokeWeight = weight; }
          if (o.name) b.name = o.name;
          noteSection(host);
          r = { op: i, kind: o.op, nodeId: b.id, note: `${o.operation} of ${ns.length} layer(s)` };
          break;
        }
        case "flow": {
          const page = figma.currentPage;
          const rest = page.flowStartingPoints.filter((f) => f.name !== o.name);
          if (o.remove) { page.flowStartingPoints = rest; r = { op: i, kind: o.op, note: `removed flow "${o.name}"` }; break; }
          if (!o.start) throw new Error(`flow "${o.name}" needs a start node.`);
          const n = await resolve(o.start, results);
          if (!(n.parent?.type === "PAGE" || n.parent?.type === "SECTION")) throw new Error(`A flow starts at a top-level frame; "${n.name}" is inside "${n.parent?.name}".`);
          if (pageOf(n)?.id !== page.id) await figma.setCurrentPageAsync(pageOf(n)!);
          // One flow per start frame: replace a same-named flow or the one already starting there (e.g. Figma's "Flow 1").
          figma.currentPage.flowStartingPoints = [...figma.currentPage.flowStartingPoints.filter((f) => f.name !== o.name && f.nodeId !== n.id), { nodeId: n.id, name: o.name }];
          r = { op: i, kind: o.op, nodeId: n.id, note: `flow "${o.name}" starts at "${n.name}"` };
          break;
        }
        case "componentize": { r = { ...(await componentize(o, results, p.meta)), op: i }; const n = await figma.getNodeByIdAsync(r.nodeId!); noteSection(n?.parent ?? null); break; }
        default: throw new Error(`Unknown op ${(o as any).op}`);
      }
      results.push(r);
    } catch (e) {
      failed = { op: i, error: e instanceof ExecError ? e.detail.message : (e as Error).message ?? String(e) };
      break;
    }
  }
  for (const s of touchedSections) if (!s.removed) fitSection(s);
  commitUndo();
  return { applied: results, failed, note: failed ? `Stopped at op ${failed.op}; ops before it were applied (one undo reverts them).` : "One undo reverts every op in this call." };
}

/** List (and with approved, remove) what Layerwright created in a session or run. */
export async function cleanup(p: { session?: string; run?: string; nodeIds?: string[]; approved?: boolean }) {
  await figma.loadAllPagesAsync();
  const found: SceneNode[] = [];
  if (p.nodeIds?.length) for (const id of p.nodeIds) { const n = await figma.getNodeByIdAsync(id); if (n && !n.removed && n.type !== "PAGE" && n.type !== "DOCUMENT") found.push(n as SceneNode); }
  else for (const page of figma.root.children) {
    for (const n of page.findAllWithCriteria({ pluginData: { keys: ["layerwright"] } }) as SceneNode[]) {
      let d: { session?: string; run?: string } = {};
      try { d = JSON.parse(n.getPluginData("layerwright")); } catch { continue; }
      if ((p.session && d.session === p.session) || (p.run && d.run === p.run) || (!p.session && !p.run)) found.push(n);
    }
  }
  // A tagged node inside another tagged node goes with its parent.
  const ids = new Set(found.map((n) => n.id));
  const top = found.filter((n) => { let q = n.parent; while (q) { if (ids.has(q.id)) return false; q = q.parent; } return true; });
  const list = top.map((n) => ({ id: n.id, name: n.name, type: n.type, page: pageOf(n)?.name }));
  if (p.approved) { for (const n of top) if (!n.removed) n.remove(); commitUndo(); }
  return { removed: !!p.approved, nodes: list };
}
