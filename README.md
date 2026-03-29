# duncan

Session memory for [pi](https://github.com/badlogic/pi-mono). Query dormant sessions, hand off context across session boundaries.

## What it does

When pi sessions end or hit their context window limit, the conversation is gone from the LLM's perspective. Duncan lets you query those dormant sessions — the full conversation history is still on disk, and duncan loads it into a fresh LLM call to answer questions about what happened.

**`duncan` tool** — the LLM calls this to query past sessions. Supports targeting by lineage (ancestors, descendants, parent) or by project (all sessions in the same working directory). Handles compaction windows so pre-compaction context is still reachable.

**`/skill:duncan`** — natural language interface. Just ask a question and the LLM figures out which sessions to search and how to route the query.

**`/dfork`** — hands off the current session to a new one with a structured summary. Use when you're approaching the context limit. The new session starts with a compressed checkpoint of everything that happened. Duncan warns at 80% context usage.

**`/lineage`** — shows the session tree and lets you switch between sessions. Displays generation, compaction window count, and a preview of each session's first message.

## Install

```bash
pi install npm:@gswangg/duncan-pi
# or
pi install git:github.com/gswangg/duncan-pi
```

## Configuration

**Query log** — duncan logs all queries to `duncan.jsonl` in the extension's own directory (next to `duncan.ts`). Override with:

```bash
export DUNCAN_LOG=/path/to/duncan.jsonl
```

## Usage

### Querying past sessions

The LLM uses the `duncan` tool automatically when it needs information from a previous session. You can also ask directly via the skill:

```
/skill:duncan what did we decide about the database schema?
```

### Handing off context

When your context window is getting full (duncan warns at 80%):

```
/dfork
```

This generates a structured summary of the current session and starts a new one with that summary as the opening message. The new session is linked to the old one via pi's parent session mechanism.

### Navigating sessions

```
/lineage          # show tree of related sessions
/lineage all      # include unrelated sessions too
```

## How it works

### Compaction windows

Pi's compaction feature summarizes old messages to free up context space, but the original messages are still in the session file. Duncan splits each session into independently queryable "windows" — one per compaction boundary — so information that was compacted away is still reachable.

### Query routing

The `sessions` parameter controls which sessions are searched:

| Mode | Behavior |
|------|----------|
| `ancestors` | Walk up the parent chain (default, start here) |
| `parent` | Immediate parent only |
| `descendants` | Children, breadth-first |
| `project` | All sessions in the same working directory, newest first |
| `global` | All sessions across all working directories, newest first |
| `<filename>` | A specific session file |

Each session/window is queried independently. Duncan uses structured output (tool call) to get a `hasContext` boolean from each query — only answers that actually found relevant context are returned.

### Pagination

Multi-session modes (`ancestors`, `descendants`, `project`, `global`) default to 50 windows per query. If there are more, the response includes pagination info. The LLM (or you via the skill) can request the next batch:

```
/skill:duncan same question, but search the next batch (offset 50)
```

## Development

```bash
npm install
tsx tests/compaction-windows.test.mjs
```
