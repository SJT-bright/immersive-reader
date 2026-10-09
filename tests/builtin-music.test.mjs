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
        assert.match(t.file, /^assets\/audio\/[a-z0-9-]+\.mp3$/, `${t.key} 路径不合规`)
        // 清单只允许放运行时真被读到的字段。曾有一个 loop: 字段全仓零消费者，
        // 面板的「可离线循环播放」实际靠 playMode='repeatAll' 兜底，已删除。
        // 要加新字段，先给出读它的代码，否则就是第二具尸体。
        assert.deepEqual(Object.keys(t).sort(), ['file', 'key', 'seconds', 'tag', 'title'],
            `${t.key} 携带了清单外/无人消费的字段`)
    }
})

test('清单里每一首音频文件真实存在且不是空文件', () => {
    for (const t of BUILTIN_TRACKS) {
        const p = resolve(ROOT, t.file)
        assert.ok(existsSync(p), `缺少音频文件：${t.file}`)
        assert.ok(readFileSync(p).length > 40000, `${t.file} 小得异常，可能没生成成功`)
    }
})

// 「哪几首是按无缝循环制作的」的权威来源是生成器的 tail 折叠参数，不是运行时清单
// （清单里的 loop 字段已因零消费者删除，见 builtin-music.js 顶部说明）。
const SEAMLESS = ['rain-window.mp3', 'night-desk.mp3', 'valley-dawn.mp3', 'hearth-snow.mp3', 'slow-tide.mp3']

test('无缝循环的生成方式只在生成器里定义，且清单不再养无人读的标志', () => {
    const script = readFileSync(resolve(ROOT, 'scripts/generate_builtin_music.py'), 'utf8')
    for (const f of SEAMLESS) {
        assert.ok(script.includes(`'${f}'`), `${f} 标了无缝循环但生成器里没有这首`)
    }
    // 带 tail 的条目数必须正好是上面这批；《林间慢读》走独立算法，不做尾巴折叠
    assert.equal((script.match(/'tail':/g) || []).length, SEAMLESS.length,
        '生成器里带 tail 折叠的条目数与无缝清单不一致')
    assert.ok(script.includes('forest-reading.mp3'), '生成器必须保留《林间慢读》的原始算法')
    // 清单侧：不允许再出现 loop 这类只写在注释里的字段
    for (const t of BUILTIN_TRACKS) assert.ok(!('loop' in t), `${t.key} 又引入了零消费字段`)
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
