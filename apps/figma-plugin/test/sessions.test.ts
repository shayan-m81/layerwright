// The session desk: whose selection it is, asking the user, attributing changes, and refusing to overwrite
// another session's work.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SessionInfo } from "@cde/core";
import { SessionDesk, targets } from "../src/sessions.ts";

const A: SessionInfo = { id: "sa", name: "shop", color: "#7c3aed", connectedAt: 0 };
const B: SessionInfo = { id: "sb", name: "admin", color: "#0d99ff", connectedAt: 0 };

function setup() {
  let sel: { id: string; name: string }[] = [];
  let clock = 1000;
  const posted: any[] = [];
  const progress: string[] = [];
  let own: string[] | null = null; // the selection Layerwright itself set (own.ts)
  const desk = new SessionDesk({ selection: () => sel, post: (m) => posted.push(m), progress: (l) => progress.push(l), nodeName: async (id) => `Layer ${id}`, now: () => clock,
    ownSelection: () => (own && own.join() === sel.map((n) => n.id).sort().join() ? own : null) });
  desk.flushMs = 0;
  const select = (...ids: string[]) => { sel = ids.map((id) => ({ id, name: `Layer ${id}` })); desk.onSelectionChange(); };
  const lastDesk = () => posted.filter((m) => m.type === "desk").at(-1);
  /** Layerwright's own work selects these layers. */
  const ownSelect = (...ids: string[]) => {
    const same = sel.map((n) => n.id).sort().join() === [...ids].sort().join();
    sel = ids.map((id) => ({ id, name: id })); own = [...ids].sort();
    if (!same) desk.onSelectionChange(true); // like Figma: no selectionchange when nothing changed
  };
  return { desk, select, ownSelect, posted, progress, lastDesk, tick: (ms: number) => { clock += ms; }, setSel: (ids: string[]) => { sel = ids.map((id) => ({ id, name: id })); } };
}

test("alone, a session uses the selection as before, with no question asked", async () => {
  const t = setup();
  t.desk.setSessions([A]);
  t.select("1:1");
  await t.desk.claimSelection(A);
  assert.equal(t.lastDesk().asks.length, 0);
  assert.equal(t.desk.owner?.session, "sa");
});

test("with two sessions, a selection that isn't a session's makes it ask; the user's answer decides", async () => {
  const t = setup();
  t.desk.setSessions([A, B]);
  t.select("1:1", "1:2"); // goes to the newest session (B) by default, so A has to ask
  const claim = t.desk.claimSelection(A);
  await Promise.resolve();
  const ask = t.lastDesk().asks[0];
  assert.deepEqual(ask.session, "sa");
  assert.match(t.progress.at(-1)!, /Waiting for you: "shop" asks for your selection/);
  t.desk.answer(ask.id, true);
  await claim;
  assert.equal(t.lastDesk().owner, "sa");
  // Now it's A's: B has to ask, and "Not now" refuses with a reason the agent can act on.
  const other = t.desk.claimSelection(B);
  await Promise.resolve();
  t.desk.answer(t.lastDesk().asks[0].id, false);
  await assert.rejects(other, (e: any) => e.detail.type === "SELECTION_NOT_CONFIRMED" && /choose "admin" in the Layerwright window/.test(e.detail.message));
});

test("what a session's own work selects is that session's; another session can't take it without asking", async () => {
  const t = setup();
  t.desk.setSessions([A, B]);
  await t.desk.run("executePlan", {}, A, async () => { t.ownSelect("9:1"); return {}; });
  assert.equal(t.lastDesk().owner, "sa");
  await t.desk.claimSelection(A); // no question: A built and selected it
  const status = t.desk.pingInfo(B, [{ id: "9:1", name: "Screen", type: "FRAME" }]);
  assert.equal(status.selection, undefined, "B doesn't get the ids of A's selection");
  assert.equal(status.selectionOwner, "shop");
  assert.match(status.selectionNote!, /isn't this session's/);
  assert.deepEqual(t.desk.pingInfo(A, [{ id: "9:1", name: "Screen", type: "FRAME" }]).selectionOwner, "this session");
});

