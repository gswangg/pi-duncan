/**
 * Test: lineage, session discovery, and pagination helpers.
 *
 * Run: tsx tests/lineage.test.mjs
 */

import {
  getAncestorChain,
  getDescendantChain,
  getProjectSessions,
  getGlobalSessions,
  getSessionPreview,
  getDuncanTargets,
  readSessionHeader,
  buildSessionTree,
  resolveGeneration,
} from "../extensions/duncan.ts";

const { SessionManager, parseSessionEntries } = await import("@mariozechner/pi-coding-agent");

import { readFileSync, mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { join, basename, dirname } from "node:path";

// ============================================================================
// Test helpers
// ============================================================================

const TEST_ROOT = join("/tmp", "duncan-lineage-test");

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (!condition) {
    console.error(`  ✗ ${msg}`);
    failed++;
  } else {
    console.log(`  ✓ ${msg}`);
    passed++;
  }
}

function setup() {
  if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true });
  mkdirSync(TEST_ROOT, { recursive: true });
}

function teardown() {
  if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true });
}

function makeUser(t) {
  return { role: "user", content: [{ type: "text", text: t }], timestamp: Date.now() };
}

function makeAssistant(t) {
  return {
    role: "assistant", content: [{ type: "text", text: t }],
    provider: "test", model: "test-model", stopReason: "endTurn",
    usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150 },
    timestamp: Date.now(),
  };
}

/**
 * Create a session with messages, optionally as a child of another session file.
 * Returns the session file path.
 */
function createSession(sessionDir, messages, parentSessionFile) {
  mkdirSync(sessionDir, { recursive: true });
  const sm = new SessionManager("/workspace", sessionDir, undefined, true);
  // If parentSessionFile specified, we need to manually write the header with parentSession
  // since SessionManager doesn't expose this in constructor.
  if (parentSessionFile) {
    // Write messages first to get the file created
    for (const msg of messages) sm.appendMessage(msg);
    const file = sm.getSessionFile();
    // Rewrite the header line to include parentSession
    const content = readFileSync(file, "utf-8");
    const lines = content.split("\n");
    const header = JSON.parse(lines[0]);
    header.parentSession = parentSessionFile;
    lines[0] = JSON.stringify(header);
    writeFileSync(file, lines.join("\n"));
    return file;
  }
  for (const msg of messages) sm.appendMessage(msg);
  return sm.getSessionFile();
}

// ============================================================================
// Tests
// ============================================================================

function testReadSessionHeader() {
  console.log("\n--- readSessionHeader ---");
  const dir = join(TEST_ROOT, "header-test");
  const file = createSession(dir, [makeUser("hello"), makeAssistant("world")]);

  const header = readSessionHeader(file);
  assert(header !== null, "header is not null");
  assert(typeof header.id === "string" && header.id.length > 0, `has id: ${header.id.slice(0, 8)}`);
  assert(typeof header.timestamp === "string", `has timestamp`);
  assert(header.parentSession === undefined, "no parentSession on root session");
}

function testReadSessionHeaderWithParent() {
  console.log("\n--- readSessionHeader with parentSession ---");
  const dir = join(TEST_ROOT, "parent-header-test");
  const parent = createSession(dir, [makeUser("parent msg"), makeAssistant("parent resp")]);
  const child = createSession(dir, [makeUser("child msg"), makeAssistant("child resp")], parent);

  const header = readSessionHeader(child);
  assert(header !== null, "header is not null");
  assert(header.parentSession === parent, `parentSession points to parent file`);
}

