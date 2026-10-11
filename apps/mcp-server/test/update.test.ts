import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkForUpdate, newer, updateNotice } from "../src/update.ts";
import { PKG_VERSION } from "../src/meta.ts";

test("version order: patch/minor/major, and a pre-release is older than its release", () => {
  assert.ok(newer("0.2.0", "0.1.9"));
  assert.ok(newer("0.1.10", "0.1.9"));
  assert.ok(!newer("0.1.4", "0.1.4"));
  assert.ok(newer("0.2.0", "0.2.0-beta.1"));
  assert.ok(!newer("0.2.0-beta.1", "0.2.0"));
});

test("update check: asks the registry at most once a day, and says what to run", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "lw-upd-")), "update-check.json");
  let calls = 0;
  const fetchLatest = async () => { calls++; return "99.0.0"; };
  const a = await checkForUpdate({ file, fetchLatest, force: true, now: Date.parse("2026-09-29T10:00:00Z") });
  assert.equal(a.updateAvailable, true);
  assert.equal(a.current, PKG_VERSION);
  assert.equal(a.command, "npx -y layerwright@latest update", "the update command, in any folder (not init in a project)");
  await checkForUpdate({ file, fetchLatest, force: true, now: Date.parse("2026-09-29T20:00:00Z") });
  assert.equal(calls, 1, "cached for a day");
  await checkForUpdate({ file, fetchLatest, force: true, now: Date.parse("2026-09-30T11:00:00Z") });
  assert.equal(calls, 2);
  const offline = await checkForUpdate({ file: join(mkdtempSync(join(tmpdir(), "lw-upd-")), "u.json"), fetchLatest: async () => { throw new Error("offline"); }, force: true });
  assert.equal(offline.updateAvailable, false, "no network never breaks anything");
});

test("the notice at a session's start: only when a newer one is out, once a day per version", () => {
  const file = join(mkdtempSync(join(tmpdir(), "lw-upd-")), "update-notice.json");
  const day = 24 * 60 * 60 * 1000, t = Date.parse("2026-10-11T09:00:00Z");
  const out = { current: "1.3.0", latest: "1.4.0", updateAvailable: true };
  assert.equal(updateNotice({ current: "1.4.0", latest: "1.4.0", updateAvailable: false }, t, file), undefined);
  assert.equal(updateNotice(out, t, file), "Layerwright 1.4.0 is available (you have 1.3.0). Type /layer:update to update, or run: npx -y layerwright@latest update");
  assert.equal(updateNotice(out, t + 60_000, file), undefined, "not again the same day");
  assert.ok(updateNotice({ ...out, latest: "1.4.1" }, t + 120_000, file), "a newer one is news");
  assert.equal(updateNotice({ ...out, latest: "1.4.1" }, t + 180_000, file), undefined);
  assert.ok(updateNotice({ ...out, latest: "1.4.1" }, t + 120_000 + day + 1, file), "and the next day again");
});
