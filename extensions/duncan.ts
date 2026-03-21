import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { buildSessionContext, convertToLlm, parseSessionEntries } from "@mariozechner/pi-coding-agent";
import { completeSimple } from "@mariozechner/pi-ai";
import type { Model, Api } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";


import { existsSync, openSync, readSync, readFileSync, closeSync, readdirSync, appendFileSync, mkdirSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ============================================================================
// Compaction windowing — split a session into independently queryable windows
// ============================================================================

/**
 * A compaction window: a slice of session context that can be queried independently.
 * For a session with N compactions, there are N+1 windows:
 *   - Window 0: raw messages from start to first compaction
 *   - Window k: compaction[k-1] summary + kept messages through compaction[k]
 *   - Window N: compaction[N-1] summary + messages to leaf (= buildSessionContext default)
 */
export interface CompactionWindow {
  windowIndex: number;
  messages: any[]; // AgentMessage[]
}

/**
 * Extract message from an entry (mirrors compaction.js getMessageFromEntry).
 */
export function getMessageFromEntry(entry: any): any | undefined {
  if (entry.type === "message") return entry.message;
  if (entry.type === "custom_message") {
    // Inline minimal createCustomMessage to avoid import issues
    return {
      role: "custom",
      customType: entry.customType,
      content: entry.content,
      display: entry.display,
      details: entry.details,
      timestamp: new Date(entry.timestamp).getTime(),
    };
  }
  if (entry.type === "branch_summary" && entry.summary) {
    return {
      role: "branchSummary",
      summary: entry.summary,
      fromId: entry.fromId,
      timestamp: new Date(entry.timestamp).getTime(),
    };
  }
  if (entry.type === "compaction") {
    return {
      role: "compactionSummary",
      summary: entry.summary,
      tokensBefore: entry.tokensBefore ?? 0,
      timestamp: new Date(entry.timestamp).getTime(),
    };
  }
  return undefined;
}

/**
 * Split session entries into compaction windows. Each window is an independent
 * message array suitable for duncan queries.
 *
 * For sessions with no compactions, returns a single window with all messages
 * (identical to current buildSessionContext behavior).
 *
 * For sessions with compactions, returns N+1 windows where N = number of compactions.
 * Each window contains the raw messages for that segment, plus the preceding
 * compaction summary if applicable.
 */
export function getCompactionWindows(entries: any[]): CompactionWindow[] {
  // Filter out session header
  const nonHeader = entries.filter((e: any) => e.type !== "session");
  if (nonHeader.length === 0) return [];

  // Build id index for tree traversal
  const byId = new Map<string, any>();
  for (const entry of nonHeader) {
    byId.set(entry.id, entry);
  }

  // Find leaf (last entry)
  const leaf = nonHeader[nonHeader.length - 1];
  if (!leaf) return [];

  // Walk from leaf to root to get the path
  const pathEntries: any[] = [];
  let current: any = leaf;
  while (current) {
    pathEntries.unshift(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }

  // Find all compaction entries on the path, in order
  const compactionIndices: number[] = [];
  for (let i = 0; i < pathEntries.length; i++) {
    if (pathEntries[i].type === "compaction") {
      compactionIndices.push(i);
    }
  }

  // Helper: collect messages from a slice of pathEntries
  const collectMessages = (start: number, end: number): any[] =>
    pathEntries.slice(start, end).map(getMessageFromEntry).filter(Boolean);

  // No compactions — single window with all messages
  if (compactionIndices.length === 0) {
    const messages = collectMessages(0, pathEntries.length);
    return messages.length > 0 ? [{ windowIndex: 0, messages }] : [];
  }

  const windows: CompactionWindow[] = [];

  // Window 0: raw messages before first compaction
  const w0 = collectMessages(0, compactionIndices[0]);
  if (w0.length > 0) windows.push({ windowIndex: 0, messages: w0 });

  // Windows 1..N: compaction summary + kept messages + new messages until next boundary
  for (let k = 0; k < compactionIndices.length; k++) {
    const compIdx = compactionIndices[k];
    const comp = pathEntries[compIdx];
    const nextBoundary = k + 1 < compactionIndices.length ? compactionIndices[k + 1] : pathEntries.length;
    const messages: any[] = [];

    // Compaction summary
    const compMsg = getMessageFromEntry(comp);
    if (compMsg) messages.push(compMsg);

    // Kept messages: entries before the compaction, from firstKeptEntryId onward
    if (comp.firstKeptEntryId) {
      let found = false;
      for (let i = 0; i < compIdx; i++) {
        if (pathEntries[i].id === comp.firstKeptEntryId) found = true;
        if (found) {
          const msg = getMessageFromEntry(pathEntries[i]);
          if (msg) messages.push(msg);
        }
      }
    }

    // New messages after compaction until next boundary
    messages.push(...collectMessages(compIdx + 1, nextBoundary));

    if (messages.length > 0) windows.push({ windowIndex: k + 1, messages });
  }

  return windows;
}

// ============================================================================
// Query metadata
// ============================================================================

// Query log location. Defaults to duncan.jsonl next to this extension file.
// Override via DUNCAN_LOG env var.
const __dirname = path.dirname(new URL(import.meta.url).pathname);
const DUNCAN_LOG = process.env.DUNCAN_LOG ?? path.join(__dirname, "duncan.jsonl");

interface DuncanRecord {
  question: string;
  answer: string;
  hasContext: boolean;
  targetSession: string;
  windowIndex: number;
  sourceSession: string;
  timestamp: string;
}

function recordQuery(record: DuncanRecord): void {
  const dir = path.dirname(DUNCAN_LOG);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(DUNCAN_LOG, JSON.stringify(record) + "\n");
}

// ============================================================================
// Duncan query — structured output via tool call
// ============================================================================

const DUNCAN_RESPONSE_TOOL = {
  name: "duncan_response",
  description: "Provide your answer to the query.",
  parameters: Type.Object({
    hasContext: Type.Boolean({ description: "true if the conversation contained specific information to answer the question, false if it did not" }),
    answer: Type.String({ description: "Your answer based on the conversation context, or a brief explanation of why you lack context" }),
  }),
};

const DUNCAN_PREFIX = `Answer solely based on the conversation above. If you don't explicitly have context from the conversation on this topic, say so. Use the duncan_response tool to provide your answer.\n\n`;

interface DuncanResult {
  answer: string;
  hasContext: boolean;
}

function validateDuncanResponse(response: any): DuncanResult | null {
  const toolCall = response.content.find((c: any) => c.type === "toolCall" && c.name === "duncan_response");
  if (!toolCall || toolCall.type !== "toolCall") return null;
  const { answer, hasContext } = toolCall.arguments;
  if (typeof answer !== "string" || typeof hasContext !== "boolean") return null;
  return { answer, hasContext };
}

const MAX_RETRIES = 3;

interface DuncanTarget {
  sessionFile: string;
  windowIndex: number;
  messages: any[]; // AgentMessage[]
}

export function getDuncanTargets(sessionFile: string): DuncanTarget[] {
  const content = readFileSync(sessionFile, "utf-8");
  const entries = parseSessionEntries(content);
  const windows = getCompactionWindows(entries);
  return windows.map(w => ({
    sessionFile,
    windowIndex: w.windowIndex,
    messages: w.messages,
  }));
}

async function duncanQuery(
  messages: any[],
  question: string,
  model: Model<Api>,
  apiKey: string,
  opts: { systemPrompt: string; signal?: AbortSignal },
): Promise<DuncanResult> {
  const llmMessages = convertToLlm([
    ...messages,
    { role: "user", content: [{ type: "text", text: DUNCAN_PREFIX + question }], timestamp: Date.now() },
  ]);
  const tools = [DUNCAN_RESPONSE_TOOL];
  const complete = () => completeSimple(model, { systemPrompt: opts.systemPrompt, messages: llmMessages, tools }, { apiKey, signal: opts.signal, maxTokens: 16384 });

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const response = await complete();

    if (response.stopReason === "error") {
      throw new Error(`Query failed (attempt ${attempt}): ${(response as any).errorMessage || "unknown error"}`);
    }

    const result = validateDuncanResponse(response);
    if (result) return result;

    llmMessages.push(
      { role: "assistant" as const, content: response.content, stopReason: response.stopReason, model: response.model, usage: response.usage },
      { role: "user" as const, content: [{ type: "text" as const, text: "You must respond by calling the duncan_response tool with { hasContext: boolean, answer: string }. Do not respond with plain text." }], timestamp: Date.now() },
    );
  }

  throw new Error(`Duncan query failed after ${MAX_RETRIES} retries: model did not produce a valid duncan_response tool call`);
}

/**
 * Query a dormant session with a plain text prompt (for handoff summaries).
 * No structured output — just returns the response text.
 */
async function sessionQuery(
  sessionFile: string,
  prompt: string,
  model: Model<Api>,
  apiKey: string,
  opts?: { systemPrompt?: string; signal?: AbortSignal },
): Promise<string> {
  const content = readFileSync(sessionFile, "utf-8");
  const entries = parseSessionEntries(content);
  const sessionEntries = entries.filter((e: any) => e.type !== "session");
  const { messages } = buildSessionContext(sessionEntries);

  messages.push({
    role: "user",
    content: [{ type: "text", text: prompt }],
    timestamp: Date.now(),
  });

  const llmMessages = convertToLlm(messages);

  const response = await completeSimple(model, {
    systemPrompt: opts?.systemPrompt ?? "",
    messages: llmMessages,
  }, {
    apiKey,
    signal: opts?.signal,
    maxTokens: 16384,
  });

  if (response.stopReason === "error") {
    throw new Error(`Query failed: ${(response as any).errorMessage || "unknown error"}`);
  }

  return response.content
    .filter((c: any) => c.type === "text")
    .map((c: any) => c.text)
    .join("\n");
}

// ============================================================================
// Lineage helpers — built on pi's native parentSession header
// ============================================================================

export function readSessionHeader(sessionFile: string): { id: string; parentSession?: string; timestamp: string } | null {
  if (!existsSync(sessionFile)) return null;
  try {
    const fd = openSync(sessionFile, "r");
    const buf = Buffer.alloc(2048);
    const bytesRead = readSync(fd, buf, 0, 2048, 0);
    closeSync(fd);
    const firstLine = buf.toString("utf-8", 0, bytesRead).split("\n")[0];
    return JSON.parse(firstLine);
  } catch {
    return null;
  }
}

interface SessionNode {
  file: string;
  id: string;
  parent?: string;
  children: string[];
  generation: number;
  timestamp: string;
}

export function buildSessionTree(sessionDir: string): Map<string, SessionNode> {
  const nodes = new Map<string, SessionNode>();

  try {
    const files = readdirSync(sessionDir);
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const fullPath = path.join(sessionDir, f);
      const header = readSessionHeader(fullPath);
      if (!header) continue;
      nodes.set(fullPath, {
        file: fullPath,
        id: header.id,
        parent: header.parentSession,
        children: [],
        generation: 0,
        timestamp: header.timestamp,
      });
    }
  } catch { return nodes; }

  for (const [_file, node] of nodes) {
    if (node.parent && nodes.has(node.parent)) {
      nodes.get(node.parent)!.children.push(node.file);
    }
  }

  for (const node of nodes.values()) {
    node.children.sort((a, b) => {
      const ta = nodes.get(a)?.timestamp ?? "";
      const tb = nodes.get(b)?.timestamp ?? "";
      return ta.localeCompare(tb);
    });
  }

  const roots = [...nodes.values()].filter(n => !n.parent || !nodes.has(n.parent));
  const queue = [...roots];
  while (queue.length > 0) {
    const node = queue.shift()!;
    for (const childFile of node.children) {
      const child = nodes.get(childFile);
      if (child) {
        child.generation = node.generation + 1;
        queue.push(child);
      }
    }
  }

  return nodes;
}

