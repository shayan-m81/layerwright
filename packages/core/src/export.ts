// Figma → Design Plan: serialize an inspected subtree (NodeSnapshot, with expandInstances) back into the DSL, so an
// existing design can be cloned, refactored ("rebuild with the new stepper") or turned into code. Pure and deterministic.
import { MAX_RADIUS, type DesignSystem, type NodeSnapshot } from "./types.ts";
import type { DesignPlan } from "./dsl.ts";
import { Resolver } from "./resolver.ts";
import { weightOfStyle } from "./weights.ts";

/** What a plan holds (dsl.ts: text content, runs per text). */
const MAX_TEXT = 5000, MAX_RUNS = 200;

export interface PlanExport { plan: DesignPlan; warnings: string[] }

/** values: "tokens" (default) writes the variables and text styles a layer is bound to, by name, so the rebuild stays
 *  bound to the Design System; "raw" writes the values they resolve to (hex, px, font fields), so the plan needs no
 *  Design System scan. With a scan, a token the scan doesn't know is written as its raw value, with a warning. */
export interface ExportOptions { name?: string; values?: "tokens" | "raw" }

const ALIGN: Record<string, string> = { MIN: "start", CENTER: "center", MAX: "end", SPACE_BETWEEN: "space-between", BASELINE: "baseline" };
const FIT: Record<string, string> = { FILL: "fill", FIT: "fit", TILE: "tile", CROP: "fill" };
const hexOnly = (f?: string[]) => (f?.length === 1 && f[0].startsWith("#") ? f[0].toUpperCase() : undefined);

/** "Plus Jakarta Sans Semi Bold": the trailing words that describe a weight or slant are the style. */
function fontOf(font: string) {
  const words = font.split(" ");
  let cut = words.length;
  while (cut > 1 && /^(thin|hairline|extra|ultra|light|regular|normal|book|medium|semi|demi|bold|black|heavy|italic|oblique|extrabold|semibold|extralight|ultralight)$/i.test(words[cut - 1])) cut--;
  const styleWords = words.slice(cut).join(" ") || "Regular";
  return { family: words.slice(0, cut).join(" "), weight: weightOfStyle(styleWords), italic: /italic|oblique/i.test(styleWords) };
}

