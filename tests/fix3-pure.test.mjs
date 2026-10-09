// fix3 批次的纯函数单测：只测不需要 DOM 的那半批缺陷
// （settings.js 的兜底值口径 / 系统音量快照形状 / 专注位退休 / reading-preset.js 的字段判定与快照往返）。
// DOM 与键盘类改动在 tests/fix3-wiring.test.mjs 里以"接线存在"的静态断言覆盖。
//
// 运行：node --test tests/fix3-pure.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeSettings, DEFAULT_SETTINGS } from '../js/settings.js'
import {
    READING_PRESETS, ENV_PRESETS, applyReadingPreset,
    capturePresetSnapshot, restorePresetSnapshot, settingsMatchPreset,
} from '../js/reading-preset.js'

const fresh = () => normalizeSettings(null)

// ---------- F3-11：normalizeSettings 的兜底值必须取自 DEFAULT_SETTINGS ----------

test('首访（localStorage 为空）拿到的雨势/雾是设计值 0.35/0.28，不是第二套真值 0.58/0.32', () => {
    const d = fresh()
    assert.equal(d.atmosphere.rain, 0.35, 'normalizeSettings 的 rain 兜底仍写着第二套真值')
    assert.equal(d.atmosphere.fog, 0.28, 'normalizeSettings 的 fog 兜底仍写着第二套真值')
    assert.equal(d.atmosphere.rain, DEFAULT_SETTINGS.atmosphere.rain)
    assert.equal(d.atmosphere.fog, DEFAULT_SETTINGS.atmosphere.fog)
})

test('atmosphere / ambience 每个字段在无存档时都等于 DEFAULT_SETTINGS（不存在第二个真值）', () => {
    const d = fresh()
    assert.deepEqual(d.atmosphere, DEFAULT_SETTINGS.atmosphere)
    assert.deepEqual(d.ambience, DEFAULT_SETTINGS.ambience)
    // 逐字段再点一遍，深比较失败时能直接说出是哪个键
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS.atmosphere)) assert.equal(d.atmosphere[k], v, `atmosphere.${k}`)
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS.ambience)) assert.equal(d.ambience[k], v, `ambience.${k}`)
})

test('空对象存档（{atmosphere:{}}）也逐字段回到 DEFAULT，不落到别的数', () => {
    const s = normalizeSettings({ atmosphere: {}, ambience: {} })
    assert.deepEqual(s.atmosphere, DEFAULT_SETTINGS.atmosphere)
    assert.deepEqual(s.ambience, DEFAULT_SETTINGS.ambience)
})

test('兜底改成取自 DEFAULT 之后，越界与畸形入参照旧被夹紧（没有放宽判定）', () => {
    const s = normalizeSettings({ atmosphere: { rain: 9, fog: -1, refraction: NaN, motion: false, enabled: false } })
    assert.equal(s.atmosphere.rain, 1)
    assert.equal(s.atmosphere.fog, 0)
    assert.equal(s.atmosphere.refraction, DEFAULT_SETTINGS.atmosphere.refraction)
    assert.equal(s.atmosphere.motion, false)
    assert.equal(s.atmosphere.enabled, false)
})

test('环境预设的雨夜口径与 DEFAULT_SETTINGS 一致（RAIN_DESIGN 与实现不再两套数）', () => {
    const rainNight = ENV_PRESETS.find(p => p.key === 'rain-night')
    assert.equal(rainNight.set.rain, DEFAULT_SETTINGS.atmosphere.rain)
    assert.equal(rainNight.set.fog, DEFAULT_SETTINGS.atmosphere.fog)
    const quietSnow = ENV_PRESETS.find(p => p.key === 'quiet-snow')
    assert.equal(quietSnow.set.snow, DEFAULT_SETTINGS.atmosphere.snow)
})

// ---------- F3-12：专注位退休，存量 true 要被清理且回不来 ----------

test('misc.hideReadingTools 退休：存量 true 读一次就被压平', () => {
    assert.equal(normalizeSettings({ misc: { hideReadingTools: true } }).misc.hideReadingTools, false)
    assert.equal(DEFAULT_SETTINGS.misc.hideReadingTools, false)
})

test('hideReadingTools 不会经"存一次再读"复活（备份跨版本带回来也一样）', () => {
    const once = normalizeSettings({ misc: { hideReadingTools: true } })
    const twice = normalizeSettings(JSON.parse(JSON.stringify(once)))
    assert.equal(twice.misc.hideReadingTools, false)
})

// ---------- F3-4：系统音量快照的形状与持久化 ----------

test('合法的系统音量快照原样保留（含 byUs）', () => {
    const s = normalizeSettings({ music: { systemMute: { volume: 42, muted: false, byUs: true } } })
    assert.deepEqual(s.music.systemMute, { volume: 42, muted: false, byUs: true })
})

