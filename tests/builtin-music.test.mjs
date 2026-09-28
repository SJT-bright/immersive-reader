import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import { BUILTIN_TRACKS, builtinTrackByKey, missingBuiltinTracks } from '../js/builtin-music.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('内置曲目清单字段完整且键唯一', () => {
    const keys = new Set()
    for (const t of BUILTIN_TRACKS) {
        assert.ok(t.key && /^[a-z0-9-]+$/.test(t.key), `key 非法：${t.key}`)
        assert.ok(!keys.has(t.key), `key 重复：${t.key}`)
        keys.add(t.key)
        assert.ok(t.title, `${t.key} 缺标题`)
        assert.ok(Number.isInteger(t.seconds) && t.seconds > 0, `${t.key} 时长非法`)
        assert.equal(typeof t.loop, 'boolean', `${t.key} loop 必须是布尔`)
        assert.match(t.file, /^assets\/audio\/[a-z0-9-]+\.mp3$/, `${t.key} 路径不合规`)
    }
})

test('清单里每一首音频文件真实存在且不是空文件', () => {
    for (const t of BUILTIN_TRACKS) {
        const p = resolve(ROOT, t.file)
        assert.ok(existsSync(p), `缺少音频文件：${t.file}`)
        assert.ok(readFileSync(p).length > 40000, `${t.file} 小得异常，可能没生成成功`)
    }
})

test('无缝循环标记只打在真正按循环生成的曲目上', () => {
    // 生成器里带 tail 折叠的才有 loop 标记；《林间慢读》是早期作品，首尾有淡入淡出
    const script = readFileSync(resolve(ROOT, 'scripts/generate_builtin_music.py'), 'utf8')
    for (const t of BUILTIN_TRACKS) {
        if (!t.loop) continue
        assert.ok(script.includes(`'${t.file.split('/').pop()}'`), `${t.file} 标了 loop 但生成器里没有这首`)
    }
    assert.ok(script.includes('forest-reading.mp3'), '生成器必须保留《林间慢读》的原始算法')
})

test('builtinTrackByKey 未知键返回 null', () => {
    assert.equal(builtinTrackByKey('nope'), null)
    assert.equal(builtinTrackByKey(undefined), null)
    assert.equal(builtinTrackByKey('rain-window').title, '雨窗随想')
})

test('missingBuiltinTracks 按标题后缀去重', () => {
    const all = missingBuiltinTracks([])
    assert.equal(all.length, BUILTIN_TRACKS.length)
    const some = missingBuiltinTracks([{ name: '雨窗随想.mp3' }, { name: '自己的歌.mp3' }])
    assert.ok(!some.some(t => t.key === 'rain-window'))
    assert.equal(some.length, BUILTIN_TRACKS.length - 1)
    assert.equal(missingBuiltinTracks(BUILTIN_TRACKS.map(t => ({ name: `${t.title}.mp3` }))).length, 0)
})