export function snapshotToPlan(root: NodeSnapshot, ds?: DesignSystem, opts: ExportOptions = {}): PlanExport {
  const warnings: string[] = [];
  const raw = opts.values === "raw";
  const resolver = ds && !raw ? new Resolver(ds) : undefined;
  const missing = new Set<string>();
  const known = new Map<string, boolean>(); // a big frame binds the same few tokens hundreds of times
  /** A variable name the plan can use: always in tokens mode without a scan; with a scan only one it knows. */
  const token = (name: string | undefined, type: "COLOR" | "FLOAT") => {
    if (raw || !name) return undefined;
    if (!resolver) return name;
    const k = `${type}:${name}`;
    if (!known.has(k)) known.set(k, !!resolver.findVariable(name, type));
    if (known.get(k)) return name;
    missing.add(name);
    return undefined;
  };
  const bound = (n: NodeSnapshot, field: string, type: "COLOR" | "FLOAT") => token(n.bound?.[field], type);
  const styleName = (id?: string, name?: string) => {
    if (raw) return undefined;
    const byId = ds?.typography.find((t) => t.styleId === id)?.name;
    if (byId || !resolver) return byId ?? name;
    if (!name) return undefined;
    const k = `TEXT:${name}`;
    if (!known.has(k)) known.set(k, !!resolver.findTextStyle(name, undefined));
    if (known.get(k)) return name;
    missing.add(name);
    return undefined;
  };

  const size = (n: NodeSnapshot, axis: "H" | "V") => {
    const mode = axis === "H" ? n.layout?.sizingH : n.layout?.sizingV;
    if (mode === "HUG") return "hug";
    if (mode === "FILL") return "fill";
    return axis === "H" ? n.w : n.h;
  };

  const color = (n: NodeSnapshot, field: "fills" | "strokes" = "fills") => bound(n, field, "COLOR") ?? hexOnly(field === "fills" ? n.fills : n.strokes);

  /** Fill (a variable, or the one solid colour), the top image and gradient, and the effect style or raw shadows and blurs. */
  const look = (n: NodeSnapshot, path: string, out: any) => {
    const solids = (n.fills ?? []).filter((x) => x.startsWith("#"));
    out.fill = bound(n, "fills", "COLOR") ?? (solids.length === 1 ? solids[0].toUpperCase() : undefined);
    if (n.image) {
      out.image = { hash: n.image.hash, fit: FIT[n.image.scaleMode] ?? "fill" };
      if (n.image.scaleMode === "CROP") warnings.push(`${path}: "${n.name}" crops its image; the crop isn't kept, so it's exported as fill (covers the layer).`);
    }
    if (n.gradient) out.gradient = { ...n.gradient, stops: n.gradient.stops.map((st) => ({ ...st, color: st.color.toUpperCase() })) };
    const gradients = (n.fills ?? []).filter((x) => x.startsWith("gradient_")).length;
    const images = (n.fills ?? []).filter((x) => x === "image").length;
    const other = (n.fills ?? []).find((x) => !x.startsWith("#") && !x.startsWith("gradient_") && !(x === "image" && n.image));
    if (other) warnings.push(`${path}: "${n.name}" has ${/^[aeiou]/.test(other) ? "an" : "a"} ${other} fill, which plans can't express; it's left out.`);
    if (solids.length > 1 || gradients > 1 || images > 1) warnings.push(`${path}: "${n.name}" stacks several fills; only one colour, the top image and the top gradient are exported.`);
    const style = !raw && n.effectStyle ? ds?.styles.find((s) => s.id === n.effectStyle)?.name : undefined;
    if (style) out.effect = style;
    else if (n.effects) {
      if (n.effects.shadows) out.shadows = n.effects.shadows.map((s) => ({ ...s, color: s.color.toUpperCase() }));
      if (n.effects.blur) out.blur = n.effects.blur;
      if (n.effects.backgroundBlur) out.backgroundBlur = n.effects.backgroundBlur;
    }
  };

  /** A text's styled pieces, each with what differs from the text itself; none when nothing differs. */
  const runsOf = (n: NodeSnapshot, content: string, base: { font?: string; fontSize?: number; color?: string }) => {
    const out: any[] = [];
    let left = content.length;
    for (const r of n.text?.runs ?? []) {
      if (left <= 0) break;
      const text = r.chars.slice(0, left);
      left -= text.length;
      const run: any = { text };
      if (r.font && r.font !== base.font) { const f = fontOf(r.font), b = fontOf(base.font ?? r.font); if (f.family !== b.family) run.fontFamily = f.family; if (f.weight !== b.weight) run.weight = f.weight; if (f.italic !== b.italic) run.italic = f.italic; }
      if (r.fontSize && r.fontSize !== base.fontSize) run.fontSize = r.fontSize;
      if (r.fill && r.fill.toUpperCase() !== base.color) run.color = r.fill.toUpperCase();
      if (r.href) run.href = r.href;
      if (text) out.push(run);
    }
    // Runs must spell the whole content; a piece that changes nothing isn't worth one.
    if (out.map((r) => r.text).join("") !== content || out.every((r) => Object.keys(r).length === 1)) return undefined;
    // Neighbours that look the same are one run; a plan holds at most MAX_RUNS of them.
    const merged: any[] = [];
    for (const r of out) {
      const prev = merged[merged.length - 1];
      const same = prev && JSON.stringify({ ...prev, text: "" }) === JSON.stringify({ ...r, text: "" });
      if (same) prev.text += r.text; else merged.push({ ...r });
    }
    if (merged.length > MAX_RUNS) { warnings.push(`${n.name}: ${merged.length} differently styled pieces of text; a plan holds ${MAX_RUNS}, so it keeps the first piece's style.`); return undefined; }
    return merged;
  };

  const node = (n: NodeSnapshot, parent: NodeSnapshot | undefined, path: string): any => {
    if (n.visible === false) return undefined;
    // In the flow of a horizontal or vertical Auto Layout parent. Anything else keeps its exact position: children of a
    // frame without Auto Layout, of a grid (which plans can't express) and absolutely positioned ones. Group children
    // are in the group's parent space.
    const inFlow = !!parent?.layout && (parent.layout.mode === "HORIZONTAL" || parent.layout.mode === "VERTICAL") && parent.type !== "GROUP" && !n.absolute;
    const origin = parent?.type === "GROUP" ? { x: parent.x ?? 0, y: parent.y ?? 0 } : { x: 0, y: 0 };
    const position = parent && !inFlow && parent.type !== "SECTION" && n.x !== undefined ? { type: "absolute", x: (n.x ?? 0) - origin.x, y: (n.y ?? 0) - origin.y } : undefined;
    const common: any = { name: n.name, ...(position ? { position } : {}), ...(n.opacity !== undefined ? { opacity: n.opacity } : {}) };
    if (n.reactions?.length) common.interactions = n.reactions.map((r) => interactionOf(r, path, warnings)).filter(Boolean);
    if (n.annotations?.length) common.annotations = n.annotations;

    if (n.type === "TEXT" && n.text) {
      // An inspect outside a plan export cuts a long text to 300 characters and marks it with "…".
      const chars = n.text.chars;
      let content = chars.length === 301 && chars.endsWith("…") ? chars.slice(0, 300) : chars;
      if (content.length > MAX_TEXT) { warnings.push(`${path}: the text is ${content.length} characters; a plan holds ${MAX_TEXT}, so it was cut (add the rest after building).`); content = content.slice(0, MAX_TEXT); }
      const t: any = { type: "text", ...common, content };
      // A text whose font, size or colour changes inside it reports them per piece: its first piece is the base.
      const first = n.text.runs?.[0];
      const baseFont = n.text.font && n.text.font !== "mixed" ? n.text.font : first?.font;
      const baseSize = n.text.fontSize ?? first?.fontSize;
      const st = styleName(n.text.styleId, n.text.style);
      if (st) t.style = st;
      else {
        const f = fontOf(baseFont ?? "Inter Regular");
        t.fontFamily = f.family;
        t.weight = f.weight;
        if (f.italic) t.italic = true;
        if (baseSize) t.fontSize = baseSize;
      }
      if (typeof n.text.lineHeight === "number") t.lineHeight = { unit: "px", value: n.text.lineHeight };
      else if (typeof n.text.lineHeight === "string" && /^\d+(\.\d+)?%$/.test(n.text.lineHeight)) t.lineHeight = { unit: "percent", value: parseFloat(n.text.lineHeight) };
      if (n.text.letterSpacing) t.letterSpacing = { unit: "px", value: n.text.letterSpacing };
      const c = color(n) ?? first?.fill?.toUpperCase();
      if (c) t.color = c;
      const runs = runsOf(n, content, { font: baseFont, fontSize: baseSize, color: hexOnly(n.fills) ?? first?.fill?.toUpperCase() });
      if (runs) t.runs = runs;
      if (n.text.align && n.text.align !== "LEFT") t.align = n.text.align.toLowerCase() === "justified" ? "justified" : n.text.align.toLowerCase();
      // Single-line text hugs; wrapping text keeps its width (or fills its column).
      const w = size(n, "H");
      t.width = n.text.autoResize === "WIDTH_AND_HEIGHT" || w === "hug" ? "hug" : w === "fill" && inFlow ? "fill" : n.w;
      return t;
    }

    if (n.type === "INSTANCE" && n.instance) {
      const ref = n.instance.componentSetId ?? n.instance.componentId;
      if (!ref) { warnings.push(`${path}: instance "${n.name}" has no reachable main component; skipped.`); return undefined; }
      const props: Record<string, string | boolean> = {};
      for (const [k, v] of Object.entries(n.instance.props ?? {})) if (typeof v === "string" || typeof v === "boolean") props[k.split("#")[0]] = v;
      // Overridden text that isn't a text property: carried as a text-layer override by layer name.
      const byText = new Map<string, NodeSnapshot>();
      const collect = (x: NodeSnapshot) => { if (x.type === "TEXT") byText.set(x.name, x); (x.children ?? []).forEach(collect); };
      (n.children ?? []).forEach(collect);
      for (const [layer, fields] of Object.entries(n.instance.overrides ?? {})) {
        if (fields.includes("characters") && byText.has(layer) && !(layer in props)) props[layer] = byText.get(layer)!.text!.chars;
        if (fields.includes("visible")) warnings.push(`${path}: "${n.name}" hides layer "${layer}" by an override; plans can't express that yet.`);
      }
      const out: any = { type: "component", ...common, component: { id: ref } };
      if (n.instance.variants && n.instance.componentSetId) out.variant = n.instance.variants;
      if (Object.keys(props).length) out.props = props;
      // "fill" outside a flow (a grid cell, the inspected root) has nothing to fill: keep the size it has.
      const w = size(n, "H"), h = size(n, "V");
      if (w === "fill") out.width = inFlow ? "fill" : n.w;
      else if (typeof w === "number") out.width = w;
      if (h === "fill") out.height = inFlow ? "fill" : n.h;
      return out;
    }

    if (["ELLIPSE", "LINE", "POLYGON", "STAR"].includes(n.type)) {
      const line = n.type === "LINE";
      const out: any = { type: "shape", ...common, shape: n.type.toLowerCase(), width: size(n, "H") === "fill" && inFlow ? "fill" : n.w, ...(line ? {} : { height: n.h }) };
      look(n, path, out);
      if (line) { delete out.fill; delete out.gradient; delete out.image; }
      const s = color(n, "strokes");
      if (s) { out.stroke = s; if (n.strokeWeight) out.strokeWeight = n.strokeWeight; }
      if (n.shape?.pointCount) out.pointCount = n.shape.pointCount;
      if (n.shape?.innerRadius !== undefined) out.innerRadius = n.shape.innerRadius;
      if (n.shape?.arc) out.arc = n.shape.arc;
      return strip(out);
    }

    if (["FRAME", "COMPONENT", "GROUP", "SECTION", "RECTANGLE"].includes(n.type)) {
      const out: any = { type: n.type === "SECTION" ? "section" : "frame", ...common };
      if (n.type === "COMPONENT") warnings.push(`${path}: component "${n.name}" exported as a frame (use its instances to reuse it).`);
      const auto = n.layout?.mode === "HORIZONTAL" || n.layout?.mode === "VERTICAL";
      if (n.layout?.mode === "GRID") warnings.push(`${path}: "${n.name}" uses a grid layout, which plans can't express; exported as a fixed frame with its children at their positions.`);
      if (n.type !== "SECTION") {
        out.layout = auto
          ? { direction: n.layout!.mode === "HORIZONTAL" ? "horizontal" : "vertical", gap: bound(n, "itemSpacing", "FLOAT") ?? n.layout!.gap ?? 0,
              padding: pad(n, (f) => bound(n, f, "FLOAT")), align: ALIGN[n.layout!.primaryAlign ?? "MIN"] ?? "start", crossAlign: ALIGN[n.layout!.counterAlign ?? "MIN"] ?? "start",
              ...(n.layout!.wrap ? { wrap: true, counterGap: bound(n, "counterAxisSpacing", "FLOAT") ?? n.layout!.counterGap } : {}) }
          : { direction: "none" };
        // Outside an Auto Layout flow (the root, absolute children) "fill" has nothing to fill: use the size. A frame
        // without Auto Layout of its own (or a grid) can still fill its parent's flow, but never hugs.
        const fit = (v: number | string | undefined, px?: number) => (v === "fill" ? (inFlow ? v : px) : auto ? v : px);
        out.width = fit(size(n, "H"), n.w);
        out.height = fit(size(n, "V"), n.h);
      }
      look(n, path, out);
      // A section's outline and corner radius are Figma's section chrome, not design.
      const s = n.type === "SECTION" ? undefined : color(n, "strokes");
      if (s) { out.stroke = s; if (n.strokeWeight) out.strokeWeight = n.strokeWeight; }
      // Figma reports a pill's "full" radius as 33554400: any radius past MAX_RADIUS is fully round.
      if (n.radius && n.type !== "SECTION") out.radius = bound(n, "topLeftRadius", "FLOAT") ?? Math.min(n.radius, MAX_RADIUS);
      if (n.clip) out.clip = true;
      if (n.truncated) warnings.push(`${path}: "${n.name}" has ${n.truncated} more children beyond the inspected depth.`);
      out.children = (n.children ?? []).map((c, i) => node(c, n, `${path}.children[${i}]`)).filter(Boolean);
      return strip(out);
    }

    // Vectors and boolean shapes come back as inline SVG icons, exactly as drawn.
    if ((n.type === "VECTOR" || n.type === "BOOLEAN_OPERATION") && n.svg) return { type: "icon", ...common, svg: n.svg, width: n.w || 1, height: n.h || 1 };

    warnings.push(`${path}: ${n.type.toLowerCase().replace(/_/g, " ")} "${n.name}" can't be exported to the DSL${n.type === "VECTOR" || n.type === "BOOLEAN_OPERATION" ? " (its SVG wasn't available: inspect with format: \"plan\")" : ""}; skipped.`);
    return undefined;
  };

  const top = node(root, undefined, "screens[0]");
  if (missing.size) warnings.unshift(`${missing.size} variable(s) or text style(s) aren't in the Design System scan (${[...missing].slice(0, 5).join(", ")}${missing.size > 5 ? ", …" : ""}); their raw values are used instead. Rescan (figma_scan_design_system refresh: true) and export again to keep them bound.`);
  const plan = { version: 1, name: opts.name ?? root.name, screenGap: 80, screens: top ? [top] : [] } as unknown as DesignPlan;
  return { plan, warnings };
}

