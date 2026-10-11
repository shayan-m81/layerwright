// What differs between macOS, Linux and Windows: starting npx, telling a free port, a watcher's lock, Claude Code's
// Monitor tool, paths in report drafts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { lockHeld, monitorAvailable } from "../src/meta.ts";
import { tcpProbe } from "../src/relay.ts";
import { redact } from "../src/memory.ts";

const launcher = fileURLToPath(new URL("../../../plugins/layer/scripts/run.mjs", import.meta.url));

test("the plugin's launcher runs npx with its arguments and passes its output and exit code through (npx.cmd on Windows)", () => {
  const v = spawnSync(process.execPath, [launcher, "--version"], { encoding: "utf8", timeout: 60_000 });
  assert.equal(v.status, 0);
  assert.match(v.stdout.trim(), /^\d+\.\d+\.\d+/);
  const fail = spawnSync(process.execPath, [launcher, "-c", "exit 3"], { encoding: "utf8", timeout: 60_000 });
  assert.equal(fail.status, 3);
});

test("a free port is told by its refusal, a taken one by its connection", async () => {
  const srv = createServer().listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  const port = (srv.address() as { port: number }).port;
  assert.equal(await tcpProbe(port), "open");
  await new Promise((r) => srv.close(r));
  assert.equal(await tcpProbe(port), "refused");
});

test("a watcher's lock counts while its owner lives and touches it; a lock nobody touched is a leftover", () => {
  const lock = join(mkdtempSync(join(tmpdir(), "lw-lock-")), "inbox.jsonl.lock");
  writeFileSync(lock, String(process.pid));
  assert.equal(lockHeld(lock), true);
  assert.equal(lockHeld(lock, process.pid), false, "not when it's the asker's own");
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old);
  assert.equal(lockHeld(lock), false, "a killed watcher (Windows reuses its pid) doesn't keep saying it runs");
});

test("Claude Code's Monitor tool: always on macOS and Linux; on Windows only with Git Bash", () => {
  assert.equal(monitorAvailable({}, "darwin"), true);
  assert.equal(monitorAvailable({}, "linux"), true);
  const has = (...files: string[]) => (p: string) => files.includes(p);
  const pf = "C:\\Program Files";
  assert.equal(monitorAvailable({ ProgramFiles: pf }, "win32", has(join(pf, "Git", "bin", "bash.exe"))), true);
  assert.equal(monitorAvailable({ ProgramFiles: pf }, "win32", has()), false);
  assert.equal(monitorAvailable({ CLAUDE_CODE_GIT_BASH_PATH: "D:\\tools\\bash.exe" }, "win32", has("D:\\tools\\bash.exe")), true);
  assert.equal(monitorAvailable({ PATH: "D:\\Git\\cmd" }, "win32", has(join("D:\\Git\\cmd", "git.exe"), join("D:\\Git\\cmd", "..", "bin", "bash.exe"))), true);
});

test("report drafts leave out Windows paths too", () => {
  assert.equal(redact("can't read C:\\Users\\Sara\\shop\\export"), "can't read <path>");
  assert.equal(redact("can't read /Users/sara/shop/export"), "can't read <path>");
});
