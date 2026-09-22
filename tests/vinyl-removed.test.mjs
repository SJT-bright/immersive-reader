import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

test('唱机源码已删除，迷你条与官方播放器仍在', () => {
    assert.equal(existsSync(join(root, 'js/vinyl-deck.js')), false)
    assert.equal(existsSync(join(root, 'tests/vinyl-deck.test.mjs')), false)
    const ui = readFileSync(join(root, 'js/music-ui.js'), 'utf8')
    const css = readFileSync(join(root, 'css/music.css'), 'utf8')
    const html = readFileSync(join(root, 'index.html'), 'utf8')
    assert.equal(ui.includes('vinyl-deck'), false)
    assert.equal(ui.includes('VinylMotion'), false)
    assert.equal(ui.includes('deck-puck'), false)
    assert.equal(css.includes('vinyl-deck'), false)
    assert.equal(css.includes('deck-puck'), false)
    assert.match(ui, /id="mp-toggle"/)
    assert.match(css, /#live-player/)
    assert.match(html, /id="live-player"/)
    assert.match(html, /迷你播放条/)
})
