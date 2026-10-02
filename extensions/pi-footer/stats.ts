/** Numbers the footer reads from the session: tokens, cost, turns, speed, context, prompt cache. */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { estimateTokens } from "@earendil-works/pi-coding-agent";

// Assumed when the model declares no prompt-cache lifetime (pi itself then tracks none).
const DEFAULT_CACHE_TTL_S = 300;

type Usage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost?: { total: number };
};
type Entry = {
  type: string;
  kind?: string; // "cache_warm" on usage entries written by pi's cache warming
  timestamp?: string;
  usage?: Usage;
  message?: {
    role: string;
    usage?: Usage;
    timestamp?: number;
    content?: unknown;
    provider?: string;
    model?: string;
    thinkingLevel?: string;
    stopReason?: string;
  };
};
export type CacheModel = {
  cost?: { cacheRead: number; cacheWrite: number }; // $ per million tokens
  promptCache?: { short?: number; long?: number }; // lifetimes in seconds
};

/** First token time by assistant message timestamp (set just before its request). Not saved. */
const firstTokenAt = new Map<number, number>();
/** Records when an assistant message's first token arrived (its first update). */
export const noteFirstToken = (timestamp: number) => {
  if (!firstTokenAt.has(timestamp)) firstTokenAt.set(timestamp, Date.now());
};

/**
 * Keeps `fn`'s result until a new entry lands (the leaf moves), the session or the model changes:
 * the footer draws on every frame (every wheel tick in full screen), and these walk the session.
 */
export function perLeaf<T>(fn: (ctx: ExtensionContext) => T) {
  let last: { key: string; value: T } | undefined;
  return (ctx: ExtensionContext) => {
    const m = ctx.model;
    const key = `${ctx.sessionManager.getSessionFile()}|${ctx.sessionManager.getLeafId()}|${m?.provider}/${m?.id}`;
    if (last?.key !== key) last = { key, value: fn(ctx) };
    return last.value;
  };
}

export const sessionStats = perLeaf((ctx) => {
  const s = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    turnCost: 0, // since the last run started: the running turn, or the last one
    cacheHit: undefined as number | undefined,
    responses: 0,
    userMessages: 0,
    toolCalls: 0,
    compactions: 0,
    lastSpeed: undefined as number | undefined,
    streamMs: 0,
    streamOutput: 0,
    lastTtft: undefined as number | undefined,
    ttftMs: 0,
    ttftCount: 0,
    workingMs: 0,
    lastTurnMs: 0, // the last run, from its start to its last entry
    startedAt: undefined as number | undefined,
    cachedAt: undefined as number | undefined, // last response or warm refresh that used the cache
    lastCached: false, // last response read or wrote the prompt cache
    lastModel: undefined as string | undefined, // provider/model of the last response
    compactedSince: false, // compaction after the last response: history no longer matches the cache
  };
  let runStart: number | undefined;
  let runEnd = 0;
  let idle = true; // the last response ended its run (or there is none yet)
  let woke: number | undefined; // a custom message while idle (another agent's, a job's end)
  const startRun = (ts: number) => {
    s.turnCost = 0;
    if (runStart !== undefined) s.workingMs += runEnd - runStart;
    runStart = runEnd = ts;
  };
  for (const e of ctx.sessionManager.getEntries() as Entry[]) {
    const ts = e.timestamp ? Date.parse(e.timestamp) : undefined;
    const assistant = e.type === "message" && e.message?.role === "assistant";
    if (ts !== undefined) {
      s.startedAt ??= ts;
      // A run (working time, the turn's cost): from a user message, or a custom message that woke
      // the idle agent (once a response follows it), to the last entry before the next run.
      if (e.type === "message" && e.message?.role === "user") {
        s.userMessages++;
        woke = undefined;
        startRun(ts);
      } else if (e.type === "custom_message" && idle) woke ??= ts;
      else if (assistant && woke !== undefined) {
        startRun(woke);
        runEnd = ts;
        woke = undefined;
      } else if (runStart !== undefined) runEnd = ts;
    }
    if (assistant) idle = e.message!.stopReason !== "toolUse";
    if (e.type === "compaction") {
      s.compactions++;
      s.compactedSince = true;
    }
    // Compaction and branch summaries bill their summary request, as in pi's footer.
    const usage =
      e.type === "usage" || e.type === "compaction" || e.type === "branch_summary"
        ? e.usage
        : e.type === "message" && e.message?.role !== "user"
          ? e.message?.usage
          : undefined;
    if (!usage) continue;
    s.input += usage.input;
    s.output += usage.output;
    s.cacheRead += usage.cacheRead;
    s.cacheWrite += usage.cacheWrite;
    s.cost += usage.cost?.total ?? 0;
    s.turnCost += usage.cost?.total ?? 0;
    if (e.type === "usage" && e.kind === "cache_warm") s.cachedAt = ts ?? s.cachedAt; // refresh extends the cache
    if (e.message?.role !== "assistant") continue;
    s.lastCached = usage.cacheRead + usage.cacheWrite > 0;
    if (s.lastCached) s.cachedAt = ts ?? s.cachedAt;
    s.lastModel = `${e.message.provider}/${e.message.model}`;
    s.compactedSince = false;
    s.responses++;
    if (Array.isArray(e.message.content))
      s.toolCalls += e.message.content.filter((c) => c?.type === "toolCall").length;
    const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
    if (prompt > 0) s.cacheHit = (usage.cacheRead / prompt) * 100;
    // Time to first token, and tokens per second from it to saved (this session's responses only).
    const sent = e.message.timestamp ?? 0;
    const first = firstTokenAt.get(sent);
    if (first === undefined || ts === undefined) continue;
    s.lastTtft = first - sent;
    s.ttftMs += s.lastTtft;
    s.ttftCount++;
    // Output arrives in bursts (a short reply can land in one chunk), so skip sub-second streams.
    const ms = ts - first;
    if (ms >= 1000 && usage.output > 0) {
      s.lastSpeed = usage.output / (ms / 1000);
      s.streamMs += ms;
      s.streamOutput += usage.output;
    }
  }
  if (runStart !== undefined) {
    s.lastTurnMs = runEnd - runStart;
    s.workingMs += s.lastTurnMs;
  }
  return s;
});
export type Stats = ReturnType<typeof sessionStats>;

