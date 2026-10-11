// DomNode → Design DSL. Pure and deterministic: the same DOM always gives the same plan.
//  - flex containers → Auto Layout (direction, gap, padding, alignment, wrap)
//  - evenly spaced block stacks → vertical Auto Layout
//  - anything else (grid, overlaps, inline runs) → a frame with absolutely positioned children
// Buttons, inputs, links and repeated cards are recorded as hints so a scanned Design System can
// replace them with real components (see design-system.ts).
import type { DesignPlan } from "@cde/core";
import type { DomNode, Rgba } from "./dom.ts";

export interface Hint { path: string; role: "primary-action" | "secondary-action" | "text-input" | "password-input" | "link" | "card"; label?: string; placeholder?: string; box?: { w: number; h: number } }
/** Rendered browser box of each plan node, by plan path (used to verify the Figma result against the source). */
export type SourceBoxes = Record<string, { w: number; h?: number }>;
export interface ConvertResult { plan: DesignPlan; hints: Hint[]; warnings: string[]; sources: SourceBoxes }

const MAX_CHILDREN = 200;
const round = (n: number) => Math.round(n * 100) / 100;
const hex = (c?: Rgba) => (c ? (c.a >= 1 ? c.hex : `${c.hex}${Math.round(c.a * 255).toString(16).padStart(2, "0").toUpperCase()}`) : undefined);
const WEIGHT: [number, string][] = [[100, "thin"], [200, "extralight"], [300, "light"], [400, "regular"], [500, "medium"], [600, "semibold"], [700, "bold"], [800, "extrabold"], [900, "black"]];
const weightName = (w: number) => WEIGHT.reduce((best, cur) => (Math.abs(cur[0] - w) < Math.abs(best[0] - w) ? cur : best))[1];
const luminance = (h: string) => { const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };

const isFlex = (d: DomNode) => /flex/.test(d.style.display);
const isOut = (d: DomNode) => d.style.position === "absolute" || d.style.position === "fixed";
const hasVisual = (d: DomNode) => !!(d.style.bg || d.style.gradient || d.style.bgImage?.src || d.style.border || d.style.shadows || d.style.clip || d.style.opacity !== undefined || d.style.blur || d.style.backdropBlur);
const textOnly = (d: DomNode) => d.kind === "element" && d.children.length === 1 && d.children[0].kind === "text";

/** Structure fingerprint used to spot repeated siblings (cards, list items). */
const signature = (d: DomNode, depth = 2): string => `${d.tag}(${depth ? d.children.map((c) => signature(c, depth - 1)).join(",") : ""})`;

/** The user's own mapping: elements matching `selector` become this component. In props, "$text" is the element's text. */
export interface ComponentMapping { selector: string; component: string | { id?: string; key?: string }; variant?: string | Record<string, string>; props?: Record<string, string | boolean> }