export function findLineageRoot(nodes: Map<string, SessionNode>, sessionFile: string): string {
  let current = sessionFile;
  while (true) {
    const node = nodes.get(current);
    if (!node?.parent || !nodes.has(node.parent)) return current;
    current = node.parent;
  }
}

export function collectLineage(nodes: Map<string, SessionNode>, rootFile: string): Set<string> {
  const lineage = new Set<string>();
  const queue = [rootFile];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (lineage.has(file)) continue;
    lineage.add(file);
    const node = nodes.get(file);
    if (node) queue.push(...node.children);
  }
  return lineage;
}

export function resolveGeneration(sessionFile: string, sessionDir: string): number {
  const nodes = buildSessionTree(sessionDir);
  return nodes.get(sessionFile)?.generation ?? 0;
}

export function getSessionPreview(sessionFile: string): string {
  if (!existsSync(sessionFile)) return "";
  try {
    const content = readFileSync(sessionFile, "utf-8");
    const lines = content.split("\n");
    for (const line of lines) {
      if (!line.includes('"role":"user"')) continue;
      try {
        const entry = JSON.parse(line);
        if (entry?.type !== "message" || entry?.message?.role !== "user") continue;
        const msg = entry.message.content;
        let text = "";
        if (typeof msg === "string") {
          text = msg;
        } else if (Array.isArray(msg)) {
          for (const c of msg) {
            if (c?.type === "text") { text = c.text; break; }
          }
        }
        text = text.replace(/[\n\r\t]+/g, " ").trim();
        if (text.length > 80) text = text.slice(0, 77) + "...";
        return text;
      } catch { continue; }
    }
    return "(no messages)";
  } catch {
    return "";
  }
}

