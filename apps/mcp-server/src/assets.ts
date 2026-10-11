// figma_import_assets: icons and pictures from files or folders into Figma in one step. SVGs become editable vectors,
// named by their path in the folder (so "arrows/left.svg" groups as arrows/left once it's a component); PNG, JPEG and
// GIF go as they are; WebP, AVIF, BMP and ICO are decoded to PNG by the headless browser. They're laid out in a
// wrapping grid in a section, as one ordinary plan.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join, relative, sep } from "node:path";
import type { DesignPlan } from "@cde/core";
import { MAX_ASSET_BYTES, decodeToPng, sniff, svgText } from "@cde/html-import";

const EXT = new Set([".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp", ".ico"]);
const MAX_ITEMS = 300, MAX_TOTAL = 60 * 1024 * 1024;

export interface AssetItem { name: string; kind: "svg" | "image"; svg?: string; src?: string; w: number; h: number }

/** A PNG's, GIF's or JPEG's size from its header. */
export function imageSize(b: Uint8Array): { w: number; h: number } | undefined {
  const be16 = (i: number) => (b[i] << 8) | b[i + 1], be32 = (i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
  if (b[0] === 0x89 && b[1] === 0x50) return { w: be32(16), h: be32(20) };
  if (b[0] === 0x47 && b[1] === 0x49) return { w: b[6] | (b[7] << 8), h: b[8] | (b[9] << 8) };
  if (b[0] === 0xff && b[1] === 0xd8) {
    // The first start-of-frame marker (not DHT C4, JPG C8 or DAC CC) has the size.
    for (let i = 2; i + 9 < b.length;) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { w: be16(i + 7), h: be16(i + 5) };
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
      i += 2 + be16(i + 2);
    }
  }
  return undefined;
}

/** An SVG's own size: its width and height in px, else its viewBox, else 24. */
export function svgSize(text: string): { w: number; h: number } {
  const tag = text.match(/<svg\b[^>]*>/i)?.[0] ?? "";
  const attr = (k: string) => tag.match(new RegExp(`\\s${k}\\s*=\\s*["']\\s*([\\d.]+)\\s*(px)?\\s*["']`, "i"))?.[1];
  const w = Number(attr("width")), h = Number(attr("height"));
  if (w > 0 && h > 0) return { w, h };
  const vb = tag.match(/viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
  if (vb && Number(vb[1]) > 0 && Number(vb[2]) > 0) return w > 0 ? { w, h: (w * Number(vb[2])) / Number(vb[1]) } : { w: Number(vb[1]), h: Number(vb[2]) };
  return { w: 24, h: 24 };
}

/** The asset files under the paths: a folder's (down 4 levels; not node_modules or hidden folders), or the files. */
function listFiles(paths: string[], warnings: string[]): { file: string; name: string }[] {
  const out: { file: string; name: string }[] = [];
  const named = (file: string, root: string) => relative(root, file).split(sep).join("/").replace(/\.[^.]+$/, "");
  const walk = (dir: string, root: string, depth: number) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (depth < 4 && !e.name.startsWith(".") && e.name !== "node_modules") walk(p, root, depth + 1); }
      else if (EXT.has(extname(e.name).toLowerCase())) out.push({ file: p, name: named(p, root) });
    }
  };
  for (const p of paths) {
    let st;
    try { st = statSync(p); } catch { warnings.push(`${p} doesn't exist.`); continue; }
    if (st.isDirectory()) walk(p, p, 0);
    else if (EXT.has(extname(p).toLowerCase())) out.push({ file: p, name: basename(p).replace(/\.[^.]+$/, "") });
    else warnings.push(`${basename(p)} isn't an SVG, PNG, JPEG, GIF, WebP or AVIF file; skipped.`);
  }
  return out;
}

/** Reads the assets: vectors for SVGs, PNG/JPEG/GIF data for pictures (others decoded to PNG). `maxSize` caps the
 *  longest side in the grid (pictures shrink to it; an SVG keeps its own size up to it). */
