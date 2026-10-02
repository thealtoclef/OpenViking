import test from "node:test";
import assert from "node:assert/strict";
import { appendSystemPrompt } from "../lib/system-prompt.mjs";

// omp passes the system prompt as an array of parts. Concatenating that array
// with `+` coerces it to a comma-joined string, so the parts have to be
// appended instead. This is the regression the helper exists for.
test("appends to an array prompt without joining or mutating it", () => {
  const base = ["you are pi", "tool rules"];
  const merged = appendSystemPrompt(base, "OpenViking profile");
  assert.deepEqual(merged, ["you are pi", "tool rules", "OpenViking profile"]);
  assert.deepEqual(base, ["you are pi", "tool rules"], "host array must not be mutated");
  assert.notEqual(merged, base);
});

test("keeps the pi string form separated by a blank line", () => {
  assert.equal(appendSystemPrompt("you are pi", "OpenViking profile"), "you are pi\n\nOpenViking profile");
});
