// Headless rendering: serve a file or folder over http (prototype runtimes fetch their own files,
// which fails on file://) and open it in Chromium. No network is needed except what the page loads.
import http from "node:http";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { readFile, stat, readdir } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Browser, Page } from "playwright-core";

const MIME: Record<string, string> = {
  ".html": "text/html", ".htm": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".otf": "font/otf", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
};

export function serve(root: string): Promise<{ url: string; close: () => void }> {
  return new Promise((ok) => {
    const srv = http.createServer(async (q, r) => {
      const p = resolve(join(root, decodeURIComponent((q.url ?? "/").split("?")[0])));
      if (!within(root, p)) { r.writeHead(403); r.end(); return; }
      try { const buf = await readFile(p); r.writeHead(200, { "content-type": MIME[extname(p).toLowerCase()] ?? "application/octet-stream" }); r.end(buf); }
      catch { r.writeHead(404); r.end(); }
    }).listen(0, "127.0.0.1", () => {
      const a = srv.address() as { port: number };
      ok({ url: `http://127.0.0.1:${a.port}`, close: () => srv.close() });
    });
  });
}

/** Is `p` the folder `root` or inside it? (By relative path: a drive root like C:\\ and a drive letter's case are fine.) */
export function within(root: string, p: string): boolean {
  const r = relative(root, p);
  return r === "" || (!!r && !r.startsWith("..") && !isAbsolute(r));
}

/** A path to an .html file, or a folder (Claude Design "standalone HTML" export): index.html, else the first .html. */
export async function resolveEntry(path: string): Promise<string> {
  const p = resolve(path);
  const s = await stat(p);
  if (s.isFile()) return p;
  const files = (await readdir(p)).filter((f) => /\.html?$/i.test(f)).sort();
  const pick = files.find((f) => /^index\.html?$/i.test(f)) ?? files[0];
  if (!pick) throw new Error(`No .html file in ${p}`);
  return join(p, pick);
}

/** The command that installs the Chromium this Layerwright's playwright-core expects (an unpinned `npx playwright`
 *  would fetch the newest one, whose browser build this version can't use). Linux also needs its system libraries. */
export function chromiumInstallCommand(): string {
  let v = "";
  try { v = createRequire(import.meta.url)("playwright-core/package.json").version; } catch { /* unknown: the newest */ }
  return `npx -y playwright-core${v ? `@${v}` : ""} install chromium${process.platform === "linux" ? " --with-deps" : ""}`;
}

/** A Chromium a Linux distribution installs (Playwright's channels only know Google Chrome and Edge). */
const LINUX_CHROMIUM = ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium", "/usr/bin/google-chrome-stable"];

/** Playwright's Chromium if installed (`npx playwright-core install chromium`), else the system Chrome or Edge, or on
 *  Linux the distribution's Chromium. */
export async function launch(): Promise<Browser> {
  const { chromium } = await import("playwright-core");
  const errors: string[] = [];
  const exe = process.env.LAYERWRIGHT_CHROMIUM_PATH;
  const distro = process.platform === "linux" ? LINUX_CHROMIUM.filter((p) => existsSync(p)).map((executablePath) => ({ executablePath })) : [];
  for (const opts of [exe ? { executablePath: exe } : undefined, {}, { channel: "chrome" }, { channel: "msedge" }, ...distro]) {
    if (!opts) continue;
    try { return await chromium.launch(opts); } catch (e) { errors.push((e as Error).message.split("\n")[0]); }
  }
  throw new Error(`No Chromium found. Run "${chromiumInstallCommand()}" or install Google Chrome, or set LAYERWRIGHT_CHROMIUM_PATH.\n${errors.join("\n")}`);
}

export interface PageOptions { root?: string; width?: number; height?: number; waitMs?: number; reducedMotion?: boolean }

/** Open `file` (served from `root`, default: the file's grandparent so ../fonts works) and run `fn`. */
export async function withPage<T>(file: string, opts: PageOptions, fn: (page: Page) => Promise<T>): Promise<T> {
  const entry = await resolveEntry(file);
  const root = resolve(opts.root ?? dirname(dirname(entry)));
  if (!within(root, entry) || entry === root) throw new Error(`${entry} is outside the served root ${root}`);
  const site = await serve(root);
  const browser = await launch();
  try {
    const page = await browser.newPage({ viewport: { width: opts.width ?? 1440, height: opts.height ?? 900 }, deviceScaleFactor: 1, reducedMotion: opts.reducedMotion === false ? "no-preference" : "reduce" });
    // tsx/esbuild wraps named inner functions in __name(); give the page a no-op so serializers run there.
    await page.addInitScript("window.__name = (f) => f");
    await page.goto(`${site.url}/${relative(root, entry).split(sep).map(encodeURIComponent).join("/")}`, { waitUntil: "networkidle" });
    await page.evaluate(() => (document as any).fonts?.ready);
    await page.waitForTimeout(opts.waitMs ?? 500);
    return await fn(page);
  } finally {
    await browser.close();
    site.close();
  }
}
