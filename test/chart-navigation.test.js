import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { navigationRange, clampVisibleRange } from '../public/js/chart-navigation.js';

const visible = { from: 20, to: 120 };
test('Zoom out increases the visible range around its center', () => {
  const r = navigationRange('out', visible, 500);
  assert.ok(r.to - r.from > 100);
  assert.equal((r.to + r.from) / 2, 70);
});
test('Zoom in decreases the visible range around its center', () => {
  const r = navigationRange('in', visible, 500);
  assert.ok(r.to - r.from < 100);
  assert.equal((r.to + r.from) / 2, 70);
});
test('Scroll left moves the visible range to older bars', () => {
  assert.ok(navigationRange('left', visible, 500).from < visible.from);
});
test('Scroll right moves the visible range to newer bars and stops at the latest bar', () => {
  assert.ok(navigationRange('right', visible, 500).from > visible.from);
  assert.deepEqual(navigationRange('right', { from: 400, to: 508 }, 500, 8), { from: 400, to: 508 });
});
test('Scroll to the latest bar keeps the configured right margin', () => {
  assert.deepEqual(navigationRange('latest', visible, 500, 8), { from: 408, to: 508 });
});
test('Reset chart view requests a full fit', () => {
  assert.deepEqual(navigationRange('reset', visible, 500), { fit: true });
});
test('a saved range beyond the available bars returns to the latest visible bars', () => {
  assert.deepEqual(clampVisibleRange({ from: 2191, to: 2333 }, 200, 8), { from: 58, to: 200 });
});
test('a valid saved range stays in place and inside the right margin', () => {
  assert.deepEqual(clampVisibleRange({ from: 20, to: 120 }, 200, 8), { from: 20, to: 120 });
  assert.deepEqual(clampVisibleRange({ from: 20, to: 240 }, 200, 8), { from: 0, to: 208 });
});
test('all six navigation buttons are present and connected to chart actions', () => {
  const source = readFileSync(new URL('../public/js/chart.js', import.meta.url), 'utf8');
  for (const action of ['out', 'in', 'left', 'right', 'latest', 'reset']) assert.ok(source.includes(`data-nav="${action}"`), `${action} button exists`);
  assert.match(source, /this\.navAction\(button\.dataset\.nav\)/);
});
