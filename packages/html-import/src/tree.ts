// HTML → Figma node tree (pixel-faithful, absolute layers; used by figma_import_html). Renders a prototype in headless Chrome and serializes what the browser
// actually painted (boxes, computed styles, text runs, inline SVG, pictures). No model tokens are spent on layout.
import type { Page } from "playwright-core";
import type { ImportNode } from "@cde/core";
import { assetName, fitSvg, loadAssets, needsLoading, svgPng } from "./assets.ts";
import { withPage } from "./browser.ts";
import { installHelpers } from "./page.ts";

export interface ImportTarget { selector: string; name?: string; index?: number }
/** Replace matching elements with instances of an existing component. Variant = first rule whose test matches
 *  (a CSS selector inside the element, or "text:<substring>"); otherwise `default`. */
export interface ImportSwap { selector: string; component: string; id?: string; key?: string; variants?: { test: string; variant: string }[]; default?: string; overrides?: "none" | "text" | "match"; fills?: boolean }
export interface ImportAction { click: string; index?: number; waitMs?: number }
export interface ImportedScreen { name: string; width: number; height: number; tree: ImportNode; nodeCount: number;
  /** What couldn't be imported as it looks (a picture that didn't load, an icon-font icon beside text). */
  warnings: string[] }

export async function importHtml(opts: { file: string; root?: string; targets?: ImportTarget[]; swaps?: ImportSwap[]; actions?: ImportAction[]; viewport?: number; waitMs?: number }): Promise<ImportedScreen[]> {
  return withPage(opts.file, { root: opts.root, width: opts.viewport ?? 2400, height: 1200, waitMs: opts.waitMs ?? 1500 }, async (page) => {
    for (const a of opts.actions ?? []) {
      await page.locator(a.click).nth(a.index ?? 0).click();
      await page.waitForTimeout(a.waitMs ?? 300);
    }
    await installHelpers(page);
    const { screens, warnings } = (await page.evaluate(SERIALIZE, { targets: opts.targets ?? null, swaps: opts.swaps ?? [] })) as { screens: ImportedScreen[]; warnings: string[] };
    for (const [i, sc] of screens.entries()) sc.warnings = [...(i ? [] : warnings), ...(await loadPictures(page, sc.tree))];
    return screens;
  });
}

/** Loads the pictures and puts them in the tree: an SVG becomes a vector (a mask's in the element's colour), anything
 *  else PNG/JPEG/GIF data; a background SVG under other content is drawn as a PNG. */
async function loadPictures(page: Page, root: any): Promise<string[]> {
  const all: any[] = [];
  const visit = (n: any) => { all.push(n); (n.children ?? []).forEach(visit); };
  visit(root);
  const urls = all.flatMap((n) => [n.type === "image" && needsLoading(n.src) ? n.src : "", n.image?.url ?? "", n.mask ?? ""]).filter(Boolean);
  if (!urls.length) return [];
  const loaded = await loadAssets(page, urls);
  const warnings: string[] = [];
  const toSvg = (n: any, svg: string) => { for (const k of Object.keys(n)) if (!["name", "x", "y", "w", "h"].includes(k)) delete n[k]; Object.assign(n, { type: "svg", svg }); };
  for (const n of all) {
    if (n.type === "image" && n.src && loaded.has(n.src)) {
      const l = loaded.get(n.src)!;
      const svg = "svg" in l ? await fitSvg(page, l.svg, n.w, n.h) : undefined;
      if (svg) toSvg(n, svg);
      else if ("src" in l) n.src = l.src;
      else { warnings.push(`The picture ${assetName(n.src)} couldn't be loaded (${"error" in l ? l.error : "not a valid SVG"}); a placeholder is used.`); delete n.src; }
      continue;
    }
    if (n.mask) {
      const l = loaded.get(n.mask)!, hex = n.fill?.hex ?? n.gradient?.stops?.[0]?.hex ?? n.maskColor;
      const svg = "svg" in l ? await fitSvg(page, l.svg, n.w, n.h, hex) : undefined;
      if (svg) { toSvg(n, svg); continue; }
      warnings.push(`"${n.name}" is drawn with a CSS mask that isn't an SVG (${assetName(n.mask)}); it's imported as a plain box.`);
      delete n.mask; delete n.maskColor;
    }
    if (n.image?.url) {
      const l = loaded.get(n.image.url)!;
      if ("svg" in l && !n.children?.length && !n.fill && !n.stroke) {
        const svg = await fitSvg(page, l.svg, n.w, n.h);
        if (svg) { toSvg(n, svg); continue; }
      }
      const src = "src" in l ? l.src : "svg" in l ? await svgPng(page, l.svg, n.w * 2, n.h * 2) : undefined;
      if (src) n.image = { src, fit: n.image.fit };
      else { warnings.push(`The background picture ${assetName(n.image.url)} of "${n.name}" couldn't be loaded (${"error" in l ? l.error : "not a valid SVG"}); left out.`); delete n.image; }
    }
  }
  return warnings;
}

