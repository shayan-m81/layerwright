// MCP tool surface. Claude reasons; these tools validate, resolve and execute deterministically.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  AnnotationDsl, Resolver, accessibilityFindings, analyzeDesign, compilePlan, designMetrics, emptyDesignSystem, enrichDesignSystem, Interaction, resolveInteraction, retrieve, snapshotToPlan, summarize, validatePlan, verifyAgainstPlan,
  type AnalysisResult, type DesignSystem, type ExecutionReport, type NodeSnapshot, type ResolvedPlan, type StructuredError, type TransformReport, type PlanSummary,
} from "@cde/core";
import { BridgeError, type FigmaTransport } from "./bridge.ts";
import { MappingStore, scanCodebase, verifyCodeUsage } from "./code.ts";
import { diffImages, importHtml, renderToPlan, screenshotHtml } from "@cde/html-import";
import { inlineImages } from "./images.ts";
import { PKG_VERSION, inboxFile, stateFile } from "./meta.ts";
import { withTask } from "./task.ts";
import { cachedUpdate, checkForUpdate, type UpdateInfo } from "./update.ts";
import { MemoryStore } from "./memory.ts";
import { readPrefs, writePrefs } from "./prefs.ts";
import { fontFix, groupFailures } from "./problems.ts";
import { INSTRUCTIONS, registerPrompts } from "./prompts.ts";
import { ACTION_LABELS, FigmaInbox, actionMeta, actionPrompt, layersLine, stopPrompt, waitingFor } from "./inbox.ts";
import { duplicateNames } from "@cde/core";
import { SkillStore, skillIndex, skillPreamble } from "./skills.ts";

type ToolResult = { content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[]; isError?: boolean };
const ok = (data: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(data) }] });
const fail = (errors: StructuredError[], extra: Record<string, unknown> = {}): ToolResult => ({ content: [{ type: "text", text: JSON.stringify({ success: false, errors, ...extra }) }], isError: true });

async function guard(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try { return await fn(); } catch (e) {
    if (e instanceof BridgeError) return fail([e.detail]);
    return fail([{ type: "FIGMA_API_ERROR", message: (e as Error).message ?? String(e) }]);
  }
}

/** watchChat: follow this session's chat (the plugin's hooks) to tell the Figma window when it waits for the user. */
export interface ServerOptions { workdir?: string; noUpdateCheck?: boolean; watchChat?: boolean; skills?: SkillStore }