/**
 * Get all session files in a directory, ordered by recency (newest first).
 */
export function getProjectSessions(sessionDir: string): string[] {
  try {
    return readdirSync(sessionDir)
      .filter(f => f.endsWith(".jsonl"))
      .sort((a, b) => b.localeCompare(a)) // newest first (timestamp prefix)
      .map(f => path.join(sessionDir, f));
  } catch {
    return [];
  }
}

/**
 * Get all session files across all project directories, ordered by recency (newest first).
 */
export function getGlobalSessions(sessionDir: string): string[] {
  const sessionsRoot = path.dirname(sessionDir); // ~/.pi/agent/sessions/
  try {
    const dirs = readdirSync(sessionsRoot, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => path.join(sessionsRoot, d.name));
    const allFiles: string[] = [];
    for (const dir of dirs) {
      try {
        const files = readdirSync(dir)
          .filter(f => f.endsWith(".jsonl"))
          .map(f => path.join(dir, f));
        allFiles.push(...files);
      } catch { /* skip unreadable dirs */ }
    }
    return allFiles.sort((a, b) => path.basename(b).localeCompare(path.basename(a)));
  } catch {
    return [];
  }
}

/**
 * Get descendant chain from current session (BFS, children only — excludes self).
 */
export function getDescendantChain(sessionFile: string, sessionDir: string): string[] {
  const nodes = buildSessionTree(sessionDir);
  const chain: string[] = [];
  const current = nodes.get(sessionFile);
  if (!current) return chain;
  const queue = [...current.children];
  while (queue.length > 0) {
    const childFile = queue.shift()!;
    const child = nodes.get(childFile);
    if (child) {
      chain.push(childFile);
      queue.push(...child.children);
    }
  }
  return chain;
}