function testBuildSessionTree() {
  console.log("\n--- buildSessionTree ---");
  const dir = join(TEST_ROOT, "tree-test");

  const root = createSession(dir, [makeUser("root"), makeAssistant("root-r")]);
  const child1 = createSession(dir, [makeUser("child1"), makeAssistant("child1-r")], root);
  const child2 = createSession(dir, [makeUser("child2"), makeAssistant("child2-r")], root);
  const grandchild = createSession(dir, [makeUser("grandchild"), makeAssistant("grandchild-r")], child1);

  const nodes = buildSessionTree(dir);
  assert(nodes.size === 4, `4 nodes (got ${nodes.size})`);

  const rootNode = nodes.get(root);
  assert(rootNode.children.length === 2, `root has 2 children`);
  assert(rootNode.generation === 0, `root is gen 0`);

  const child1Node = nodes.get(child1);
  assert(child1Node.generation === 1, `child1 is gen 1`);
  assert(child1Node.children.length === 1, `child1 has 1 child`);

  const grandchildNode = nodes.get(grandchild);
  assert(grandchildNode.generation === 2, `grandchild is gen 2`);
  assert(grandchildNode.children.length === 0, `grandchild has 0 children`);
}

function testAncestorChain() {
  console.log("\n--- getAncestorChain ---");
  const dir = join(TEST_ROOT, "ancestor-test");

  const gen0 = createSession(dir, [makeUser("gen0"), makeAssistant("gen0-r")]);
  const gen1 = createSession(dir, [makeUser("gen1"), makeAssistant("gen1-r")], gen0);
  const gen2 = createSession(dir, [makeUser("gen2"), makeAssistant("gen2-r")], gen1);

  const chain = getAncestorChain(gen2, dir);
  assert(chain.length === 3, `3 ancestors (got ${chain.length})`);
  assert(chain[0] === gen2, `chain[0] is self`);
  assert(chain[1] === gen1, `chain[1] is parent`);
  assert(chain[2] === gen0, `chain[2] is grandparent`);

  // Root has only itself
  const rootChain = getAncestorChain(gen0, dir);
  assert(rootChain.length === 1, `root chain is 1 (self)`);
}

function testDescendantChain() {
  console.log("\n--- getDescendantChain ---");
  const dir = join(TEST_ROOT, "descendant-test");

  const root = createSession(dir, [makeUser("root"), makeAssistant("root-r")]);
  const child1 = createSession(dir, [makeUser("child1"), makeAssistant("child1-r")], root);
  const child2 = createSession(dir, [makeUser("child2"), makeAssistant("child2-r")], root);
  const grandchild = createSession(dir, [makeUser("gc"), makeAssistant("gc-r")], child1);

  const chain = getDescendantChain(root, dir);
  assert(chain.length === 3, `3 descendants (got ${chain.length})`);
  assert(!chain.includes(root), `excludes self`);
  assert(chain.includes(child1), `includes child1`);
  assert(chain.includes(child2), `includes child2`);
  assert(chain.includes(grandchild), `includes grandchild`);

  // BFS order: children before grandchildren
  const child1Idx = chain.indexOf(child1);
  const gcIdx = chain.indexOf(grandchild);
  assert(child1Idx < gcIdx, `child1 before grandchild (BFS)`);

  // Leaf has no descendants
  const leafChain = getDescendantChain(grandchild, dir);
  assert(leafChain.length === 0, `leaf has 0 descendants`);
}

function testGetProjectSessions() {
  console.log("\n--- getProjectSessions ---");
  const dir = join(TEST_ROOT, "project-test");

  const s1 = createSession(dir, [makeUser("first"), makeAssistant("first-r")]);
  const s2 = createSession(dir, [makeUser("second"), makeAssistant("second-r")]);
  const s3 = createSession(dir, [makeUser("third"), makeAssistant("third-r")]);

  const sessions = getProjectSessions(dir);
  assert(sessions.length === 3, `3 sessions (got ${sessions.length})`);

  // All files present
  const basenames = new Set(sessions.map(f => basename(f)));
  assert(basenames.has(basename(s1)) && basenames.has(basename(s2)) && basenames.has(basename(s3)), `all sessions present`);

  // Sorted by filename descending (newest first)
  const sorted = [...sessions].sort((a, b) => basename(b).localeCompare(basename(a)));
  assert(sessions.every((f, i) => f === sorted[i]), `sorted newest first`);
}

