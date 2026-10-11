// Reads the rendered DOM into a plain, layout-aware tree (DomNode). Runs in the page; convert.ts
// turns it into the Design DSL. Everything here is computed style + boxes, so it is deterministic.
// Pictures (<img>, CSS backgrounds and masks) are loaded afterwards, in Node (assets.ts).
import type { Page } from "playwright-core";
import { assetName, fitSvg, loadAssets, needsLoading, svgPng } from "./assets.ts";
import { installHelpers } from "./page.ts";

export interface Rgba { hex: string; a: number }
export interface DomBox { x: number; y: number; w: number; h: number }
export interface DomStyle {
  display: string; position: string; zIndex?: string; direction: "ltr" | "rtl";
  flexDirection?: string; flexWrap?: string; justify?: string; alignItems?: string; alignSelf?: string; flexGrow?: number;
  rowGap?: number; columnGap?: number; padding: [number, number, number, number];
  bg?: Rgba; gradient?: { type: "linear" | "radial" | "angular"; angle: number; stops: { color: Rgba; position: number }[] };
  blur?: number; backdropBlur?: number;
  border?: { widths: [number, number, number, number]; color: Rgba };
  radius?: number; shadows?: { inset: boolean; x: number; y: number; blur: number; spread: number; color: Rgba }[];
  opacity?: number; clip?: boolean;
  font?: { family: string; weight: number; size: number; lineHeight?: number; letterSpacing?: number; italic: boolean; color?: Rgba; align: string; transform?: string };
  objectFit?: string;
  /** A CSS background picture (`src` once loaded), and a CSS mask (an icon in the element's colour). */
  bgImage?: { url: string; fit: "FILL" | "FIT" | "TILE"; src?: string }; mask?: string;
}
export interface DomNode {
  kind: "element" | "text" | "svg" | "image";
  tag: string; name: string; box: DomBox; style: DomStyle;
  text?: string; lines?: number; svg?: string; src?: string;
  /** Styled pieces of one text (inline <b>, <span>, <a>): offsets into `text` with the piece's own font. */
  runs?: { start: number; end: number; font: NonNullable<DomStyle["font"]>; href?: string }[];
  attrs: { role?: string; type?: string; placeholder?: string; value?: string; ariaLabel?: string; alt?: string; href?: string; id?: string; testid?: string; mark?: number };
  children: DomNode[];
}

export interface DomRead { root: DomNode; webFonts: Record<string, string[]>; warnings: string[] }

/** Read the rendered DOM. Elements matching `marks[i]` carry `attrs.mark = i` (user component mappings). */
export async function readDom(page: Page, selector = "body", marks: string[] = []): Promise<DomNode> {
  return (await readPage(page, selector, marks)).root;
}

export async function readPage(page: Page, selector = "body", marks: string[] = []): Promise<DomRead> {
  await installHelpers(page);
  const res = await page.evaluate(SERIALIZE_DOM, { selector, marks });
  if ("error" in res) throw new Error(res.error);
  if (!res.root) throw new Error(`Nothing rendered for "${selector}".`);
  const read = res as DomRead;
  read.warnings = [...read.warnings, ...(await loadPictures(page, read.root))];
  return read;
}

/** Loads the pictures and puts them in the tree: an SVG becomes a vector (a mask's in the element's colour), anything
 *  else PNG/JPEG/GIF data. A background SVG under other content is drawn as a PNG. */