export async function collectAssets(paths: string[], o: { maxSize?: number } = {}): Promise<{ items: AssetItem[]; warnings: string[] }> {
  const warnings: string[] = [];
  const max = o.maxSize ?? 320;
  let files = listFiles(paths, warnings);
  if (files.length > MAX_ITEMS) { warnings.push(`${files.length} files: imported the first ${MAX_ITEMS}. Import the rest in another call.`); files = files.slice(0, MAX_ITEMS); }
  const items: (AssetItem | undefined)[] = [];
  const decode: { i: number; src: string; name: string }[] = [];
  let total = 0;
  for (const f of files) {
    const buf = readFileSync(f.file);
    if (buf.length > MAX_ASSET_BYTES) { warnings.push(`${f.name}: ${(buf.length / 1e6).toFixed(1)} MB is over the 10 MB limit; skipped.`); continue; }
    if ((total += buf.length) > MAX_TOTAL) { warnings.push(`Stopped at ${f.name}: over 60 MB in one import. Import the rest in another call.`); break; }
    const kind = sniff(buf);
    if (kind === "svg") { const svg = svgText(buf); items.push({ name: f.name, kind: "svg", svg, ...svgSize(svg) }); continue; }
    if (kind !== "other") {
      const size = imageSize(buf);
      if (!size) { warnings.push(`${f.name}: couldn't read its size; skipped.`); continue; }
      items.push({ name: f.name, kind: "image", src: `data:image/${kind};base64,${buf.toString("base64")}`, ...size });
      continue;
    }
    decode.push({ i: items.length, src: `data:image/${extname(f.file).slice(1).toLowerCase().replace("jpg", "jpeg")};base64,${buf.toString("base64")}`, name: f.name });
    items.push(undefined);
  }
  if (decode.length) {
    let done: Awaited<ReturnType<typeof decodeToPng>> = [];
    try { done = await decodeToPng(decode.map((d) => d.src)); }
    catch (e) { warnings.push(`${decode.length} WebP/AVIF/BMP/ICO file(s) need a browser to decode, and none was found (${(e as Error).message.split("\n")[0]}); skipped.`); }
    decode.forEach((d, k) => {
      const r = done[k];
      if (r && "src" in r) items[d.i] = { name: d.name, kind: "image", src: r.src, w: r.w, h: r.h };
      else if (done.length) warnings.push(`${d.name}: the browser couldn't decode it; skipped.`);
    });
  }
  // Shrink to the grid's cap, keeping the proportions.
  const out = items.filter((x): x is AssetItem => !!x).map((x) => {
    const k = Math.min(1, max / Math.max(x.w, x.h));
    return { ...x, w: Math.max(1, Math.round(x.w * k * 100) / 100), h: Math.max(1, Math.round(x.h * k * 100) / 100) };
  });
  return { items: out, warnings };
}

/** Where each asset is in the plan assetPlan makes (screens[0] is the section, its first child the grid). */
export const assetPath = (i: number) => `screens[0].children[0].children[${i}]`;

/** The assets in a wrapping grid on a white frame, in a section. */
export function assetPlan(items: AssetItem[], o: { name: string; page?: string }): DesignPlan {
  const gap = 32, pad = 40;
  const cols = Math.min(8, Math.max(1, Math.ceil(Math.sqrt(items.length))));
  const cell = Math.max(...items.map((x) => x.w));
  const width = Math.round(Math.min(1800, Math.max(240, pad * 2 + cols * cell + (cols - 1) * gap)));
  return {
    version: 1, name: o.name, ...(o.page ? { target: { page: o.page } } : {}),
    screens: [{ type: "section", name: o.name, children: [{
      type: "frame", name: o.name, width, height: "hug", fill: "#FFFFFF", radius: 16,
      layout: { direction: "horizontal", wrap: true, gap, counterGap: gap, padding: pad, crossAlign: "center" },
      children: items.map((x) => x.kind === "svg"
        ? { type: "icon", name: x.name, svg: x.svg, width: x.w, height: x.h }
        : { type: "image", name: x.name, src: x.src, width: x.w, height: x.h, fit: "fill" }),
    }] }],
  } as DesignPlan;
}
