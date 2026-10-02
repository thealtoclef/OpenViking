import test from "node:test";
import assert from "node:assert/strict";
import { latestResetBoundaryId, resetBoundaryChanged } from "../lib/reset-boundary.mjs";

const entry = (id, type = "message") => ({ id, type });

test("finds the newest clear marker", () => {
  assert.equal(latestResetBoundaryId([entry("a"), entry("c1", "reset_boundary"), entry("b")]), "c1");
  assert.equal(
    latestResetBoundaryId([entry("c1", "reset_boundary"), entry("c2", "reset_boundary")]),
    "c2",
  );
});

test("a branch without a marker reports none", () => {
  assert.equal(latestResetBoundaryId([entry("a")]), null);
  assert.equal(latestResetBoundaryId([]), null);
  assert.equal(latestResetBoundaryId(undefined), null);
});

test("the first observation only records the marker, never acts on it", () => {
  // A session cleared before the extension loaded is already started against
  // the post-clear branch; firing here would reset a healthy session.
  assert.deepEqual(resetBoundaryChanged(undefined, [entry("c1", "reset_boundary")]), {
    id: "c1",
    changed: false,
  });
});

test("a clear after the first observation is a change", () => {
  // First look: no marker, nothing to do.
  assert.deepEqual(resetBoundaryChanged(undefined, [entry("a")]), { id: null, changed: false });
  // The user clears: the marker appears and the instance has looked before.
  assert.deepEqual(resetBoundaryChanged(null, [entry("a"), entry("c1", "reset_boundary")]), {
    id: "c1",
    changed: true,
  });
});

test("a marker the instance has not seen is a change", () => {
  assert.deepEqual(resetBoundaryChanged("c1", [entry("c1", "reset_boundary"), entry("c2", "reset_boundary")]), {
    id: "c2",
    changed: true,
  });
});

test("the same marker twice is not a change", () => {
  const branch = [entry("c1", "reset_boundary")];
  assert.deepEqual(resetBoundaryChanged("c1", branch), { id: "c1", changed: false });
});