async function loadPictures(page: Page, root: DomNode): Promise<string[]> {
  const all: DomNode[] = [];
  const visit = (d: DomNode) => { all.push(d); d.children.forEach(visit); };
  visit(root);
  const urls = all.flatMap((d) => [d.kind === "image" && needsLoading(d.src) ? d.src! : "", d.kind === "element" ? d.style.bgImage?.url ?? "" : "", d.kind === "element" ? d.style.mask ?? "" : ""]).filter(Boolean);
  if (!urls.length) return [];
  const loaded = await loadAssets(page, urls);
  const warnings: string[] = [];
  for (const d of all) {
    const { w, h } = d.box;
    if (d.kind === "image" && d.src && loaded.has(d.src)) {
      const l = loaded.get(d.src)!;
      const svg = "svg" in l ? await fitSvg(page, l.svg, w, h) : undefined;
      if (svg) Object.assign(d, { kind: "svg", svg, src: undefined });
      else if ("src" in l) d.src = l.src;
      else { warnings.push(`The picture ${assetName(d.src)} couldn't be loaded (${"error" in l ? l.error : "not a valid SVG"}); a placeholder is used.`); d.src = undefined; }
    }
    if (d.kind !== "element") continue;
    const mask = d.style.mask, l = mask && loaded.get(mask);
    if (mask && l) {
      const hex = d.style.bg?.hex ?? d.style.gradient?.stops[0]?.color.hex ?? d.style.font?.color?.hex;
      const svg = "svg" in l ? await fitSvg(page, l.svg, w, h, hex) : undefined;
      if (svg) { Object.assign(d, { kind: "svg", svg, children: [] }); continue; }
      warnings.push(`"${d.name}" is drawn with a CSS mask that isn't an SVG (${assetName(mask)}); it's imported as a plain box.`);
    }
    const bg = d.style.bgImage, b = bg && loaded.get(bg.url);
    if (!bg || !b) continue;
    if ("svg" in b && !d.children.length && !d.style.bg && !d.style.border) {
      // An icon drawn as a background: a vector.
      const svg = await fitSvg(page, b.svg, w, h);
      if (svg) { Object.assign(d, { kind: "svg", svg }); continue; }
    }
    const src = "src" in b ? b.src : "svg" in b ? await svgPng(page, b.svg, w * 2, h * 2) : undefined;
    if (src) bg.src = src;
    else { warnings.push(`The background picture ${assetName(bg.url)} of "${d.name}" couldn't be loaded (${"error" in b ? b.error : "not a valid SVG"}); left out.`); d.style.bgImage = undefined; }
  }
  return warnings;
}

