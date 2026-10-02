import test from "node:test";
import assert from "node:assert/strict";
import { hasContextProjection, isOmpHost, isSubagent } from "../lib/host-adapter.mjs";

test("pi's projected context is detected", () => {
  const pi = { sessionManager: { buildContextEntries: () => [], getBranch: () => [] } };
  assert.equal(hasContextProjection(pi.sessionManager), true);
  assert.equal(isOmpHost(pi), false);
});

test("a host without buildContextEntries is omp-shaped", () => {
  const omp = { sessionManager: { getBranch: () => [] } };
  assert.equal(hasContextProjection(omp.sessionManager), false);
  assert.equal(isOmpHost(omp), true);
});

test("a missing session manager probes as no projection rather than throwing", () => {
  assert.equal(hasContextProjection(undefined), false);
  assert.equal(isOmpHost(undefined), true);
  assert.equal(isOmpHost({}), true);
});

test("a spawned session is detected by identity kind, not depth", () => {
  assert.equal(isSubagent({ agent: { kind: "sub", depth: 0 } }), true, "/tan clones are depth 0");
  assert.equal(isSubagent({ agent: { kind: "sub", depth: 3 } }), true);
  assert.equal(isSubagent({ agent: { kind: "main", depth: 0 } }), false);
});

test("a host without agent identity is never a subagent", () => {
  // pi has no agent identity and no subagents; treating it as one would disable
  // the extension outright.
  assert.equal(isSubagent(undefined), false);
  assert.equal(isSubagent({}), false);
  assert.equal(isSubagent({ agent: {} }), false);
});
