/**
 * Boot the extension against a throwaway config and a fake OpenViking server.
 *
 * Shared by the lifecycle suites. The host session is a mutable object rather
 * than a captured string, because that is how the real hosts behave: omp's
 * SessionManager is mutated in place on a session switch, so a handler reading
 * `getSessionId()` after the switch sees the new id on the same object.
 */
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
/** tests/support/ -> the extension directory. */
export const EXTENSION_DIR = dirname(dirname(TEST_DIR));
const EXTENSION_URL = pathToFileURL(EXTENSION_DIR + "/").href;

// Only the extension's own relative `.js` specifiers are touched, and only
// after the real resolution has already failed, so nothing else in the process
// can change meaning because this file ran.
registerHooks({
  resolve(specifier, context, nextResolve) {
    const inExtension = typeof context?.parentURL === "string"
      && context.parentURL.startsWith(EXTENSION_URL);
    if (!inExtension || !specifier.startsWith(".") || !specifier.endsWith(".js")) {
      return nextResolve(specifier, context);
    }
    try {
      return nextResolve(specifier, context);
    } catch {
      return nextResolve(specifier.slice(0, -3) + ".ts", context);
    }
  },
});

const MANAGED_ENV = [
  "OPENVIKING_CREDENTIAL_SOURCE",
  "OPENVIKING_CLI_CONFIG_FILE",
  "OPENVIKING_CONFIG_FILE",
  "OPENVIKING_URL",
  "OPENVIKING_BASE_URL",
  "OPENVIKING_MCP_URL",
  "OPENVIKING_API_KEY",
  "OPENVIKING_BEARER_TOKEN",
  "OPENVIKING_ACCOUNT",
  "OPENVIKING_USER",
  "OPENVIKING_AUTH_MODE",
  "OPENVIKING_PEER_ID",
  "OPENVIKING_DEBUG",
  "OPENVIKING_DEBUG_LOG",
  "OV_DEBUG_LOG",
  "OPENVIKING_PENDING_DIR",
];

async function startServer() {
  const initializes = [];
  const gate = { health: null };
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", async () => {
      const path = (req.url || "").split("?")[0];
      if (path === "/mcp") {
        let method = null;
        try {
          method = JSON.parse(Buffer.concat(chunks).toString("utf8"))?.method ?? null;
        } catch {
          // A malformed body is still a post worth ignoring, not a crash.
        }
        if (method === "initialize") initializes.push(Date.now());
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ detail: "root key cannot reach /mcp" }));
        return;
      }
      if (path === "/health") await gate.health;
      // Everything the REST half touches during startup: /health, the profile
      // fetch, recall. An empty result keeps each of them a no-op.
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", result: {} }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    initializes,
    gate,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** The slice of pi's API `index.ts` reaches for. */
export function fakePi() {
  const handlers = new Map();
  const tools = [];
  const commands = new Map();
  return {
    pi: {
      on(event, handler) { handlers.set(event, handler); },
      registerTool(tool) { tools.push(tool?.name); },
      registerCommand(name, command) { commands.set(name, command); },
      appendEntry() {},
      getAllTools() { return []; },
      sendMessage() {},
    },
    handlers,
    tools,
    commands,
  };
}

/**
 * A host context over a mutable session.
 *
 * `session.id` and `session.branch` are read live on every call, so a test can
 * change them and have the next handler invocation see the change without
 * swapping the context object — exactly what omp does on a session switch.
 */
export function fakeCtx(notified = [], statuses = [], session = { id: "host-A", branch: [] }) {
  return {
    sessionManager: {
      getSessionId: () => session.id,
      getBranch: () => session.branch,
      getLeafId: () => "entry-1",
    },
    ui: {
      notify: (...args) => notified.push(args),
      setStatus: (...args) => statuses.push(args),
    },
    getContextUsage: () => ({ tokens: 0, contextWindow: 262144, percent: 0 }),
  };
}

/** Boot one extension instance against a throwaway config and a fake server. */
export async function withExtension(t, fn) {
  const server = await startServer();
  const dir = await mkdtemp(join(tmpdir(), "ov-pi-handshake-"));
  const saved = Object.fromEntries(MANAGED_ENV.map((name) => [name, process.env[name]]));
  for (const name of MANAGED_ENV) delete process.env[name];
  process.env.OPENVIKING_CREDENTIAL_SOURCE = "env";
  process.env.OPENVIKING_URL = server.url;
  process.env.OPENVIKING_API_KEY = "pi-handshake-key";
  process.env.OPENVIKING_CLI_CONFIG_FILE = join(dir, "ovcli.conf");
  process.env.OPENVIKING_CONFIG_FILE = join(dir, "ov.conf");
  process.env.OPENVIKING_PENDING_DIR = join(dir, "pending");
  await writeFile(join(dir, "ovcli.conf"), JSON.stringify({ plugin: { pi: {} } }), "utf8");

  t.after(async () => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });

  // Dynamic, so the resolve hook above is already installed. The module is
  // evaluated once per process; each call to its default export builds a fresh
  // extension instance with its own bridge and its own session state.
  const mod = await import(join(EXTENSION_DIR, "index.ts"));
  assert.equal(typeof mod.default, "function");

  const { pi, handlers, tools, commands } = fakePi();
  await mod.default(pi);
  const notified = [];
  const statuses = [];
  const session = { id: "host-A", branch: [] };
  const ctx = () => fakeCtx(notified, statuses, session);
  return fn({
    server,
    handlers,
    tools,
    commands,
    notified,
    statuses,
    session,
    ctx,
    configPath: join(dir, "ovcli.conf"),
    turn: (prompt, systemPrompt = "BASE") => handlers.get("before_agent_start")(
      { type: "before_agent_start", prompt, systemPrompt },
      ctx(),
    ),
    shutdown: () => handlers.get("session_shutdown")(
      { type: "session_shutdown", reason: "reload" },
      ctx(),
    ),
  });
}

/**
 * The OpenViking session id the status line last reported.
 *
 * The line is `OV ✓ · ↩3 · ctx … · <id>`; the id is the last ` · ` segment, or
 * `none` when the session never bound.
 */
export function lastSessionId(statuses) {
  const line = statuses.at(-1)?.[1] ?? "";
  const segment = (line.split(" · ").at(-1) ?? "").trim();
  return segment === "none" ? "" : segment;
}