test("the user's own edits while a session's edit runs aren't credited to that session: no false CONFLICT for another session", async () => {
  const t = setup();
  t.desk.setSessions([A, B]);
  t.tick(10);
  // A renames 1:1; meanwhile the user edits 5:5 (Figma reports both as LOCAL).
  await t.desk.run("editNodes", { ops: [{ op: "rename", node: "1:1", name: "x" }] }, A, async () => {
    t.desk.onDocumentChange([{ id: "1:1", origin: "LOCAL", type: "PROPERTY_CHANGE" }, { id: "5:5", origin: "LOCAL", type: "PROPERTY_CHANGE" }, { id: "9:9", origin: "LOCAL", type: "CREATE" }]);
    return {};
  });
  t.tick(10);
  await t.desk.run("editNodes", { ops: [{ op: "set", node: "5:5", text: "Hi" }] }, B, async () => ({}));
  await assert.rejects(t.desk.run("editNodes", { ops: [{ op: "rename", node: "1:1", name: "y" }] }, B, async () => ({})), (e: any) => e.detail.type === "CONFLICT", "what A really changed still guards against B");
  await assert.rejects(t.desk.run("editNodes", { ops: [{ op: "delete", node: "9:9" }] }, B, async () => ({})), (e: any) => e.detail.type === "CONFLICT", "and what A created");
});

test("editing a layer another session changed after this one read it is refused; reading it again clears that", async () => {
  const t = setup();
  t.desk.setSessions([A, B]);
  const ops = { ops: [{ op: "set", node: "5:5", text: "Hi" }] };
  await t.desk.run("inspect", {}, A, async () => ({ nodes: [{ id: "5:1", children: [{ id: "5:5" }] }] }));
  t.tick(1000);
  await t.desk.run("editNodes", ops, B, async () => { t.desk.onDocumentChange([{ id: "5:5", origin: "LOCAL" }]); return {}; });
  t.tick(2000);
  let ran = false;
  await assert.rejects(t.desk.run("editNodes", ops, A, async () => { ran = true; return {}; }),
    (e: any) => e.detail.type === "CONFLICT" && /"Layer 5:5" \(5:5\) was changed by session "admin" 2s ago/.test(e.detail.message));
  assert.equal(ran, false, "nothing was changed");
  await t.desk.run("inspect", {}, A, async () => ({ nodes: [{ id: "5:5" }] }));
  t.tick(10);
  await t.desk.run("editNodes", ops, A, async () => { ran = true; return {}; });
  assert.equal(ran, true);
});

test("the user's own edits and a session's own edits are never conflicts", async () => {
  const t = setup();
  t.desk.setSessions([A, B]);
  const ops = { ops: [{ op: "rename", node: "7:7", name: "x" }] };
  t.tick(5);
  t.desk.onDocumentChange([{ id: "7:7", origin: "LOCAL" }]); // nothing running: the user did it
  await t.desk.run("editNodes", ops, A, async () => { t.desk.onDocumentChange([{ id: "7:7" }]); return {}; });
  t.tick(5);
  await t.desk.run("editNodes", ops, A, async () => ({}));
});

test("edits from different sessions run one after another, never interleaved", async () => {
  const t = setup();
  t.desk.setSessions([A, B]);
  const log: string[] = [];
  const slow = (name: string) => async () => { log.push(`${name} start`); await new Promise((r) => setTimeout(r, 20)); log.push(`${name} end`); return {}; };
  await Promise.all([t.desk.run("editNodes", {}, A, slow("A")), t.desk.run("editNodes", {}, B, slow("B")), t.desk.run("inspect", {}, B, async () => { log.push("read"); return {}; })]);
  assert.deepEqual(log.filter((l) => l !== "read"), ["A start", "A end", "B start", "B end"]);
  assert.equal(log.indexOf("read") < log.indexOf("A end"), true, "reads don't wait for edits");
});

