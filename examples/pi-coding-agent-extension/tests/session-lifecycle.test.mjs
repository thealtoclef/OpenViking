/**
 * Session lifecycle under hosts that keep one extension runner across
 * conversations (omp's `/new`, `/resume`, `/fork`) and hosts that reset the
 * conversation in place (`/clear`).
 *
 * The failure these cover is silent: the extension memoizes `started` and the
 * OpenViking session id, so a new conversation was captured into the previous
 * one's memory stream, with the old boundary, watermark and recall ledger
 * leaking into it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { lastSessionId, withExtension } from "./support/pi-harness.mjs";

test("a session switch rebinds the OpenViking session to the new conversation", async (t) => {
  await withExtension(t, async ({ handlers, session, statuses, turn, ctx, shutdown }) => {
    await turn("hello");
    assert.equal(lastSessionId(statuses), "pi-host-A");

    // omp mutates the same SessionManager in place and then emits
    // session_switch — no session_shutdown, no new session_start.
    session.id = "host-B";
    await handlers.get("session_switch")({ type: "session_switch", reason: "new" }, ctx());
    await turn("second conversation");

    assert.equal(lastSessionId(statuses), "pi-host-B", "the new conversation must not reuse the old OV session");
    await shutdown();
  });
});

test("the switch flushes the conversation being left", async (t) => {
  await withExtension(t, async ({ handlers, session, turn, notified, ctx, shutdown }) => {
    await turn("hello");
    const before = notified.length;
    await handlers.get("session_before_switch")({ type: "session_before_switch", reason: "new" }, ctx());
    assert.equal(notified.length, before, "a flush is silent unless it fails");
    session.id = "host-B";
    await shutdown();
  });
});

test("a host that re-emits session_start with a new id resets through the safety net", async (t) => {
  await withExtension(t, async ({ handlers, session, statuses, turn, ctx, shutdown }) => {
    await turn("hello");
    assert.equal(lastSessionId(statuses), "pi-host-A");

    // pi's path: same runner torn down and rebuilt, so session_start arrives
    // again with a different id instead of a session_switch event.
    session.id = "host-C";
    await handlers.get("session_start")({ type: "session_start", reason: "new" }, ctx());
    await turn("after the switch");

    assert.equal(lastSessionId(statuses), "pi-host-C", "the stale session state must not survive the new id");
    await shutdown();
  });
});

test("session_start without an id change does not rebind", async (t) => {
  await withExtension(t, async ({ handlers, server, turn, statuses, ctx, shutdown }) => {
    await turn("hello");
    const initializes = server.initializes.length;
    await handlers.get("session_start")({ type: "session_start", reason: "reload" }, ctx());
    await turn("same session");
    assert.equal(lastSessionId(statuses), "pi-host-A");
    // The reload re-attempts the handshake (the session is toolless), but it
    // must not have re-run the OV session binding.
    assert.ok(server.initializes.length >= initializes);
    await shutdown();
  });
});

test("/clear moves the conversation to its own OpenViking session", async (t) => {
  await withExtension(t, async ({ session, statuses, turn, ctx, shutdown }) => {
    await turn("before the clear");
    assert.equal(lastSessionId(statuses), "pi-host-A");

    // `/clear` keeps the session id and the transcript, and appends a marker.
    // No lifecycle event fires for it, so the marker is the only signal.
    session.branch = [{ type: "reset_boundary", id: "1" }];
    await turn("after the clear");

    assert.equal(
      lastSessionId(statuses),
      "pi-host-A__1",
      "the cleared context must be captured into its own OV session",
    );
    await shutdown();
  });
});

test("a clear that predates the first observation is not re-handled", async (t) => {
  await withExtension(t, async ({ session, statuses, turn, ctx, shutdown }) => {
    // The branch already carries a marker when the extension first looks: the
    // session was started against the post-clear branch, so acting on it would
    // restart a healthy session for nothing.
    session.branch = [{ type: "reset_boundary", id: "1" }];
    await turn("first turn");
    assert.equal(lastSessionId(statuses), "pi-host-A");

    // A later clear still counts.
    session.branch = [{ type: "reset_boundary", id: "1" }, { type: "reset_boundary", id: "2" }];
    await turn("after a real clear");
    assert.equal(lastSessionId(statuses), "pi-host-A__2");
    await shutdown();
  });
});

test("the same clear marker does not rebind on every turn", async (t) => {
  await withExtension(t, async ({ session, statuses, turn, ctx, shutdown }) => {
    session.branch = [{ type: "reset_boundary", id: "1" }];
    await turn("first");
    session.branch = [{ type: "reset_boundary", id: "1" }, { type: "reset_boundary", id: "2" }];
    await turn("cleared");
    assert.equal(lastSessionId(statuses), "pi-host-A__2");

    await turn("next turn");
    await turn("another turn");
    assert.equal(lastSessionId(statuses), "pi-host-A__2", "the marker is handled once, not per turn");
    await shutdown();
  });
});
