// Which request from the Figma window a tool call works on: every Figma tool takes an optional `requestId`.
// Several requests can run at once (in background subagents); the plugin gives each its own cursor, so the user sees
// who works on what. The id rides along with every bridge request made while that tool call runs.
import { AsyncLocalStorage } from "node:async_hooks";

const store = new AsyncLocalStorage<string | undefined>();

/** Run a tool call on behalf of a task (or none). */
export const withTask = <T>(task: string | undefined, fn: () => T): T => store.run(task, fn);

/** The task of the tool call running now, if it named one. */
export const currentTask = (): string | undefined => store.getStore();
