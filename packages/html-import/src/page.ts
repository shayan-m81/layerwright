// What both importers do inside the page (dom.ts for the editable plan, tree.ts for pixel-exact layers): inline SVG
// as Figma reads it, sprite icons (<use>), icon fonts, and where each picture comes from (an <img>, a CSS background,
// a CSS mask). installHelpers puts them on window.__lw before a serializer runs; assets.ts then loads the pictures in
// Node, and the helpers turn them into what Figma takes: SVG markup, or PNG/JPEG/GIF bytes. Self-contained: it runs
// in the browser.
import type { Page } from "playwright-core";

export interface Asset { url: string; role: "img" | "bg" | "mask"; fit?: "FILL" | "FIT" | "TILE" }

export async function installHelpers(page: Page): Promise<void> {
  await page.evaluate(HELPERS);
}

const HELPERS = async () => {
  const w = window as any;
  if (w.__lw) return;
  const NS = "http://www.w3.org/2000/svg";
  const px = (v: string | null | undefined) => parseFloat(v ?? "") || 0;
  const canvas = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
  const converted = new Map<string, { hex: string; a: number } | null>();
  /** Any CSS colour (oklch, lab, hsl, …) → sRGB hex and alpha, by painting one pixel. */
  const color = (v: string): { hex: string; a: number } | null => {
    if (!v || v === "none") return null;
    if (!converted.has(v)) {
      canvas.clearRect(0, 0, 1, 1); canvas.fillStyle = "rgba(0,0,0,0)"; canvas.fillStyle = v; canvas.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = canvas.getImageData(0, 0, 1, 1).data;
      const h = (n: number) => n.toString(16).padStart(2, "0");
      converted.set(v, a ? { hex: `#${h(r)}${h(g)}${h(b)}`.toUpperCase(), a: Math.round((a / 255) * 1000) / 1000 } : null);
    }
    return converted.get(v)!;
  };
  const warnings: string[] = [];
  const hrefOf = (u: Element) => u.getAttribute("href") ?? u.getAttributeNS("http://www.w3.org/1999/xlink", "href") ?? "";

  // Sprite files (<use href="icons.svg#home">): their symbols are copied into the page, so every <use> points inside it.
  {
    const files = new Map<string, Promise<Document | null>>(), done = new Map<string, string>();
    let host: SVGSVGElement | null = null, n = 0;
    for (const u of document.querySelectorAll("use")) {
      const href = hrefOf(u), at = href.indexOf("#");
      if (at <= 0) continue;
      if (!done.has(href)) {
        const file = new URL(href.slice(0, at), document.baseURI).href;
        if (!files.has(file)) files.set(file, fetch(file).then((r) => (r.ok ? r.text() : "")).then((t) => (t ? new DOMParser().parseFromString(t, "image/svg+xml") : null)).catch(() => null));
        const ref = (await files.get(file))?.getElementById(href.slice(at + 1));
        if (!ref) { warnings.push(`The sprite icon ${href} wasn't found; it's left empty.`); done.set(href, ""); continue; }
        if (!host) { host = document.createElementNS(NS, "svg") as SVGSVGElement; host.setAttribute("style", "display:none"); document.body.appendChild(host); }
        const copy = document.importNode(ref, true) as Element;
        copy.id = `lw-sprite-${n++}`;
        host.appendChild(copy);
        done.set(href, copy.id);
      }
      if (done.get(href)) { u.setAttribute("href", `#${done.get(href)}`); u.removeAttributeNS("http://www.w3.org/1999/xlink", "href"); }
    }
  }

  /** The colours an SVG element paints with, as attributes (Figma doesn't read CSS classes). */
  const paint = (d: Element, fill: { hex: string; a: number } | null, stroke: { hex: string; a: number } | null, cs: CSSStyleDeclaration) => {
    d.setAttribute("fill", fill ? fill.hex : "none");
    if (fill && fill.a < 1) d.setAttribute("fill-opacity", String(fill.a));
    if (stroke) { d.setAttribute("stroke", stroke.hex); d.setAttribute("stroke-width", String(px(cs.strokeWidth))); d.setAttribute("stroke-linecap", cs.strokeLinecap); d.setAttribute("stroke-linejoin", cs.strokeLinejoin); }
  };

  /** A <use> as plain shapes: what it points at, placed and scaled like the browser does (a symbol's viewBox fits the
   *  <use> box), painted with its own colours, or the <use>'s where it inherits them (fill="currentColor", none set). */
  const expandUse = (use: Element, box: { w: number; h: number }): Element | null => {
    const ref = document.getElementById(hrefOf(use).slice(1));
    if (!ref) return null;
    const g = document.createElementNS(NS, "g");
    const tf: string[] = [];
    const x = px(use.getAttribute("x")), y = px(use.getAttribute("y"));
    if (x || y) tf.push(`translate(${x} ${y})`);
    const symbol = ref.tagName.toLowerCase() === "symbol";
    const vb = symbol ? (ref.getAttribute("viewBox") ?? "").split(/[\s,]+/).map(Number) : [];
    if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) {
      const W = px(use.getAttribute("width")) || box.w, H = px(use.getAttribute("height")) || box.h;
      const k = Math.min(W / vb[2], H / vb[3]);
      tf.push(`translate(${(W - vb[2] * k) / 2} ${(H - vb[3] * k) / 2}) scale(${k}) translate(${-vb[0]} ${-vb[1]})`);
    }
    if (tf.length) g.setAttribute("transform", tf.join(" "));
    const ucs = getComputedStyle(use);
    const rootCs = getComputedStyle((ref as unknown as SVGElement).ownerSVGElement ?? ref);
    const inherits = (s: Element, prop: "fill" | "stroke", cs: CSSStyleDeclaration) => {
      const own = s.getAttribute(prop) ?? (s as SVGElement).style?.getPropertyValue(prop);
      if (own) return /^(currentcolor|inherit)$/i.test(own.trim()) ? (/^currentcolor$/i.test(own.trim()) ? "color" : "inherit") : "own";
      return cs[prop] === rootCs[prop] ? "inherit" : "own"; // a colour from the sprite's own CSS stays
    };
    for (const c of symbol ? [...ref.children] : [ref]) {
      const copy = c.cloneNode(true) as Element;
      const srcs = [c, ...c.querySelectorAll("*")], dsts = [copy, ...copy.querySelectorAll("*")];
      srcs.forEach((s, i) => {
        const cs = getComputedStyle(s), d = dsts[i];
        d.removeAttribute("style"); d.removeAttribute("class"); d.removeAttribute("id");
        const pick = (prop: "fill" | "stroke") => { const how = inherits(s, prop, cs); return color(how === "own" ? cs[prop] : how === "color" ? ucs.color : ucs[prop]); };
        paint(d, pick("fill"), pick("stroke"), inherits(s, "stroke", cs) === "own" ? cs : ucs);
      });
      g.appendChild(copy);
    }
    return g;
  };

  /** Inline <svg> as Figma reads it: computed colours as attributes, <use> expanded, a progress ring's dash as a real
   *  arc, a CSS transform on the <svg> baked in, and its rendered size. */
  const svgMarkup = (el: SVGSVGElement): string => {
    const r = el.getBoundingClientRect();
    const vb = el.viewBox?.baseVal;
    const outer = { w: vb && vb.width ? vb.width : r.width, h: vb && vb.height ? vb.height : r.height };
    const clone = el.cloneNode(true) as SVGSVGElement;
    const src = [el, ...el.querySelectorAll("*")], dst = [clone, ...clone.querySelectorAll("*")];
    src.forEach((s, i) => {
      const cs = getComputedStyle(s), d = dst[i];
      d.removeAttribute("style"); d.removeAttribute("class");
      if (i === 0) return;
      if (s.tagName.toLowerCase() === "use") { const g = expandUse(s, outer); if (g) d.replaceWith(g); else d.remove(); return; }
      const st = color(cs.stroke);
      paint(d, color(cs.fill), st, cs);
      // Dashes: a progress ring (one dash about as long as the circle, shifted by an offset) becomes a real arc,
      // since Figma renders SVG dash patterns differently; other dashes are kept as a plain pattern.
      if (st && cs.strokeDasharray && cs.strokeDasharray !== "none") {
        const dash = cs.strokeDasharray.split(/[ ,]+/).map(px).filter((n) => n > 0);
        const off = px(cs.strokeDashoffset);
        d.removeAttribute("stroke-dashoffset"); d.removeAttribute("stroke-dasharray");
        const isCircle = s.tagName.toLowerCase() === "circle";
        const rr = isCircle ? px(s.getAttribute("r")) : 0, cx = px(s.getAttribute("cx")), cy = px(s.getAttribute("cy"));
        const circ = 2 * Math.PI * rr;
        const visible = dash.length === 1 ? dash[0] - off : dash.length === 2 && dash[1] >= circ * 0.98 ? dash[0] - off : NaN;
        if (isCircle && rr > 0 && Number.isFinite(visible) && (dash[0] >= circ * 0.98 || dash.length === 2)) {
          const frac = Math.max(0, Math.min(1, visible / circ));
          if (frac < 0.999) {
            const a = frac * 2 * Math.PI;
            const path = document.createElementNS(NS, "path");
            for (const at of [...d.attributes]) if (!["cx", "cy", "r"].includes(at.name)) path.setAttribute(at.name, at.value);
            path.setAttribute("d", frac <= 0 ? "" : `M ${cx + rr} ${cy} A ${rr} ${rr} 0 ${a > Math.PI ? 1 : 0} 1 ${cx + rr * Math.cos(a)} ${cy + rr * Math.sin(a)}`);
            path.setAttribute("fill", "none");
            d.replaceWith(path);
          }
        } else if (dash.length) d.setAttribute("stroke-dasharray", dash.join(" "));
      }
    });
    // A CSS transform on the <svg> itself (e.g. rotate(-90deg) to start a ring at the top) is baked into the markup.
    const tf = getComputedStyle(el).transform;
    if (tf && tf !== "none") {
      const m = tf.match(/matrix\(([^)]+)\)/);
      if (m) {
        const [a, b, c, dd, e, f] = m[1].split(",").map(Number);
        const k = r.width ? outer.w / r.width : 1;
        const g = document.createElementNS(NS, "g");
        g.setAttribute("transform", `translate(${outer.w / 2} ${outer.h / 2}) matrix(${a} ${b} ${c} ${dd} ${e * k} ${f * k}) translate(${-outer.w / 2} ${-outer.h / 2})`);
        while (clone.firstChild) g.appendChild(clone.firstChild);
        clone.appendChild(g);
      }
    }
    clone.setAttribute("width", String(r.width)); clone.setAttribute("height", String(r.height));
    clone.setAttribute("xmlns", NS);
    return clone.outerHTML;
  };

  const urlOf = (v: string) => { const m = v && v !== "none" ? v.match(/url\(\s*["']?([^"')]+)["']?\s*\)/) : null; return m ? m[1] : undefined; };
  /** Where an element's pictures come from: its CSS background image (the top one that is a picture, with how it's
   *  sized) and a CSS mask (an icon in the element's colour). Gradients are read by the serializers. */
  const pictures = (el: Element, cs: CSSStyleDeclaration): { bg?: { url: string; fit: "FILL" | "FIT" | "TILE" }; mask?: string } => {
    const out: { bg?: { url: string; fit: "FILL" | "FIT" | "TILE" }; mask?: string } = {};
    const layer = cs.backgroundImage.split(/,(?![^(]*\))/).find((l) => /^\s*url\(/.test(l));
    const bg = layer && urlOf(layer);
    if (bg) {
      const size = cs.backgroundSize.split(",")[0].trim(), repeat = cs.backgroundRepeat.split(",")[0].trim();
      out.bg = { url: bg, fit: size === "contain" ? "FIT" : size === "cover" || /^100%( 100%)?$/.test(size) ? "FILL" : /repeat/.test(repeat) && !/no-repeat/.test(repeat) && size === "auto" ? "TILE" : size === "auto" ? "FILL" : "FIT" };
    }
    const mask = urlOf((cs as any).webkitMaskImage || (cs as any).maskImage || "");
    if (mask) out.mask = mask;
    void el;
    return out;
  };

  /** Icon fonts (Font Awesome, Material Symbols, icomoon…): glyphs Figma would show as boxes, or as plain words, when
   *  the font isn't installed. Such an icon is drawn as a picture at 4× (canvas uses the page's loaded fonts). */
  const ICON_FONT = /(^|[\s"',-])(icons?|awesome|symbols|glyphs?|fontello|icomoon|remixicon|feather|phosphor|ionicons|boxicons|tabler|lucide|bootstrap-icons|la-solid|codicon|dashicons)([\s"',-]|$)/i;
  const PRIVATE = /^[-\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}\s]+$/u;
  const glyphText = (text: string, cs: CSSStyleDeclaration) => !!text.trim() && (PRIVATE.test(text) || ICON_FONT.test(cs.fontFamily));
  const pseudoText = (el: Element, which: "::before" | "::after") => {
    const cs = getComputedStyle(el, which);
    const m = cs.content.match(/^"([\s\S]*)"$/);
    return m && cs.display !== "none" ? { text: m[1].replace(/\\(.)/g, "$1"), cs } : null;
  };
  const draw = (text: string, cs: CSSStyleDeclaration, w0: number, h0: number): string | undefined => {
    const w = Math.max(1, Math.round(w0)), h = Math.max(1, Math.round(h0)), k = 4;
    const c = document.createElement("canvas");
    c.width = w * k; c.height = h * k;
    const g = c.getContext("2d");
    const col = color(cs.color);
    if (!g || !col) return undefined;
    g.font = `${cs.fontStyle} ${cs.fontWeight} ${parseFloat(cs.fontSize) * k}px ${cs.fontFamily}`;
    g.fillStyle = cs.color;
    g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText(text, (w * k) / 2, (h * k) / 2);
    return c.toDataURL("image/png");
  };
  /** An element that is one icon-font glyph (its own text, or ::before/::after on an empty element): the picture of
   *  it. An icon glyph in ::before/::after of an element with other content is reported, not drawn. */
  const glyphIcon = (el: Element, name: string): string | undefined => {
    const own = [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent!.trim());
    const r = el.getBoundingClientRect();
    const pseudo = [pseudoText(el, "::before"), pseudoText(el, "::after")].filter((p) => p && glyphText(p.text, p.cs)) as { text: string; cs: CSSStyleDeclaration }[];
    if (!el.children.length && own.length === 1 && !pseudo.length) {
      const cs = getComputedStyle(el), text = own[0].textContent!.trim();
      // A private-use glyph, or one word in an icon font (Material's ligatures: "home", "arrow_back").
      return PRIVATE.test(text) || (ICON_FONT.test(cs.fontFamily) && /^[\w-]+$/.test(text)) ? draw(text, cs, r.width, r.height) : undefined;
    }
    if (!pseudo.length) return undefined;
    if (!el.children.length && !own.length) return draw(pseudo[0].text, pseudo[0].cs, r.width, r.height);
    warnings.push(`"${name}" has an icon-font icon in ::before/::after next to other content; it isn't imported (leaves a gap). An inline <svg> imports as a vector.`);
    return undefined;
  };

  /** Where an <img> picture comes from: its URL (assets.ts loads it), or for one made in the page (blob:) a PNG now. */
  const imgSrc = (img: HTMLImageElement): string | undefined => {
    const src = img.currentSrc || img.src;
    if (!src || !/^blob:/.test(src)) return src || undefined;
    if (!img.complete || !img.naturalWidth) return undefined;
    try { const c = document.createElement("canvas"); c.width = img.naturalWidth; c.height = img.naturalHeight; c.getContext("2d")!.drawImage(img, 0, 0); return c.toDataURL("image/png"); } catch { return undefined; }
  };
  /** A <canvas> as a picture (when the page may read it). */
  const canvasPng = (el: HTMLCanvasElement): string | undefined => { try { return el.toDataURL("image/png"); } catch { return undefined; } };

  // --- after the pictures are loaded (assets.ts) ---
  const parseSvg = (text: string): SVGSVGElement | null => {
    const doc = new DOMParser().parseFromString(text, "image/svg+xml");
    const svg = doc.documentElement;
    return svg && svg.tagName.toLowerCase() === "svg" && !doc.querySelector("parsererror") ? (svg as unknown as SVGSVGElement) : null;
  };
  /** An SVG file at a box: a viewBox so it scales, the box's size, and for a CSS mask every painted part in one colour. */
  const fitSvg = (text: string, w: number, h: number, hex?: string): string | undefined => {
    const svg = parseSvg(text);
    if (!svg) return undefined;
    for (const s of svg.querySelectorAll("script, foreignObject")) s.remove();
    if (!svg.getAttribute("viewBox")) {
      const sw = px(svg.getAttribute("width")), sh = px(svg.getAttribute("height"));
      if (sw > 0 && sh > 0 && !/%/.test(svg.getAttribute("width")! + svg.getAttribute("height"))) svg.setAttribute("viewBox", `0 0 ${sw} ${sh}`);
    }
    svg.setAttribute("width", String(w)); svg.setAttribute("height", String(h));
    if (hex) {
      for (const s of svg.querySelectorAll("style")) s.remove();
      for (const e of svg.querySelectorAll("path, circle, rect, ellipse, polygon, polyline, line, text, use, g")) {
        if (e.getAttribute("fill") !== "none") e.setAttribute("fill", hex);
        if (e.getAttribute("stroke") && e.getAttribute("stroke") !== "none") e.setAttribute("stroke", hex);
      }
      svg.setAttribute("fill", hex);
    }
    svg.setAttribute("xmlns", NS);
    return new XMLSerializer().serializeToString(svg);
  };
  const decode = (src: string) => new Promise<HTMLImageElement>((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => bad(new Error("the browser couldn't decode it")); i.src = src; });
  /** Any picture the browser can show (WebP, AVIF, BMP, ICO, SVG…) → PNG, which Figma takes. An SVG is drawn at `w`×`h`. */
  const toPng = async (src: string, w?: number, h?: number): Promise<{ src: string; w: number; h: number }> => {
    const img = await decode(src);
    const W = Math.max(1, Math.round(w || img.naturalWidth || 1)), H = Math.max(1, Math.round(h || img.naturalHeight || 1));
    const c = document.createElement("canvas"); c.width = W; c.height = H;
    c.getContext("2d")!.drawImage(img, 0, 0, W, H);
    return { src: c.toDataURL("image/png"), w: img.naturalWidth, h: img.naturalHeight };
  };

  w.__lw = { color, svgMarkup, pictures, glyphIcon, imgSrc, canvasPng, fitSvg, toPng, warnings };
};
