/** Exercise the extension lifecycle with REST available and MCP refused. */

import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { EXTENSION_DIR, fakeCtx, fakePi, withExtension } from "./support/pi-harness.mjs";

test("the first turn attempts the handshake once, and the retry waits for the next one", async (t) => {
  await withExtension(t, async ({ server, turn, shutdown, notified }) => {
    await turn("hello");
    assert.equal(
      server.initializes.length,
      1,
      "turn one must not re-attempt the handshake start() already joined",
    );

    await turn("again");
    assert.equal(
      server.initializes.length,
      2,
      "turn two is the retry branch doing its job on a toolless session",
    );

    await turn("and again");
    assert.equal(server.initializes.length, 3, "and it keeps retrying while there are no tools");

    // The failure is announced once, not once per attempt.
    const warnings = notified.filter(([message]) => /no tools this session/.test(message));
    assert.equal(warnings.length, 1, JSON.stringify(notified));
    assert.match(warnings[0][0], /403/);

    await shutdown();
  });
});

test("a refused handshake still leaves the session working", async (t) => {
  await withExtension(t, async ({ turn, tools, statuses, shutdown }) => {
    const result = await turn("hello");
    // No tools registered, but the session is live: the system prompt still
    // comes back (or at worst undefined), and the status line flags the gap.
    assert.deepEqual(tools, []);
    if (result) assert.ok(!/OpenViking tools/.test(result.systemPrompt));
    assert.ok(
      statuses.some(([, status]) => /OV ✓/.test(status) && /tools ✗/.test(status)),
      JSON.stringify(statuses),
    );
    await shutdown();
  });
});

test("reload clears only the owning extension's coexistence marker", async (t) => {
  await withExtension(t, async ({ turn, shutdown }) => {
    await turn("hello");
    assert.ok(globalThis.__OPENVIKING_PI_EXTENSION__);
    await shutdown();
    assert.equal(globalThis.__OPENVIKING_PI_EXTENSION__, undefined);
  });
  await withExtension(t, async ({ turn, shutdown }) => {
    await turn("hello");
    const replacement = { dir: "another-instance" };
    globalThis.__OPENVIKING_PI_EXTENSION__ = replacement;
    await shutdown();
    assert.equal(globalThis.__OPENVIKING_PI_EXTENSION__, replacement);
    delete globalThis.__OPENVIKING_PI_EXTENSION__;
  });
});

test("shutdown during health check cannot restore the marker or register tools", async (t) => {
  await withExtension(t, async ({ server, turn, shutdown, tools }) => {
    let release;
    server.gate.health = new Promise((resolve) => { release = resolve; });
    const starting = turn("hello");
    await shutdown();
    release();
    await starting;
    assert.equal(globalThis.__OPENVIKING_PI_EXTENSION__, undefined);
    assert.deepEqual(tools, []);
    assert.equal(server.initializes.length, 0);
  });
});

for (const plugin of [{ mcpEnabled: false }, { bypassSession: true }]) {
  test("MCP stays off for " + JSON.stringify(plugin), async (t) => {
    await withExtension(t, async ({ server, turn, shutdown, configPath }) => {
      // The instance loads configuration at construction, so reload it first.
      await shutdown();
      await writeFile(configPath, JSON.stringify({ plugin: { pi: plugin } }));
      const { default: extension } = await import(join(EXTENSION_DIR, "index.ts"));
      const { pi, handlers } = fakePi();
      await extension(pi);
      await handlers.get("before_agent_start")({ prompt: "hello", systemPrompt: "BASE" }, fakeCtx());
      assert.equal(server.initializes.length, 0);
      await handlers.get("session_shutdown")({}, fakeCtx());
    });
  });
}

