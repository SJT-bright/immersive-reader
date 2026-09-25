import test from 'node:test'
import assert from 'node:assert/strict'
import { spreadColumnMetrics } from '../js/book-spread.js'

test('one spread is exactly two columns and the gutter sits on the center line', () => {
    for (const width of [320, 390, 640, 900, 1156, 1400, 1800]) {
        const m = spreadColumnMetrics(width)
        assert.equal(m.columnWidth * 2 + m.gutter + m.outer * 2, m.pageWidth)
        assert.ok(Math.abs(m.gapCenter - m.pageWidth / 2) < 0.01)
        assert.ok(m.columnWidth >= 80)
        assert.ok(m.gutter >= 16)
        assert.ok(m.outer >= 12)
    }
})