const TRIG: Record<string, string> = { ON_CLICK: "click", ON_HOVER: "hover", ON_PRESS: "press", ON_DRAG: "drag", MOUSE_ENTER: "mouse-enter", MOUSE_LEAVE: "mouse-leave", AFTER_TIMEOUT: "after-delay" };
const ACT: Record<string, string> = { NAVIGATE: "navigate", OVERLAY: "overlay", SWAP: "swap", SCROLL_TO: "scroll-to", CHANGE_TO: "change-to", BACK: "back", CLOSE: "close", URL: "url" };
const EASE: Record<string, string> = { EASE_OUT: "ease-out", EASE_IN: "ease-in", EASE_IN_AND_OUT: "ease-in-out", LINEAR: "linear", EASE_IN_BACK: "ease-in-back", EASE_OUT_BACK: "ease-out-back", GENTLE: "gentle", QUICK: "quick", BOUNCY: "bouncy", SLOW: "slow" };

/** A snapshot reaction as a DSL interaction; destinations stay Figma node ids. */
function interactionOf(r: NonNullable<NodeSnapshot["reactions"]>[number], path: string, warnings: string[]) {
  const trigger = TRIG[r.trigger ?? ""], action = ACT[r.action ?? ""];
  if (!trigger || !action) { warnings.push(`${path}: a ${r.trigger ?? "?"} → ${r.action ?? "?"} interaction can't be expressed in the DSL; skipped.`); return undefined; }
  const out: any = { trigger, action };
  if (r.delay) out.delay = Math.round(r.delay * 1000);
  if (r.to) out.to = r.to;
  if (r.url) out.url = r.url;
  if (r.transition) out.transition = { type: r.transition.type.toLowerCase().replace(/_/g, "-"), ...(r.transition.direction ? { direction: r.transition.direction.toLowerCase() } : {}), duration: r.transition.duration, easing: EASE[r.transition.easing ?? ""] ?? "ease-out" };
  return out;
}

/** Padding: a bound variable's name (from `token`) or the raw value, per side; one value when all sides agree. */
function pad(n: NodeSnapshot, token: (field: string) => string | undefined) {
  const p = n.layout?.padding;
  if (!p) return 0;
  const v = (k: "top" | "right" | "bottom" | "left", f: string) => token(f) ?? p[k];
  const out = { top: v("top", "paddingTop"), right: v("right", "paddingRight"), bottom: v("bottom", "paddingBottom"), left: v("left", "paddingLeft") };
  const vals = Object.values(out);
  return vals.every((x) => x === vals[0]) ? vals[0] : out;
}

function strip(v: any): any {
  if (Array.isArray(v)) return v.map(strip);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => [k, strip(x)]));
  return v;
}