test("a session that leaves stops waiting and loses the selection", async () => {
  const t = setup();
  t.desk.setSessions([A, B]);
  t.select("3:3");
  const claim = t.desk.claimSelection(A);
  await Promise.resolve();
  t.desk.setSessions([B]);
  await assert.rejects(claim, (e: any) => e.detail.type === "SELECTION_NOT_CONFIRMED");
  assert.equal(t.lastDesk().asks.length, 0);
});

test("targets: the existing layers an edit touches, not the ones it creates", () => {
  assert.deepEqual(targets("editNodes", { ops: [{ op: "duplicate", node: "1:1" }, { op: "rename", node: "$0", name: "x" }, { op: "group", nodes: ["1:2", "1:3"] }] }), ["1:1", "1:2", "1:3"]);
  assert.deepEqual(targets("applyTransformations", { transformations: [{ nodeId: "4:4" }] }), ["4:4"]);
  assert.deepEqual(targets("executePlan", { plan: {} }), []);
});

test("one session: every selection is its own, without a question", async () => {
  const t = setup();
  t.desk.setSessions([A]);
  t.select("7:1");
  assert.deepEqual([t.lastDesk().owner, t.lastDesk().to, t.lastDesk().why], ["sa", "sa", "only"]);
  await t.desk.claimSelection(A);
  assert.equal(t.lastDesk().asks.length, 0);
  t.select(); // nothing selected: nobody owns nothing
  assert.equal(t.desk.owner, null);
});

test("several sessions: nobody until the user picks one; then every new selection is that session's until they pick another", async () => {
  const t = setup();
  const C: SessionInfo = { id: "sc", name: "home", color: "#14ae5c", connectedAt: 99 }; // joined last
  t.desk.setSessions([A, B, C]);
  t.select("2:1");
  assert.deepEqual([t.lastDesk().owner, t.lastDesk().to, t.lastDesk().why], [null, null, null], "no guess: not the newest, not anybody");
  t.desk.assign("sa");
  assert.deepEqual([t.lastDesk().owner, t.lastDesk().to, t.lastDesk().why], ["sa", "sa", "picked"]);
  await t.desk.claimSelection(A);
  assert.equal(t.lastDesk().asks.length, 0, "the picked session uses it without asking");
  // Nothing moves it: other sessions working, joining, reconnecting.
  t.tick(10);
  await t.desk.run("editNodes", { ops: [{ op: "rename", node: "9:9", name: "x" }] }, B, async () => ({}));
  await t.desk.run("ping", {}, C, async () => ({}));
  t.desk.setSessions([A, B, C, { id: "sd", name: "new", color: "#e8a200", connectedAt: 500 }]);
  for (const id of ["2:2", "2:3"]) {
    t.select(id);
    assert.deepEqual([t.lastDesk().owner, t.lastDesk().to, t.lastDesk().why], ["sa", "sa", "picked"], `still A for ${id}`);
  }
  // Another session wants it: it asks; a yes makes it the user's pick from then on.
  const claim = t.desk.claimSelection(B);
  await Promise.resolve();
  assert.equal(t.lastDesk().asks.length, 1);
  t.desk.answer(t.lastDesk().asks[0].id, true);
  await claim;
  t.select("2:4");
  assert.deepEqual([t.lastDesk().to, t.lastDesk().why], ["sb", "picked"]);
  // The picked session leaves: nobody again, the user chooses.
  t.desk.setSessions([A, C]);
  t.select("2:5");
  assert.deepEqual([t.lastDesk().owner, t.lastDesk().to], [null, null]);
});