const SERIALIZE_DOM = ({ selector, marks }: { selector: string; marks: string[] }): any => {
  for (const m of marks) { try { document.querySelector(m); } catch { return { error: `Invalid CSS selector in mappings: "${m}"` }; } }
  const px = (v: string) => parseFloat(v) || 0;
  // Any CSS colour (oklch, lab, hsl, color(), …) → sRGB, by painting one pixel. Claude Design exports use oklch.
  const colorCanvas = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
  const converted = new Map<string, string | undefined>();
  const toRgbString = (c: string): string | undefined => {
    if (!converted.has(c)) {
      colorCanvas.clearRect(0, 0, 1, 1);
      colorCanvas.fillStyle = "rgba(0,0,0,0)"; colorCanvas.fillStyle = c;
      colorCanvas.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = colorCanvas.getImageData(0, 0, 1, 1).data;
      converted.set(c, a ? `rgba(${r}, ${g}, ${b}, ${Math.round((a / 255) * 1000) / 1000})` : undefined);
    }
    return converted.get(c);
  };
  const COLOR_FN = /(?:rgba?|oklch|oklab|lab|lch|hsla?|hwb|color)\([^()]*(?:\([^()]*\)[^()]*)*\)/;
  const rgba = (v0: string, clear = false) => {
    let v = v0;
    if (!/^\s*rgba?\(/.test(v)) { const fn = v.match(COLOR_FN); if (!fn) return undefined; v = toRgbString(fn[0]) ?? ""; }
    const m = v.match(/rgba?\(([^)]+)\)/);
    if (!m) return undefined;
    const [r, g, b, a = "1"] = m[1].split(/[ ,/]+/).filter(Boolean);
    const al = parseFloat(a);
    if (!(al > 0) && !(clear && al === 0)) return undefined;
    const h = (n: string) => Math.max(0, Math.min(255, Math.round(+n))).toString(16).padStart(2, "0");
    return { hex: `#${h(r)}${h(g)}${h(b)}`.toUpperCase(), a: Math.round(al * 1000) / 1000 };
  };
  const splitTop = (s: string) => { const out: string[] = []; let d = 0, cur = ""; for (const ch of s) { if (ch === "(") d++; if (ch === ")") d--; if (ch === "," && !d) { out.push(cur.trim()); cur = ""; } else cur += ch; } if (cur.trim()) out.push(cur.trim()); return out; };
  // (tree.ts parses gradients the same way for the pixel-faithful importer; both run inside the page.)
  const gradient = (bg0: string) => {
    const bg = splitTop(bg0)[0] ?? ""; // the top layer when there are several backgrounds
    const m = bg.match(/^(linear|radial|conic)-gradient\((.*)\)$/);
    if (!m) return undefined;
    const kind = m[1] === "radial" ? "radial" : m[1] === "conic" ? "angular" : "linear";
    const parts = splitTop(m[2]);
    let angle = 180;
    if (kind === "linear") {
      if (/deg$/.test(parts[0])) angle = parseFloat(parts.shift()!);
      else if (/^to /.test(parts[0])) angle = ({ "to top": 0, "to right": 90, "to bottom": 180, "to left": 270 } as Record<string, number>)[parts.shift()!] ?? 180;
    } else if (parts[0] && !COLOR_FN.test(parts[0]) && !/^(transparent|currentcolor)\b/i.test(parts[0])) {
      // "circle at center", "from 90deg at 50% 50%": the shape/position part (a conic's start angle is kept).
      const from = parts.shift()!.match(/from\s+(-?[\d.]+)deg/);
      angle = from ? parseFloat(from[1]) : 0;
    }
    const raw = parts.map((p, i) => {
      const cm = p.match(COLOR_FN); const color = cm ? rgba(cm[0], true) : undefined;
      const pos = p.replace(cm?.[0] ?? "", "").match(/([\d.]+)%/);
      return color && { color, position: pos ? +pos[1] / 100 : i / Math.max(1, parts.length - 1) };
    }).filter(Boolean) as { color: Rgba; position: number }[];
    // CSS fades to "transparent" premultiplied: a clear stop takes its neighbours' colours (two stops when both sides
    // have one), or Figma would fade through grey.
    const stops = raw.flatMap((st, i) => {
      if (st.color.a) return [st];
      const prev = raw.slice(0, i).reverse().find((x) => x.color.a), next = raw.slice(i + 1).find((x) => x.color.a);
      return [prev, next].filter(Boolean).map((n) => ({ ...st, color: { hex: n!.color.hex, a: 0 } }));
    });
    return stops.length >= 2 && stops.some((x) => x.color.a) ? { type: kind, angle, stops } : undefined;
  };
  const blurOf = (f: string) => { const m = f && f !== "none" ? f.match(/blur\(([\d.]+)px\)/) : null; return m ? parseFloat(m[1]) || undefined : undefined; };
  const shadows = (v: string) => {
    if (!v || v === "none") return undefined;
    const out = splitTop(v).map((s) => {
      const cm = s.match(COLOR_FN); const color = cm ? rgba(cm[0]) : undefined;
      const n = s.replace(cm?.[0] ?? "", "").replace("inset", "").trim().split(/\s+/).map(px);
      return color && { inset: /inset/.test(s), x: n[0] || 0, y: n[1] || 0, blur: n[2] || 0, spread: n[3] || 0, color };
    }).filter(Boolean);
    return out.length ? out : undefined;
  };
  const family = (f: string) => f.split(",")[0].replace(/["']/g, "").trim();
  const nameOf = (el: Element) => el.getAttribute("aria-label") || el.getAttribute("data-name") || (el.id ? `#${el.id}` : "") || (typeof el.className === "string" && el.className.trim() ? `.${el.className.trim().split(/\s+/)[0]}` : "") || el.tagName.toLowerCase();

  const styleOf = (el: Element, cs: CSSStyleDeclaration) => {
    const bw = (["Top", "Right", "Bottom", "Left"] as const).map((s) => ((cs as any)[`border${s}Style`] !== "none" ? px((cs as any)[`border${s}Width`]) : 0)) as [number, number, number, number];
    const sideColors = [cs.borderTopColor, cs.borderRightColor, cs.borderBottomColor, cs.borderLeftColor];
    const bc = rgba(sideColors[bw.findIndex((w) => w > 0)] ?? "");
    const radius = Math.max(px(cs.borderTopLeftRadius), px(cs.borderTopRightRadius), px(cs.borderBottomRightRadius), px(cs.borderBottomLeftRadius));
    return {
      display: cs.display, position: cs.position, zIndex: cs.zIndex === "auto" ? undefined : cs.zIndex, direction: cs.direction === "rtl" ? "rtl" : "ltr",
      flexDirection: cs.flexDirection, flexWrap: cs.flexWrap, justify: cs.justifyContent, alignItems: cs.alignItems, alignSelf: cs.alignSelf, flexGrow: px(cs.flexGrow) || undefined,
      rowGap: px(cs.rowGap) || undefined, columnGap: px(cs.columnGap) || undefined,
      padding: [px(cs.paddingTop), px(cs.paddingRight), px(cs.paddingBottom), px(cs.paddingLeft)],
      bg: rgba(cs.backgroundColor), gradient: gradient(cs.backgroundImage),
      border: bw.some(Boolean) && bc ? { widths: bw, color: bc } : undefined,
      radius: radius || undefined, shadows: shadows(cs.boxShadow),
      blur: blurOf(cs.filter), backdropBlur: blurOf((cs as unknown as Record<string, string>).backdropFilter ?? (cs as unknown as Record<string, string>).webkitBackdropFilter),
      opacity: +cs.opacity < 1 ? +cs.opacity : undefined, clip: cs.overflow === "hidden" || cs.overflowX === "hidden" || undefined,
      font: {
        family: family(cs.fontFamily), weight: +cs.fontWeight || 400, size: px(cs.fontSize),
        lineHeight: cs.lineHeight === "normal" ? undefined : px(cs.lineHeight), letterSpacing: px(cs.letterSpacing) || undefined,
        italic: cs.fontStyle === "italic", color: rgba(cs.color), align: cs.textAlign, transform: cs.textTransform !== "none" ? cs.textTransform : undefined,
      },
      objectFit: el.tagName === "IMG" ? cs.objectFit : undefined,
    };
  };

  const attrs = (el: Element) => ({
    role: el.getAttribute("role") ?? undefined, type: el.getAttribute("type") ?? undefined,
    placeholder: el.getAttribute("placeholder") ?? undefined, value: (el as HTMLInputElement).value || undefined,
    ariaLabel: el.getAttribute("aria-label") ?? undefined, alt: el.getAttribute("alt") || undefined, href: el.getAttribute("href") ?? undefined,
    id: el.id || undefined, testid: el.getAttribute("data-testid") ?? undefined,
    mark: (() => { const i = marks.findIndex((m) => el.matches(m)); return i >= 0 ? i : undefined; })(),
  });

  const lw = (window as any).__lw; // page.ts: SVG, pictures, icon fonts

  // Lines of a text range. Pieces in different fonts on one line have slightly different tops, so counting
  // distinct tops over-counts.
  const lineCount = (range: Range) => {
    const rects = [...range.getClientRects()].filter((q) => q.width > 0).sort((a, b) => a.top - b.top);
    // A new line starts more than half a line below the current one (tight line heights make boxes overlap).
    let lines = 0, top = -Infinity, height = 0;
    for (const q of rects) { if (q.top > top + height / 2) { lines++; top = q.top; height = q.height; } }
    return lines || 1;
  };

  const textChild = (n: Node, cs: CSSStyleDeclaration, ox: number, oy: number, style?: any): any => {
    const raw = n.textContent ?? "";
    if (!raw.trim()) return null;
    const range = document.createRange(); range.selectNodeContents(n);
    const tr = range.getBoundingClientRect();
    if (!tr.width) return null;
    let text = raw.replace(/\s+/g, " ").trim();
    if (cs.textTransform === "uppercase") text = text.toUpperCase();
    else if (cs.textTransform === "lowercase") text = text.toLowerCase();
    const parent = n.parentElement!;
    return { kind: "text", tag: "#text", name: text.slice(0, 40), box: { x: tr.left - ox, y: tr.top - oy, w: tr.width, h: tr.height }, style: style ?? styleOf(parent, cs), text, lines: lineCount(range), attrs: {}, children: [] };
  };

  // Inline formatting: text mixed with plain inline elements (<b>, <span>, <a>, <br>; no box of their own) is one
  // paragraph in the browser, so it becomes one text with styled runs instead of many positioned text layers.
  const plainInline = (e: Element): boolean => {
    const c = getComputedStyle(e);
    if (c.display !== "inline" || ["svg", "img", "input", "textarea", "select", "button"].includes(e.tagName.toLowerCase())) return false;
    const box = rgba(c.backgroundColor) || [c.borderTopStyle, c.borderRightStyle, c.borderBottomStyle, c.borderLeftStyle].some((b) => b !== "none")
      || [c.paddingLeft, c.paddingRight, c.paddingTop, c.paddingBottom].some((v) => px(v) > 0) || c.backgroundImage !== "none" || c.boxShadow !== "none";
    return !box && [...e.children].every((k) => k.tagName.toLowerCase() === "br" || plainInline(k));
  };
  const inlineRuns = (el: Element, cs: CSSStyleDeclaration, r: DOMRect): any => {
    const kids = [...el.childNodes];
    const elems = kids.filter((n) => n.nodeType === 1) as Element[];
    if (!elems.length || !elems.every((k) => k.tagName.toLowerCase() === "br" || plainInline(k))) return null;
    if (!kids.some((n) => n.nodeType === 3 && n.textContent!.trim()) && elems.length < 2) return null;
    // Walk the text in order, collapsing whitespace across piece boundaries like the browser does.
    const pieces: { text: string; el: Element }[] = [];
    const visit = (n: Node, owner: Element) => {
      if (n.nodeType === 3) pieces.push({ text: n.textContent ?? "", el: owner });
      else if (n.nodeType === 1) { const e = n as Element; if (e.tagName.toLowerCase() === "br") pieces.push({ text: "\n", el: owner }); else e.childNodes.forEach((k) => visit(k, e)); }
    };
    kids.forEach((k) => visit(k, el));
    let text = "";
    const runs: any[] = [];
    for (const pc of pieces) {
      const ps = getComputedStyle(pc.el);
      let t = pc.text === "\n" ? "\n" : pc.text.replace(/\s+/g, " ");
      if (t !== "\n" && (text === "" || /[ \n]$/.test(text))) t = t.replace(/^ /, "");
      if (ps.textTransform === "uppercase") t = t.toUpperCase(); else if (ps.textTransform === "lowercase") t = t.toLowerCase();
      if (!t) continue;
      const start = text.length;
      text += t;
      if (pc.el !== el) runs.push({ start, end: text.length, font: styleOf(pc.el, ps).font, href: pc.el.closest("a")?.getAttribute("href") ?? undefined });
    }
    const trimmed = text.replace(/ +$/, "");
    if (!trimmed.trim()) return null;
    const range = document.createRange(); range.selectNodeContents(el);
    const tr = range.getBoundingClientRect();
    const lines = lineCount(range);
    return { kind: "text", tag: "#text", name: trimmed.slice(0, 40), box: { x: tr.left - r.left, y: tr.top - r.top, w: tr.width, h: tr.height }, style: styleOf(el, cs), text: trimmed,
      lines, runs: runs.map((x) => ({ ...x, end: Math.min(x.end, trimmed.length) })).filter((x) => x.end > x.start), attrs: {}, children: [] };
  };

  const walk = (el: Element, ox: number, oy: number): any => {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || +cs.opacity === 0) return null;
    // display: contents generates no box (its rect is 0×0 at the page origin): its children belong to the parent.
    if (cs.display === "contents") {
      const lifted: any[] = [];
      for (const n of el.childNodes) {
        if (n.nodeType === 3) { const t = textChild(n, cs, ox, oy); if (t) lifted.push(t); }
        else if (n.nodeType === 1) { const c = walk(n as Element, ox, oy); if (c) lifted.push(...(c.kind === "contents" ? c.children : [c])); }
      }
      return { kind: "contents", children: lifted };
    }
    const r = el.getBoundingClientRect();
    const tag = el.tagName.toLowerCase();
    if (["script", "style", "template", "noscript", "head", "meta", "link"].includes(tag)) return null;
    if ((r.width < 0.5 || r.height < 0.5) && cs.overflow !== "visible") return null;
    const box = { x: r.left - ox, y: r.top - oy, w: r.width, h: r.height };
    const base = { tag, name: nameOf(el), box, style: styleOf(el, cs), attrs: attrs(el), children: [] as any[] };
    if (tag === "svg") return { ...base, kind: "svg", svg: lw.svgMarkup(el) };
    // Pictures by their address; readPage loads them (Node, then the plugin gets only data).
    if (tag === "img") return { ...base, kind: "image", src: lw.imgSrc(el) };
    if (tag === "canvas") { const src = lw.canvasPng(el); if (src) return { ...base, kind: "image", src }; }
    const pics = lw.pictures(el, cs);
    if (pics.bg) (base.style as DomStyle).bgImage = pics.bg;
    if (pics.mask) (base.style as DomStyle).mask = pics.mask;
    if (["input", "textarea", "select"].includes(tag)) {
      const i = el as HTMLInputElement;
      const shown = i.value || i.placeholder || (tag === "select" ? (el as HTMLSelectElement).selectedOptions[0]?.text : "") || "";
      if (shown) base.children.push({ kind: "text", tag: "#text", name: shown.slice(0, 40), box: (() => { const lh = cs.lineHeight === "normal" ? px(cs.fontSize) * 1.25 : px(cs.lineHeight); const bl = px(cs.borderLeftWidth), br = px(cs.borderRightWidth); return { x: px(cs.paddingLeft) + bl, y: Math.max(0, (r.height - lh) / 2), w: Math.max(1, r.width - px(cs.paddingLeft) - px(cs.paddingRight) - bl - br), h: lh }; })(), style: { ...base.style, font: { ...base.style.font, color: i.value ? base.style.font.color : rgba(getComputedStyle(el, "::placeholder").color) ?? base.style.font.color } }, text: shown, lines: 1, attrs: {}, children: [] });
      return { ...base, kind: "element" };
    }
    // An icon-font icon: a picture of the glyph (Figma would show a box or the ligature's word).
    const glyph = lw.glyphIcon(el, base.name);
    if (glyph) return { ...base, kind: "image", src: glyph, attrs: { ...base.attrs, alt: base.attrs.ariaLabel || "Icon" }, children: [] };
    const merged = inlineRuns(el, cs, r);
    if (merged) { base.children.push(merged); return { ...base, kind: "element" }; }
    for (const n of el.childNodes) {
      if (n.nodeType === 3) {
        const t = textChild(n, cs, r.left, r.top, base.style);
        if (t) base.children.push(t);
      } else if (n.nodeType === 1) {
        const c = walk(n as Element, r.left, r.top);
        if (c) base.children.push(...(c.kind === "contents" ? c.children : [c]));
      }
    }
    return { ...base, kind: "element" };
  };

  // Web fonts by family, with the formats the page ships (Figma can only use fonts installed as TTF/OTF).
  const webFonts: Record<string, string[]> = {};
  for (const sheet of [...document.styleSheets]) {
    let rules: CSSRuleList;
    try { rules = sheet.cssRules; } catch { continue; } // cross-origin stylesheet
    for (const rule of [...rules]) {
      if (!(rule instanceof CSSFontFaceRule)) continue;
      const fam = rule.style.getPropertyValue("font-family").replace(/["']/g, "").trim();
      const src = rule.style.getPropertyValue("src");
      const formats = [...src.matchAll(/\.(woff2|woff|ttf|otf)\b|format\(["']?(woff2|woff|truetype|opentype)/g)].map((m) => (m[1] ?? m[2]).replace("truetype", "ttf").replace("opentype", "otf"));
      if (fam) webFonts[fam] = [...new Set([...(webFonts[fam] ?? []), ...formats])];
    }
  }
  const el = document.querySelector(selector);
  if (!el) return { root: null, webFonts, warnings: lw.warnings };
  const r = el.getBoundingClientRect();
  let root = walk(el, r.left, r.top);
  if (root?.kind === "contents") root = null;
  // The page body is at least as tall as the document; an element keeps its own box.
  if (root) { root.box.x = 0; root.box.y = 0; if (el === document.body) root.box.h = Math.max(root.box.h, document.documentElement.scrollHeight); }
  return { root, webFonts, warnings: lw.warnings };
};
