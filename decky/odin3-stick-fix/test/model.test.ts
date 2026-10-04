import { test } from "node:test";
import assert from "node:assert/strict";
import { applyRest, fromParams, normalize, restShift, setField, setSymmetric, toParams, trackReach, emptyReach } from "../src/lib/model.ts";

const AANZE = {
  axis_leftx_min: -700, axis_leftx_max: 700, axis_leftx_center: 0, axis_leftx_deadzone: 70,
  axis_lefty_min: -835, axis_lefty_max: 835, axis_lefty_center: 0, axis_lefty_deadzone: 70,
  axis_rightx_min: -910, axis_rightx_max: 910, axis_rightx_center: 0, axis_rightx_deadzone: 70,
  axis_righty_min: -825, axis_righty_max: 825, axis_righty_center: 0, axis_righty_deadzone: 70,
};

test("params round-trip through the editor model", () => {
  const edit = fromParams(AANZE);
  assert.equal(edit.left.left, 700);
  assert.equal(edit.left.up, 835);
  assert.equal(edit.right.down, 825);
  assert.equal(edit.left.symmetric, true);
  assert.deepEqual(toParams(edit), AANZE);
});

test("symmetric editing mirrors the opposite direction", () => {
  let edit = fromParams(AANZE);
  edit = setField(edit, "left", "left", 680);
  assert.equal(edit.left.right, 680);
  edit = setSymmetric(edit, "left", false);
  edit = setField(edit, "left", "up", 800);
  assert.equal(edit.left.down, 835);
  assert.ok(restShift(edit.left).y > 0);
  edit = setSymmetric(edit, "left", true);
  assert.equal(edit.left.up, 800);
  assert.equal(edit.left.down, 800);
});

test("values are clamped", () => {
  const edit = setField(fromParams(AANZE), "right", "centerX", 9999);
  assert.equal(edit.right.centerX, 300);
});

test("normalize and reach use the declared side", () => {
  assert.equal(normalize({ value: -350, min: -700, max: 700 }), -0.5);
  const reach = trackReach(emptyReach(), {
    leftx: { value: -700, min: -700, max: 700 },
    lefty: { value: 900, min: -835, max: 835 },
    rightx: { value: 0, min: -910, max: 910 },
    righty: { value: 0, min: -825, max: 825 },
  });
  assert.equal(reach.leftx.neg, 1);
  assert.ok(reach.lefty.pos > 1);
});

test("rest measurement cancels the offset and widens the deadzone", () => {
  const edit = applyRest(fromParams(AANZE), {
    leftx: { mean: -38, min: -45, max: -30, noise: 8, center: 38 },
    lefty: { mean: -22, min: -26, max: -18, noise: 4, center: 22 },
    rightx: { mean: 3, min: 1, max: 5, noise: 2, center: -3 },
    righty: { mean: 0, min: -1, max: 1, noise: 1, center: 0 },
  });
  assert.equal(edit.left.centerX, 38);
  assert.equal(edit.left.centerY, 22);
  assert.equal(edit.left.deadzone, 70);
  assert.equal(edit.right.centerX, -3);
});
