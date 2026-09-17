import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pointAt, samplePath } from './flow-geometry.js';

test('straight rails measure their true length and interpolate linearly', () => {
  const rail = samplePath('M80 200 H280');
  assert.equal(rail.length, 200);
  assert.deepEqual(pointAt(rail, 0).slice(0, 2), [80, 200]);
  assert.deepEqual(pointAt(rail, .5).slice(0, 2), [180, 200]);
  assert.deepEqual(pointAt(rail, 1).slice(0, 2), [280, 200]);
  assert.deepEqual(pointAt(rail, .25).slice(2), [1, 0]);
  const vertical = samplePath('M200 67.5 V210');
  assert.equal(vertical.length, 142.5);
  assert.deepEqual(pointAt(vertical, .5), [200, 138.75, 0, 1]);
});

test('curved rails stay between the chord and the control polygon and end at the final point', () => {
  const rail = samplePath('M680 200 H725 C795 200 780 68 840 68 H910');
  const chord = 45 + Math.hypot(840 - 725, 68 - 200) + 70;
  const polygon = 45 + Math.hypot(70, 0) + Math.hypot(-15, -132) + Math.hypot(60, 0) + 70;
  assert.ok(rail.length > chord && rail.length < polygon, `${rail.length} between ${chord} and ${polygon}`);
  assert.deepEqual(pointAt(rail, 1).slice(0, 2), [910, 68]);
  const [x, y, dx, dy] = pointAt(rail, .5);
  assert.ok(x > 725 && x < 840 && y > 68 && y < 200, 'the midpoint sits inside the curve');
  assert.ok(dx > 0 && dy < 0, 'the coin heads up and to the right through the bend');
  assert.ok(Math.abs(Math.hypot(dx, dy) - 1) < 1e-9, 'the tangent is a unit vector');
});

test('fractions are clamped and unsupported commands are rejected', () => {
  const rail = samplePath('M0 0 L10 0');
  assert.deepEqual(pointAt(rail, -1).slice(0, 2), [0, 0]);
  assert.deepEqual(pointAt(rail, 2).slice(0, 2), [10, 0]);
  assert.throws(() => samplePath('M0 0 A5 5 0 0 1 10 10'), /Unsupported path command: A/);
  assert.throws(() => samplePath('M0 0'), /at least two points/);
});
