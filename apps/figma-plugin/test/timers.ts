// Timers the plugin's own code (src/) starts, tracked so a test can tell that nothing keeps running after a request.
// Import it before the plugin code. Intervals are unref'd, so a plugin-wide poll doesn't keep the test run alive.
const live = new Map<unknown, string>();
const fromSrc = () => /\/src\/[\w-]+\.ts/.exec(new Error().stack ?? "")?.[0];
const g = globalThis as any;
const { setTimeout: st, clearTimeout: ct, setInterval: si, clearInterval: ci } = globalThis;
g.setTimeout = (fn: (...a: unknown[]) => void, ms?: number, ...a: unknown[]) => {
  const at = fromSrc();
  const h = st(() => { live.delete(h); fn(...a); }, ms);
  if (at) live.set(h, at);
  return h;
};
g.clearTimeout = (h: any) => { live.delete(h); ct(h); };
g.setInterval = (fn: (...a: unknown[]) => void, ms?: number, ...a: unknown[]) => {
  const at = fromSrc();
  const h = si(fn, ms, ...a);
  h.unref?.();
  if (at) { live.set(h, `${at} (interval)`); intervals.push({ at, ms: ms ?? 0, fn: () => fn(...a) }); }
  return h;
};
/** The intervals the plugin started, so a test can run a tick now instead of waiting for it. */
export const intervals: { at: string; ms: number; fn: () => void }[] = [];
g.clearInterval = (h: any) => { live.delete(h); ci(h); };

/** The plugin's timers that are still pending or running, by the file that started them. */
export function pendingTimers(): string[] { return [...live.values()]; }
