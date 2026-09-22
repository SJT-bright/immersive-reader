import test from 'node:test'
import assert from 'node:assert/strict'
import { BOOK_LIGHTING, buildBookLighting, samplePaper } from '../js/book-lighting.js'

test('moving the key light across the spine mirrors paper illumination and cast direction', () => {
    const light = BOOK_LIGHTING.light
    for (const x of [0, .5, 2, 4, 12, 60, 110]) {
        const left = samplePaper(x, { light })
        const right = samplePaper(-x, { light: [-light[0], light[1], light[2]] })
        left.forEach((c, i) => assert.ok(Math.abs(c - right[i]) < .001))
    }
    const a = buildBookLighting(1200).shadow
    const b = buildBookLighting(1200, { light: [-light[0], light[1], light[2]] }).shadow
    assert.ok(a.x > 0 && b.x < 0)
    assert.equal(a.y, b.y)
})
test('larger source softens the cast; increased clearance extends it', () => {
    const base = buildBookLighting(1200).shadow
    assert.ok(buildBookLighting(1200, { sourceRadius: .6 }).shadow.blur > base.blur)
    const raised = buildBookLighting(1200, { clearance: 6 }).shadow
    assert.ok(raised.x > base.x && raised.y > base.y && raised.blur > base.blur)
})
test('paper stays finite and legible throughout the leaves; binding remains recessed', () => {
    for (let x = -140; x <= 140; x += .25) {
        const color = samplePaper(x)
        assert.ok(color.every(c => Number.isFinite(c) && c >= 0 && c <= 255))
        if (Math.abs(x) > 12) {
            const luminance = rgb => rgb.map(c => { const v = c / 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4 })
                .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0)
            assert.ok((luminance(color) + .05) / (luminance([51, 40, 28]) + .05) > 7)
        }
    }
    assert.ok(samplePaper(0)[0] < samplePaper(60)[0])
    for (const w of [320, 640, 1280]) assert.ok(!buildBookLighting(w).gradient.includes('NaN'))
    assert.throws(() => buildBookLighting(0), RangeError)
})

test('cast contrast follows key/fill balance, with no directional cast when key is off', () => {
    const base = buildBookLighting(1200).vars['--book-cast-opacity']
    assert.equal(buildBookLighting(1200, { key: 0 }).vars['--book-cast-opacity'], 0)
    assert.ok(buildBookLighting(1200, { ambient: 1 }).vars['--book-cast-opacity'] < base)
})
