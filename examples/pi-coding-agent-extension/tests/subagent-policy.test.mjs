/**
 * Spawned-session policy.
 *
 * omp rebinds extension factories into every task/eval subagent and `/tan`
 * clone, and each rebound instance runs the whole lifecycle: its own
 * OpenViking session, profile, recall, capture and commit. Full participation
 * is the default that every harness visible to subagents uses (Claude Code
 * isolates them per session, opencode isolates per child session), so the
 * extension keeps parity unless the shared `skipSubagentSessions` knob says
 * otherwise.
 *
 * The one thing genuinely shared is the process-wide coexistence marker, which
 * is what the refcount below protects.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { lastSessionId, withExtension } from "./support/pi-harness.mjs";

const SUBAGENT = { kind: "sub", id: "0-Explore", name: "explore", depth: 1, parentId: "Main" };

test("a spawned session participates fully by default", async (t) => {
  await withExtension(t, async ({ statuses, turn, shutdown }) => {
    await turn("explore the repo");
    assert.equal(lastSessionId(statuses), "pi-host-A", "omp gives each subagent its own session id");
    assert.ok(globalThis.__OPENVIKING_PI_EXTENSION__, "and its own marker claim");
    await shutdown();
  }, { agent: SUBAGENT });
});

test("skipSubagentSessions keeps a spawned session off OpenViking entirely", async (t) => {
  await withExtension(t, async ({ statuses, turn, tools, shutdown }) => {
    await turn("explore the repo");
    assert.equal(lastSessionId(statuses), "", "no OpenViking session is bound");
    assert.deepEqual(tools, [], "and no tool surface is registered");
    assert.equal(globalThis.__OPENVIKING_PI_EXTENSION__, undefined, "nor is the probe published");
    await shutdown();
  }, { agent: SUBAGENT, env: { OPENVIKING_SKIP_SUBAGENT_SESSIONS: "true" } });
});

test("skipSubagentSessions leaves the top-level session alone", async (t) => {
  await withExtension(t, async ({ statuses, turn, shutdown }) => {
    await turn("run the tests");
    assert.equal(lastSessionId(statuses), "pi-host-A");
    await shutdown();
  }, { env: { OPENVIKING_SKIP_SUBAGENT_SESSIONS: "true" } });
});

test("a subagent finishing does not clear the parent's coexistence marker", async (t) => {
  await withExtension(t, async (parent) => {
    await parent.turn("parent work");
    assert.ok(globalThis.__OPENVIKING_PI_EXTENSION__, "the parent published the probe");

    // A second instance of the same extension directory, which is what a
    // subagent is: the module is imported once, the factory runs again. It
    // writes the same process-wide key, and its shutdown must not remove a
    // claim the parent still holds — with the probe gone, the experimental
    // context-management fork re-engages alongside OpenViking takeover.
    await withExtension(t, async (child) => {
      await child.turn("subagent work");
      await child.shutdown();
      assert.ok(globalThis.__OPENVIKING_PI_EXTENSION__, "the parent is still live");
    }, { agent: SUBAGENT });

    await parent.shutdown();
    assert.equal(globalThis.__OPENVIKING_PI_EXTENSION__, undefined, "the last instance clears it");
  });
});