export function toPlan(screens: { name: string; width: number; dom: DomNode }[], opts: { name?: string; mappings?: ComponentMapping[]; fontMap?: Record<string, string> } = {}): ConvertResult {
  const fontMap = new Map(Object.entries(opts.fontMap ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const mapFont = (f?: string) => (f ? fontMap.get(f.toLowerCase()) ?? f : f);
  const hints: Hint[] = [];
  const warnings: string[] = [];
  const sources: SourceBoxes = {};

  const hintFor = (d: DomNode, path: string) => {
    const label = collectText(d).slice(0, 80) || d.attrs.ariaLabel;
    if (d.tag === "input" || d.tag === "textarea" || d.tag === "select") {
      if (["checkbox", "radio", "range", "file", "hidden", "submit", "button"].includes(d.attrs.type ?? "")) return;
      hints.push({ path, role: d.attrs.type === "password" ? "password-input" : "text-input", placeholder: d.attrs.placeholder, label: d.attrs.ariaLabel, box: { w: d.box.w, h: d.box.h } });
      return;
    }
    const buttonish = d.tag === "button" || d.attrs.role === "button" || (d.tag === "input" && ["submit", "button"].includes(d.attrs.type ?? ""));
    const linkButton = d.tag === "a" && (d.style.bg || d.style.border);
    if (buttonish || linkButton) {
      const dark = d.style.bg && d.style.bg.a > 0.5 && luminance(d.style.bg.hex) < 0.5;
      hints.push({ path, role: dark ? "primary-action" : "secondary-action", label, box: { w: d.box.w, h: d.box.h } });
    } else if (d.tag === "a" && label) hints.push({ path, role: "link", label, box: { w: d.box.w, h: d.box.h } });
  };

  const text = (d: DomNode, box = d.box): any => {
    const f = d.style.font!;
    const rtl = d.style.direction === "rtl";
    const alignCss = f.align === "start" ? (rtl ? "right" : "left") : f.align === "end" ? (rtl ? "left" : "right") : f.align;
    return {
      type: "text", name: d.name.slice(0, 60) || "Text", content: d.text!.slice(0, 5000),
      fontFamily: mapFont(f.family) || undefined, weight: weightName(f.weight), fontSize: round(f.size),
      // line-height: normal depends on the font's metrics, and Figma's AUTO differs from Chrome's: use the rendered one.
      lineHeight: f.lineHeight ? { unit: "px", value: round(f.lineHeight) } : d.box.h > 0 ? { unit: "px", value: round(d.box.h / Math.max(1, d.lines ?? 1)) } : undefined,
      letterSpacing: f.letterSpacing ? { unit: "px", value: round(f.letterSpacing) } : undefined,
      italic: f.italic || undefined, color: hex(f.color),
      align: ({ left: "left", right: "right", center: "center", justify: "justified" } as Record<string, string>)[alignCss] ?? (rtl ? "right" : undefined),
      direction: rtl ? "rtl" : undefined,
      runs: d.runs?.length ? toRuns(d.text!.slice(0, 5000), d.runs, f)?.map((x) => (x.fontFamily ? { ...x, fontFamily: mapFont(x.fontFamily) } : x)) : undefined,
      _box: box,
    };
  };

  /** Converts one node. `_box` is kept on the result until the parent decides sizing/position. */
  const node = (d: DomNode, path: string): any => {
    if (d.kind === "text") return text(d);
    if (d.kind === "svg") return { type: "icon", name: d.attrs.ariaLabel || d.attrs.alt || "Icon", svg: d.svg, _box: d.box };
    if (d.kind === "image") {
      let src = d.src;
      if (src && !/^(data:image\/(png|jpe?g|gif);base64,|https:\/\/)/.test(src)) { warnings.push(`${path}: image "${src.slice(0, 80)}" is not a data/https URL; placeholder used.`); src = undefined; }
      return { type: "image", name: d.attrs.ariaLabel || d.attrs.alt || "Image", src, fit: d.style.objectFit === "contain" ? "fit" : "fill", radius: d.style.radius, _box: d.box };
    }
    // The user's mappings win over everything else: the element becomes that component, with its text as props.
    if (d.kind === "element" && d.attrs.mark !== undefined && opts.mappings?.[d.attrs.mark]) {
      const m = opts.mappings[d.attrs.mark];
      const label = collectText(d).slice(0, 200);
      const props = m.props ? Object.fromEntries(Object.entries(m.props).map(([k, v]) => [k, v === "$text" ? label : v])) : label ? { label } : undefined;
      return { type: "component", name: d.name.slice(0, 120) || d.tag, component: m.component, variant: m.variant, props, _box: d.box, _mapped: true };
    }
    // Plain wrappers disappear: a text-only element becomes the text itself (with the element's box,
    // so centred/right-aligned headings stay put), and a single-child wrapper hands over its child.
    if (!hasVisual(d) && textOnly(d) && !isFlex(d) && !["button", "a", "input", "textarea", "select"].includes(d.tag)) return text({ ...d.children[0], name: d.name, style: d.style }, d.box);
    if (!hasVisual(d) && d.children.length === 1 && d.children[0].kind === "element" && !isFlex(d) && d.style.padding.every((p) => !p) && !["button", "a"].includes(d.tag)) {
      const c = d.children[0];
      return node({ ...c, box: { ...c.box, x: c.box.x + d.box.x, y: c.box.y + d.box.y } }, path);
    }
    hintFor(d, path);
    return container(d, path);
  };

  const container = (d: DomNode, path: string): any => {
    const s = d.style;
    const bw = s.border?.widths ?? [0, 0, 0, 0];
    const pad = s.padding.map((p, i) => round(p + bw[i])) as [number, number, number, number];
    const inner = { x: pad[3], y: pad[0], w: d.box.w - pad[1] - pad[3], h: d.box.h - pad[0] - pad[2] };
    let kids = d.children;
    if (kids.length > MAX_CHILDREN) { warnings.push(`${path}: ${kids.length} children; kept the first ${MAX_CHILDREN}.`); kids = kids.slice(0, MAX_CHILDREN); }
    const flow = kids.filter((k) => !isOut(k));
    const rtl = s.direction === "rtl";

    let layout: any;
    let order = kids;
    if (isFlex(d)) {
      const horizontal = (s.flexDirection ?? "row").startsWith("row");
      // Figma lays out left→right / top→bottom: order by the painted position, then let the DSL's
      // rtl flag restore logical order for right-to-left rows.
      order = [...flow].sort((a, b) => (horizontal ? a.box.x - b.box.x : a.box.y - b.box.y));
      if (horizontal && rtl) order.reverse();
      let align = ({ "flex-start": "start", start: "start", normal: "start", left: "start", center: "center", "flex-end": "end", end: "end", right: "end", "space-between": "space-between" } as Record<string, string>)[s.justify ?? "normal"] ?? "start";
      if (horizontal && rtl && (s.justify === "flex-start" || s.justify === "flex-end" || s.justify === "normal" || s.justify === "start" || s.justify === "end")) align = align === "start" ? "end" : align === "end" ? "start" : align;
      layout = {
        direction: horizontal ? "horizontal" : "vertical",
        gap: round((horizontal ? s.columnGap : s.rowGap) ?? 0), padding: padObj(pad),
        align, crossAlign: ({ center: "center", "flex-end": "end", end: "end", baseline: "baseline" } as Record<string, string>)[s.alignItems ?? ""] ?? "start",
        wrap: horizontal && s.flexWrap === "wrap" ? true : undefined,
      };
      // In a right-to-left column the cross-axis start is the right edge.
      if (!horizontal && rtl) layout.crossAlign = layout.crossAlign === "start" ? "end" : layout.crossAlign === "end" ? "start" : layout.crossAlign;
    } else if (flow.length === 1) {
      // One child (a button label, an input value): Auto Layout whose padding reproduces its exact position.
      // Absolutely positioned siblings (an overlay on an icon) are added separately, out of the flow.
      order = flow;
      const c = flow[0].box;
      const l = Math.max(0, c.x), t = Math.max(0, c.y), r = Math.max(0, d.box.w - c.x - c.w), b = Math.max(0, d.box.h - c.y - c.h);
      const centred = Math.abs(l - r) < 1;
      layout = { direction: "vertical", gap: 0, padding: padObj([round(t), round(centred ? pad[1] : r), round(b), round(centred ? pad[3] : l)]), crossAlign: centred ? "center" : rtl ? "end" : "start" };
      if (!centred) layout.padding = padObj([round(t), round(r), round(b), round(l)]);
    } else if (flow.length && stacksVertically(flow)) {
      const sorted = [...flow].sort((a, b) => a.box.y - b.box.y);
      const gaps = sorted.slice(1).map((k, i) => k.box.y - (sorted[i].box.y + sorted[i].box.h));
      const even = gaps.every((g) => Math.abs(g - (gaps[0] ?? 0)) < 1 && g > -0.5);
      const lefts = sorted.map((k) => k.box.x - inner.x), rights = sorted.map((k) => inner.w - (k.box.x - inner.x + k.box.w));
      const cross = lefts.every((l, i) => Math.abs(l) < 1 || Math.abs(l - rights[i]) < 1 || Math.abs(rights[i]) < 1);
      if (even && cross && Math.abs(sorted[0].box.y - inner.y) < 1) {
        order = sorted;
        const centred = sorted.every((k, i) => Math.abs(lefts[i] - rights[i]) < 1 && Math.abs(lefts[i]) >= 1);
        layout = { direction: "vertical", gap: round(Math.max(0, gaps[0] ?? 0)), padding: padObj(pad), crossAlign: centred ? "center" : rtl ? "end" : "start" };
      }
    }
    if (!layout) layout = { direction: "none" };

    const out: any = {
      type: "frame", name: d.name.slice(0, 120) || d.tag, layout,
      fill: hex(s.bg), image: s.bgImage?.src ? { src: s.bgImage.src, fit: s.bgImage.fit.toLowerCase() } : undefined, gradient: s.gradient && { type: s.gradient.type, angle: s.gradient.angle, stops: s.gradient.stops.map((st) => ({ color: hex(st.color)!, position: round(st.position) })) },
      blur: s.blur, backgroundBlur: s.backdropBlur,
      stroke: s.border ? hex(s.border.color) : undefined,
      ...(s.border ? (new Set(bw).size === 1 ? { strokeWeight: bw[0] } : { strokeWeights: { top: bw[0], right: bw[1], bottom: bw[2], left: bw[3] } }) : {}),
      radius: s.radius ? round(s.radius) : undefined,
      shadows: s.shadows?.map((sh) => ({ type: sh.inset ? "inner" : "drop", x: round(sh.x), y: round(sh.y), blur: round(sh.blur), spread: round(sh.spread), color: hex(sh.color)! })),
      opacity: s.opacity, clip: s.clip, direction: rtl && layout.direction === "horizontal" ? "rtl" : undefined,
      _box: d.box, children: [] as any[],
    };
    const auto = layout.direction !== "none";
    // Fixed CSS sizes: if the rendered box is bigger than its content (padding + children + gaps), the size was set
    // explicitly (width/height, min-*, flex-basis, justify-content with free space) and must stay FIXED, not hug.
    if (auto && flow.length && !layout.wrap) {
      const horiz = layout.direction === "horizontal";
      const gapTotal = (layout.gap ?? 0) * (flow.length - 1);
      const sum = (f: (k: DomNode) => number) => flow.reduce((a, k) => a + f(k), 0);
      const max = (f: (k: DomNode) => number) => Math.max(...flow.map(f));
      const contentW = pad[1] + pad[3] + (horiz ? sum((k) => k.box.w) + gapTotal : max((k) => k.box.w));
      const contentH = pad[0] + pad[2] + (horiz ? max((k) => k.box.h) : sum((k) => k.box.h) + gapTotal);
      out._fixedW = d.box.w - contentW > 1;
      out._fixedH = d.box.h - contentH > 1;
      // Children that stretch across it (full-width blocks in a column, flex-grow items in a row) take their size
      // from the container, so its width isn't "just its content": keep it fixed, or they'd have nothing to fill.
      const innerW = d.box.w - pad[1] - pad[3];
      // A single line of text (on its own or as a text-only element) is the exception: it may set the width itself.
      // (Only a plain text wrapper: a styled box with a letter in it, like a step circle, has its own size.)
      const singleLine = (k: DomNode) => (k.kind === "text" && (k.lines ?? 1) <= 1) || (textOnly(k) && !hasVisual(k) && (k.children[0].lines ?? 1) <= 1);
      if (horiz ? flow.some((k) => (k.style.flexGrow ?? 0) > 0) : flow.some((k) => Math.abs(k.box.w - innerW) < 1 && !singleLine(k))) out._fixedW = true;
    }
    const children: any[] = [];
    // Repeated siblings with the same structure and a visual container read as cards.
    const sigs = new Map<string, number>();
    for (const k of order) if (k.kind === "element" && hasVisual(k)) sigs.set(signature(k), (sigs.get(signature(k)) ?? 0) + 1);
    const pushChild = (k: DomNode, i: number, absolute: boolean) => {
      const p = `${path}.children[${children.length}]`;
      const c = node(k, p);
      if (!c) return;
      // Texts too: they aren't reported (font metrics), but a text that grew explains the containers around it.
      if (c._box) sources[p] = { w: round(c._box.w), h: round(c._box.h) };
      if (k.kind === "element" && hasVisual(k) && k.children.length >= 2 && (sigs.get(signature(k)) ?? 0) >= 3 && c.type === "frame") {
        if (/^(div|li|article|section)$/.test(c.name)) c.name = "Card";
        hints.push({ path: p, role: "card", label: collectText(k).slice(0, 60) });
      }
      place(c, k, { auto, horizontal: layout.direction === "horizontal", inner, absolute, stretch: s.alignItems === "stretch" || s.alignItems === "normal", crossFixed: layout.direction === "horizontal" ? !!out._fixedH : !!out._fixedW });
      children.push(c);
    };
    // Paint order: absolutely positioned layers that come before the flow in the HTML (a stepper's connector line,
    // a background shape) sit behind it, the rest on top. Figma paints later layers over earlier ones.
    const firstFlow = kids.findIndex((k) => !isOut(k));
    const behind = auto ? kids.filter((k, i) => isOut(k) && (firstFlow < 0 || i < firstFlow) && !(Number(k.style.zIndex) > 0)) : [];
    behind.forEach((k, i) => pushChild(k, i, true));
    order.forEach((k, i) => pushChild(k, i, !auto));
    if (auto) kids.filter((k) => isOut(k) && !behind.includes(k)).forEach((k, i) => pushChild(k, i, true));
    out.children = children;
    // A single line of text inside a container (buttons, links, chips, tags): container and label hug,
    // like a real Figma button. Fixed browser widths would wrap the label on tiny font metric differences.
    const only = children.length === 1 ? children[0] : undefined;
    const onlyDom = order.length === 1 ? order[0] : undefined;
    if (auto && only?.type === "text" && !only.position && onlyDom && (onlyDom.lines ?? 1) <= 1) { only.width = "hug"; out._hugText = !out._fixedW; }
    if (!auto) { out.width = round(d.box.w); out.height = round(d.box.h); }
    return out;
  };

  /** Size and position a converted child inside its parent. */
  const place = (c: any, k: DomNode, p: { auto: boolean; horizontal: boolean; inner: { x: number; y: number; w: number; h: number }; absolute: boolean; stretch: boolean; crossFixed?: boolean }) => {
    const b = c._box as { x: number; y: number; w: number; h: number };
    delete c._box;
    const hugText = !!c._hugText;
    const fixedH = !!c._fixedH, fixedW = !!c._fixedW;
    delete c._hugText; delete c._fixedW; delete c._fixedH;
    if (c._mapped) {
      delete c._mapped;
      if (p.absolute || !p.auto) c.position = { type: "absolute", x: round(b.x), y: round(b.y) };
      else if (!p.horizontal && Math.abs(b.w - p.inner.w) < 1) c.width = "fill";
      else if (p.horizontal && (k.style.flexGrow ?? 0) > 0) c.width = "fill";
      return;
    }
    const w = round(Math.max(1, b.w)), h = round(Math.max(1, b.h));
    // An Auto Layout frame hugs its content unless its CSS height was bigger than the content.
    const autoH = (c.type === "frame" && c.layout?.direction && c.layout.direction !== "none") ? (fixedH ? h : "hug") : h;
    if (p.absolute || !p.auto) {
      c.position = { type: "absolute", x: round(b.x), y: round(b.y) };
      if (hugText) { c.width = "hug"; c.height = autoH; return; }
      c.width = c.type === "text" && (k.lines ?? 1) <= 1 && c.align !== "center" && c.align !== "right" ? "hug" : w;
      if (c.type !== "text") c.height = autoH;
      return;
    }
    const fullMain = p.horizontal ? false : Math.abs(b.w - p.inner.w) < 1;
    const oneLine = c.type === "text" && (k.lines ?? 1) <= 1;
    // A frame whose CSS width was just its content hugs, so a wider fallback font widens it instead of wrapping.
    const contentWidth = c.type === "frame" && c.layout?.direction !== "none" && !fixedW;
    if (p.horizontal) {
      c.width = (k.style.flexGrow ?? 0) > 0 ? "fill" : hugText || oneLine || contentWidth ? "hug" : w;
      // Stretching to the row's height: fine in a fixed-height row, or for a child with a height of its own
      // (content in Auto Layout). An empty frame in a hugging row has nothing to size it (Figma leaves it at its
      // default 100px), so it keeps the rendered height.
      const ownHeight = c.type !== "frame" || (c.layout?.direction !== "none" && (c.children?.length ?? 0) > 0);
      if (c.type !== "text") c.height = p.stretch && (p.crossFixed || ownHeight) && Math.abs(b.h - p.inner.h) < 1 ? "fill" : autoH;
    } else {
      // A single line spanning a column only fills it when the column's width is fixed; otherwise it hugs (the
      // column's cross alignment keeps it on the right side in RTL), so it can't wrap on a wider fallback font.
      c.width = fullMain && !(oneLine && !p.crossFixed) ? "fill" : hugText || oneLine ? "hug" : w;
      if (c.type !== "text") c.height = autoH;
    }
  };

  const plan: DesignPlan = {
    version: 1, name: opts.name ?? "HTML import", screenGap: 120,
    screens: screens.map((sc, i) => {
      const f = container(sc.dom, `screens[${i}]`);
      // A page is at least as tall as the viewport, but the screen hugs its content: compare the width only.
      sources[`screens[${i}]`] = { w: sc.width };
      delete f._box; delete f._hugText; delete f._fixedW; delete f._fixedH;
      return { ...f, type: "screen", name: sc.name, width: sc.width, height: f.layout.direction === "none" ? f.height : undefined, fill: f.fill ?? "#FFFFFF" };
    }),
  } as DesignPlan;
  return { plan: strip(plan) as DesignPlan, hints, warnings, sources };
}

/** DOM runs → DSL runs covering the whole text; each carries only what differs from the text's own font. */
function toRuns(text: string, runs: NonNullable<DomNode["runs"]>, base: NonNullable<DomNode["style"]["font"]>) {
  const out: any[] = [];
  let at = 0;
  const plain = (end: number) => { if (end > at) out.push({ text: text.slice(at, end) }); at = Math.max(at, end); };
  for (const r of [...runs].sort((a, b) => a.start - b.start)) {
    if (r.start < at || r.end > text.length) continue;
    plain(r.start);
    const f = r.font, piece: any = { text: text.slice(r.start, r.end) };
    if (f.weight !== base.weight) piece.weight = weightName(f.weight);
    if (f.italic !== base.italic) piece.italic = f.italic;
    if (f.family && f.family !== base.family) piece.fontFamily = f.family;
    if (Math.abs(f.size - base.size) > 0.01) piece.fontSize = round(f.size);
    if (f.color && hex(f.color) !== hex(base.color)) piece.color = hex(f.color);
    if (r.href && /^https?:/.test(r.href)) piece.href = r.href;
    out.push(piece);
    at = r.end;
  }
  plain(text.length);
  // Nothing styled differently: a plain text is simpler.
  return out.some((x) => Object.keys(x).length > 1) ? out : undefined;
}

function padObj(p: [number, number, number, number]) {
  return p.every((x) => x === p[0]) ? p[0] : { top: p[0], right: p[1], bottom: p[2], left: p[3] };
}

function stacksVertically(kids: DomNode[]) {
  const s = [...kids].sort((a, b) => a.box.y - b.box.y);
  return s.every((k, i) => i === 0 || k.box.y >= s[i - 1].box.y + s[i - 1].box.h - 0.5);
}

function collectText(d: DomNode): string {
  return d.kind === "text" ? d.text ?? "" : d.children.map(collectText).filter(Boolean).join(" ").trim();
}

/** Drop undefined values so plans (and snapshots) stay small and stable. */
function strip(v: any): any {
  if (Array.isArray(v)) return v.map(strip);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => [k, strip(x)]));
  return v;
}
