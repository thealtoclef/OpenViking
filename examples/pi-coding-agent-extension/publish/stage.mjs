#!/usr/bin/env node
/**
 * Publish staging for `@thealtoclef/pi-openviking`.
 *
 * The extension directory is an upstream example, not an npm package: its
 * `package.json` is `private` and versioned with the server, and its `shared/`
 * runtime is generated. Publishing therefore happens from a staged copy whose
 * manifest is an overlay, so upstream's file never has to carry release-only
 * fields and a rebase cannot conflict on them.
 *
 * The overlay is not cosmetic. A manifest without `dependencies` leaves the
 * host's `bun install` with nothing to fetch, and `lib/mcp-bridge.mjs` fails to
 * import at load time — the extension then registers no tools at all. A
 * manifest without `skills` publishes without the SKILL.md files that teach
 * those tools. Both were the earlier fork's overlay bugs.
 *
 * Usage:
 *   node publish/stage.mjs --version 2026.10.1 [--out dist]
 */
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const PUBLISH_DIR = dirname(fileURLToPath(import.meta.url));
export const EXTENSION_DIR = dirname(PUBLISH_DIR);
export const REPO_ROOT = resolve(EXTENSION_DIR, "..", "..");

/** Copied into the staging tree for validation, kept out of the tarball by `files`. */
export const STAGING_ONLY_ENTRIES = ["node_modules", "package-lock.json", "publish", "dist"];

export function isPublishableVersion(value) {
  return /^\d{4}\.\d{1,2}\.\d+$/.test(String(value || ""));
}

/**
 * The manifest that ships: the template with a resolved version.
 *
 * Pure, so the release gate can assert its shape without writing anything.
 */
export function buildPublishManifest(template, version) {
  if (!isPublishableVersion(version)) {
    throw new Error(`version must be CalVer YYYY.M.N, got ${JSON.stringify(version)}`);
  }
  return { ...template, version };
}

/** Field-by-field checks the published package must satisfy to be usable. */
export function assertPublishableManifest(manifest) {
  const fail = (message) => {
    throw new Error(`publish manifest is unusable: ${message}`);
  };
  if (!manifest.name || manifest.private !== false) fail("name must be set and private must be false");
  if (!manifest.dependencies?.["@modelcontextprotocol/client"]) {
    fail("dependencies must carry @modelcontextprotocol/client or the host installs nothing to import");
  }
  for (const entry of ["index.ts", "lib", "shared", "skills"]) {
    if (!manifest.files?.includes(entry)) fail(`files must include ${entry}`);
  }
  for (const host of ["omp", "pi"]) {
    if (manifest[host]?.extensions?.[0] !== "index.ts") fail(`${host}.extensions must point at index.ts`);
  }
  return manifest;
}

async function stage({ version, outDir }) {
  const template = JSON.parse(await readFile(join(PUBLISH_DIR, "package.template.json"), "utf8"));
  const manifest = assertPublishableManifest(buildPublishManifest(template, version));

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const staged = join(outDir, "pi-openviking");
  await cp(EXTENSION_DIR, staged, {
    recursive: true,
    filter: (source) => {
      const name = relative(EXTENSION_DIR, source);
      return name === "" || !STAGING_ONLY_ENTRIES.includes(name.split("/")[0]);
    },
  });
  await writeFile(join(staged, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return { staged, manifest };
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed in ${cwd}`);
}

async function main() {
  const args = process.argv.slice(2);
  const versionIndex = args.indexOf("--version");
  const version = versionIndex >= 0 ? args[versionIndex + 1] : "";
  const outIndex = args.indexOf("--out");
  const outDir = resolve(REPO_ROOT, outIndex >= 0 ? args[outIndex + 1] : "dist/pi-openviking-stage");

  if (!isPublishableVersion(version)) {
    console.error("usage: node publish/stage.mjs --version YYYY.M.N [--out DIR]");
    process.exit(2);
  }

  // The publishable tree must contain the generated shared runtime, and the
  // tests import it, so generate before anything else.
  run("node", [join(REPO_ROOT, "examples", "memory-plugin-shared", "sync.mjs")], REPO_ROOT);

  // Tests run against the source tree: the staged copy deliberately omits
  // node_modules, and the suite imports `@modelcontextprotocol/client`. What
  // ships is then validated by `npm pack --dry-run` below, which prints the
  // exact file list the tarball would carry.
  const tests = (await readdir(join(EXTENSION_DIR, "tests")))
    .filter((name) => name.endsWith(".test.mjs"))
    .map((name) => join(EXTENSION_DIR, "tests", name));
  run("node", ["--test", ...tests], EXTENSION_DIR);

  const { staged, manifest } = await stage({ version, outDir });
  console.log(`staged ${manifest.name}@${manifest.version} -> ${staged}`);

  run("npm", ["pack", "--dry-run"], staged);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
