import test from "node:test";
import assert from "node:assert/strict";
import { latestResetBoundary, resetBoundaryChanged } from "../lib/reset-boundary.mjs";

const entry = (id, type = "message") => ({ id, type });

test("finds the newest marker with its index", () => {
  assert.deepEqual(
    latestResetBoundary([entry("a"), entry("c1", "reset_boundary"), entry("b")]),
    { id: "c1", index: 1 },
  );
  assert.deepEqual(
    latestResetBoundary([entry("c1", "reset_boundary"), entry("c2", "reset_boundary")]),
    { id: "c2", index: 1 },
  );
});

test("a branch without a marker reports none and no index", () => {
  assert.deepEqual(latestResetBoundary([entry("a")]), { id: null, index: -1 });
  assert.deepEqual(latestResetBoundary([]), { id: null, index: -1 });
  assert.deepEqual(latestResetBoundary(undefined), { id: null, index: -1 });
});

test("the first observation only records the marker, never acts on it", () => {
  // A session cleared before the extension loaded is already started against
  // the post-clear branch; firing here would reset a healthy session.
  assert.deepEqual(resetBoundaryChanged(undefined, [entry("c1", "reset_boundary")]), {
    id: "c1",
    index: 0,
    changed: false,
  });
});

test("a clear after the first observation is a change, carrying its position", () => {
  // First look: no marker, nothing to do.
  assert.deepEqual(resetBoundaryChanged(undefined, [entry("a")]), { id: null, index: -1, changed: false });
  // The user clears: the marker appears and the instance has looked before.
  // The index is what keeps the cleared prefix out of the next session's capture.
  assert.deepEqual(resetBoundaryChanged(null, [entry("a"), entry("b"), entry("c1", "reset_boundary")]), {
    id: "c1",
    index: 2,
    changed: true,
  });
});

test("a marker the instance has not seen is a change", () => {
  const next = resetBoundaryChanged("c1", [entry("c1", "reset_boundary"), entry("c2", "reset_boundary")]);
  assert.equal(next.id, "c2");
  assert.equal(next.index, 1);
  assert.equal(next.changed, true);
});

test("the same marker twice is not a change", () => {
  const branch = [entry("c1", "reset_boundary")];
  assert.deepEqual(resetBoundaryChanged("c1", branch), { id: "c1", index: 0, changed: false });
});
