// The pictures an imported page uses (<img>, CSS backgrounds and masks), loaded here in Node through the page's own
// browser context (local files, https, no CORS in the way), so the Figma plugin never needs the network. Each becomes
// what Figma takes: SVG markup (an editable vector) or PNG/JPEG/GIF bytes; WebP, AVIF, BMP, ICO… are decoded to PNG
// by the browser. A picture that can't be loaded is reported, never fatal.
import type { Page } from "playwright-core";

export const MAX_ASSET_BYTES = 10 * 1024 * 1024;
export type Loaded = { svg: string } | { src: string } | { error: string };

/** What the bytes are, by their first bytes (a server's content-type is often wrong or missing). */
export function sniff(buf: Uint8Array, type = ""): "svg" | "png" | "jpeg" | "gif" | "other" {
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png";
  if (buf[0] === 0xff && buf[1] === 0xd8) return "jpeg";
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return "gif";
  const head = Buffer.from(buf.subarray(0, 1000)).toString("utf8").replace(/^﻿/, "").trimStart();
  if (/svg/.test(type) || /^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(head)) return "svg";
  return "other";
}

/** The text of an SVG file from its `<svg` on (Figma's importer wants no XML prolog before it). */
export const svgText = (buf: Uint8Array) => { const t = Buffer.from(buf).toString("utf8"); const at = t.search(/<svg[\s>]/i); return at >= 0 ? t.slice(at) : t; };

/** Short words for a picture in a warning: its file name, or "an inline image". */
export const assetName = (url: string) => (url.startsWith("data:") ? "an inline image" : decodeURIComponent(url.split(/[?#]/)[0].split("/").pop() || url).slice(0, 80));

async function loadOne(page: Page, url: string): Promise<Loaded> {
  try {
    let buf: Buffer, type = "";
    if (url.startsWith("data:")) {
      const m = url.match(/^data:([^;,]*)((?:;[^;,]*)*?)(;base64)?,([\s\S]*)$/);
      if (!m) throw new Error("not a valid data: URL");
      type = m[1];
      buf = m[3] ? Buffer.from(m[4], "base64") : Buffer.from(decodeURIComponent(m[4]), "utf8");
    } else if (/^https?:/.test(url)) {
      const res = await page.request.get(url, { timeout: 15_000 });
      if (!res.ok()) throw new Error(`HTTP ${res.status()}`);
      type = (res.headers()["content-type"] ?? "").split(";")[0].trim();
      buf = await res.body();
    } else throw new Error(`a ${url.split(":")[0]}: address can't be loaded`);
    if (buf.length > MAX_ASSET_BYTES) throw new Error(`it's ${(buf.length / 1e6).toFixed(1)} MB (limit 10 MB)`);
    const kind = sniff(buf, type);
    if (kind === "svg") return { svg: svgText(buf) };
    if (kind !== "other") return { src: `data:image/${kind};base64,${buf.toString("base64")}` };
    // WebP, AVIF, BMP, ICO…: the browser decodes it, and it comes back as a PNG.
    const png = await page.evaluate(({ src }) => (window as any).__lw.toPng(src), { src: `data:${/^image\//.test(type) ? type : "image/png"};base64,${buf.toString("base64")}` });
    return { src: png.src };
  } catch (e) {
    return { error: (e as Error).message.split("\n")[0] };
  }
}

/** Loads each picture once. */
export async function loadAssets(page: Page, urls: string[]): Promise<Map<string, Loaded>> {
  const out = new Map<string, Loaded>();
  for (const url of new Set(urls)) out.set(url, await loadOne(page, url));
  return out;
}

/** An SVG file at a box (a viewBox so it scales), in one colour for a CSS mask. */
export const fitSvg = (page: Page, svg: string, w: number, h: number, hex?: string): Promise<string | undefined> =>
  page.evaluate(({ svg, w, h, hex }) => (window as any).__lw.fitSvg(svg, w, h, hex), { svg, w, h, hex });

/** An SVG drawn as a PNG at `w`×`h` (a background image under other content, where a vector can't go). */
export const svgPng = async (page: Page, svg: string, w: number, h: number): Promise<string | undefined> => {
  try { return (await page.evaluate(({ src, w, h }) => (window as any).__lw.toPng(src, w, h), { src: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`, w, h })).src; }
  catch { return undefined; }
};

/** Pictures that still have to be loaded: anything but PNG/JPEG/GIF data already. */
export const needsLoading = (src?: string) => !!src && !/^data:image\/(png|jpe?g|gif);base64,/.test(src);

/** Decodes pictures Figma can't take (WebP, AVIF…) to PNG in a headless browser, with their natural size. */
export async function decodeToPng(sources: string[]): Promise<({ src: string; w: number; h: number } | { error: string })[]> {
  if (!sources.length) return [];
  const { launch } = await import("./browser.ts");
  const { installHelpers } = await import("./page.ts");
  const browser = await launch();
  try {
    const page = await browser.newPage();
    await page.setContent("<!doctype html><body></body>");
    await page.evaluate("window.__name = (f) => f"); // see withPage
    await installHelpers(page);
    const out: ({ src: string; w: number; h: number } | { error: string })[] = [];
    for (const src of sources) {
      try { out.push(await page.evaluate(({ src }) => (window as any).__lw.toPng(src), { src })); }
      catch (e) { out.push({ error: (e as Error).message.split("\n")[0] }); }
    }
    return out;
  } finally { await browser.close(); }
}