// After a compaction pi reports no context tokens until the next response (e.g. a session resumed
// right after an auto-compaction). Estimate them like pi does (chars / 4) over the session's
// messages: no system prompt or tools, so it runs low.
export const contextUsage = perLeaf((ctx) => {
  const usage = ctx.getContextUsage();
  if (usage?.tokens !== null) return usage && { ...usage, estimated: false };
  const { messages } = ctx.sessionManager.buildSessionContext();
  const tokens = messages.reduce((n, m) => n + estimateTokens(m), 0);
  return { ...usage, tokens, percent: (tokens / usage.contextWindow) * 100, estimated: true };
});

/**
 * With a virtual model (api "pi-virtual"), the physical model and thinking level of the branch's
 * latest response, like pi's own footer: the virtual model has no cost or cache lifetime.
 */
export const routedModel = perLeaf((ctx) => {
  if (ctx.model?.api !== "pi-virtual") return undefined;
  const branch = ctx.sessionManager.getBranch() as Entry[];
  for (let i = branch.length - 1; i >= 0; i--) {
    const m = branch[i]!.message;
    if (branch[i]!.type !== "message" || m?.role !== "assistant") continue;
    if (m.stopReason === "error" || m.stopReason === "aborted") continue;
    const model = ctx.modelRegistry.find(m.provider ?? "", m.model ?? "");
    return model && model.api !== "pi-virtual"
      ? { model, thinkingLevel: m.thinkingLevel }
      : undefined;
  }
  return undefined;
});

/**
 * Prompt cache: alive for its lifetime after the last cached response (or warm refresh); cold
 * once that passes, the model changed, or the history was compacted: the next message re-bills.
 */
export function cacheState(ctx: ExtensionContext, s: Stats) {
  const model = routedModel(ctx)?.model ?? ctx.model;
  const ttlMs =
    ((model as CacheModel | undefined)?.promptCache?.[
      process.env.PI_CACHE_RETENTION === "long" ? "long" : "short"
    ] ?? DEFAULT_CACHE_TTL_S) * 1000;
  const cacheAge = s.cachedAt !== undefined ? Date.now() - s.cachedAt : 0;
  const expired = cacheAge > ttlMs;
  const modelChanged = !!model && !!s.lastModel && s.lastModel !== `${model.provider}/${model.id}`;
  return {
    ttlMs,
    cacheAge,
    expired,
    cold: s.lastCached && (expired || modelChanged || s.compactedSince),
  };
}