test("/viking starts the session when session_start was never delivered", async (t) => {
  await withExtension(t, async ({ server, commands, notified }) => {
    // A host can install the extension into a session that is already running
    // (omp's `plugin install`), where session_start fired before this extension
    // existed and never fires again. No turn and no session_start here: the
    // command itself is the only chance to start.
    assert.equal(server.initializes.length, 0);

    await commands.get("viking").handler("", fakeCtx(notified));

    assert.ok(
      server.initializes.length > 0,
      "the status command must run the startup chain itself, not report 'not connected'",
    );
    assert.ok(
      notified.some(([message]) => /OpenViking: connected/.test(message)),
      JSON.stringify(notified),
    );
    await commands.get("viking").handler("", fakeCtx(notified));
    assert.equal(server.initializes.length, 1, "start() is memoized; a second status call adds nothing");
  });
});

test("oversized tool results are projected in the context hook", async (t) => {
  await withExtension(t, async ({ handlers, turn, ctx, shutdown }) => {
    await turn("hello");
    assert.ok(handlers.get("context"), "the context hook is registered");

    // ~100k tokens of bash output, against a cap of 5% of the 262144-token
    // window reported by the fake ctx (clamped to the 8192..50000 band).
    const huge = "x".repeat(400000);
    const messages = [
      { role: "user", content: "run it", timestamp: 1 },
      { role: "toolResult", toolCallId: "call-1", toolName: "bash", content: [{ type: "text", text: huge }], timestamp: 2 },
    ];
    const result = await handlers.get("context")({ type: "context", messages }, ctx);
    const out = result?.messages ?? messages;
    const text = out[1].content[0].text;

    assert.ok(text.length < huge.length, "the oversized result was projected");
    assert.match(text, /\[tool result projected: kept \d+ of ~\d+ tokens\]/);
    assert.equal(out.length, 2);
    await shutdown();
  });
});

test("shutdown commits the conversation, even under takeover", async (t) => {
  await withExtension(t, async ({ server, session, handlers, ctx, turn, shutdown }) => {
    // A real turn leaves messages on the branch, which is what makes there be
    // something to archive.
    session.branch = [
      { id: "m1", type: "message", message: { role: "user", content: "hello", timestamp: 1 } },
      { id: "m2", type: "message", message: { role: "assistant", content: "hi", timestamp: 2 } },
    ];
    await turn("hello");
    // turn_end is what syncs the branch; before_agent_start only queues recall.
    await handlers.get("turn_end")({ type: "turn_end" }, ctx());
    await shutdown();
    // Nothing else runs after a quit, so a tail left uncommitted is only ever
    // archived if the user happens to resume that exact session. Takeover used
    // to skip this commit entirely, which is how a real session ended with
    // commit_count 0 and 592 pending tokens.
    assert.ok(
      server.requests.some((request) => /\/commit$/.test(request)),
      JSON.stringify(server.requests),
    );
  });
});

test("a session the server never created is not committed or retried", async (t) => {
  await withExtension(t, async ({ server, turn, shutdown }) => {
    // Startup binds the OpenViking session, but the empty branch syncs nothing,
    // so the server has no such session yet. Committing here can only 404, and
    // enqueueing that retry left an entry failing again on every later replay.
    await turn("hello");
    await shutdown();
    assert.deepEqual(
      server.requests.filter((request) => /\/commit$/.test(request)),
      [],
      JSON.stringify(server.requests),
    );
  });
});

test("a 404 commit is reported but never queued for retry", async (t) => {
  await withExtension(t, async ({ server, session, handlers, ctx, turn, shutdown, pendingDir }) => {
    session.branch = [
      { id: "m1", type: "message", message: { role: "user", content: "hello", timestamp: 1 } },
      { id: "m2", type: "message", message: { role: "assistant", content: "hi", timestamp: 2 } },
    ];
    await turn("hello");
    await handlers.get("turn_end")({ type: "turn_end" }, ctx());
    server.gate.commitStatus = 404;
    await shutdown();

    assert.ok(server.requests.some((request) => /\/commit$/.test(request)), "the commit was attempted");
    // The durable path must not swallow a request that can only fail again.
    // The queue directory is created on first write, so its absence is the
    // strongest form of "nothing was queued".
    const { existsSync, readdirSync } = await import("node:fs");
    assert.deepEqual(existsSync(pendingDir) ? readdirSync(pendingDir) : [], [], "no unretryable commit enters the queue");
  });
});
