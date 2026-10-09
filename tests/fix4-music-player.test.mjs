// 音频播放器修复的判定用例（对应台账 F4-5 / F4-6 / F4-7）。
// 用真实 LocalAudioPlayer + 按 HTMLMediaElement 规范建模的 Audio 桩：
// play() 立刻把 paused 置 false，但返回的 promise 要等「首帧」才落定；
// 落定前调用 pause() 或清 src 就按规范以 AbortError 拒绝——F4-5 的假报错正在这条路径上。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

let metadataMode = 'ok'          // ok | never | error
const live = []

class AudioStub extends EventTarget {
    constructor () {
        super()
        this.paused = true
        this.ended = false
        this.volume = 1
        this.currentTime = 0
        this.duration = NaN
        this.preload = ''
        this._attrs = {}
        this.loadCalls = 0
        this._settle = null
        this._reject = null
        live.push(this)
    }
    get src () { return this._attrs.src || '' }
    set src (v) {
        this._attrs.src = v
        if (this._played) return
        if (metadataMode === 'never') return
        if (metadataMode === 'error') { setTimeout(() => this.dispatchEvent(new Event('error')), 1); return }
        setTimeout(() => { if (this._attrs.src) { this.duration = 42.5; this.dispatchEvent(new Event('loadedmetadata')) } }, 2)
    }
    removeAttribute (k) { if (k === 'src') { this._attrs.src = ''; this._abort() } }
    getAttribute (k) { return this._attrs[k] ?? null }
    load () { this.loadCalls++; this._abort() }
    _abort () { if (this._reject) this._reject(Object.assign(new Error('The play() request was interrupted by a call to pause()'), { name: 'AbortError' })) }
    play () {
        this._played = true
        this.paused = false
        return new Promise((resolve, reject) => {
            this._reject = reject
            this._settle = () => { this._reject = null; this._settle = null; resolve() }
        })
    }
    pause () { this.paused = true; this._abort() }
    static settleAll (ms = 3) { setTimeout(() => live.forEach(el => el._settle && el._settle()), ms) }
    static clear () { live.length = 0 }
}

globalThis.document = { addEventListener() {}, hidden: false, createElement: () => ({ getContext: () => null }) }
globalThis.window = { addEventListener() {} }
globalThis.Audio = function () { return new AudioStub() }
// 只往真的 URL 上补两个方法，别把 URL 构造函数整个换成普通对象：
// 否则后面的 new URL(...) 会炸。
URL.createObjectURL = () => 'blob:stub/' + Math.random().toString(36).slice(2)
URL.revokeObjectURL = () => {}

const { LocalAudioPlayer } = await import('../js/music.js')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const tracks = n => Array.from({ length: n }, (_, i) => ({ id: `t${i}`, name: `曲 ${i}`, data: {} }))
const freshPlayer = (n = 2) => {
    const p = new LocalAudioPlayer()
    p.setFadeMs(0)                      // 关掉交叉淡化，让判定集中在被打断的 play() 上
    p.setTracks(tracks(n))
    const errors = []
    p.addEventListener('audioerror', e => errors.push(e.detail))
    return { p, errors }
}

test('F4-5 点 A 曲后立刻点 B 曲：被自己 retire 打断的 play() 不弹「浏览器阻止了播放」', async () => {
    AudioStub.clear()
    const { p, errors } = freshPlayer()
    const first = p.play('t0')          // 首帧未到，promise 仍挂
    const second = p.play('t1')         // _retireCurrent() 会 pause/释放旧元素 → AbortError
    AudioStub.settleAll()
    await second
    await first
    assert.deepEqual(errors, [], `自伤打断不该提示故障，实际收到：${errors.join(' | ')}`)
    assert.equal(p.currentId, 't1')
})

test('F4-5 点播放后立刻点暂停：同样不该弹故障提示', async () => {
    AudioStub.clear()
    const { p, errors } = freshPlayer(1)
    const inflight = p.play('t0')       // paused 已置 false，pause() 走淡出/真暂停分支
    const pausing = p.pause()
    await inflight
    await pausing
    assert.deepEqual(errors, [], `实际收到：${errors.join(' | ')}`)
})

test('F4-5 真·NotAllowedError 仍然必须提示，不能被一并放行', async () => {
    AudioStub.clear()
    const { p, errors } = freshPlayer(1)
    const orig = AudioStub.prototype.play
    AudioStub.prototype.play = function () {
        this._played = true; this.paused = false
        return Promise.reject(Object.assign(new Error('play() blocked by the browser'), { name: 'NotAllowedError' }))
    }
    try {
        await p.play('t0')
    } finally {
        AudioStub.prototype.play = orig
    }
    assert.equal(errors.length, 1, '真实拦截要保留提示')
    assert.match(errors[0], /浏览器阻止了播放或媒体无法解码/)
})