/**
 * Get ancestor chain from current session to root (parent first).
 */
export function getAncestorChain(sessionFile: string, sessionDir: string): string[] {
  const nodes = buildSessionTree(sessionDir);
  const chain: string[] = [];
  // Include current session — its earlier compaction windows are ancestors too.
  // The last window (active context) gets filtered out downstream.
  let current = nodes.get(sessionFile);
  if (current) chain.push(sessionFile);
  while (current?.parent && nodes.has(current.parent)) {
    chain.push(current.parent);
    current = nodes.get(current.parent);
  }
  return chain;
}

/**
 * Resolve model and API key from extension context.
 */
async function getModelAndKey(ctx: ExtensionContext): Promise<{ model: Model<Api>; apiKey: string }> {
  const model = ctx.model;
  if (!model) throw new Error("No model selected");
  const apiKey = await ctx.modelRegistry.getApiKeyForProvider(model.provider);
  if (!apiKey) throw new Error(`No API key for provider "${model.provider}"`);
  return { model, apiKey };
}

// ============================================================================
// Extension
// ============================================================================

export default function (pi: ExtensionAPI) {
  const THRESHOLD = 80;
  let warned = false;

  pi.on("session_start", async () => {
    warned = false;
  });

  pi.on("turn_end", async (_event, ctx) => {
    const usage = ctx.getContextUsage();
    if (!usage || usage.percent === null) return;
    if (usage.percent > THRESHOLD && !warned) {
      warned = true;
      ctx.ui.notify(
        `Context at ${Math.round(usage.percent)}% — run /dfork to hand off`,
        "warning"
      );
    }
  });

  // ---- duncan tool — query dormant sessions in-process ----
  pi.registerTool({
    name: "duncan",
    label: "Duncan",
    description: "Query a dormant session from a previous context handoff. Loads the session's full conversation context and asks a question against it using the same model. Use this when you need information from a previous session that isn't in your current context.",
    promptSnippet: "duncan — query dormant sessions from previous handoffs for information not in current context",
    promptGuidelines: [
      "Use duncan when the current context references a previous session or when the user asks about work done in earlier sessions.",
      "The 'sessions' parameter accepts 'parent' (immediate parent only), 'ancestors' (walk up lineage, parent first), 'descendants' (walk down to children, BFS), 'project' (all sessions from same working directory, newest first), 'global' (all sessions across all projects, newest first), or a specific session filename.",
      "For 'ancestors' mode, sessions are queried parent-first — the answer comes from the first session that has relevant information.",
      "For 'descendants' mode, child sessions are queried breadth-first. Use when you spawned work via /dfork and need to know what happened in those sessions.",
      "For 'project' mode, all sessions started from the same working directory are queried (newest first). Use when the information might be in a non-ancestor session from the same project.",
      "For 'global' mode, all sessions across all working directories are queried (newest first). Use as a last resort when the information might be in an unrelated project.",
      "Keep questions specific and self-contained — the dormant session has no knowledge of the current conversation.",
      "Results include pagination info when not all windows were queried. Call again with a higher offset to continue searching.",
    ],
    parameters: Type.Object({
      question: Type.String({ description: "The question to ask the dormant session. Should be specific and self-contained." }),
      sessions: Type.String({ description: "Which sessions to query: 'parent' (immediate parent only), 'ancestors' (walk up lineage, parent first), 'descendants' (walk down to children, BFS), 'project' (all sessions from same working directory, newest first), 'global' (all sessions across all projects, newest first), or a session filename." }),
      limit: Type.Optional(Type.Number({ description: "Max windows to query. Defaults: 50 for ancestors/descendants/project/global, unlimited for parent and explicit filename." })),
      offset: Type.Optional(Type.Number({ description: "Skip this many windows before querying. Use for pagination when a previous query didn't find what you needed. Default: 0." })),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (!sessionFile) {
        return { content: [{ type: "text", text: "Error: no active session" }], isError: true };
      }

      const sessionDir = path.dirname(sessionFile);
      let targets: string[] = [];
      const LIMITED_MODES = new Set(["ancestors", "descendants", "project", "global"]);
      const DEFAULT_LIMIT = 50;
      const limit = params.limit ?? (LIMITED_MODES.has(params.sessions) ? DEFAULT_LIMIT : Infinity);
      const offset = params.offset ?? 0;

      if (params.sessions === "parent") {
        const chain = getAncestorChain(sessionFile, sessionDir);
        // chain[0] is self — parent is chain[1]
        if (chain.length < 2) {
          return { content: [{ type: "text", text: "No parent session found." }], isError: true };
        }
        targets = [chain[1]];
      } else if (params.sessions === "ancestors") {
        targets = getAncestorChain(sessionFile, sessionDir);
        if (targets.length === 0) {
          return { content: [{ type: "text", text: "No ancestor sessions found." }], isError: true };
        }
      } else if (params.sessions === "descendants") {
        targets = getDescendantChain(sessionFile, sessionDir);
        if (targets.length === 0) {
          return { content: [{ type: "text", text: "No descendant sessions found." }], isError: true };
        }
      } else if (params.sessions === "project") {
        targets = getProjectSessions(sessionDir);
        if (targets.length === 0) {
          return { content: [{ type: "text", text: "No sessions found in this project directory." }], isError: true };
        }
      } else if (params.sessions === "global") {
        targets = getGlobalSessions(sessionDir);
        if (targets.length === 0) {
          return { content: [{ type: "text", text: "No sessions found." }], isError: true };
        }
      } else {
        // Treat as filename — resolve relative to session dir
        const target = path.resolve(sessionDir, params.sessions);
        if (!existsSync(target)) {
          return { content: [{ type: "text", text: `Session not found: ${params.sessions}` }], isError: true };
        }
        targets = [target];
      }

      // Deduplicate session files (ancestor + project could overlap)
      targets = [...new Set(targets)];

      // Expand session files into duncan targets (one per compaction window)
      const allTargets: DuncanTarget[] = [];
      for (const target of targets) {
        try {
          const windows = getDuncanTargets(target);
          if (target === sessionFile) {
            // Current session: drop the last window (that's our active context),
            // but keep earlier windows — those are behind compaction barriers
            windows.pop();
          }
          allTargets.push(...windows);
        } catch (err: any) {
          // If a file can't be parsed, skip it
        }
      }

      if (allTargets.length === 0) {
        return { content: [{ type: "text", text: "No queryable context found in target sessions." }], isError: true };
      }

      // Apply offset and limit
      const totalWindows = allTargets.length;
      const duncanTargets = allTargets.slice(offset, offset + limit);

      if (duncanTargets.length === 0) {
        return { content: [{ type: "text", text: `No windows in range (offset ${offset}, total ${totalWindows}).` }], isError: true };
      }

      const sessionCount = new Set(duncanTargets.map(t => t.sessionFile)).size;
      const windowCount = duncanTargets.length;
      const hasMore = offset + limit < totalWindows;

      const update = (text: string) => onUpdate?.({ content: [{ type: "text", text }] });
      const rangeLabel = hasMore || offset > 0 ? ` (${offset}–${offset + windowCount} of ${totalWindows})` : "";
      update(`**${params.question}**\n\nquerying ${windowCount} window${windowCount === 1 ? "" : "s"} from ${sessionCount} session${sessionCount === 1 ? "" : "s"}${rangeLabel} (${params.sessions})…`);

      let { model, apiKey } = await getModelAndKey(ctx);
      const systemPrompt = ctx.getSystemPrompt();
      const sourceSession = path.basename(sessionFile);
      const BATCH_SIZE = 10;
      let completed = 0;

      const queryTarget = async (target: DuncanTarget): Promise<{ session: string; window: number; answer: string; hasContext: boolean }> => {
        const targetSession = path.basename(target.sessionFile);
        try {
          const result = await duncanQuery(target.messages, params.question, model, apiKey, { systemPrompt, signal });
          recordQuery({
            question: params.question, answer: result.answer, hasContext: result.hasContext,
            targetSession, windowIndex: target.windowIndex, sourceSession, timestamp: new Date().toISOString(),
          });
          completed++;
          update(`**${params.question}**\n\n${completed}/${windowCount} windows queried…`);
          return { session: targetSession, window: target.windowIndex, ...result };
        } catch (err: any) {
          completed++;
          update(`**${params.question}**\n\n${completed}/${windowCount} windows queried…`);
          return { session: targetSession, window: target.windowIndex, answer: `Error: ${err.message}`, hasContext: false };
        }
      };

      const results: Array<{ session: string; window: number; answer: string; hasContext: boolean }> = [];

      for (let i = 0; i < duncanTargets.length; i += BATCH_SIZE) {
        if (signal?.aborted) break;
        const batch = duncanTargets.slice(i, i + BATCH_SIZE);
        const batchResults = await Promise.all(batch.map(queryTarget));
        results.push(...batchResults);
      }

      // Filter: only return answers that have context, unless none do
      const withContext = results.filter(r => r.hasContext);
      const relevant = withContext.length > 0 ? withContext : results;

      const answers = relevant.map(r => {
        const windowLabel = windowCount > sessionCount ? ` (window ${r.window})` : "";
        return relevant.length === 1
          ? r.answer
          : `### ${r.session}${windowLabel}\n${r.answer}`;
      }).join("\n\n---\n\n");

      const parts = [`**${params.question}**\n\n${answers}`];

      if (hasMore) {
        const nextOffset = offset + limit;
        const remaining = totalWindows - nextOffset;
        parts.push(`\n\n---\n*Queried ${windowCount} of ${totalWindows} windows (offset ${offset}). ${remaining} more available — call again with offset: ${nextOffset} to continue.*`);
      }

      return { content: [{ type: "text", text: parts.join("") }] };
    },
  });

  // ---- /dfork — handoff to new session ----
  pi.registerCommand("dfork", {
    description: "Hand off to a new session with context summary",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();

      const oldSessionFile = ctx.sessionManager.getSessionFile();
      if (!oldSessionFile) {
        ctx.ui.notify("No active session", "error");
        return;
      }
      const oldSessionId = path.basename(oldSessionFile, ".jsonl").split("_").pop();
      const sessionDir = path.dirname(oldSessionFile);
      const oldGen = resolveGeneration(oldSessionFile, sessionDir);

      ctx.ui.notify("Generating dfork summary...", "info");

      // Adapted from pi's compaction SUMMARIZATION_PROMPT
      const summaryPrompt = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

      try {
        const { model, apiKey } = await getModelAndKey(ctx);
        const summary = await sessionQuery(oldSessionFile, summaryPrompt, model, apiKey, {
          systemPrompt: ctx.getSystemPrompt(),
        });

        if (!summary.trim()) {
          ctx.ui.notify("Summary generation returned empty response", "error");
          return;
        }

        const newGen = oldGen + 1;

        const newSession = await ctx.newSession({
          parentSession: oldSessionFile,
          setup: async (sm) => {
            sm.appendMessage({
              role: "user",
              content: [{
                type: "text",
                text: `# Duncan Handoff (gen ${newGen})\n\nContinuing from previous session \`${oldSessionId}\`.\n\n${summary}`,
              }],
              timestamp: Date.now(),
            });
          },
        });

        if (newSession.cancelled) {
          ctx.ui.notify("Handoff cancelled", "info");
          return;
        }

        warned = false;
        ctx.ui.notify(`dfork complete (gen ${newGen}) ✓`, "success");
      } catch (err: any) {
        ctx.ui.notify(`Handoff failed: ${err.message?.slice(0, 200)}`, "error");
      }
    },
  });

  // ---- /lineage — show session tree, optionally switch ----
  pi.registerCommand("lineage", {
    description: "Show session lineage tree and switch sessions. Use /lineage all to include unrelated sessions.",
    handler: async (args, ctx) => {
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (!sessionFile) {
        ctx.ui.notify("No active session", "error");
        return;
      }
      const sessionDir = path.dirname(sessionFile);
      const nodes = buildSessionTree(sessionDir);

      if (nodes.size === 0) {
        ctx.ui.notify("No sessions found", "error");
        return;
      }

      const showAll = args.trim() === "all";
      const rootFile = findLineageRoot(nodes, sessionFile);
      const lineage = collectLineage(nodes, rootFile);

      const previews = new Map<string, string>();
      const windowCounts = new Map<string, number>();
      const sessionFiles = showAll ? [...nodes.keys()] : [...lineage];
      for (const file of sessionFiles) {
        previews.set(file, getSessionPreview(file));
        // Count compaction windows (compactions + 1) — cheap line scan
        try {
          const raw = readFileSync(file, "utf-8");
          const compactions = (raw.match(/"type":"compaction"/g) || []).length;
          windowCounts.set(file, compactions + 1);
        } catch {
          windowCounts.set(file, 1);
        }
      }

      const options: string[] = [];
      const fileByOption = new Map<string, string>();

      function addOption(file: string, node: SessionNode, depth: number) {
        const indent = "  ".repeat(depth);
        const shortId = node.id.split("-")[0];
        const date = node.timestamp.replace("T", " ").slice(0, 16);
        const marker = file === sessionFile ? " ◀" : "";
        const wc = windowCounts.get(file) ?? 1;
        const windowBadge = wc > 1 ? ` [${wc}w]` : "";
        const preview = previews.get(file) ?? "";
        const label = `${indent}${shortId} (${date})${windowBadge}${marker}  ${preview}`;
        options.push(label);
        fileByOption.set(label, file);
      }

      const collectTree = (file: string, depth: number, filter?: Set<string>) => {
        const node = nodes.get(file);
        if (!node) return;
        addOption(file, node, depth);
        const children = filter ? node.children.filter(c => filter.has(c)) : node.children;
        for (const child of children) {
          collectTree(child, depth + 1, filter);
        }
      };

      collectTree(rootFile, 0, lineage);

      if (showAll) {
        const others = [...nodes.keys()].filter(f => !lineage.has(f));
        if (others.length > 0) {
          options.push("── other sessions ──");
          fileByOption.set("── other sessions ──", "");
          for (const file of others) {
            addOption(file, nodes.get(file)!, 0);
          }
        }
      }

      if (options.length === 1) {
        ctx.ui.notify("Only one session in lineage (this one)", "info");
        return;
      }

      const choice = await ctx.ui.select(
        showAll ? "All sessions" : "Lineage",
        options
      );
      if (!choice) return;

      const targetFile = fileByOption.get(choice);
      if (!targetFile || targetFile === sessionFile) {
        if (targetFile === sessionFile) ctx.ui.notify("Already on this session", "info");
        return;
      }

      await ctx.switchSession(targetFile);
    },
  });
}
