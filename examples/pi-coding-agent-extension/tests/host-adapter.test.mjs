import test from "node:test";
import assert from "node:assert/strict";
import { hasContextProjection, isOmpHost } from "../lib/host-adapter.mjs";

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