function testGetGlobalSessions() {
  console.log("\n--- getGlobalSessions ---");
  // Global scans sibling directories under the parent of sessionDir
  const sessionsRoot = join(TEST_ROOT, "sessions");
  const projA = join(sessionsRoot, "--project-a--");
  const projB = join(sessionsRoot, "--project-b--");

  const a1 = createSession(projA, [makeUser("a1"), makeAssistant("a1-r")]);
  const a2 = createSession(projA, [makeUser("a2"), makeAssistant("a2-r")]);
  const b1 = createSession(projB, [makeUser("b1"), makeAssistant("b1-r")]);

  // getGlobalSessions takes a sessionDir (one project) and scans its parent
  const global = getGlobalSessions(projA);
  assert(global.length === 3, `3 global sessions (got ${global.length})`);

  // Should include sessions from both projects
  const basenames = new Set(global.map(f => basename(f)));
  assert(basenames.has(basename(a1)), `includes a1 from project A`);
  assert(basenames.has(basename(b1)), `includes b1 from project B`);

  // All sorted by filename descending (newest first)
  const sorted = [...global].sort((a, b) => basename(b).localeCompare(basename(a)));
  assert(global.every((f, i) => f === sorted[i]), `sorted newest first`);
}

function testGetSessionPreview() {
  console.log("\n--- getSessionPreview ---");
  const dir = join(TEST_ROOT, "preview-test");

  const file = createSession(dir, [
    makeUser("What is the airspeed velocity of an unladen swallow?"),
    makeAssistant("African or European?"),
  ]);

  const preview = getSessionPreview(file);
  assert(preview.includes("airspeed velocity"), `preview has first user message: "${preview}"`);

  // Long messages get truncated
  const longFile = createSession(dir, [
    makeUser("A".repeat(200)),
    makeAssistant("ok"),
  ]);
  const longPreview = getSessionPreview(longFile);
  assert(longPreview.length <= 80, `long preview truncated (${longPreview.length} chars)`);
  assert(longPreview.endsWith("..."), `truncated preview ends with ...`);
}

function testResolveGeneration() {
  console.log("\n--- resolveGeneration ---");
  const dir = join(TEST_ROOT, "gen-test");

  const gen0 = createSession(dir, [makeUser("gen0"), makeAssistant("gen0-r")]);
  const gen1 = createSession(dir, [makeUser("gen1"), makeAssistant("gen1-r")], gen0);
  const gen2 = createSession(dir, [makeUser("gen2"), makeAssistant("gen2-r")], gen1);

  assert(resolveGeneration(gen0, dir) === 0, `gen0 = 0`);
  assert(resolveGeneration(gen1, dir) === 1, `gen1 = 1`);
  assert(resolveGeneration(gen2, dir) === 2, `gen2 = 2`);
}

function testGetDuncanTargetsWithParent() {
  console.log("\n--- getDuncanTargets across lineage ---");
  const dir = join(TEST_ROOT, "targets-lineage");

  const parent = createSession(dir, [
    makeUser("parent-work"), makeAssistant("parent-done"),
  ]);
  const child = createSession(dir, [
    makeUser("child-work"), makeAssistant("child-done"),
  ], parent);

  const parentTargets = getDuncanTargets(parent);
  assert(parentTargets.length === 1, `parent: 1 window`);
  assert(parentTargets[0].messages.length === 2, `parent window has 2 messages`);

  const childTargets = getDuncanTargets(child);
  assert(childTargets.length === 1, `child: 1 window`);

  // Ancestor chain from child includes both
  const chain = getAncestorChain(child, dir);
  assert(chain.length === 2, `chain has 2 sessions`);
  let totalWindows = 0;
  for (const file of chain) totalWindows += getDuncanTargets(file).length;
  assert(totalWindows === 2, `2 total windows across lineage`);
}

// ============================================================================
// Run
// ============================================================================

setup();
try {
  testReadSessionHeader();
  testReadSessionHeaderWithParent();
  testBuildSessionTree();
  testAncestorChain();
  testDescendantChain();
  testGetProjectSessions();
  testGetGlobalSessions();
  testGetSessionPreview();
  testResolveGeneration();
  testGetDuncanTargetsWithParent();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  console.log("✅ All tests passed\n");
} finally {
  teardown();
}