test('畸形系统音量快照一律丢弃，不写入可疑档位', () => {
    assert.equal(normalizeSettings({ music: { systemMute: null } }).music.systemMute, null)
    assert.equal(normalizeSettings({ music: { systemMute: 'yes' } }).music.systemMute, null)
    assert.equal(normalizeSettings({ music: { systemMute: { volume: 'loud', muted: true } } }).music.systemMute, null)
    assert.equal(normalizeSettings({ music: { systemMute: { volume: 150, muted: true } } }).music.systemMute, null)
    assert.equal(normalizeSettings({ music: { systemMute: { volume: -1 } } }).music.systemMute, null)
    assert.equal(normalizeSettings({ music: { systemMute: { volume: 12.5 } } }).music.systemMute, null)
})

test('快照里的布尔字段收紧：非 true 一律 false（默认没有 byUs 时不算我们按的）', () => {
    const s = normalizeSettings({ music: { systemMute: { volume: 10, muted: 'true' } } })
    assert.deepEqual(s.music.systemMute, { volume: 10, muted: false, byUs: false })
})

test('没有存档时 systemMute 默认 null，字段存在于 DEFAULT_SETTINGS（可被持久化）', () => {
    assert.equal(fresh().music.systemMute, null)
    assert.ok('systemMute' in DEFAULT_SETTINGS.music)
})

// ---------- F3-17：预设判定看真实字段，快照能真的把自定义找回来 ----------

test('默认环境（新用户 light）匹配 light；被自定义过的不再匹配', () => {
    const base = fresh()
    assert.equal(settingsMatchPreset(base, 'light'), true)
    const tuned = fresh()
    tuned.atmosphere.rain = 0.9
    assert.equal(settingsMatchPreset(tuned, 'light'), false, '雨势被调到 0.9 之后仍被当成 light，切预设就不会留快照')
    const noTimer = fresh()
    noTimer.misc.showReadingTimer = false
    assert.equal(settingsMatchPreset(noTimer, 'light'), false)
})

test('芯片标签与真实设置脱节时，字段判定照样要求留快照（F3-17 的核心场景）', () => {
    const s = fresh()
    s.misc.readingPreset = 'light' // 标签还挂着「轻氛围」
    s.atmosphere.lightning = true // 但用户自己开了闪电
    assert.equal(s.misc.readingPreset === 'light', true)
    assert.equal(settingsMatchPreset(s, 'light'), false)
})

test('专注预设落地后匹配 focus；full 不改字段所以恒匹配', () => {
    const s = fresh()
    assert.equal(settingsMatchPreset(s, 'focus'), false)
    applyReadingPreset(s, 'focus')
    assert.equal(settingsMatchPreset(s, 'focus'), true)
    assert.equal(settingsMatchPreset(fresh(), 'full'), true)
    assert.equal(settingsMatchPreset(fresh(), '不存在的键'), true)
})

test('有快照时，自定义环境切过预设后可以完整找回', () => {
    const s = fresh()
    s.atmosphere.rain = 0.8
    s.atmosphere.lightning = true
    s.atmosphere.fog = 0.5
    s.background.mode = 'rotate'
    s.misc.scrollFade = false
    s.misc.showReadingTimer = true
    const before = structuredClone(s)
    const snap = capturePresetSnapshot(s)
    assert.equal(applyReadingPreset(s, 'light'), true)
    assert.notEqual(s.atmosphere.rain, 0.8, 'light 预设应当改动雨势，否则这个测试没有意义')
    assert.equal(restorePresetSnapshot(s, snap), true)
    for (const key of ['rain', 'fog', 'lightning']) assert.equal(s.atmosphere[key], before.atmosphere[key], `atmosphere.${key}`)
    assert.equal(s.background.mode, before.background.mode)
    assert.equal(s.misc.scrollFade, before.misc.scrollFade)
})

test('没有快照时 restorePresetSnapshot 返回 false（调用方必须据此给明确提示）', () => {
    const s = fresh()
    const before = structuredClone(s.atmosphere)
    assert.equal(restorePresetSnapshot(s, null), false)
    assert.deepEqual(s.atmosphere, before, '无快照时不得改动设置')
})

test('预设清单本身仍然只有三档（文案改动没动结构）', () => {
    assert.deepEqual(READING_PRESETS.map(p => p.key), ['focus', 'light', 'full'])
    // 「静止背景」的承诺兑现不了：专注预设不动 background.mode，文案里就不该再有这句话（F3-17）
    const focus = READING_PRESETS.find(p => p.key === 'focus')
    assert.equal(focus.hint.includes('静止背景'), false, '专注阅读的文案仍在承诺它没做到的"静止背景"')
    assert.equal(applyReadingPreset(fresh(), 'focus'), true)
})

test('专注预设确实不改 background.mode（证明上面那条文案断言的口径）', () => {
    const s = fresh()
    s.background.mode = 'rotate'
    applyReadingPreset(s, 'focus')
    assert.equal(s.background.mode, 'rotate')
})
