import test from "node:test";
import assert from "node:assert/strict";
import { resolveContextMessageIds } from "../lib/context-message-ids.mjs";

const user = (content, timestamp) => ({ role: "user", content, timestamp });

test("pi's buildContextEntries projection maps the nth user message to the nth user entry", () => {
  const ids = new WeakMap();
  const messages = [
    user("hi", 1),
    { role: "assistant", content: "hello" },
    user("again", 2),
  ];
  const resolved = resolveContextMessageIds(messages, {
    buildContextEntries: () => [
      { id: "u1", type: "message", message: user("hi", 1) },
      { id: "a1", type: "message", message: { role: "assistant", content: "hello" } },
      { id: "u2", type: "message", message: user("again", 2) },
    ],
  });
  assert.equal(resolved.get(messages[0]), "u1");
  assert.equal(resolved.get(messages[2]), "u2");
  assert.equal(resolved.has(messages[1]), false, "assistant messages get no id");
});

test("omp's getBranch() fallback recovers ids by content, not position", () => {
  const messages = [
    user("first", 10),
    user("second", 20),
  ];
  // The branch carries an entry the context projection dropped (a tail the
  // boundary excluded), so index alignment would be wrong here; content
  // matching finds the right ids anyway.
  const resolved = resolveContextMessageIds(messages, {
    getBranch: () => [
      { id: "u-other", type: "message", message: user("not in context", 5) },
      { id: "u1", type: "message", message: user("first", 10) },
      { id: "u2", type: "message", message: user("second", 20) },
      { id: "custom", type: "custom_message", message: user("second", 20) },
    ],
  });
  assert.equal(resolved.get(messages[0]), "u1");
  assert.equal(resolved.get(messages[1]), "u2");
});

test("duplicate user text with distinct timestamps keeps its own id", () => {
  const messages = [user("same", 1), user("same", 2)];
  const resolved = resolveContextMessageIds(messages, {
    getBranch: () => [
      { id: "a", type: "message", message: user("same", 1) },
      { id: "b", type: "message", message: user("same", 2) },
    ],
  });
  assert.equal(resolved.get(messages[0]), "a");
  assert.equal(resolved.get(messages[1]), "b");
});

test("no session manager support yields no ids instead of throwing", () => {
  const messages = [user("hi", 1)];
  assert.equal(resolveContextMessageIds(messages, undefined).has(messages[0]), false);
  assert.equal(resolveContextMessageIds(messages, {}).has(messages[0]), false);
});