test('F4-6 当前曲目被移出列表时与 _discard() 对齐：pause + removeAttribute(src) + load', () => {
    AudioStub.clear()
    const p = new LocalAudioPlayer()
    p.setFadeMs(0)
    p.setTracks(tracks(3))
    const first = p.play('t1')
    AudioStub.settleAll(1)
    const el = p.audio
    const boundBefore = Boolean(el.getAttribute('src'))
    first.catch(() => {})
    p.setTracks(tracks(3).filter(t => t.id !== 't1'))
    assert.equal(boundBefore, true, '前提：移除前元素确实挂着 src')
    assert.equal(el.loadCalls, 1, '缺 load() 时解码器与缓存不会即时释放（200MB 单曲会层层累积）')
    assert.equal(Boolean(el.getAttribute('src')), false, 'src 必须摘干净')
    assert.equal(p.currentId, null)
})

test('F4-7 一轮补探 20 首全部拿到时长（旧闸门只会做 3 首，其余永久 –:–）', async () => {
    AudioStub.clear()
    metadataMode = 'ok'
    const p = new LocalAudioPlayer()
    p.setTracks(tracks(20))
    let peak = 0
    p.addEventListener('state', () => { peak = Math.max(peak, p._probing.size) })
    for (const t of p.tracks) p.probeDuration(t.id)     // 每人只叫一次，靠队列自己排干
    for (let i = 0; i < 80 && p.durations.size < 20; i++) await sleep(10)
    assert.equal(p.durations.size, 20, '被丢弃的探测必须排队补上，而不是直接 return 0')
    assert.ok(peak <= 3, `并发上限失守：峰值 ${peak}`)
    assert.equal(p._queued.size, 0, '队列应排干')
})

test('F4-7 探测失败也广播状态，且有重试上界不会死循环', async () => {
    AudioStub.clear()
    metadataMode = 'error'
    const p = new LocalAudioPlayer()
    p.setTracks(tracks(4))
    let emits = 0
    p.addEventListener('state', () => {
        emits++
        for (const t of p.tracks) if (!p.durationOf(t.id)) p.probeDuration(t.id)
    })
    for (const t of p.tracks) p.probeDuration(t.id)
    for (let i = 0; i < 10; i++) await sleep(10)
    assert.ok(emits > 0, '旧写法失败时不 emit，面板再也拿不到补探机会 → 永久 –:–')
    const attempts = [...p._probeAttempts.values()].sort()
    assert.equal(attempts.length, 4)
    assert.ok(Math.max(...attempts) <= 3, `重试次数失守：${attempts}`)
    const snapshot = [...p._probeAttempts.values()]
    for (let i = 0; i < 5; i++) { for (const t of p.tracks) p.probeDuration(t.id); await sleep(10) }
    assert.deepEqual([...p._probeAttempts.values()], snapshot, '到上界后不得再开新探测')
    metadataMode = 'ok'
})

test('F4-7 曲目被删除后清理探测状态，不留脏缓存', async () => {
    AudioStub.clear()
    metadataMode = 'ok'
    const p = new LocalAudioPlayer()
    p.setTracks(tracks(5))
    await Promise.all(p.tracks.map(t => p.probeDuration(t.id)))
    assert.equal(p.durations.size, 5)
    p.setTracks(tracks(5).filter(t => t.id !== 't2'))
    assert.equal(p.durations.has('t2'), false)
    assert.equal(p._probeAttempts.has('t2'), false, '尝试计数不该跟着曲目残留')
    assert.equal(p.urls.has('t2'), false)
})

// ── 以下两条是对 music-ui.js 的静态判定（面板要真 DOM 才跑得起，这里守结构）──
const uiSrc = readFileSync(fileURLToPath(new URL('../js/music-ui.js', import.meta.url)), 'utf8')

test('F4-5 面板不再重复挂 audioerror→toast', () => {
    assert.equal((uiSrc.match(/addEventListener\('audioerror'/g) || []).length, 0,
        'audioerror 只在 main.js 一处 toast；面板这一侧的重复监听应已摘除')
})

test('F4-4 曲目列表签名不含播放态/当前曲/时长，行状态改为就地同步', () => {
    const start = uiSrc.indexOf('const signature = JSON.stringify([')
    assert.ok(start > 0, '找不到列表签名')
    const body = uiSrc.slice(start, uiSrc.indexOf('])', start) + 2)
    for (const forbidden of ['st.playing', 'st.currentId', 'durationOf']) {
        assert.equal(body.includes(forbidden), false, `签名里不该再有 ${forbidden}：它会让整张列表重建，把键盘焦点踢回 body`)
    }
    assert.match(uiSrc, /this\.syncTrackRows\(st\)/, '列表状态应有就地同步入口')
    const syncStart = uiSrc.indexOf('syncTrackRows (st) {')
    assert.ok(syncStart > 0, 'syncTrackRows 缺失')
    const syncBody = uiSrc.slice(syncStart, uiSrc.indexOf('\n    }\n', syncStart))
    assert.match(syncBody, /classList\.toggle\('playing'/, '选中态必须用 classList.toggle')
    assert.match(syncBody, /setAttribute\('aria-label'/, '播放/暂停文案必须单独改 aria-label')
    assert.equal(/innerHTML/.test(syncBody), false, '就地同步里不许出现 innerHTML 重建')
    assert.ok(syncBody.length > 200, 'syncTrackRows 体量异常，可能截断失败')
})
