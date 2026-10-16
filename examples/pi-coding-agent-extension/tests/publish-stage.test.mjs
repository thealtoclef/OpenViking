import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertPublishableManifest,
  buildPublishManifest,
  isPublishableVersion,
} from "../publish/stage.mjs";

const TEMPLATE = JSON.parse(
  await readFile(join(dirname(fileURLToPath(import.meta.url)), "..", "publish", "package.template.json"), "utf8"),
);

test("release versions use calendar dates and positive same-day post counters", () => {
  for (const version of ["2026.10.2", "2026.10.2-post.1", "2026.10.2-post.12", "2024.2.29", "2026.12.31-post.1"]) {
    assert.ok(isPublishableVersion(version), version);
  }
  for (const version of [
    "1.0.0", "2026.10", "2026.0.2", "2026.13.2", "2026.10.0",
    "2026.2.29", "2026.4.31", "2026.10.32", "2026.010.2", "2026.10.02",
    "2026.10.2-post.0", "2026.10.2-post.01", "2026.10.2-post",
    "2026.10.2-post.-1", "2026.10.2-post.1.2", "2026.10.2+post.1",
  ]) {
    assert.ok(!isPublishableVersion(version), version);
    assert.throws(() => buildPublishManifest(TEMPLATE, version), /CalVer/);
  }
});

test("the overlay carries the fields a host install needs", () => {
  const manifest = assertPublishableManifest(buildPublishManifest(TEMPLATE, "2026.10.1"));
  assert.equal(manifest.name, "@thealtoclef/pi-openviking");
  assert.equal(manifest.version, "2026.10.1");
  assert.equal(manifest.private, false);
  // Dropping this is the earlier fork's bug: the host's `bun install` then has
  // nothing to fetch and lib/mcp-bridge.mjs fails to import at load time.
  assert.equal(manifest.dependencies["@modelcontextprotocol/client"], "2.0.0");
  assert.deepEqual(manifest.omp.extensions, ["index.ts"]);
  assert.deepEqual(manifest.pi.extensions, ["index.ts"]);
  for (const entry of ["index.ts", "lib", "shared", "skills", "README.md"]) {
    assert.ok(manifest.files.includes(entry), `files must include ${entry}`);
  }
  assert.ok(!manifest.files.includes("config.json"), "config.json was removed upstream");
  assert.ok(!manifest.files.includes("tests"), "tests validate the artifact, they do not ship in it");
});

test("an unusable manifest is rejected rather than published", () => {
  const manifest = buildPublishManifest(TEMPLATE, "2026.10.1");
  assert.throws(() => assertPublishableManifest({ ...manifest, dependencies: {} }), /dependencies/);
  assert.throws(() => assertPublishableManifest({ ...manifest, files: ["index.ts"] }), /files/);
  assert.throws(() => assertPublishableManifest({ ...manifest, pi: undefined }), /pi\.extensions/);
  assert.throws(() => assertPublishableManifest({ ...manifest, private: true }), /private/);
});
