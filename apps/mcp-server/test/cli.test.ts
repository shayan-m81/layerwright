import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { launch } from "@cde/html-import";
import { importCommand } from "../src/cli.ts";

let chromium = true;
try { await (await launch()).close(); } catch { chromium = false; }

(chromium ? test : test.skip)("layerwright import prints a plan summary for an HTML file", async () => {
  const lines: string[] = [];
  const code = await importCommand([fileURLToPath(new URL("../../../packages/html-import/test/fixtures/login.html", import.meta.url)), "--viewport", "390"], (s) => lines.push(s));
  assert.equal(code, 0);
  const out = lines.join("\n");
  assert.match(out, /Plan "Sign in"/);
  assert.match(out, /screens: +Sign in – 390/);
  assert.match(out, /primary-action/);
});

test("layerwright import without a path prints usage", async () => {
  const lines: string[] = [];
  assert.equal(await importCommand([], (s) => lines.push(s)), 2);
  assert.match(lines.join("\n"), /Usage:/);
});

test("the built CLI runs when started through a symlink, as npm's .bin does", { skip: process.platform === "win32" && "npm makes .cmd shims on Windows, not links" }, async () => {
  const { execFileSync } = await import("node:child_process");
  const { existsSync, mkdtempSync, symlinkSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const built = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  if (!existsSync(built)) return; // `npm run build` produces it; CI builds before testing
  const link = join(mkdtempSync(join(tmpdir(), "lw-bin-")), "layerwright");
  symlinkSync(built, link);
  const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  assert.equal(execFileSync(process.execPath, [link, "--version"], { encoding: "utf8" }).trim(), version);
});

test("the MCP server exits and frees its port when Claude Code closes stdin", async () => {
  const { spawn } = await import("node:child_process");
  const { existsSync } = await import("node:fs");
  const built = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  if (!existsSync(built)) return;
  const child = spawn(process.execPath, [built], { env: { ...process.env, LAYERWRIGHT_PORT: String(19000 + Math.floor(Math.random() * 900)) }, stdio: ["pipe", "ignore", "pipe"] });
  await new Promise<void>((r) => child.stderr!.on("data", (d) => { if (/ready/.test(String(d))) r(); }));
  child.stdin!.end();
  const code = await Promise.race([new Promise((r) => child.on("exit", r)), new Promise((r) => setTimeout(() => r("timeout"), 5000))]);
  if (code === "timeout") child.kill();
  assert.equal(code, 0);
});

(chromium ? test : test.skip)("layerwright import --to-figma builds the HTML in Figma without an AI client", async () => {
  const { toFigma } = await import("../src/cli.ts");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const WebSocket = (await import("ws")).default;
  const port = 7337;
  let plan: any;
  // A fake plugin that connects once the CLI's bridge is up, like a user opening the plugin.
  const fake = (async () => {
    for (let i = 0; i < 100; i++) {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      const ok = await new Promise<boolean>((r) => { ws.on("open", () => r(true)); ws.on("error", () => r(false)); });
      if (!ok) { await new Promise((r) => setTimeout(r, 100)); continue; }
      ws.send(JSON.stringify({ type: "hello", fileName: "TEST", page: "Page 1" }));
      ws.on("message", (m) => {
        const req = JSON.parse(String(m));
        let result: unknown = {};
        if (req.method === "executePlan") { plan = req.params.plan; result = { createdRootIds: ["100:1"], page: { id: "0:1", name: "Designs" }, nodeIds: { "screens[0]": "100:1" }, warnings: [] }; }
        // What Figma would report for the plan (no sizes: those checks need real layout).
        const snap = (n: any, id: string): any => ({ id, name: n.name, type: { frame: "FRAME", text: "TEXT", instance: "INSTANCE", rect: "RECTANGLE", svg: "FRAME" }[n.kind as string],
          ...(n.kind === "frame" ? { layout: { mode: n.layout?.direction ?? "NONE" }, children: n.children.map((c: any, i: number) => snap(c, `${id}.${i}`)) } : {}),
          ...(n.kind === "text" ? { text: { chars: n.content } } : {}) });
        if (req.method === "inspect") result = { page: "Designs", nodes: [snap(plan.roots[0], "100:1")] };
        ws.send(JSON.stringify({ id: req.id, ok: true, result }));
      });
      return;
    }
  })();
  const lines: string[] = [];
  const login = fileURLToPath(new URL("../../../packages/html-import/test/fixtures/login.html", import.meta.url));
  const code = await toFigma(login, { viewports: [390], page: "Designs", port, workdir: mkdtempSync(join(tmpdir(), "lw-cli-")) }, (s) => lines.push(s));
  await fake;
  assert.equal(code, 0, lines.join("\n"));
  assert.equal(plan.target.page, "Designs");
  assert.match(lines.join("\n"), /Connected to "TEST"[\s\S]*Plan: Sign in – 390[\s\S]*Built 1 screen\(s\) in Figma; verification passed/);
});

test("layerwright fonts lists an export's fonts and installs only TTF/OTF, once", async () => {
  const { fontsCommand } = await import("../src/cli.ts");
  const { mkdtempSync, mkdirSync, writeFileSync, readdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const src = mkdtempSync(join(tmpdir(), "lw-fonts-"));
  mkdirSync(join(src, "_ds", "kit", "fonts"), { recursive: true });
  for (const f of ["A-Regular.ttf", "A-Bold.otf", "A-Web.woff2"]) writeFileSync(join(src, "_ds", "kit", "fonts", f), "x");
  const dest = mkdtempSync(join(tmpdir(), "lw-dest-"));
  const lines: string[] = [];
  assert.equal(await fontsCommand([src], (s) => lines.push(s), dest), 0);
  assert.match(lines.join("\n"), /2 installable font file\(s\), 1 web-only/);
  assert.deepEqual(readdirSync(dest), []);
  assert.equal(await fontsCommand([src, "--install"], () => {}, dest), 0);
  assert.deepEqual(readdirSync(dest).sort(), ["A-Bold.otf", "A-Regular.ttf"]);
  const again: string[] = [];
  await fontsCommand([src, "--install"], (s) => again.push(s), dest);
  assert.match(again.join("\n"), /0 font\(s\) installed/);
});
