import test from 'node:test'
import assert from 'node:assert/strict'
import { isSelectionGesture, wordPopoverPosition } from '../src/scriptInteractions.ts'

test('touch taps, mouse jitter and stale selections do not block word clicks', () => {
  assert.equal(isSelectionGesture(false, false, 0), false)
  assert.equal(isSelectionGesture(false, false, 9), false)
  assert.equal(isSelectionGesture(true, false, 0), false)
})
test('actual drag and long-press selection still trigger highlight', () => {
  assert.equal(isSelectionGesture(true, true, 0), true)
  assert.equal(isSelectionGesture(true, true, 80), true)
  assert.equal(isSelectionGesture(true, false, 80), true)
})
test('definition fits viewport at each edge and after expanding content', () => {
  for (const [vw, vh] of [[320, 568], [1440, 900]]) {
    for (const [x, y] of [[0, 0], [vw, 10], [5, vh], [vw, vh], [vw / 2, vh / 2]]) {
      for (const height of [100, 300, vh - 24]) {
        const width = Math.min(280, vw - 24)
        const pos = wordPopoverPosition(x, y, width, height, vw, vh)
        assert.ok(pos.left >= 12 && pos.left + width <= vw - 12)
        assert.ok(pos.top >= 12 && pos.top + height <= vh - 12)
      }
    }
  }
})