// Runs inside the page. Kept dependency-free and self-contained.
const SERIALIZE = ({ targets, swaps }: { targets: ImportTarget[] | null; swaps: ImportSwap[] }) => {
  const px = (v: string) => parseFloat(v) || 0;
  // Any CSS colour (oklch, lab, hsl, color(), …) → sRGB, by painting one pixel. Claude Design exports use oklch.
  const colorCanvas = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
  const converted = new Map<string, string | null>();
  const COLOR_FN = /(?:rgba?|oklch|oklab|lab|lch|hsla?|hwb|color)\([^()]*(?:\([^()]*\)[^()]*)*\)/;
  const color = (v0: string, clear = false): { hex: string; a: number } | null => {
    let v = v0;
    if (!/^\s*rgba?\(/.test(v)) {
      const fn = v.match(COLOR_FN);
      if (!fn) return null;
      if (!converted.has(fn[0])) {
        colorCanvas.clearRect(0, 0, 1, 1); colorCanvas.fillStyle = "rgba(0,0,0,0)"; colorCanvas.fillStyle = fn[0]; colorCanvas.fillRect(0, 0, 1, 1);
        const [r, g, b, a] = colorCanvas.getImageData(0, 0, 1, 1).data;
        converted.set(fn[0], a ? `rgba(${r}, ${g}, ${b}, ${Math.round((a / 255) * 1000) / 1000})` : null);
      }
      v = converted.get(fn[0]) ?? "";
    }
    const m = v.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const [r, g, b, a = "1"] = m[1].split(/[ ,/]+/).filter(Boolean);
    const al = parseFloat(a);
    if (al === 0 && !clear) return null;
    const h = (n: string) => Math.round(+n).toString(16).padStart(2, "0");
    return { hex: `#${h(r)}${h(g)}${h(b)}`.toUpperCase(), a: al };
  };
  const splitTop = (s: string) => { const out: string[] = []; let d = 0, cur = ""; for (const ch of s) { if (ch === "(") d++; if (ch === ")") d--; if (ch === "," && !d) { out.push(cur.trim()); cur = ""; } else cur += ch; } if (cur.trim()) out.push(cur.trim()); return out; };
  // (dom.ts parses gradients the same way for the editable importer; both run inside the page.)
  const gradient = (bg0: string): any => {
    const bg = splitTop(bg0)[0] ?? "";
    const m = bg.match(/^(linear|radial|conic)-gradient\((.*)\)$/);
    if (!m) return null;
    const kind = m[1] === "radial" ? "radial" : m[1] === "conic" ? "angular" : "linear";
    const parts = splitTop(m[2]);
    let angle = 180;
    if (kind === "linear") {
      if (/deg$/.test(parts[0])) angle = parseFloat(parts.shift()!);
      else if (/^to /.test(parts[0])) { const t = parts.shift()!; angle = ({ "to top": 0, "to right": 90, "to bottom": 180, "to left": 270 } as any)[t] ?? 180; }
    } else if (parts[0] && !COLOR_FN.test(parts[0]) && !/^(transparent|currentcolor)\b/i.test(parts[0])) {
      const from = parts.shift()!.match(/from\s+(-?[\d.]+)deg/);
      angle = from ? parseFloat(from[1]) : 0;
    }
    const raw = parts.map((p, i) => {
      const cm = p.match(COLOR_FN); const c = cm ? color(cm[0], true) : null;
      const pos = p.replace(cm?.[0] ?? "", "").match(/([\d.]+)%/);
      return c && { hex: c.hex, a: c.a, pos: pos ? +pos[1] / 100 : i / Math.max(1, parts.length - 1) };
    }).filter(Boolean) as { hex: string; a: number; pos: number }[];
    // CSS fades to "transparent" premultiplied: a clear stop takes its neighbours' colours (two stops when both sides
    // have one), or Figma would fade through grey.
    const stops = raw.flatMap((st, i) => {
      if (st.a) return [st];
      const prev = raw.slice(0, i).reverse().find((x) => x.a), next = raw.slice(i + 1).find((x) => x.a);
      return [prev, next].filter(Boolean).map((n) => ({ ...st, hex: n!.hex }));
    });
    return stops.length >= 2 && stops.some((x) => x.a) ? { type: kind, angle, stops } : null;
  };
  const blurOf = (f: string) => { const b = f && f !== "none" ? f.match(/blur\(([\d.]+)px\)/) : null; return b ? parseFloat(b[1]) || undefined : undefined; };
  const shadows = (v: string) => {
    if (!v || v === "none") return undefined;
    return splitTop(v).map((s) => {
      const cm = s.match(COLOR_FN); const c = cm ? color(cm[0]) : null;
      const nums = s.replace(cm?.[0] ?? "", "").replace("inset", "").trim().split(/\s+/).map(px);
      return c && { inset: /inset/.test(s), x: nums[0] || 0, y: nums[1] || 0, blur: nums[2] || 0, spread: nums[3] || 0, hex: c.hex, a: c.a };
    }).filter(Boolean);
  };
  const weightStyle = (w: string) => ({ "100": "Thin", "200": "ExtraLight", "300": "Light", "400": "Regular", "500": "Medium", "600": "SemiBold", "700": "Bold", "800": "ExtraBold", "900": "Black" } as any)[String(Math.round(+w / 100) * 100)] ?? "Regular";
  const family = (f: string) => f.split(",")[0].replace(/["']/g, "").trim();

  let count = 0;
  const nameOf = (el: Element) => el.getAttribute("aria-label") || el.getAttribute("data-name") || el.getAttribute("role") || el.tagName.toLowerCase();

  const lw = (window as any).__lw; // page.ts: SVG, pictures, icon fonts
  function svgNode(el: SVGSVGElement, ox: number, oy: number) {
    const r = el.getBoundingClientRect();
    count++;
    return { type: "svg", name: el.getAttribute("aria-label") || "art", x: r.left - ox, y: r.top - oy, w: r.width, h: r.height, svg: lw.svgMarkup(el) };
  }

  function textNodes(el: Element, ox: number, oy: number, cs: CSSStyleDeclaration) {
    const out: any[] = [];
    for (const n of el.childNodes) {
      if (n.nodeType !== 3 || !n.textContent || !n.textContent.trim()) continue;
      const range = document.createRange(); range.selectNodeContents(n);
      const r = range.getBoundingClientRect();
      if (!r.width) continue;
      const c = color(cs.color);
      let content = n.textContent.replace(/\s+/g, " ").trim();
      if (cs.textTransform === "uppercase") content = content.toUpperCase();
      // Wrapped only when a box starts over half a line below the first (mixed fonts on one line differ by a few px).
      const rects = [...range.getClientRects()].filter((q) => q.width > 0);
      const lines = rects.some((q) => q.top > rects[0].top + rects[0].height / 2);
      count++;
      out.push({
        type: "text", name: content.slice(0, 40), x: r.left - ox, y: r.top - oy, w: r.width, h: r.height, content,
        font: { family: family(cs.fontFamily), style: weightStyle(cs.fontWeight) }, size: px(cs.fontSize),
        lineHeight: cs.lineHeight === "normal" ? undefined : px(cs.lineHeight), letterSpacing: px(cs.letterSpacing) || undefined,
        color: c?.hex, opacity: c && c.a < 1 ? c.a : undefined,
        align: lines ? ({ right: "RIGHT", end: "RIGHT", center: "CENTER", left: "LEFT", start: cs.direction === "rtl" ? "RIGHT" : "LEFT" } as any)[cs.textAlign] ?? "RIGHT" : (cs.direction === "rtl" ? "RIGHT" : "LEFT"),
        wrap: lines,
      });
    }
    return out;
  }

  function walk(el: Element, ox: number, oy: number, isRoot: boolean): any[] {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || +cs.opacity === 0) return [];
    if (el.tagName.toLowerCase() === "svg") return [svgNode(el as SVGSVGElement, ox, oy)];
    const r = el.getBoundingClientRect();
    if (!isRoot && (r.width === 0 || r.height === 0) && cs.overflow !== "visible") return [];
    const bg = color(cs.backgroundColor);
    const grad = gradient(cs.backgroundImage);
    // A concave corner drawn as a hard-edged radial (transparent up to R px, then a colour from R px) becomes a fillet
    // shape. Soft radial gradients (glows, spotlights) are real gradients.
    const hard = cs.backgroundImage.match(/^radial-gradient\([^,]*,\s*(?:transparent|rgba\(0, 0, 0, 0\))\s+([\d.]+)px,\s*(rgba?\([^)]+\))\s+([\d.]+)px\)$/);
    const notch = hard && hard[1] === hard[3] ? color(hard[2]) : null;
    const sh = shadows(cs.boxShadow);
    const bw = ["Top", "Right", "Bottom", "Left"].map((s) => (cs as any)[`border${s}Style`] !== "none" ? px((cs as any)[`border${s}Width`]) : 0);
    const bc = color(cs.borderTopColor) || color(cs.borderRightColor) || color(cs.borderBottomColor) || color(cs.borderLeftColor);
    const radius = [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius].map(px);
    const clip = cs.overflow === "hidden" || cs.overflowX === "hidden";
    const blend = cs.mixBlendMode !== "normal" ? cs.mixBlendMode : undefined;
    const opacity = +cs.opacity < 1 ? +cs.opacity : undefined;
    const tag = el.tagName.toLowerCase();

    // Pictures by their address (importHtml loads them, so the plugin gets only data), and icon-font icons as pictures.
    const box = { x: r.left - ox, y: r.top - oy, w: r.width, h: r.height };
    const fit = (cs.objectFit === "contain" || cs.objectFit === "scale-down") ? "FIT" : "FILL";
    const picture = (src: string | undefined, f = fit, name = "image") => { count++; return [{ type: "image", name: el.getAttribute("alt") || el.getAttribute("aria-label") || name, ...box, src, fit: f, radius: radius.some(Boolean) ? radius : undefined, opacity }]; };
    if (tag === "img") return picture(lw.imgSrc(el));
    if (tag === "canvas") { const src = lw.canvasPng(el); if (src) return picture(src); }
    const glyph = lw.glyphIcon(el, nameOf(el));
    if (glyph) return picture(glyph, "FIT", "icon");
    const pics = lw.pictures(el, cs);

    if (notch) { count++; const w = r.width, h = r.height; return [{ type: "svg", name: "notch-fillet", x: r.left - ox, y: r.top - oy, w, h, svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><path d="M0 0A${w} ${h} 0 0 0 ${w} ${h}L0 ${h}Z" fill="${notch.hex}"/></svg>` }]; }

    const visual = isRoot || (cs.display !== "contents" && swaps.some((s) => el.matches(s.selector))) || bg || grad || pics.bg || pics.mask || sh || bw.some(Boolean) || clip || blend || opacity !== undefined || tag === "image-slot" || blurOf(cs.filter) || blurOf((cs as any).backdropFilter ?? "");
    const kids: any[] = [];
    const cx = visual ? r.left : ox, cy = visual ? r.top : oy;
    if (tag !== "image-slot") {
      kids.push(...textNodes(el, cx, cy, cs));
      for (const c of el.children) kids.push(...walk(c, cx, cy, false));
    }
    if (!visual) return kids;
    count++;
    const swap = isRoot ? undefined : swaps.find((s) => el.matches(s.selector));
    const swapInfo = swap && {
      component: swap.component, id: swap.id, key: swap.key, overrides: swap.overrides, fills: swap.fills,
      variant: swap.variants?.find((v) => v.test.startsWith("text:") ? (el.textContent ?? "").includes(v.test.slice(5)) : !!el.querySelector(v.test))?.variant ?? swap.default,
    };
    const node: any = {
      type: "frame", name: tag === "image-slot" ? "image" : nameOf(el), x: r.left - ox, y: r.top - oy, w: r.width, h: r.height,
      fill: bg ? { hex: bg.hex, a: bg.a } : undefined, gradient: grad || undefined, shadows: sh,
      blur: blurOf(cs.filter), backdropBlur: blurOf((cs as any).backdropFilter ?? (cs as any).webkitBackdropFilter),
      stroke: bw.some(Boolean) && bc ? { hex: bc.hex, a: bc.a, weights: bw } : undefined,
      radius: radius.some(Boolean) ? radius : undefined, clip, blend, opacity, children: kids,
    };
    if (swapInfo) node.swap = swapInfo;
    if (pics.bg) node.image = { url: pics.bg.url, fit: pics.bg.fit };
    if (pics.mask) { node.mask = pics.mask; node.maskColor = color(cs.color)?.hex; }
    if (tag === "image-slot") node.placeholder = el.getAttribute("placeholder") || "image";
    return [node];
  }

  let roots: { el: Element; name: string }[];
  if (targets) roots = targets.flatMap((t) => {
    let els = [...document.querySelectorAll(t.selector)];
    if (t.index !== undefined) els = els.slice(t.index, t.index + 1);
    return els.map((el, i, all) => ({ el, name: t.name ? (all.length > 1 ? `${t.name} ${i + 1}` : t.name) : nameOf(el) }));
  });
  else {
    // Default: every nested prototype screen on a review board, named by the label above it.
    roots = [...document.querySelectorAll(".sc-host .sc-host")].map((el) => {
      let host: Element = el;
      const p = el.parentElement!;
      if (getComputedStyle(p).overflow === "hidden" && p.children.length === 1) host = p;
      const label = host.previousElementSibling?.textContent?.trim();
      return { el: host, name: label || (el as HTMLElement).dataset.scName || "Screen" };
    });
    if (!roots.length) roots = [{ el: document.body, name: document.title || "Screen" }];
  }
  const screens = roots.map(({ el, name }) => {
    count = 0;
    const r = el.getBoundingClientRect();
    const [tree] = walk(el, r.left, r.top, true);
    tree.x = 0; tree.y = 0; tree.name = name;
    return { name, width: r.width, height: r.height, tree, nodeCount: count };
  });
  return { screens, warnings: lw.warnings };
};
