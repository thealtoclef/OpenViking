import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CONTEXT_WINDOW,
  TOOL_ADMISSION_MARKER_PREFIX,
  admitContextToolResults,
  admitToolResultWithinBudget,
  estimateTokens,
  resolveContextWindow,
  resolveToolResultAdmissionCapTokens,
} from "../lib/tool-admission.mjs";

const WINDOW = 200000;

function toolResult(content, toolName = "bash") {
  return { role: "toolResult", toolCallId: "call-1", toolName, content, isError: false, timestamp: 0 };
}

function textPart(text) {
  return { type: "text", text };
}

/** Text long enough to exceed the cap for the given window. */
function oversized(window = WINDOW) {
  const capTokens = resolveToolResultAdmissionCapTokens(window);
  return "x".repeat(capTokens * 8);
}

test("cap scales with the window and clamps at both ends", () => {
  // 5% of 200k = 10000, inside the floor/ceiling band.
  assert.equal(resolveToolResultAdmissionCapTokens(200000), 10000);
  // 5% of 64k = 3200, below the 8192 floor.
  assert.equal(resolveToolResultAdmissionCapTokens(64000), 8192);
  // 5% of 2M = 100000, above the 50000 ceiling.
  assert.equal(resolveToolResultAdmissionCapTokens(2000000), 50000);
  // A non-numeric window falls back rather than producing NaN.
  assert.equal(
    resolveToolResultAdmissionCapTokens(undefined),
    resolveToolResultAdmissionCapTokens(DEFAULT_CONTEXT_WINDOW),
  );
});

test("cap honours configured knobs", () => {
  assert.equal(
    resolveToolResultAdmissionCapTokens(200000, { capFraction: 0.01, minTokens: 1000, maxTokens: 50000 }),
    2000,
  );
  assert.equal(
    resolveToolResultAdmissionCapTokens(200000, { capFraction: 0.5, minTokens: 1000, maxTokens: 4000 }),
    4000,
  );
});

test("under-budget text passes through unprojected", () => {
  const result = admitToolResultWithinBudget("hello world", 1000);
  assert.equal(result.projected, false);
  assert.equal(result.text, "hello world");
});

test("over-budget text is projected within the budget", () => {
  const budget = 500;
  const result = admitToolResultWithinBudget("y".repeat(40000), budget);
  assert.equal(result.projected, true);
  assert.ok(result.text.includes(TOOL_ADMISSION_MARKER_PREFIX));
  assert.ok(estimateTokens(result.text) <= budget);
});

test("projection keeps the head and the tail", () => {
  const text = `HEAD_MARKER${"m".repeat(40000)}TAIL_MARKER`;
  const result = admitToolResultWithinBudget(text, 500);
  assert.ok(result.text.startsWith("HEAD_MARKER"));
  assert.ok(result.text.endsWith("TAIL_MARKER"));
});

test("a zero budget empties the result rather than overflowing", () => {
  const result = admitToolResultWithinBudget("z".repeat(1000), 0);
  assert.deepEqual(result, { text: "", projected: true });
});

test("re-admitting an already projected result is idempotent", () => {
  const once = admitToolResultWithinBudget(oversized(), 500);
  const twice = admitToolResultWithinBudget(once.text, 500);
  assert.equal(twice.projected, false);
  assert.equal(twice.text, once.text);
});

test("non-toolResult messages keep object identity", () => {
  const user = { role: "user", content: "hi", timestamp: 0 };
  const assistant = { role: "assistant", content: "yo", timestamp: 0 };
  const messages = [user, assistant, toolResult([textPart(oversized())])];
  const out = admitContextToolResults(messages, WINDOW);
  assert.equal(out[0], user);
  assert.equal(out[1], assistant);
  assert.notEqual(out[2], messages[2]);
});

test("an under-cap list is returned unchanged by identity", () => {
  const messages = [{ role: "user", content: "hi", timestamp: 0 }, toolResult([textPart("small output")])];
  assert.equal(admitContextToolResults(messages, WINDOW), messages);
});

test("disabling admission is a no-op", () => {
  const messages = [toolResult([textPart(oversized())])];
  assert.equal(admitContextToolResults(messages, WINDOW, { enabled: false }), messages);
});

test("string content is normalized to a text part when projected", () => {
  const [message] = admitContextToolResults([toolResult(oversized())], WINDOW);
  assert.ok(Array.isArray(message.content));
  assert.equal(message.content[0].type, "text");
  assert.ok(message.content[0].text.includes(TOOL_ADMISSION_MARKER_PREFIX));
});

test("image parts survive projection untouched", () => {
  const image = { type: "image", data: "base64", mimeType: "image/png" };
  const [message] = admitContextToolResults([toolResult([textPart(oversized()), image])], WINDOW);
  assert.equal(message.content[1], image);
  assert.ok(message.content[0].text.includes(TOOL_ADMISSION_MARKER_PREFIX));
});

test("multi-part text is admitted within the shared cap", () => {
  const capTokens = resolveToolResultAdmissionCapTokens(WINDOW);
  const parts = [textPart(oversized()), textPart(oversized()), textPart("small tail")];
  const [message] = admitContextToolResults([toolResult(parts)], WINDOW);
  const total = message.content.reduce(
    (sum, part) => sum + (part.type === "text" ? estimateTokens(part.text) : 0),
    0,
  );
  assert.ok(total <= capTokens);
  // The small part fits under the cap and is preserved verbatim.
  assert.equal(message.content[2], parts[2]);
});

test("the tool result metadata is preserved", () => {
  const [message] = admitContextToolResults([toolResult([textPart(oversized())], "read")], WINDOW);
  assert.equal(message.role, "toolResult");
  assert.equal(message.toolCallId, "call-1");
  assert.equal(message.toolName, "read");
  assert.equal(message.isError, false);
});

test("context window resolution prefers usage, then model, then the default", () => {
  assert.equal(resolveContextWindow({ getContextUsage: () => ({ contextWindow: 128000 }) }), 128000);
  assert.equal(resolveContextWindow({ model: { contextWindow: 64000 } }), 64000);
  assert.equal(resolveContextWindow({ getContextUsage: () => undefined }), DEFAULT_CONTEXT_WINDOW);
  assert.equal(resolveContextWindow(undefined), DEFAULT_CONTEXT_WINDOW);
});

test("non-array input is tolerated", () => {
  assert.deepEqual(admitContextToolResults(undefined, WINDOW), []);
});
