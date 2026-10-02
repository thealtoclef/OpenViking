import test from "node:test";
import assert from "node:assert/strict";
import { capRecallTimeout } from "../lib/recall-deadline.mjs";

test("caps a server-fuse timeout to the host deadline", () => {
  const capped = capRecallTimeout({ timeoutMs: 45000, actorPeerId: "peer-1" }, 25000);
  assert.equal(capped.timeoutMs, 25000);
});

test("keeps the actor peer the shared layer passed down", () => {
  // The regression this replaces forwarded `timeoutMs` as a bare number, which
  // dropped `actorPeerId` and made the legacy-peer retry search the wrong space.
  const capped = capRecallTimeout({ timeoutMs: 45000, actorPeerId: "legacy-peer" }, 25000);
  assert.equal(capped.actorPeerId, "legacy-peer");
});

test("never raises a timeout that is already under the cap", () => {
  assert.equal(capRecallTimeout({ timeoutMs: 1000 }, 25000).timeoutMs, 1000);
  assert.equal(capRecallTimeout({}, 25000).timeoutMs, 10000, "unset means the client default, capped");
});

test("without a cap the options are passed through untouched", () => {
  const options = { timeoutMs: 45000, actorPeerId: "peer-1" };
  assert.equal(capRecallTimeout(options, undefined), options);
  assert.equal(capRecallTimeout(undefined, undefined), undefined);
});
