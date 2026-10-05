// Older (0.x, single-session) Layerwright servers on this computer: found from the process list, and explained.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeOlder, findOlderServers, packageDirOf } from "../src/others.ts";
import { doctor } from "../src/setup.ts";

const PS = [
  "  101 npm exec layerwright@0.1.3",
  "  102 node /Users/me/.npm/_npx/aaa/node_modules/.bin/layerwright",
  "  103 /usr/local/bin/node /Users/me/.npm/_npx/bbb/node_modules/layerwright/dist/cli.js hub --port 7331",
  "  104 node /Users/me/.npm/_npx/bbb/node_modules/.bin/layerwright",
  "  105 node /Users/me/.npm/_npx/bbb/node_modules/.bin/layerwright inbox-watch",
  "  106 node /opt/proj/node_modules/layerwright/dist/cli.js --port 7332",
  "  107 node /Users/me/code/other/node_modules/.bin/tsx src/cli.ts",
].join("\n");
const VERSIONS: Record<string, string> = {
  "/Users/me/.npm/_npx/aaa/node_modules/layerwright": "0.1.3",
  "/Users/me/.npm/_npx/bbb/node_modules/layerwright": "1.0.0",
  "/opt/proj/node_modules/layerwright": "0.2.2",
};

test("a server's package folder comes from its command line; CLI subcommands (hub, inbox-watch…) aren't servers", () => {
  assert.equal(packageDirOf("node /x/_npx/aaa/node_modules/.bin/layerwright"), "/x/_npx/aaa/node_modules/layerwright");
  assert.equal(packageDirOf("node /x/node_modules/layerwright/dist/cli.js --port 7332"), "/x/node_modules/layerwright");
  assert.equal(packageDirOf("node /x/node_modules/layerwright/dist/cli.js serve"), "/x/node_modules/layerwright");
  assert.equal(packageDirOf("node /x/node_modules/.bin/layerwright hub --port 7331"), undefined);
  assert.equal(packageDirOf("node /x/node_modules/.bin/layerwright inbox-watch"), undefined);
  assert.equal(packageDirOf("npm exec layerwright@0.1.3"), undefined, "npm's wrapper isn't the server");
});

test("only 0.x servers are reported, with the folder they run in; this process and 1.x ones are left out", () => {
  const found = findOlderServers({ ps: () => PS, versionAt: (d) => VERSIONS[d], cwdOf: (pid) => (pid === 102 ? "/Users/me/self/gift-mvp" : undefined), self: 104 });
  assert.deepEqual(found, [{ pid: 102, version: "0.1.3", workdir: "/Users/me/self/gift-mvp" }, { pid: 106, version: "0.2.2", workdir: undefined }]);
  assert.match(describeOlder(found[0], "1.0.0"), /^The session in \/Users\/me\/self\/gift-mvp runs Layerwright 0\.1\.3, which can't share Figma .* "layerwright@0\.1\.3" to "layerwright@1\.0\.0" in \.mcp\.json/);
  assert.match(describeOlder(found[1], "1.0.0"), /^A session \(pid 106\)/);
  assert.deepEqual(findOlderServers({ ps: () => { throw new Error("no ps"); } }), [], "never throws");
});

test("doctor names a session still on 0.x and how to update it", async () => {
  const lines: string[] = [];
  await doctor({ dir: mkdtempSync(join(tmpdir(), "lw-older-")), port: 7398, skipBrowserCheck: true, out: (s) => lines.push(s),
    olderServers: () => [{ pid: 102, version: "0.1.3", workdir: "/Users/me/self/gift-mvp" }] });
  const text = lines.join("\n");
  assert.match(text, /✗ the session in \/Users\/me\/self\/gift-mvp runs Layerwright 0\.1\.3, a single-session server that can't share Figma/);
  assert.match(text, /fix: in that project change "layerwright@0\.1\.3" to "layerwright@\d+\.\d+\.\d+" in \.mcp\.json.*kill 102/);
});