export function createServer(bridge: FigmaTransport, opts: ServerOptions = {}) {
  const workdir = resolve(opts.workdir ?? process.env.LAYERWRIGHT_WORKDIR ?? process.cwd());
  const home = join(workdir, ".layerwright");
  const cacheDir = join(home, "cache");
  const mappings = new MappingStore(join(home, "mapping.json"));
  const memory = new MemoryStore(join(home, "memory.json"));
  const skills = opts.skills ?? new SkillStore();
  const plans = new Map<string, { plan: ResolvedPlan; summary: PlanSummary; report?: ExecutionReport; sources?: Record<string, { w: number; h?: number }>; webFonts?: Record<string, string[]> }>();
  const analyses = new Map<string, AnalysisResult>();
  let ds: DesignSystem | undefined;
  // Everything this server creates is tagged with the session (and run), so leftovers can be found and cleaned up.
  const session = `s${Date.now().toString(36)}`;
  let runSeq = 0;
  const meta = () => ({ session, run: `${session}.${++runSeq}` });
  let lastPage: string | undefined;

  const cacheFile = (fileName: string) => join(cacheDir, `${fileName.replace(/[^\w.-]+/g, "_")}.json`);
  /** Where `save` points, refused when it leaves the project (an absolute path elsewhere, ../, or a link out of it):
   *  an export never creates folders or overwrites files outside it. */
  const saveTarget = (save: string) => {
    const file = resolve(workdir, save);
    const within = (root: string, p: string) => { const r = relative(root, p); return r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r); };
    let real = file;
    while (!existsSync(real)) real = dirname(real);
    let ok = within(workdir, file);
    try { ok &&= within(realpathSync(workdir), realpathSync(real)); } catch { ok = false; }
    if (!ok) throw new BridgeError({ type: "UNSUPPORTED_PROPERTY", path: "save", message: `save must be a file or folder inside the project (${workdir}), relative to it, e.g. "exports/hero.png"; or true for .layerwright/exports. "${save}" is outside it.` });
    return file;
  };
  /** Write an exported image where the user can open it: true → .layerwright/exports/<node>.<ext>; a path → that file, or that folder. */
  const saveExport = (save: true | string, img: { base64: string; format: string; name: string }) => {
    const ext = img.format === "jpg" ? "jpg" : "png";
    const fileName = `${img.name.replace(/[^\p{L}\p{N}._]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "export"}.${ext}`;
    let file = save === true ? join(home, "exports", fileName) : saveTarget(save);
    if (save !== true && (/[\\/]$/.test(save) || (existsSync(file) && statSync(file).isDirectory()) || !/\.(png|jpe?g)$/i.test(file))) file = join(file, fileName);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, Buffer.from(img.base64, "base64"));
    return file;
  };
  const loadDs = (): DesignSystem | undefined => {
    if (ds) return ds;
    const name = bridge.info()?.fileName;
    if (name && existsSync(cacheFile(name))) ds = JSON.parse(readFileSync(cacheFile(name), "utf8"));
    return ds;
  };
  const needDs = () => {
    const d = loadDs();
    if (!d) throw new BridgeError({ type: "DESIGN_SYSTEM_NOT_SCANNED", message: "No Design System cached. Call figma_scan_design_system first." });
    return d;
  };
  const staleWarning = () => {
    const f = bridge.info()?.fileName;
    return ds && f && ds.fileName !== f ? [`Cached Design System is from "${ds.fileName}" but Figma has "${f}" open. Rescan if this file has its own components.`] : undefined;
  };

  // claude/channel: Claude Code (started with channels) shows requests from the Figma window in the conversation.
  const server = new McpServer({ name: "layerwright", version: PKG_VERSION }, { instructions: INSTRUCTIONS, capabilities: { experimental: { "claude/channel": {} } } });
  registerPrompts(server);
  // The plugin window names each session; the client's own name (claude-code, cursor…) helps tell them apart.
  server.server.oninitialized = () => { const c = server.server.getClientVersion(); if (c?.name) bridge.setClient?.(c.name); };

  // Requests the user sends from the Figma window to this session (inbox.ts). Claude Code gets them pushed as a
  // channel message; every client also finds them in its next tool result, or with figma_inbox.
  let watchTold = false;
  /** This server's own command line, to run one of its subcommands (inbox-watch). */
  const selfCommand = (sub: string) => [process.execPath, ...process.execArgv, process.argv[1], sub].filter(Boolean).map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(" ");
  const inbox = new FigmaInbox((id, status, message) => bridge.actionUpdate?.(id, status, message));
  bridge.onActionDrop = (id, by) => inbox.drop(id, by);
  bridge.onActionStop = (id) => {
    if (!inbox.stop(id)) return;
    // Wake the session the same ways a request does: the channel, and the monitor's file.
    const push = /claude/i.test(server.server.getClientVersion()?.name ?? "");
    if (push) server.server.notification({ method: "notifications/claude/channel", params: { content: stopPrompt(id), meta: { request_id: id, action: "stop" } } }).catch(() => {});
    const file = push ? inboxFile() : undefined;
    if (file) { try { mkdirSync(dirname(file), { recursive: true }); appendFileSync(file, JSON.stringify({ id, stop: true }) + "\n"); } catch { /* the next tool result says it too */ } }
  };
  bridge.onAction = (a) => {
    const client = server.server.getClientVersion()?.name ?? "";
    const push = /claude/i.test(client);
    if (push) server.server.notification({ method: "notifications/claude/channel", params: { content: actionPrompt(a), meta: actionMeta(a) } }).catch(() => {});
    // Claude Code's plugin monitor (layerwright inbox-watch) reads this file and wakes the session: no channel needed.
    const file = push ? inboxFile() : undefined;
    if (file) { try { mkdirSync(dirname(file), { recursive: true }); appendFileSync(file, JSON.stringify({ id: a.id, kind: a.kind, text: a.text, skills: a.skills, layers: layersLine(a) }) + "\n"); } catch { /* the channel or the next tool result still carries it */ } }
    inbox.add(a, push);
  };
  // Asking the user in the chat. The plugin's hooks (layerwright hook-event) write what this session does there: it
  // asked a question, needs a permission, or ended its turn. When it is waiting for the user (and it works in Figma),
  // the Figma window and its cursor say "answer in Claude Code"; any next tool call means it's working again.
  let waiting: { kind: string; text?: string } | undefined;
  let figmaAt = 0;
  const tellWaiting = (w?: { kind: string; text?: string }) => {
    if (JSON.stringify(w) === JSON.stringify(waiting)) return;
    waiting = w;
    bridge.notify?.({ type: "session-state", waiting: !!w, kind: w?.kind, text: w?.text });
  };
  const chatState = stateFile();
  if (chatState && opts.watchChat !== false) {
    let seen = 0;
    const poll = setInterval(() => {
      let at = 0;
      try { at = statSync(chatState).mtimeMs; } catch { return; }
      if (at === seen) return;
      seen = at;
      let ev: { event?: string; text?: string } = {};
      try { ev = JSON.parse(readFileSync(chatState, "utf8")); } catch { return; }
      const decided = waitingFor(ev, inbox.pendingCount() > 0);
      // Only sessions that work in Figma (lately, or on a request from the window) bother the user there.
      if (decided && !(inbox.pendingCount() > 0 || Date.now() - figmaAt < 20 * 60_000)) return;
      tellWaiting(decided);
    }, 700);
    poll.unref?.();
  }

  // Requests from the Figma window can run side by side (in background subagents): a Figma tool call that names its
  // `requestId` (the request from the window it works for) is drawn with that request's own cursor (task.ts).
  const REQUEST_ID = z.string().max(40).optional().describe("The id of the request from the Figma window this call is for (from figma_inbox, or the message that brought it). With several requests running at once, each shows its own cursor in Figma");
  const NO_TASK = new Set(["figma_status", "figma_inbox", "figma_reply"]);
  // Every failed tool call is remembered for this project (see memory.ts), so recurring problems surface with a hint.
  const register = server.registerTool.bind(server) as (...a: any[]) => unknown;
  (server as any).registerTool = (name: string, cfg: any, handler: (...a: any[]) => Promise<ToolResult>) => {
    const tasked = /^figma_/.test(name) && !NO_TASK.has(name) && !!cfg?.inputSchema && typeof cfg.inputSchema === "object" && !("requestId" in cfg.inputSchema);
    return register(name, tasked ? { ...cfg, inputSchema: { ...cfg.inputSchema, requestId: REQUEST_ID } } : cfg, async (...a: any[]) => {
    let task: string | undefined;
    if (tasked && a[0] && typeof a[0] === "object") { const { requestId: t, ...rest } = a[0]; task = typeof t === "string" && t ? t : undefined; a = [rest, ...a.slice(1)]; }
    if (/^figma_/.test(name)) figmaAt = Date.now();
    tellWaiting(undefined); // it is working again: not waiting for the user
    // Work for a request the user stopped in the window goes no further.
    if (task && inbox.isStopped(task)) return fail([{ type: "STOPPED", message: stopPrompt(task) }]);
    const r = await withTask(task, () => handler(...a));
    if (r.isError) {
      try { const d = JSON.parse((r.content[0] as { text: string }).text); for (const e of (d.errors ?? []).slice(0, 3)) memory.problem(name, e.type, e.path ? `${e.path}: ${e.message}` : e.message); } catch { /* not JSON */ }
    }
    // A request from the Figma window that this session hasn't seen yet rides along with whatever it called.
    const halted = inbox.takeStopped();
    if (halted.length) r.content.push({ type: "text", text: JSON.stringify({ stoppedInFigma: halted.map((x) => x.id), note: halted.map((x) => stopPrompt(x.id)).join(" ") }) });
    const fresh = name === "figma_inbox" || name === "figma_reply" ? [] : inbox.takeUntold();
    if (fresh.length) r.content.push({ type: "text", text: JSON.stringify({ fromFigma: fresh.map((x) => ({ id: x.id, request: actionPrompt(x) })),
      note: "The user sent this from the Figma window while you were working. Don't drop what you're doing: if it touches other layers, start it in a background subagent now (it passes requestId: \"<id>\" on its Figma calls); if it's about the same layers, do it right after (if it already arrived as a <channel> or Monitor message with the same request id, it's the same request)." }) });
    return r;
    });
  };
  /** Choices made by id between same-named components are remembered and reused. */
  const rememberChoices = (plan: any) => {
    const d = loadDs();
    const dups = new Set((d && duplicateNames(d) || []).map((x) => x.name));
    if (!d || !dups.size) return;
    const walk = (n: any) => {
      if (n?.component && typeof n.component === "object" && n.component.id) {
        const set = d.componentSets.find((x) => x.id === n.component.id) ?? d.components.find((x) => x.id === n.component.id);
        const name = set ? ("variantIds" in set ? set.name : set.componentSet ?? set.name) : undefined;
        const setId = set && !("variantIds" in set) && set.componentSetId ? set.componentSetId : set?.id;
        if (name && setId && dups.has(name)) memory.rememberComponent(name, setId);
      }
      (n?.children ?? []).forEach(walk);
    };
    [...(plan.screens ?? []), ...(plan.inserts ?? []).flatMap((x: any) => x.nodes)].forEach(walk);
  };
  const preferred = () => Object.fromEntries(Object.entries(memory.read().components).map(([k, v]) => [k, v.id]));

  // Update check: once a day at most, in the background; the plugin window and figma_status show the result.
  let update: UpdateInfo | undefined = cachedUpdate();
  const serverInfo = () => ({ type: "server-info", version: PKG_VERSION, update });
  if (!opts.noUpdateCheck) checkForUpdate().then((u) => { update = u; bridge.notify?.(serverInfo()); }).catch(() => {});
  bridge.onHello = () => bridge.notify?.(serverInfo());

  server.registerTool("figma_status", {
    description: "Check whether the Figma bridge plugin is connected, which file/page is open, the current selection, and whether a Design System scan is cached. Cheap; call first, with a title for this session.",
    inputSchema: {
      title: z.string().trim().min(2).max(40).optional().describe("2–4 words naming what this session is doing (e.g. \"Checkout redesign\", \"Login bug fix\"), in the user's language. The Figma plugin window shows it, so the user can tell sessions apart and give the right one their selection. Set it on the first call; again only when the task changes"),
      listen: z.boolean().optional().describe("Return doFirst (the watcher that wakes this session when the user sends a request from the Figma window) even if it was returned before: /layer:connect"),
    },
  }, async ({ title, listen }) => guard(async () => {
    if (bridge.kicked) await bridge.rejoin?.();
    if (title) bridge.setTitle?.(title);
    // The language the user chose to be told things in (every project, every session): layerwright_memory language.
    const language = readPrefs().language;
    const base = { connected: bridge.connected(), file: bridge.info()?.fileName, designSystemCached: !!loadDs(), designSystemScannedAt: ds?.scannedAt, workdir,
      ...(language ? { language, languageNote: `Explain things to the user in ${language} (their saved choice), here and in figma_reply messages.` } : {}) };
    // Requests from the Figma window should start this session by themselves. The plugin's monitor does that in a
    // terminal; where plugin monitors don't run (the desktop app), the agent starts the same watcher once.
    const watch = (!watchTold || listen) && /claude/i.test(server.server.getClientVersion()?.name ?? "") && inboxFile()
      ? { doFirst: { tool: "Monitor", command: selfCommand("inbox-watch"), description: "Requests from the Layerwright window in Figma", timeout_ms: 1800000 },
          requestsFromFigma: "Before you answer the user, start the Monitor in doFirst (silently, no need to mention it). It wakes this session when the user sends a request from the Figma window, so they never have to type /layer:inbox. It exits at once if a watcher already runs for this session. When it expires, start it again. When it reports a request, call figma_inbox and do it." }
      : undefined;
    if (watch) watchTold = true;
    // Skills help with every job, Figma open or not (Figma → code, a spec, a critique of a screenshot).
    let skillList: ReturnType<typeof skillIndex>;
    try { skillList = skillIndex(skills); } catch { /* skills are a help, never a reason figma_status fails */ }
    if (!bridge.connected()) return ok({ ...base, ...watch, skills: skillList, hint: "Open Figma desktop → Plugins → Development → Layerwright." });
    const ping = await bridge.request<{ page: string; dsChangedSinceScan?: boolean; watchingSince?: string }>("ping", { scannedAt: ds?.scannedAt }, 10_000);
    const warnings = [...(staleWarning() ?? [])];
    if (ds && ping.dsChangedSinceScan) warnings.push("Components or styles changed in Figma since the last scan. Rescan (figma_scan_design_system refresh: true) before planning.");
    if (update?.updateAvailable) warnings.push(`Layerwright ${update.latest} is available (this is ${update.current}). Tell the user once: ${update.steps?.join(" → ")}.`);
    if (lastPage && ping.page !== lastPage) warnings.push(`Figma now shows page "${ping.page}", but the last build went to "${lastPage}". Plans build on the current page unless target.page is set.`);
    const shared = bridge.session && (bridge.sessionCount ?? 1) > 1
      ? { sharedFigma: { thisSession: bridge.session.name, sessions: bridge.sessionCount, note: "Other Claude/Cursor sessions use this Figma file too. Work on layers by id; a selection is yours only when the user gives it to this session in the Layerwright window (figma_inspect target 'selection' asks them)." } }
      : undefined;
    if (bridge.session && !bridge.session.titled) warnings.push(`The plugin window calls this session "${bridge.session.name}" (its folder). Call figma_status again with title: 2–4 words naming the task, so the user can tell sessions apart.`);
    return ok({ ...base, ...ping, ...shared, ...watch, session, version: PKG_VERSION, memory: memory.summary(), skills: skillList, update: update?.updateAvailable ? update : undefined, warnings: warnings.length ? warnings : undefined });
  }));

  server.registerTool("figma_inbox", {
    description: "Requests the user sent from the Figma window to this session (they select layers, pick this session and an action such as \"Build this in code\", or write their own words), plus open ones no other session is handling, which this session takes over. Returns each with what to do and the layers. Do them, and report each with figma_reply. /layer:inbox calls this.",
    inputSchema: {
      takeOver: z.boolean().optional().describe("true only when the user typed /layer:inbox in this session: that moves here requests sent to other sessions that haven't started on them. Leave it off when a Monitor event or fromFigma brought you here: then only requests whose session left or never picked them up come here"),
    },
  }, async ({ takeOver }) => guard(async () => {
    // Requests sent to other sessions: taken only when nobody is on them (the hub decides, see Hub.takeable); the
    // rest are listed so this session leaves them alone.
    const elsewhere: { id: string; session?: string; status?: string; what: string }[] = [];
    for (const r of (await bridge.inboxList?.()) ?? []) {
      if (inbox.get(r.action.id)) continue;
      const got = bridge.inboxTake ? await bridge.inboxTake(r.action.id, !!takeOver) : { action: await bridge.inboxClaim?.(r.action.id, !!takeOver) };
      if (got.action) inbox.adopt(got.action);
      else elsewhere.push({ id: r.action.id, session: got.heldBy ?? r.sessionName, status: got.status ?? r.status, what: `${ACTION_LABELS[r.action.kind] ?? r.action.kind} on ${layersLine(r.action)}` });
    }
    const others = elsewhere.length ? { elsewhere, elsewhereNote: "Sent to other sessions, which have them: leave these alone (the user can move one here with /layer:inbox in this session, unless it's already being worked on)." } : {};
    const open = inbox.takeOpen();
    if (!open.length) return ok({ requests: [], ...others, note: "Nothing from the Figma window for this session. The user sends requests from the Layerwright plugin: select layers → choose this session → pick an action." });
    return ok({ requests: open.map((x) => ({ id: x.action.id, status: x.status, request: actionPrompt(x.action) })), ...others, next: "Do them in order; figma_reply({ id, status: \"working\" }) when you start one, and status \"done\" with a one-line message when it's finished." });
  }));

  server.registerTool("figma_reply", {
    description: "Tell the user in the Figma window how a request from there is going (status working, done or failed, with a one-line message: what you did and where, or what you need). Without an id it posts a note to the window.",
    inputSchema: {
      id: z.string().max(40).optional().describe("The request id (from the <channel> message, fromFigma or figma_inbox)"),
      status: z.enum(["working", "done", "failed"]).optional(),
      message: z.string().max(400).optional().describe("One line for the user, in their language"),
    },
  }, async ({ id, status, message }) => guard(async () => {
    if (id) {
      if (inbox.isStopped(id)) return fail([{ type: "STOPPED", message: stopPrompt(id) }]);
      if (!inbox.reply(id, status ?? "working", message)) {
        const by = inbox.takenBy(id);
        return fail([{ type: "INVALID_PLAN", message: by ? `Request ${id} was taken over by ${by}, which handles it now: stop working on it here.` : `No request ${id} from the Figma window in this session. figma_inbox lists them.` }]);
      }
      return ok({ success: true, id, status: status ?? "working" });
    }
    if (!message) return fail([{ type: "INVALID_PLAN", message: "Give a message (or an id and a status)." }]);
    bridge.actionUpdate?.(`note-${Date.now().toString(36)}`, "done", message);
    return ok({ success: true });
  }));

  server.registerTool("figma_scan_design_system", {
    description: "Scan the open Figma file for components, component sets/variants/properties, variables (+modes), text/paint/effect styles and library components used in the file. Normalizes, infers semantic roles, caches to disk, and returns a COMPACT summary (not the full dump). Use refresh=true after the DS changed.",
    inputSchema: { refresh: z.boolean().optional(), includeLibraries: z.boolean().optional().describe("Include enabled library variable collections (default true)"),
      reload: z.boolean().optional().describe("Re-read the cache file from disk (after editing it) instead of scanning"),
      maxInstances: z.number().int().min(100).max(200000).optional().describe("How many instances to check for library components (default: 3000, or every instance on the current page)") },
  }, async ({ refresh, includeLibraries, reload, maxInstances }) => guard(async () => {
    if (reload) { ds = undefined; if (!loadDs()) return fail([{ type: "DESIGN_SYSTEM_NOT_SCANNED", message: "No cache file for this Figma file; scan instead." }]); return ok({ cached: true, reloaded: true, ...summarize(ds!) }); }
    if (!refresh && loadDs() && !staleWarning()) return ok({ cached: true, ...summarize(ds!) });
    const raw: any = await bridge.request("scanDesignSystem", { includeLibraries, maxInstances }, 600_000);
    const { warnings, timings, ...rest } = raw;
    ds = enrichDesignSystem(rest);
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(cacheFile(ds.fileName), JSON.stringify(ds));
    return ok({ cached: false, warnings, timingsMs: timings, ...summarize(ds) });
  }));

  server.registerTool("figma_get_design_context", {
    description: "Retrieve ONLY the Design System parts relevant to a task (components with variants/properties, spacing/color/radius tokens, text styles, and known code mappings). Use before writing a Design Plan. Example task: 'password reset flow: email, OTP, new password, success'.",
    inputSchema: { task: z.string(), roles: z.array(z.string()).optional().describe("Extra semantic roles, e.g. ['otp-input','toast']"), limit: z.number().int().min(1).max(40).optional() },
  }, async ({ task, roles, limit }) => guard(async () => {
    const d = needDs();
    const r = retrieve(d, task, { roles, limit });
    const maps = r.components.map((c) => mappings.forComponent(c.name)).filter(Boolean);
    return ok({ ...r, codeMappings: maps, warnings: staleWarning() });
  }));

  server.registerTool("figma_inspect", {
    description: "Read Figma nodes: the selection (default), the current page (top level) or a node id. format: tree (default; compact snapshot of layout, fills, bound variables, text styles, instances), summary (counts, instances per component, top-level children; cheap for big frames), text (every text layer, flat), instances (every instance with variants, props and overrides, flat), plan (the subtree as a Design Plan you can edit and send to figma_preview_plan: clone, refactor, or implement in code). Big answers are capped; use summary, a smaller depth, or offset/limit.",
    inputSchema: { target: z.string().optional().describe("'selection' (default) | 'page' | a node id"), depth: z.number().int().min(0).max(20).optional(), maxNodes: z.number().int().min(1).max(5000).optional(),
      expandInstances: z.boolean().optional().describe("tree: descend into instances (their text, hidden layers, overrides)"),
      format: z.enum(["tree", "summary", "text", "instances", "plan"]).optional(),
      offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(500).optional().describe("text/instances: page through the list (default 100)") },
  }, async ({ target, depth, maxNodes, expandInstances, format, offset, limit }) => guard(async () => {
    const f = format ?? "tree";
    const deep = f !== "tree";
    const res = await bridge.request<{ page: string; nodes: NodeSnapshot[] }>("inspect", { target, svg: f === "plan", depth: depth ?? (deep ? 20 : undefined), maxNodes: maxNodes ?? (deep ? 5000 : undefined), expandInstances: deep || expandInstances }, 120_000);
    if (!res.nodes.length) return fail([{ type: "NODE_NOT_FOUND", message: "Nothing selected. Pass a node id or ask the user to select a frame." }]);
    const flat: { n: NodeSnapshot; path: string; inInstance: boolean }[] = [];
    const walk = (n: NodeSnapshot, path: string, inInstance: boolean) => { flat.push({ n, path, inInstance }); (n.children ?? []).forEach((c) => walk(c, `${path} / ${c.name}`, inInstance || n.type === "INSTANCE")); };
    res.nodes.forEach((n) => walk(n, n.name, false));
    const page = <T,>(items: T[]) => { const o = offset ?? 0, l = limit ?? 100; return { items: items.slice(o, o + l), total: items.length, offset: o, next: o + l < items.length ? o + l : undefined }; };
    if (f === "summary") {
      const byType: Record<string, number> = {}, byComponent: Record<string, number> = {};
      for (const { n, inInstance } of flat) { if (inInstance) continue; byType[n.type] = (byType[n.type] ?? 0) + 1; if (n.instance) { const k = `${n.instance.componentSet ?? n.instance.component}${n.instance.variants ? ` / ${Object.values(n.instance.variants).join(", ")}` : ""}`; byComponent[k] = (byComponent[k] ?? 0) + 1; } }
      return ok({ page: res.page, roots: res.nodes.map((n) => ({ id: n.id, type: n.type, name: n.name, size: `${n.w}×${n.h}`, layout: n.layout?.mode, children: (n.children ?? []).map((c) => ({ id: c.id, type: c.type, name: c.name, size: `${c.w}×${c.h}` })).slice(0, 60) })), byType, instancesByComponent: byComponent, hiddenLayers: flat.filter((x) => x.n.visible === false && !x.inInstance).length });
    }
    if (f === "text") return ok({ page: res.page, ...page(flat.filter((x) => x.n.type === "TEXT").map(({ n, path, inInstance }) => ({ id: n.id, path, text: n.text?.chars, style: n.text?.style ?? n.text?.font, size: n.text?.fontSize, inInstance: inInstance || undefined, hidden: n.visible === false || undefined }))) });
    if (f === "instances") return ok({ page: res.page, ...page(flat.filter((x) => x.n.type === "INSTANCE").map(({ n, path }) => ({ id: n.id, path, componentSet: n.instance?.componentSet, componentSetId: n.instance?.componentSetId, component: n.instance?.component, componentId: n.instance?.componentId, variants: n.instance?.variants, props: n.instance?.props, overrides: n.instance?.overrides }))) });
    if (f === "plan") {
      const out = res.nodes.map((n) => snapshotToPlan(n, loadDs()));
      const plan = { ...out[0].plan, screens: out.flatMap((o) => o.plan.screens) };
      return ok({ plan, warnings: out.flatMap((o) => o.warnings).slice(0, 30), next: "Edit the plan (or reuse it as is), then figma_preview_plan. Instances point at their component set by id." });
    }
    const text = JSON.stringify(res);
    if (text.length > 80_000) return ok({ truncated: true, chars: text.length, hint: "This tree is too big to return whole. Use format: \"summary\" first, then inspect a child by id, lower depth, or format text/instances with offset/limit.", preview: text.slice(0, 20_000) });
    return ok(res);
  }));

  server.registerTool("figma_preview_plan", {
    description: "Validate a Design Plan (Design DSL JSON) with Zod, resolve every component/variant/property/token against the cached Design System, and return a planId + human-readable summary WITHOUT touching Figma. Invalid plans or unresolved components return structured errors with suggestions — fix the plan and preview again.",
    inputSchema: { plan: z.any().describe("DesignPlan object: { name, screens: DesignNode[], target?, screenGap? }. See the figma-design skill for the DSL.") },
  }, async ({ plan }) => guard(async () => {
    const v = validatePlan(plan);
    if (!v.success) return fail(v.errors);
    // A plan with only raw values needs no scan; one that references components or tokens gets a clear hint.
    const cachedDs = loadDs();
    const d = cachedDs ?? emptyDesignSystem(bridge.info()?.fileName);
    rememberChoices(v.plan);
    const c = compilePlan(d, v.plan, { preferred: preferred() });
    if (!c.ok || !c.plan) {
      const needsScan = !cachedDs && c.errors.some((e) => ["COMPONENT_NOT_FOUND", "TOKEN_NOT_FOUND", "STYLE_NOT_FOUND", "INVALID_VARIANT"].includes(e.type));
      return fail(needsScan ? [{ type: "DESIGN_SYSTEM_NOT_SCANNED", message: "This plan uses components, tokens or styles; call figma_scan_design_system first." }, ...c.errors] : c.errors, { warnings: c.warnings, summary: c.summary });
    }
    plans.set(c.plan.planId, { plan: c.plan, summary: c.summary });
    const destructive = !!c.plan.target.parentId || !!c.plan.inserts?.length;
    return ok({ success: true, planId: c.plan.planId, summary: c.summary, warnings: [...c.warnings, ...(staleWarning() ?? [])], requiresApproval: destructive, next: destructive ? "Show the summary to the user; call figma_execute_plan with approved=true only after they agree." : "Show the summary; then call figma_execute_plan (creates new frames only)." });
  }));

  server.registerTool("import_html_to_plan", {
    description: "Convert an HTML page or folder (e.g. a Claude Design standalone HTML export) into an editable Design Plan: flexbox → Auto Layout, colors, borders, radii, shadows, gradients, fonts, text (incl. RTL), images and SVG icons. With a scanned Design System, buttons/inputs/links become real DS components. Returns a planId for figma_execute_plan, exactly like figma_preview_plan. Nothing is sent to Figma yet.",
    inputSchema: {
      path: z.string().describe("An .html file, or a folder containing index.html"),
      viewport: z.union([z.number().int().min(200).max(4000), z.array(z.number().int().min(200).max(4000)).min(1).max(6)]).optional().describe("Viewport width(s). Default [1440, 390] (desktop + mobile)"),
      useDesignSystem: z.boolean().optional().describe("Map buttons/inputs/links to scanned DS components (default: true when a DS is cached)"),
      selector: z.string().optional().describe("CSS selector of the element to import (default body)"),
      mappings: z.array(z.object({
        selector: z.string().describe("CSS selector, e.g. .btn-primary"),
        component: z.union([z.string(), z.object({ id: z.string().optional(), key: z.string().optional() }).strict()]),
        variant: z.union([z.string(), z.record(z.string())]).optional(),
        props: z.record(z.union([z.string(), z.boolean()])).optional().describe('Component props; "$text" is the element\'s text (default: { label: "$text" })'),
      })).optional().describe("Your own element → component mappings; they win over automatic Design System matching"),
      fontMap: z.record(z.string()).optional().describe('Replace font families, e.g. { "YekanBakhFaNum": "IRANYekanX" } for a web font that isn\'t installed'),
      page: z.string().optional().describe("Page (name or id) to build on when executed (default: the current page)"),
      targets: z.array(z.object({ selector: z.string(), name: z.string().optional() })).max(50).optional()
        .describe("Several elements, each its own screen (e.g. the cards of a Claude Design review board); each keeps its rendered width"),
      target: z.object({ parentId: z.string().optional(), x: z.number().optional(), y: z.number().optional() }).optional()
        .describe("Where to build: inside an existing node such as a section (needs approval), or at x/y on the page"),
    },
  }, async ({ path, viewport, useDesignSystem, selector, mappings: userMappings, fontMap, page, targets, target }) => guard(async () => {
    const cached = loadDs();
    const useDs = useDesignSystem ?? !!cached;
    if (useDs && !cached) return fail([{ type: "DESIGN_SYSTEM_NOT_SCANNED", message: "useDesignSystem needs a scan. Call figma_scan_design_system, or pass useDesignSystem: false." }]);
    const d = useDs ? cached! : emptyDesignSystem(bridge.info()?.fileName);
    // What worked before in this project is the default; what's passed now wins and is remembered.
    const mem = memory.read();
    const usedFonts = { ...mem.fontMap, ...(fontMap ?? {}) };
    const usedMappings = [...mem.mappings.filter((m) => !(userMappings ?? []).some((u) => u.selector === m.selector)), ...(userMappings ?? [])];
    memory.rememberFonts(fontMap); memory.rememberMappings(userMappings);
    const exportDir = (() => { const p = resolve(workdir, path); try { return statSync(p).isDirectory() ? p : dirname(p); } catch { return dirname(p); } })();
    memory.update((m) => { m.lastExport = exportDir; });
    const r = await renderToPlan(resolve(workdir, path), { viewports: viewport === undefined ? (targets?.length ? [1440] : undefined) : [viewport].flat(), selector, targets, ds: useDs ? d : undefined, mappings: usedMappings.length ? usedMappings : undefined, fontMap: Object.keys(usedFonts).length ? usedFonts : undefined });
    const c = compilePlan(d, page || target ? { ...r.plan, target: { ...(r.plan.target ?? {}), ...(target ?? {}), ...(page ? { page } : {}) } } : r.plan, { preferred: preferred() });
    const fromMemory = { fontMap: Object.keys(mem.fontMap).filter((k) => !fontMap?.[k]).length ? mem.fontMap : undefined, mappings: usedMappings.length - (userMappings?.length ?? 0) || undefined };
    if (!c.ok || !c.plan) return fail(c.errors, { warnings: [...r.warnings, ...c.warnings], summary: c.summary });
    plans.set(c.plan.planId, { plan: c.plan, summary: c.summary, sources: r.sources, webFonts: r.webFonts });
    const intoExisting = !!c.plan.target.parentId;
    return ok({ success: true, planId: c.plan.planId, summary: c.summary, mappedToDesignSystem: r.mapped, fromMemory: fromMemory.fontMap || fromMemory.mappings ? fromMemory : undefined, webFonts: Object.keys(r.webFonts).length ? r.webFonts : undefined, warnings: [...r.warnings, ...c.warnings].slice(0, 30),
      requiresApproval: intoExisting || undefined, next: `${intoExisting ? "Show the summary; this builds inside an existing node, so call figma_execute_plan with approved: true after the user agrees." : "Show the summary; then call figma_execute_plan with this planId."} Afterwards, match it to the Design System: figma_analyze_design({ target, mode: "sync" }).` });
  }));

  server.registerTool("figma_execute_plan", {
    description: "Execute a previously previewed plan in Figma (native frames, Auto Layout, component instances, variables, styles). One undo step. Rolls back fully on failure. Automatically verifies the result against the plan. Requires approved=true when the plan writes into an existing node.",
    inputSchema: { planId: z.string(), approved: z.boolean().optional() },
  }, async ({ planId, approved }) => guard(async () => {
    const entry = plans.get(planId);
    if (!entry) return fail([{ type: "INVALID_PLAN", message: `Unknown planId ${planId}. Call figma_preview_plan first.` }]);
    if ((entry.plan.target.parentId || entry.plan.inserts?.length) && !approved) return fail([{ type: "NOT_APPROVED", message: "This plan modifies an existing node. Ask the user, then call again with approved=true." }]);
    const images = await inlineImages(entry.plan);
    const m = meta();
    const report = await bridge.request<ExecutionReport>("executePlan", { plan: images.plan, meta: m }, 180_000);
    entry.report = report;
    lastPage = report.page?.name;
    const mismatches = await verifyPlan(entry.plan, report, entry.sources);
    if (mismatches.length) memory.problem("figma_execute_plan", "VERIFICATION", `${mismatches.length} mismatch(es): ${[...new Set(mismatches.map((m) => m.issue))].join("; ")}`);
    return ok({ success: true, created: report.createdRootIds, page: report.page?.name, run: m.run, nodeCount: Object.keys(report.nodeIds).length, warnings: [...images.warnings, ...explainFonts(report.warnings, entry.webFonts)], verification: verdict(mismatches),
      next: "Check it visually with figma_export_image (pass compareWith: { html } for an HTML import)." });
  }));

  /** Say why a font is missing when the page only ships it as a web font (Figma can't load .woff/.woff2). */
  const explainFonts = (warnings: string[], webFonts: Record<string, string[]> = {}) => warnings.map((w) => {
    const m = w.match(/^Font "([^"]+)" is not (?:available|installed)/);
    if (!m) return w;
    const exportDir = memory.read().lastExport;
    const shipped = fontFix([m[1]], exportDir);
    // The export ships the font: say exactly how to install it.
    if (shipped.startsWith("Your export ships")) return `${w} ${shipped}`;
    const formats = Object.entries(webFonts).find(([f]) => f.toLowerCase() === m[1].toLowerCase())?.[1];
    if (!formats) return `${w} Install it on this computer and restart Figma, or re-import with fontMap: { "${m[1]}": "<an installed family>" }.`;
    const webOnly = formats.length > 0 && formats.every((f) => f === "woff" || f === "woff2");
    return `${w} The page loads it as a web font (${formats.join(", ") || "unknown format"})${webOnly ? ", which Figma can't use: install a TTF/OTF version of it on this machine" : ": install it on this machine"} and restart Figma, or re-import with fontMap: { "${m[1]}": "<an installed family>" }.`;
  });

  const verifyPlan = async (plan: ResolvedPlan, report: ExecutionReport, sources?: Record<string, { w: number; h?: number }>) => {
    const all = [];
    const roots = [...plan.roots, ...(plan.inserts ?? []).flatMap((x) => x.roots)];
    for (let i = 0; i < roots.length; i++) {
      const id = report.createdRootIds[i];
      const snap = id ? ((await bridge.request<{ nodes: NodeSnapshot[] }>("inspect", { target: id, depth: 12, maxNodes: 4000, expandInstances: true })).nodes[0]) : undefined;
      all.push(...verifyAgainstPlan(roots[i], snap, { sources, nodeIds: report.nodeIds }));
    }
    return all;
  };
  /** Keep the answer small: counts by issue, and the first mismatches. */
  const verdict = (mismatches: Awaited<ReturnType<typeof verifyPlan>>) => {
    const byIssue: Record<string, number> = {};
    for (const m of mismatches) byIssue[m.issue] = (byIssue[m.issue] ?? 0) + 1;
    return { passed: mismatches.length === 0, byIssue, mismatches: mismatches.slice(0, 25), total: mismatches.length };
  };

  server.registerTool("figma_verify", {
    description: "Re-inspect the nodes created by an executed plan and report structural mismatches against the plan (missing nodes, wrong component/variant, text, layout, unbound tokens). Use after the user edited things or before implementing code.",
    inputSchema: { planId: z.string() },
  }, async ({ planId }) => guard(async () => {
    const e = plans.get(planId);
    if (!e?.report) return fail([{ type: "INVALID_PLAN", message: "Plan not executed in this session." }]);
    return ok(verdict(await verifyPlan(e.plan, e.report, e.sources)));
  }));

  server.registerTool("figma_analyze_design", {
    description: "Mode B. Inspect the selected frame (or node id), compare it to the Design System, and propose NON-destructive transformations: custom buttons/inputs → DS instances, raw spacing/radius → tokens, raw colors → color variables, raw text → text styles, manual layout → Auto Layout. Returns an analysisId + grouped summary. Nothing is changed.",
    inputSchema: { target: z.string().optional().describe("'selection' (default) or node id"), verbose: z.boolean().optional().describe("Include every transformation (default: summary + first 40)"),
      mode: z.enum(["audit", "sync", "a11y", "critique"]).optional().describe("audit (default): exact matches only. sync: after an import (e.g. from HTML), match to the Design System like a designer: buttons and pills become DS components with the closest-looking variant, text gets the style with the same size and weight (even if the import used a stand-in font), colours get variables or colour styles. a11y: WCAG 2.2 checks (text contrast against its real background, touch target size, tiny text). critique: a11y plus consistency signals (spacing off the scale, font sizes, raw colours, near-miss alignment) for the visual critique loop") },
  }, async ({ target, verbose, mode }) => guard(async () => {
    // Accessibility and critique report findings; they change nothing and need no Design System scan.
    if (mode === "a11y" || mode === "critique") {
      const snap = await bridge.request<{ nodes: NodeSnapshot[] }>("inspect", { target: target ?? "selection", depth: 20, maxNodes: 20000, expandInstances: true }, 180_000);
      if (!snap.nodes.length) return fail([{ type: "NODE_NOT_FOUND", message: "Nothing selected. Ask the user to select a frame." }]);
      const d = loadDs();
      const findings = snap.nodes.flatMap((n) => accessibilityFindings(n));
      const metrics = mode === "critique" ? snap.nodes.map((n) => designMetrics(n, d)) : [];
      findings.push(...metrics.flatMap((m) => m.findings));
      const order = { error: 0, warning: 1, info: 2 } as const;
      findings.sort((a, b) => order[a.severity] - order[b.severity]);
      const count = (sev: string) => findings.filter((f) => f.severity === sev).length;
      return ok({ mode, errors: count("error"), warnings: count("warning"), infos: count("info"), findings: verbose ? findings : findings.slice(0, 40), total: findings.length,
        metrics: mode === "critique" ? metrics.map((m) => m.metrics) : undefined,
        next: mode === "critique" ? "Look at figma_export_image of the same node too. Score the rubric (hierarchy, spacing, alignment, contrast, consistency, density), fix the worst issues with a plan or figma_edit, and check again (at most 3 rounds)." : "Tell the user the errors first; fix contrast with DS colours, not raw values." });
    }
    const d = needDs();
    const snap = await bridge.request<{ nodes: NodeSnapshot[] }>("inspect", { target: target ?? "selection", depth: 20, maxNodes: 20000 });
    if (!snap.nodes.length) return fail([{ type: "NODE_NOT_FOUND", message: "Nothing selected. Ask the user to select a frame." }]);
    const results = snap.nodes.map((n) => analyzeDesign(d, n, { mode }));
    const merged: AnalysisResult = { analysisId: results.map((r) => r.analysisId).join("_"), transformations: results.flatMap((r) => r.transformations), summary: results.flatMap((r) => r.summary), unresolved: results.flatMap((r) => r.unresolved) };
    // Groups across all analysed nodes, by label.
    const byLabel = new Map<string, string[]>();
    for (const r of results) for (const g of r.groups ?? []) byLabel.set(g.label, [...(byLabel.get(g.label) ?? []), ...g.ids]);
    merged.groups = [...byLabel].map(([label, ids], i) => ({ id: `g${i + 1}`, label, count: ids.length, ids }));
    analyses.set(merged.analysisId, merged);
    const list = merged.transformations.map((t) => ({ id: t.id, op: t.op, node: t.nodeName, reason: t.reason }));
    return ok({ analysisId: merged.analysisId, groups: merged.groups!.map(({ ids, ...g }) => g), transformations: verbose ? list : list.slice(0, 40), total: list.length, unresolved: merged.unresolved.slice(0, 10),
      next: "Present the groups (with their reasons) to the user and ask which to apply; pass groups or excludeGroups to figma_apply_transformations. Originals of replaced nodes are hidden, not deleted." });
  }));

  server.registerTool("figma_apply_transformations", {
    description: "Apply transformations from figma_analyze_design. REQUIRES approved=true, which you may only set after the user explicitly approved. Pass ids to apply a subset (default all). Replaced originals are hidden and renamed, never deleted. One undo step.",
    inputSchema: { analysisId: z.string(), approved: z.boolean(), ids: z.array(z.string()).optional(), ops: z.array(z.enum(["bind_fill", "apply_fill_style", "bind_number", "apply_text_style", "convert_auto_layout", "replace_with_instance"])).optional().describe("Apply only these kinds of transformation"),
      groups: z.array(z.string()).optional().describe("Apply only these groups (ids from figma_analyze_design, e.g. g1)"), excludeGroups: z.array(z.string()).optional().describe("Apply everything except these groups") },
  }, async ({ analysisId, approved, ids, ops, groups, excludeGroups }) => guard(async () => {
    if (!approved) return fail([{ type: "NOT_APPROVED", message: "Get explicit user approval first." }]);
    const a = analyses.get(analysisId);
    if (!a) return fail([{ type: "INVALID_PLAN", message: "Unknown analysisId; run figma_analyze_design again." }]);
    const inGroups = (gs?: string[]) => new Set((a.groups ?? []).filter((g) => gs?.includes(g.id)).flatMap((g) => g.ids));
    const only = groups ? inGroups(groups) : undefined, skip = inGroups(excludeGroups);
    const chosen = a.transformations.filter((t) => (!ids || ids.includes(t.id)) && (!ops || ops.includes(t.op)) && (!only || only.has(t.id)) && !skip.has(t.id));
    // Replacements first changes structure; bindings on replaced nodes would be wasted, so drop those.
    const replaced = new Set(chosen.filter((t) => t.op === "replace_with_instance").map((t) => t.nodeId));
    const order = { convert_auto_layout: 0, replace_with_instance: 1, bind_number: 2, bind_fill: 3, apply_fill_style: 3, apply_text_style: 4 } as const;
    const final = chosen.filter((t) => t.op === "replace_with_instance" || !replaced.has(t.nodeId)).sort((x, y) => order[x.op] - order[y.op]);
    const report = await bridge.request<TransformReport>("applyTransformations", { transformations: final }, 600_000);
    analyses.delete(analysisId);
    const byOp: Record<string, number> = {};
    for (const t of final) if (report.applied.some((a) => a.id === t.id)) byOp[t.op] = (byOp[t.op] ?? 0) + 1;
    const names = new Map(final.map((t) => [t.id, t.nodeName]));
    const problems = groupFailures(report.failed.map((f) => ({ ...f, node: names.get(f.id) })), { exportDir: memory.read().lastExport });
    return ok({ success: report.failed.length === 0, applied: report.applied.length, byOp, notApplied: report.failed.length || undefined,
      problems: problems.length ? problems : undefined, hiddenOriginals: report.hiddenOriginals.length,
      next: problems.length ? `Tell the user what didn't apply and the fix: ${problems.map((p) => `${p.count} × ${p.cause} → ${p.fix}`).join(" | ")}` : undefined });
  }));

  server.registerTool("figma_pages", {
    description: "Create (or reorder) pages in the open Figma file, in the given order. Existing pages with the same name are reused; an empty default page is renamed instead of kept.",
    inputSchema: { pages: z.array(z.string().min(1)).min(1).max(40) },
  }, async ({ pages }) => guard(async () => ok(await bridge.request("ensurePages", { pages }, 30_000))));

  server.registerTool("figma_import_html", {
    description: "Import an HTML prototype into Figma at full fidelity for almost no tokens: renders it in headless Chrome, serializes the painted result (boxes, colors, gradients, shadows, radii, text, inline SVG) and builds it on a page. With no targets, every screen on a review board (nested .sc-host) is imported and named by its label. Use dryRun to list screens first.",
    inputSchema: {
      file: z.string().describe("Path to the .html file"),
      root: z.string().optional().describe("Directory to serve (default: the file's grandparent, so ../fonts works)"),
      targets: z.array(z.object({ selector: z.string(), name: z.string().optional(), index: z.number().int().min(0).optional().describe("Take only the nth match") })).optional().describe("CSS selectors of the elements to import as screens"),
      swaps: z.array(z.object({
        selector: z.string(), component: z.string().describe("Component or set name (label for errors when id/key is given)"),
        id: z.string().optional().describe("Exact local component/set id (use when names are ambiguous)"),
        key: z.string().optional().describe("Component/set key, e.g. a library component found by a library search"),
        variants: z.array(z.object({ test: z.string(), variant: z.string() })).optional(), default: z.string().optional(),
        overrides: z.enum(["none", "text", "match"]).optional().describe("none: keep the component as is; text (default): copy matching text; match: also hide layers the element lacks"),
        fills: z.boolean().optional().describe("Copy the element's fill onto the instance (default false)"),
      })).optional()
        .describe("Replace matching elements with instances of existing components. Variant = first rule whose test matches, else default; an unknown variant is an error, never a silent fallback."),
      actions: z.array(z.object({ click: z.string(), index: z.number().int().min(0).optional(), waitMs: z.number().min(0).max(10000).optional() })).optional().describe("Clicks to perform before capturing (open menus, advance steps)"),
      replace: z.boolean().optional().describe("Remove an existing section with the same name on that page first"),
      components: z.boolean().optional().describe("Turn each imported root into a component. Names like \"Wish card/State=Chosen\" are combined into component sets."),
      only: z.array(z.string()).optional().describe("Keep only screens whose name contains one of these strings"),
      page: z.string().optional().describe("Page to build on (created if missing)"),
      section: z.string().optional().describe("Wrap the screens in a Figma section with this name"),
      gap: z.number().min(0).max(2000).optional(),
      fontMap: z.record(z.string()).optional().describe('Replace font families, e.g. { "YekanBakhFaNum": "IRANYekanX" }'),
      dryRun: z.boolean().optional(),
    },
  }, async ({ file, root, targets, swaps, actions, replace, components, only, page, section, gap, fontMap, dryRun }) => guard(async () => {
    let screens = await importHtml({ file: resolve(workdir, file), root: root && resolve(workdir, root), targets, swaps, actions });
    if (fontMap) {
      const fm = new Map(Object.entries(fontMap).map(([k, v]) => [k.toLowerCase(), v]));
      const walk = (n: any) => { if (n.type === "text" && fm.has(n.font.family.toLowerCase())) n.font = { ...n.font, family: fm.get(n.font.family.toLowerCase()) }; (n.children ?? []).forEach(walk); };
      screens.forEach((s) => walk(s.tree));
    }
    if (only?.length) screens = screens.filter((s) => only.some((o) => s.name.includes(o)));
    const list = screens.map((s) => ({ name: s.name, width: Math.round(s.width), height: Math.round(s.height), nodes: s.nodeCount }));
    if (dryRun || !screens.length) return ok({ dryRun: true, screens: list });
    const res = await bridge.request<{ page: string; screens: { id: string; name: string; width: number; height: number }[] }>("importTree", { page, section, gap, components, replace, screens: screens.map(({ name, tree }) => ({ name, tree })), meta: meta() }, 300_000);
    lastPage = res.page;
    // Screens are laid out one per import (component sets combine several), so only compare plain screens.
    const mismatches = components ? [] : res.screens.flatMap((b, i) => {
      const s = list[i];
      return s && (Math.abs(b.width - s.width) > Math.max(4, s.width * 0.05) || Math.abs(b.height - s.height) > Math.max(4, s.height * 0.05))
        ? [{ path: `screens[${i}]`, nodeId: b.id, issue: "size far from the source's rendered box", expected: `${s.width}×${s.height}`, actual: `${Math.round(b.width)}×${Math.round(b.height)}` }] : [];
    });
    return ok({ imported: list, ...res, verification: verdict(mismatches), next: "Check it visually with figma_export_image({ nodeId, compareWith: { html } })." });
  }));

  server.registerTool("figma_foundations", {
    description: "Create or update Design System foundations in the open file: a variable collection (COLOR and FLOAT variables, e.g. \"color/brand/deep-teal\": \"#176B66\", \"radius/media\": 20), text styles, colour styles (a hex, a gradient, or bound to a colour variable so the style follows the token), effect styles (shadows, layer/background blur) and grid styles (columns, rows, square grid). Idempotent by name. Rescan the DS afterwards.",
    inputSchema: {
      collection: z.string().default("Tokens"),
      colors: z.record(z.string()).optional().describe("#RRGGBB or #RRGGBBAA"),
      numbers: z.record(z.number()).optional(),
      textStyles: z.array(z.object({ name: z.string(), family: z.string(), style: z.string(), size: z.number(), lineHeight: z.number().optional().describe("px"), letterSpacing: z.number().optional().describe("percent") })).optional(),
      paintStyles: z.array(z.object({ name: z.string(), color: z.string().optional(), variable: z.string().optional().describe("Bind the style to this colour variable"),
        gradient: z.object({ type: z.enum(["linear", "radial", "angular", "diamond"]).optional(), angle: z.number().optional(), stops: z.array(z.object({ color: z.string(), position: z.number().min(0).max(1) })).min(2) }).optional() })).optional(),
      effectStyles: z.array(z.object({ name: z.string(), shadows: z.array(z.object({ type: z.enum(["drop", "inner"]).optional(), x: z.number().optional(), y: z.number().optional(), blur: z.number().optional(), spread: z.number().optional(), color: z.string() })).optional(),
        blur: z.object({ type: z.enum(["layer", "background"]), radius: z.number().min(0) }).optional() })).optional(),
      gridStyles: z.array(z.object({ name: z.string(),
        columns: z.object({ count: z.number().int().min(1), gutter: z.number().optional(), margin: z.number().optional(), alignment: z.enum(["STRETCH", "CENTER", "MIN", "MAX"]).optional(), color: z.string().optional() }).optional(),
        rows: z.object({ count: z.number().int().min(1), gutter: z.number().optional(), margin: z.number().optional(), alignment: z.enum(["STRETCH", "CENTER", "MIN", "MAX"]).optional(), color: z.string().optional() }).optional(),
        grid: z.object({ size: z.number().min(1), color: z.string().optional() }).optional() })).optional(),
    },
  }, async (p) => guard(async () => ok(await bridge.request("foundations", p, 60_000))));

  server.registerTool("figma_export_image", {
    description: "Render a Figma node as an image you can look at: use it after every build or edit to check the result visually (empty instances, wrong sizes and wrong variants are obvious in a picture). With compareWith, the source HTML is screenshotted in headless Chrome too, and you get both images, a diff heatmap and the share of changed pixels.",
    inputSchema: {
      nodeId: z.string().describe("Node to render (a frame, section, instance, ...)"),
      scale: z.number().min(0.05).max(4).optional().describe("Default 1; capped so the longest side stays within maxDimension"),
      maxDimension: z.number().int().min(100).max(4000).optional().describe("Default 1600 px"),
      format: z.enum(["png", "jpg"]).optional(),
      save: z.union([z.boolean(), z.string()]).optional().describe("Also write the image to disk and return its path, so it can be shown to the user or attached: true saves to .layerwright/exports/<node>.png; a string is a file or folder inside the project (relative to the workdir). The image you see is only visible to you, not to the user"),
      compareWith: z.object({
        html: z.string().optional().describe("The .html file (or folder) the node was built from"),
        nodeId: z.string().optional().describe("Another Figma node to compare with (before/after, original/clone)"),
        selector: z.string().optional().describe("Element to screenshot (default body)"),
        viewport: z.number().int().min(200).max(4000).optional().describe("Viewport width (default: the node's width)"),
      }).optional(),
    },
  }, async ({ nodeId, scale, maxDimension, format, save, compareWith }) => guard(async () => {
    if (typeof save === "string") saveTarget(save); // refused before Figma renders anything
    const maxDim = maxDimension ?? 1600;
    const exp = (s?: number) => bridge.request<{ base64: string; format: string; width: number; height: number; scale: number; name: string }>("exportImage", { nodeId, scale: s, format, maxDimension: maxDim }, 120_000);
    const mime = (f: string) => (f === "jpg" ? "image/jpeg" : "image/png");
    if (!compareWith) {
      const img = await exp(scale);
      const file = save ? saveExport(save, img) : undefined;
      return { content: [{ type: "image", data: img.base64, mimeType: mime(img.format) }, { type: "text", text: JSON.stringify({ node: img.name, width: img.width, height: img.height, scale: img.scale, file,
        next: file ? undefined : "Only you can see this image. To show it to the user, call again with save: true and send them the file." }) }] };
    }
    if (compareWith.nodeId) {
      const [a, b] = await Promise.all([exp(scale), bridge.request<{ base64: string; format: string; width: number; height: number }>("exportImage", { nodeId: compareWith.nodeId, scale, format, maxDimension: maxDim }, 120_000)]);
      const diff = await diffImages({ base64: a.base64, mime: mime(a.format) }, { base64: b.base64, mime: mime(b.format) });
      const same = diff.changedCells < 0.01 && Math.abs(a.width - b.width) <= 2 && Math.abs(a.height - b.height) <= 2;
      return { content: [
        { type: "text", text: `${nodeId}:` }, { type: "image", data: a.base64, mimeType: mime(a.format) },
        { type: "text", text: `${compareWith.nodeId}:` }, { type: "image", data: b.base64, mimeType: mime(b.format) },
        { type: "text", text: "Diff (red = changed):" }, { type: "image", data: diff.heatmap, mimeType: "image/png" },
        { type: "text", text: JSON.stringify({ a: { width: a.width, height: a.height }, b: { width: b.width, height: b.height }, changedCells: diff.changedCells, regions: diff.regions, verdict: same ? "same" : `${diff.regions.length} changed region(s)` }) },
      ] };
    }
    if (!compareWith.html) return fail([{ type: "INVALID_PLAN", message: "compareWith needs html or nodeId." }]);
    const snap = (await bridge.request<{ nodes: NodeSnapshot[] }>("inspect", { target: nodeId, depth: 0 })).nodes[0];
    const figmaW = snap?.w ?? 1440, figmaH = snap?.h ?? 900;
    const html = await screenshotHtml(resolve(workdir, compareWith.html!), { selector: compareWith.selector, width: compareWith.viewport ?? figmaW, height: compareWith.selector ? undefined : figmaH });
    // Export at the HTML's pixel size so both images line up (capped by maxDimension).
    const img = await exp(html.width / Math.max(1, figmaW));
    const diff = await diffImages({ base64: html.base64 }, { base64: img.base64, mime: mime(img.format) });
    // Whole page: only content that runs past the Figma node counts; an element: its box must match.
    const sizeOff = Math.abs(figmaW - html.width) > 2 || (html.contentHeight !== undefined ? html.contentHeight > figmaH + Math.max(4, figmaH * 0.02) : Math.abs(figmaH - html.height) > Math.max(4, html.height * 0.02));
    const verdict = diff.changedCells < 0.01 && !sizeOff ? "close match"
      : `${sizeOff ? `size differs (Figma ${figmaW}×${figmaH}, HTML ${html.width}×${html.height}); ` : ""}${diff.regions.length} changed region(s), largest first: look at them in the heatmap before reporting success`;
    return { content: [
      { type: "text", text: "Figma:" }, { type: "image", data: img.base64, mimeType: mime(img.format) },
      { type: "text", text: "HTML source:" }, { type: "image", data: html.base64, mimeType: "image/png" },
      { type: "text", text: "Diff (red = changed):" }, { type: "image", data: diff.heatmap, mimeType: "image/png" },
      { type: "text", text: JSON.stringify({ figma: { width: figmaW, height: figmaH }, html: { width: html.width, height: html.contentHeight ?? html.height }, changedCells: diff.changedCells, regions: diff.regions, verdict }) },
    ] };
  }));

  const Ref = z.string().describe('Node id, or "$n" for the node made by op n of this call');
  const EditOp = z.discriminatedUnion("op", [
    z.object({ op: z.literal("rename"), node: Ref, name: z.string().min(1) }).strict(),
    z.object({ op: z.literal("move"), node: Ref, parent: Ref.optional(), page: z.string().optional().describe("Page name or id (top level of that page)"), index: z.number().int().min(0).optional(), x: z.number().optional(), y: z.number().optional() }).strict(),
    z.object({ op: z.literal("duplicate"), node: Ref, parent: Ref.optional(), x: z.number().optional(), y: z.number().optional(), name: z.string().optional() }).strict(),
    z.object({ op: z.literal("set"), node: Ref, visible: z.boolean().optional(), locked: z.boolean().optional(), x: z.number().optional(), y: z.number().optional(), width: z.number().positive().optional(), height: z.number().positive().optional(),
      opacity: z.number().min(0).max(1).optional(), text: z.string().optional().describe("Characters of a text layer"), properties: z.record(z.union([z.string(), z.boolean()])).optional().describe("Instance properties/variants by name") }).strict(),
    z.object({ op: z.literal("delete"), node: Ref }).strict(),
    z.object({ op: z.literal("resizeToFit"), node: Ref.describe("A section, an Auto Layout frame (set to hug) or a frame"), padding: z.number().min(0).optional() }).strict(),
    z.object({ op: z.literal("prototype"), node: Ref, interactions: z.array(Interaction).min(1).max(20).describe('e.g. [{ trigger: "click", action: "navigate", to: "12:34", transition: { type: "smart-animate", duration: 300 } }]; "to" is a node id or "$n"'),
      replace: z.boolean().optional().describe("Replace the node's interactions (default true) or add to them") }).strict(),
    z.object({ op: z.literal("swap"), node: Ref.describe("An instance"), component: z.union([z.string(), z.object({ id: z.string().optional(), key: z.string().optional() }).strict()]).describe("Target component or set: name, { id } or { key }"),
      variant: z.union([z.string(), z.record(z.string())]).optional().describe("Variant of the target set, e.g. { State: \"Open\" }") }).strict(),
    z.object({ op: z.literal("bind"), node: Ref, field: z.enum(["fills", "strokes", "itemSpacing", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "padding", "cornerRadius", "width", "height", "opacity", "strokeWeight"]),
      variable: z.union([z.string(), z.object({ id: z.string().optional(), key: z.string().optional() }).strict()]).describe("Variable name (e.g. color/bg/surface, spacing/md), { id } or { key }") }).strict(),
    z.object({ op: z.literal("style"), node: Ref, kind: z.enum(["fill", "stroke", "text", "effect"]),
      style: z.union([z.string(), z.object({ id: z.string() }).strict()]).describe("Style name (e.g. Fa Text sm/Bold) or { id }") }).strict(),
    z.object({ op: z.literal("annotate"), node: Ref, annotations: z.array(AnnotationDsl).min(1).max(10), replace: z.boolean().optional().describe("Replace the node's annotations (default: add)") }).strict(),
    z.object({ op: z.literal("group"), nodes: z.array(Ref).min(1).max(200).describe("Layers with the same parent"), name: z.string().optional() }).strict(),
    z.object({ op: z.literal("ungroup"), node: Ref.describe("A group, frame or boolean shape; its layers move to its parent") }).strict(),
    z.object({ op: z.literal("boolean"), nodes: z.array(Ref).min(1).max(100).describe("Shapes or vectors with the same parent; the bottom one is the base for subtract"),
      operation: z.enum(["union", "subtract", "intersect", "exclude", "flatten"]), name: z.string().optional() }).strict(),
    z.object({ op: z.literal("flow"), name: z.string().min(1), start: Ref.optional().describe("Top-level frame where the flow starts"), description: z.string().optional(), remove: z.boolean().optional() }).strict(),
    z.object({ op: z.literal("componentize"), nodes: z.array(Ref).min(1).max(100), mode: z.enum(["single", "multiple", "variants"]).optional(),
      name: z.string().optional().describe("Component (single) or component set (variants) name"),
      variants: z.array(z.record(z.string())).optional().describe('One entry per node, e.g. [{ State: "Expanded", Step: "Evidence" }, …]'),
      duplicate: z.boolean().optional().describe("Work on copies and leave the originals untouched (default true)"),
      exposeText: z.union([z.boolean(), z.array(z.string())]).optional().describe("Turn text layers (all, or these names) into TEXT properties"),
      autoLayout: z.boolean().optional().describe("Give absolutely positioned layers that stack cleanly Auto Layout first, so the component adapts to new text (default true; uneven layouts are left as they are)"),
      parent: Ref.optional(), x: z.number().optional(), y: z.number().optional() }).strict(),
  ]);
  const MUTATES = new Set(["rename", "move", "set", "delete", "resizeToFit", "prototype", "flow", "swap", "annotate", "bind", "style", "group", "ungroup", "boolean"]);

  server.registerTool("figma_edit", {
    description: "Change existing layers in one undo step: rename, move (to a parent, section or page), duplicate, set (visible, position, size, opacity, text, instance properties), delete, resizeToFit (sections grow to their content), prototype (click/hover/after-delay interactions: navigate, overlay, swap, scroll-to, back, close, url, and change-to between variants for interactive components, with transitions), flow (a prototype starting point), swap (an instance to another component or variant; overrides are kept), bind (a variable to fills, strokes, gap, padding, radius, size, opacity), style (a fill, stroke, text or effect style), annotate (native Figma annotations for dev handoff: markdown, measured properties, a category), group / ungroup, boolean (union, subtract, intersect, exclude or flatten shapes), and componentize (turn existing frames into a component, several components, or one component set with variants; works on copies by default, and can expose text layers as TEXT properties). Ops run in order and can use \"$n\" for the node made by op n. Changing or deleting existing nodes needs approved=true; without it, delete only hides and renames the node (🗑).",
    inputSchema: { ops: z.array(EditOp).min(1).max(200), approved: z.boolean().optional().describe("Required for ops that change existing nodes; for delete it means really remove") },
  }, async ({ ops, approved }) => guard(async () => {
    const needs = ops.filter((o) => MUTATES.has(o.op) && o.op !== "delete" || (o.op === "componentize" && o.duplicate === false));
    if (needs.length && !approved) return fail([{ type: "NOT_APPROVED", message: `${needs.length} op(s) change existing nodes (${[...new Set(needs.map((o) => o.op))].join(", ")}). Show the user what will change, then call again with approved: true.` }]);
    // Prototype ops: DSL interactions → plugin-ready ones ("$n" stays a reference to an earlier op's node).
    const errors: StructuredError[] = [];
    const resolver = (() => { const d = loadDs(); if (!d) return undefined; const r = new Resolver(d); r.preferred = preferred(); return r; })();
    const sent = ops.map((o, k) => {
      if (o.op === "prototype") return { ...o, interactions: o.interactions.map((it) => resolveInteraction(it, `ops[${k}]`, (r) => (/^\$\d+$/.test(r) ? r : undefined), errors, () => ["a Figma node id", '"$n"'])).filter(Boolean) };
      if (o.op === "swap") {
        // The same resolution as plans: ids, keys, duplicate names, remembered choices.
        if (!resolver) { errors.push({ type: "DESIGN_SYSTEM_NOT_SCANNED", path: `ops[${k}]`, message: "swap needs a Design System scan (figma_scan_design_system)." }); return o; }
        const m = resolver.findComponent({ component: o.component, variant: o.variant }, `ops[${k}]`);
        if ("error" in m) { errors.push(m.error); return o; }
        return { op: "swap", node: o.node, componentId: m.def.id, componentKey: m.def.remote ? m.def.key : undefined, remote: m.def.remote, componentName: m.set ? `${m.set.name} / ${Object.values(m.def.variants ?? {}).join(", ")}` : m.def.name };
      }
      if (o.op === "bind") {
        const d = loadDs();
        const colour = o.field === "fills" || o.field === "strokes";
        if (typeof o.variable === "object" && o.variable.key && !o.variable.id) return { op: "bind", node: o.node, field: o.field, variableId: "", variableKey: o.variable.key };
        if (!d || !resolver) { errors.push({ type: "DESIGN_SYSTEM_NOT_SCANNED", path: `ops[${k}]`, message: "bind needs a Design System scan (figma_scan_design_system)." }); return o; }
        const ref = o.variable;
        const v = typeof ref === "object" ? d.variables.find((x) => x.id === ref.id) : resolver.findVariable(ref, colour ? "COLOR" : "FLOAT");
        if (!v) { errors.push({ type: "TOKEN_NOT_FOUND", path: `ops[${k}]`, message: `No ${colour ? "colour" : "number"} variable matches ${JSON.stringify(o.variable)}.`, suggestions: d.variables.filter((x) => x.type === (colour ? "COLOR" : "FLOAT")).map((x) => x.name).slice(0, 10) }); return o; }
        return { op: "bind", node: o.node, field: o.field, variableId: v.id, variableKey: v.remote ? v.key : undefined, variableName: v.name };
      }
      if (o.op === "style") {
        const d = loadDs();
        if (!d) { errors.push({ type: "DESIGN_SYSTEM_NOT_SCANNED", path: `ops[${k}]`, message: "style needs a Design System scan (figma_scan_design_system)." }); return o; }
        const type = o.kind === "text" ? "TEXT" : o.kind === "effect" ? "EFFECT" : "PAINT";
        const want = typeof o.style === "string" ? o.style.toLowerCase() : undefined;
        // Prefer a copy whose font is known (text styles from a library may not report it).
        const pool = d.styles.filter((x) => x.type === type && (want ? x.name.toLowerCase() === want : x.id === (o.style as { id: string }).id));
        const typo = (id: string) => d.typography.find((t) => t.styleId === id);
        const st = pool.sort((a, b) => Number(!!typo(b.id)?.fontFamily) - Number(!!typo(a.id)?.fontFamily))[0];
        if (!st) { errors.push({ type: "STYLE_NOT_FOUND", path: `ops[${k}]`, message: `No ${o.kind} style ${JSON.stringify(o.style)}.`, suggestions: d.styles.filter((x) => x.type === type).map((x) => x.name).slice(0, 10) }); return o; }
        const t = typo(st.id);
        return { op: "style", node: o.node, kind: o.kind, styleId: st.id, styleKey: st.remote ? st.key : undefined, styleName: st.name, font: t?.fontFamily && t.fontStyle ? { family: t.fontFamily, style: t.fontStyle } : undefined };
      }
      return o;
    });
    if (errors.length) return fail(errors);
    const res = await bridge.request<{ applied: unknown[]; failed?: { op: number; error: string } }>("editNodes", { ops: sent, approved, meta: meta() }, 180_000);
    if (res.failed) {
      const [p] = groupFailures([{ error: res.failed.error }], { exportDir: memory.read().lastExport });
      return fail([{ type: "FIGMA_API_ERROR", message: `op ${res.failed.op} (${ops[res.failed.op].op}): ${res.failed.error}`, fix: p?.fix }], { ...res });
    }
    return ok({ success: true, ...res, next: "Check the result with figma_export_image." });
  }));

  server.registerTool("figma_migrate", {
    description: "Move every instance of one component (set) to another, e.g. from an old Accordion set to the new one, or from one library to another: each instance is swapped to the matching variant (same property values; map renamed properties or values), keeping its overrides. Without approved it only reports what would change (instances per target variant, and the ones with no match). With approved it applies everything in one undo step.",
    inputSchema: {
      from: z.union([z.string(), z.object({ id: z.string().optional(), key: z.string().optional() }).strict()]).describe("Old component or set: name, { id } or { key }"),
      to: z.union([z.string(), z.object({ id: z.string().optional(), key: z.string().optional() }).strict()]).describe("New component or set"),
      target: z.string().optional().describe("Where to look: a node id (a frame, section) or 'page' (default: the selection)"),
      propertyMap: z.record(z.string()).optional().describe('Renamed variant properties, old → new, e.g. { "Type": "Hierarchy" }'),
      valueMap: z.record(z.record(z.string())).optional().describe('Renamed values per (new) property, e.g. { "Hierarchy": { "Primary": "Contained" } }'),
      approved: z.boolean().optional(),
    },
  }, async ({ from, to, target, propertyMap, valueMap, approved }) => guard(async () => {
    const d = needDs();
    const r = new Resolver(d); r.preferred = preferred();
    const src = r.findComponent({ component: from }, "from"), dst = r.findComponent({ component: to }, "to");
    if ("error" in src) return fail([src.error]);
    if ("error" in dst) return fail([dst.error]);
    const fromId = src.set?.id ?? src.def.id, toName = dst.set?.name ?? dst.def.name;
    const snap = await bridge.request<{ nodes: NodeSnapshot[] }>("inspect", { target: target ?? "selection", depth: 25, maxNodes: 20000, expandInstances: true }, 180_000);
    if (!snap.nodes.length) return fail([{ type: "NODE_NOT_FOUND", message: "Nothing to search: pass target (a node id or 'page') or select a frame." }]);
    const found: NodeSnapshot[] = [];
    const walk = (n: NodeSnapshot) => { if (n.type === "INSTANCE" && (n.instance?.componentSetId ?? n.instance?.componentId) === fromId) found.push(n); (n.children ?? []).forEach(walk); };
    snap.nodes.forEach(walk);
    const ops: any[] = [], unmatched: { node: string; nodeId: string; variant?: Record<string, string>; reason: string }[] = [];
    const byTarget: Record<string, number> = {};
    for (const n of found) {
      // Old variant values under the new property names, with renamed values.
      const want: Record<string, string> = {};
      for (const [k, v] of Object.entries(n.instance?.variants ?? {})) { const nk = propertyMap?.[k] ?? k; want[nk] = valueMap?.[nk]?.[v] ?? v; }
      const known = new Set((dst.set?.properties ?? []).filter((p) => p.type === "VARIANT").map((p) => p.name.toLowerCase()));
      const variant = Object.fromEntries(Object.entries(want).filter(([k]) => known.has(k.toLowerCase())));
      const m = dst.set ? r.findComponent({ component: { id: dst.set.id }, variant: Object.keys(variant).length ? variant : undefined }, n.id) : dst;
      if ("error" in m) { unmatched.push({ node: n.name, nodeId: n.id, variant: n.instance?.variants, reason: m.error.message }); continue; }
      const label = `${toName} / ${Object.values(m.def.variants ?? {}).join(", ")}`;
      byTarget[label] = (byTarget[label] ?? 0) + 1;
      ops.push({ op: "swap", node: n.id, componentId: m.def.id, componentKey: m.def.remote ? m.def.key : undefined, remote: m.def.remote, componentName: label });
    }
    const summary = { from: src.set?.name ?? src.def.name, to: toName, instances: found.length, swaps: ops.length, byTarget, unmatched: unmatched.slice(0, 20), unmatchedCount: unmatched.length };
    if (!approved || !ops.length) return ok({ dryRun: true, ...summary, next: ops.length ? "Show the user the counts (and anything unmatched: use propertyMap/valueMap), then call again with approved: true." : "Nothing to migrate here." });
    const res = await bridge.request<{ applied: unknown[]; failed?: { op: number; error: string } }>("editNodes", { ops, approved: true, meta: meta() }, 600_000);
    return res.failed ? fail([{ type: "FIGMA_API_ERROR", message: `Stopped at instance ${res.failed.op + 1} of ${ops.length}: ${res.failed.error}`, fix: groupFailures([{ error: res.failed.error }])[0]?.fix }], { ...summary, applied: res.applied.length })
      : ok({ success: true, ...summary, applied: res.applied.length, note: "One undo reverts the whole migration." });
  }));

  server.registerTool("layerwright_memory", {
    description: "What Layerwright remembers in this project (.layerwright/memory.json, shareable with the team): font substitutions and component mappings reused by imports, which of several same-named components the user chose, the user's notes, and recurring problems with hints. Save a note whenever the user corrects you ('use the Fa styles for Persian text'), so the next session starts from it. action language saves the language the user wants explanations in, for every project (figma_status returns it as language).",
    inputSchema: { action: z.enum(["get", "note", "forget", "language"]), note: z.string().max(500).optional().describe("note: the user's correction or preference, in their words"),
      language: z.string().trim().max(40).optional().describe("language: the language the user wants explanations in (\"Persian\", \"English\"…); empty clears it. Kept for this user in every project"),
      forget: z.object({ note: z.number().int().min(0).optional(), component: z.string().optional(), font: z.string().optional(), selector: z.string().optional(), all: z.boolean().optional() }).optional() },
  }, async ({ action, note, forget, language }) => guard(async () => {
    if (action === "language") return ok({ language: writePrefs({ language: language ?? "" }).language ?? null, note: "Every Layerwright session explains things in this language from now on (figma_status returns it)." });
    if (action === "note") { if (!note) return fail([{ type: "INVALID_PLAN", message: "note needs text." }]); memory.note(note); }
    if (action === "forget") memory.forget(forget ?? {});
    const m = memory.read();
    return ok({ ...m, problems: m.problems.slice(-20), summary: memory.summary() });
  }));

  server.registerTool("layerwright_skills", {
    description: "Skills: guidance for design, UX, UI and design-to-code jobs (a design critique, a handoff spec with every state, layout, typography, colour, accessibility, motion…). figma_status lists the enabled ones with when each fits: before such a job, read the closest one (action read) and follow it. The library ships with Layerwright; the user adds their own (action add, from a link or the text of a SKILL.md) and they stay across updates. The user also manages them in the Skills tab of the Figma window.",
    inputSchema: {
      action: z.enum(["list", "read", "add", "remove", "enable", "disable"]),
      id: z.string().max(80).optional().describe("read/remove/enable/disable: the skill"),
      file: z.string().max(200).optional().describe("read: another file of the skill that its SKILL.md points to (default SKILL.md)"),
      source: z.string().max(200_000).optional().describe("add: a link (GitHub folder, file or repository; a .md link; a skills page that links to one) or the full text of a SKILL.md"),
      name: z.string().max(60).optional().describe("add: the skill's id, when its own name doesn't fit"),
    },
  }, async ({ action, id, file, source, name }) => guard(async () => {
    const need = (v: string | undefined, what: string) => { if (!v) throw new Error(`${action} needs ${what}.`); return v; };
    if (action === "list") return ok({ categories: skills.categories(), skills: skills.list().map(({ files, ...s }) => ({ ...s, files: files.length })) });
    if (action === "read") { const r = skills.read(need(id, "an id"), file); return { content: [{ type: "text" as const, text: `${skillPreamble(r.skill)}\n\n--- ${r.file} ---\n${r.text}` }] }; }
    if (action === "add") { const s = await skills.add(need(source, "a source (a link or the SKILL.md text)"), { name }); return ok({ added: { id: s.id, name: s.name, when: s.when, files: s.files, source: s.source }, note: "Saved with the user's own skills (~/.layerwright/skills), enabled; updates don't touch it. It shows in the Skills tab of the Figma window." }); }
    if (action === "remove") { skills.remove(need(id, "an id")); return ok({ removed: id }); }
    const s = skills.setEnabled(need(id, "an id"), action === "enable");
    return ok({ id: s.id, enabled: s.enabled });
  }));

  server.registerTool("figma_cleanup", {
    description: "List what Layerwright created (by session, run or node ids) — e.g. leftovers from failed attempts — and, with approved=true, remove it. Default: this session, list only.",
    inputSchema: { scope: z.enum(["session", "all"]).optional().describe("session (default): this server session; all: every Layerwright-made node in the file"),
      run: z.string().optional().describe("Only one run (the `run` returned by figma_execute_plan)"), nodeIds: z.array(z.string()).optional(), approved: z.boolean().optional() },
  }, async ({ scope, run, nodeIds, approved }) => guard(async () => ok(await bridge.request("cleanup", { session: !run && !nodeIds && scope !== "all" ? session : undefined, run, nodeIds, approved }, 120_000))));

  server.registerTool("figma_select", {
    description: "Select and zoom to node ids in Figma (to show the user what was created or will change). Switches to the page of the first node.",
    inputSchema: { nodeIds: z.array(z.string()).min(1) },
  }, async ({ nodeIds }) => guard(async () => ok(await bridge.request("select", { nodeIds }))));

  server.registerTool("code_scan_components", {
    description: "Scan the codebase (React/Next) for exported UI components, framework/Tailwind/shadcn signals, and suggest Figma↔code mappings by name. Use before implementing a Figma design so existing components are reused.",
    inputSchema: { root: z.string().optional().describe("Project root (default: server working directory)") },
  }, async ({ root }) => guard(async () => ok({ ...scanCodebase(resolve(root ?? workdir), loadDs()), savedMappings: mappings.read() })));

  server.registerTool("code_mapping", {
    description: "Read or upsert the Figma component → code component mapping stored in .layerwright/mapping.json (commit it to share with the team).",
    inputSchema: {
      action: z.enum(["get", "set"]),
      mappings: z.array(z.object({ figmaComponent: z.string(), codeComponent: z.string().optional(), importPath: z.string().optional(), props: z.record(z.string()).optional(), variants: z.record(z.string()).optional(), notes: z.string().optional() })).optional(),
    },
  }, async ({ action, mappings: items }) => guard(async () => ok({ mappings: action === "set" ? mappings.upsert(items ?? []) : mappings.read() })));

  server.registerTool("code_verify_usage", {
    description: "Verify an implementation file against the design: are the mapped code components for the plan's Figma components used? Flags raw <button>/<input> duplicates and arbitrary Tailwind values.",
    inputSchema: { file: z.string(), planId: z.string().optional(), figmaComponents: z.array(z.string()).optional() },
  }, async ({ file, planId, figmaComponents }) => guard(async () => {
    const fromPlan = planId ? Object.keys(plans.get(planId)?.summary.instances ?? {}).map((n) => n.split(" / ")[0]) : [];
    return ok(verifyCodeUsage(resolve(workdir, file), [...fromPlan, ...(figmaComponents ?? [])], mappings));
  }));

  return server;
}