test("what a session's own work selects is that session's; the user's next selection goes back to their pick", async () => {
  const t = setup();
  t.desk.setSessions([A, B]);
  t.desk.assign("sa");
  await t.desk.run("executePlan", {}, B, async () => { t.ownSelect("9:1"); return {}; });
  assert.deepEqual([t.lastDesk().owner, t.lastDesk().to, t.lastDesk().why], ["sb", "sa", "picked"], "B may use what it built, but Send to stays the user's session");
  t.select("2:1");
  assert.deepEqual([t.lastDesk().owner, t.lastDesk().why], ["sa", "picked"], "not B's just because it was working");
  // A selection the user makes while B's edit runs is the user's: it goes to their pick, not to B.
  await t.desk.run("editNodes", { ops: [{ op: "rename", node: "1:1", name: "x" }] }, B, async () => { t.select("3:3"); return {}; });
  assert.equal(t.lastDesk().owner, "sa");
});

test("with nothing selected, Send to still names the user's pick (the chat box)", () => {
  const t = setup();
  t.desk.setSessions([A, B]);
  t.desk.publish();
  assert.equal(t.lastDesk().to, null);
  t.desk.assign("sb");
  t.select();
  assert.deepEqual([t.lastDesk().owner, t.lastDesk().to, t.lastDesk().why], [null, "sb", "picked"]);
});

test("a session that selects layers on purpose (select) gets them, even when they were already selected; another request doesn't claim the selection", async () => {
  const t = setup();
  t.desk.setSessions([A, B]);
  t.select("4:4"); // the user selected it: nobody's yet (no pick)
  assert.equal(t.lastDesk().owner, null);
  await t.desk.run("editNodes", { ops: [{ op: "rename", node: "1:1", name: "x" }] }, B, async () => ({}));
  assert.equal(t.lastDesk().owner, null, "an edit that selects nothing doesn't claim what happens to be selected");
  await t.desk.run("select", { nodeIds: ["4:4"] }, A, async () => { t.ownSelect("4:4"); return {}; });
  assert.deepEqual([t.lastDesk().owner, t.lastDesk().to], ["sa", null], "A selected it on purpose (no change for Figma to report): A's to use; Send to still waits for the user's pick");
});

test("the user's session survives a reconnect or the hub restarting (the list empties for a moment), and what a session read is kept, so no false CONFLICT", async () => {
  const t = setup();
  t.desk.setSessions([A, B]);
  t.desk.assign("sa");
  t.tick(10);
  // B changes 7:7; A reads it afterwards.
  await t.desk.run("editNodes", { ops: [{ op: "rename", node: "7:7", name: "x" }] }, B, async () => { t.desk.onDocumentChange([{ id: "7:7", origin: "LOCAL", type: "PROPERTY_CHANGE" }]); return {}; });
  t.tick(10);
  await t.desk.run("inspect", { target: "7:7" }, A, async () => ({ nodes: [{ id: "7:7" }] }));
  // The window reconnects: no sessions for a moment, then both again.
  t.desk.setSessions([]);
  t.tick(300);
  t.desk.setSessions([A, B]);
  t.select("2:1");
  assert.deepEqual([t.lastDesk().owner, t.lastDesk().to, t.lastDesk().why], ["sa", "sa", "picked"], "still the user's pick");
  await t.desk.run("editNodes", { ops: [{ op: "rename", node: "7:7", name: "y" }] }, A, async () => ({})); // no CONFLICT: A read it after B's change
});

test("when a second session joins, the one the user was using stays their session (and the line says so) until they pick another", () => {
  const t = setup();
  t.desk.setSessions([A]);
  t.select("2:1");
  assert.deepEqual([t.lastDesk().to, t.lastDesk().why], ["sa", "only"]);
  t.desk.setSessions([A, B]);
  t.select("2:2");
  assert.deepEqual([t.lastDesk().owner, t.lastDesk().to, t.lastDesk().why], ["sa", "sa", "kept"]);
  t.desk.assign("sb");
  t.select("2:3");
  assert.deepEqual([t.lastDesk().to, t.lastDesk().why], ["sb", "picked"]);
  // Back to one and up again: the user's pick stays theirs.
  t.desk.setSessions([B]);
  t.desk.setSessions([B, A]);
  assert.deepEqual([t.lastDesk().to, t.lastDesk().why], ["sb", "picked"]);
});
