// 音乐播放引擎。
//
// 两条来源：
//   1. 网易云官方外链播放器（严格白名单解析，iframe 由固定模板生成，绝不注入用户 HTML）；
//   2. 本地音频（IndexedDB 中的 Blob，由本模块播放）。
//
// 本模块不依赖 DOM 结构，可被 Node 单元测试直接导入；所有浏览器 API 都在方法内、
// 并在使用前做能力检测。播放能力包括：定位、播放模式（QQ 音乐四态）、歌曲淡入淡出
// （双音频元素交叉淡化）、睡眠定时、系统媒体键。
//
// 播放模式与 QQ 音乐对齐：一个按钮循环四态——
//   列表循环 repeatAll → 单曲循环 repeatOne → 顺序播放 sequential → 随机播放 shuffle。

const ALLOWED_HOSTS = new Set(['music.163.com', 'y.music.163.com'])

// outchain player 的 type 映射（官方生成器约定；HTTP 200 不等于播放成功）：
// 2 = 单曲（默认高度 66），0 = 歌单（默认高度 430），1 = 专辑（默认高度 430）
const KINDS = {
    song: { path: '/song', type: 2, height: 66, label: '单曲' },
    playlist: { path: '/playlist', type: 0, height: 430, label: '歌单' },
    album: { path: '/album', type: 1, height: 430, label: '专辑' },
}

const DIGITS = /^\d{1,20}$/

export function parseNeteaseLink (input) {
    const raw = String(input || '').trim()
    if (!raw) return { ok: false, reason: '请粘贴网易云音乐的链接' }
    if (/[<>"']/.test(raw)) return { ok: false, reason: '链接中包含非法字符' }
    if (/\s/.test(raw)) return { ok: false, reason: '链接中包含空格' }

    let url
    try {
        url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`)
    } catch {
        return { ok: false, reason: '不是有效的网址' }
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        return { ok: false, reason: '只支持 http(s) 链接' }
    }
    if (!ALLOWED_HOSTS.has(url.hostname) || url.username || url.password || url.port) {
        return { ok: false, reason: `只支持网易云音乐官方链接（music.163.com），收到：${url.hostname}` }
    }

    // music.163.com/#/song?id=xxx 形式：路径为 /，真实路由在 hash 里
    let path = url.pathname
    let search = url.searchParams
    if (path === '/' && url.hash.startsWith('#/')) {
        const hashUrl = new URL(`https://music.163.com/${url.hash.slice(2)}`)
        path = hashUrl.pathname
        search = hashUrl.searchParams
    }
    path = path.replace(/\/+$/, '') || '/'

    // 直接的 outchain 形式：/outchain/{type}/{id}
    const outchain = path.match(/^\/outchain\/(\d+)\/(\d+)$/)
    if (outchain) {
        const type = Number(outchain[1])
        const kind = Object.entries(KINDS).find(([, k]) => k.type === type)
        if (!kind || !DIGITS.test(outchain[2])) return { ok: false, reason: `不支持的外链类型 ${type}（仅支持单曲/歌单/专辑）` }
        return { ok: true, kind: kind[0], type, id: outchain[2], label: kind[1].label }
    }

    for (const [kind, def] of Object.entries(KINDS)) {
        if (path === def.path) {
            const id = search.get('id')
            if (!id || !DIGITS.test(id)) {
                return { ok: false, reason: `链接里缺少合法的数字 id（${def.path}?id=…）` }
            }
            return { ok: true, kind, type: def.type, id, label: def.label }
        }
    }
    if (path === '/program') {
        return { ok: false, reason: '电台节目暂不支持外链嵌入，可改用单曲/歌单/专辑链接' }
    }
    return { ok: false, reason: `无法识别的链接路径：${path}` }
}

// iframe src 只由本函数用校验过的数字拼出
export function buildPlayerUrl ({ type, id }) {
    if (![0, 1, 2].includes(Number(type))) throw new Error('非法 type')
    if (!DIGITS.test(String(id))) throw new Error('非法 id')
    const height = Number(type) === 2 ? 66 : 430
    return `https://music.163.com/outchain/player?type=${Number(type)}&id=${id}&auto=0&height=${height}`
}

export function buildOpenUrl ({ kind, id }) {
    const def = KINDS[kind]
    if (!def || !DIGITS.test(String(id))) throw new Error('非法参数')
    return `https://music.163.com${def.path}?id=${id}`
}

export function neteaseEmbedHeight ({ type }) {
    return Number(type) === 2 ? 80 : 444 // 66/430 + 上下少量余量
}

// 画面迷你条与右侧面板共用一路音源：本地正在播放时优先，否则看官方播放器是否挂着。
export function musicSurface ({ localPlaying = false, localCount = 0, qqMounted = false, neteaseMounted = false } = {}) {
    const source = localPlaying ? 'local' : qqMounted ? 'qq' : neteaseMounted ? 'netease' : 'local'
    return {
        source,
        showLocalMini: source === 'local' && localCount > 0,
        showRemote: source === 'qq' || source === 'netease',
    }
}

// ---------- 通用工具 ----------

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

export function formatTime (seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
    const total = Math.floor(seconds)
    const m = Math.floor(total / 60)
    const s = total % 60
    if (m >= 60) {
        const h = Math.floor(m / 60)
        return `${h}:${String(m % 60).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    }
    return `${m}:${String(s).padStart(2, '0')}`
}

// Fisher–Yates；keepFirst 指定的曲目固定排在最前（当前曲目不被随机换掉）
export function shuffleIds (ids, keepFirst = null) {
    const out = [...ids]
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        ;[out[i], out[j]] = [out[j], out[i]]
    }
    if (keepFirst && out.includes(keepFirst)) {
        out.splice(out.indexOf(keepFirst), 1)
        out.unshift(keepFirst)
    }
    return out
}

// 默认封面：用 canvas 画一枚音符，供系统媒体面板显示。无法绘制时返回 null。
let artworkCache
export function defaultArtwork () {
    if (artworkCache !== undefined) return artworkCache
    artworkCache = null
    try {
        if (typeof document === 'undefined') return artworkCache
        const c = document.createElement('canvas')
        c.width = c.height = 256
        const g = c.getContext('2d')
        if (!g) return artworkCache
        g.fillStyle = '#f5f1e8'
        g.fillRect(0, 0, 256, 256)
        g.fillStyle = '#2b2620'
        g.beginPath()
        g.arc(104, 176, 26, 0, Math.PI * 2)
        g.arc(184, 152, 26, 0, Math.PI * 2)
        g.fill()
        g.fillRect(124, 56, 12, 120)
        g.fillRect(204, 32, 12, 120)
        g.beginPath()
        g.moveTo(124, 56)
        g.lineTo(216, 32)
        g.lineTo(216, 60)
        g.lineTo(124, 84)
        g.closePath()
        g.fill()
        artworkCache = c.toDataURL('image/png')
    } catch { /* 媒体面板只是增强，失败不影响播放 */ }
    return artworkCache
}

// ---------- 本地音频播放器 ----------

// 播放模式与 QQ 音乐对齐：一个按钮循环四态。
export const PLAY_MODES = ['repeatAll', 'repeatOne', 'sequential', 'shuffle']
export const PLAY_MODE_LABELS = { repeatAll: '列表循环', repeatOne: '单曲循环', sequential: '顺序播放', shuffle: '随机播放' }
// QQ 音乐「歌曲淡入淡出」档位：关闭 / 0.5 秒 / 1 秒 / 2 秒
export const FADE_STEPS = [0, 500, 1000, 2000]

export class LocalAudioPlayer extends EventTarget {
    constructor () {
        super()
        this.tracks = [] // [{ id, name, data(Blob) }]，顺序由调用方决定
        this.urls = new Map()
        this.durations = new Map() // id -> 秒
        this.currentId = null
        this.playMode = 'repeatAll' // repeatAll | repeatOne | sequential | shuffle
        this.volume = 0.8
        this.muted = false
        this.fadeMs = 1000 // 歌曲淡入淡出时长（QQ 音乐「歌曲淡入淡出」），0 = 关闭
        this.sleepUntil = null // 睡眠定时的到期时间戳（分钟模式）
        this.sleepAfterTrack = false
        this._shuffleOrder = null
        this._pauseToken = 0
        this._sleepTimer = null
        this._probing = new Set()
        this._fadeDisabled = false
        this._waiting = false
        this._retiring = new Set() // 交叉淡化中正在淡出的旧音频元素

        this.audio = this._makeAudio()

        this.installMediaSession()
    }

    // 每个音频元素独立绑定事件；只有「主元素」的事件才驱动状态，
    // 交叉淡化期间旧元素的 ended/error 不会误触发切歌。
    _makeAudio () {
        const el = new Audio()
        el.preload = 'metadata'
        el.volume = this.effectiveVolume()
        const main = () => el === this.audio
        const emit = () => { if (main()) this.emit() }
        el.addEventListener('timeupdate', emit)
        el.addEventListener('durationchange', emit)
        el.addEventListener('loadedmetadata', emit)
        el.addEventListener('waiting', () => { if (main()) { this._waiting = true; emit() } })
        el.addEventListener('playing', () => { if (main()) { this._waiting = false; this.updateMediaSession(); emit() } })
        el.addEventListener('play', () => { if (main()) { this.updateMediaSession(); emit() } })
        el.addEventListener('pause', () => { if (main()) { this._waiting = false; this.updateMediaSession(); emit() } })
        el.addEventListener('ended', () => { if (main()) this.onEnded() })
        el.addEventListener('error', () => {
            if (!main()) return
            this._waiting = false
            this.dispatchEvent(new CustomEvent('audioerror', {
                detail: '本地音频播放失败：格式不受浏览器支持或文件损坏',
            }))
            emit()
        })
        return el
    }

    emit () {
        this.dispatchEvent(new CustomEvent('state', { detail: this.getState() }))
    }

    // 淡入淡出对"减少动态效果"用户是干扰，由主装配在启动时关闭
    setFadeEnabled (on) {
        this._fadeDisabled = on === false
        if (this._fadeDisabled) {
            this._cancelFade(this.audio)
            for (const el of [...this._retiring]) this._discard(el)
            this.audio.volume = this.effectiveVolume()
        }
        this.emit()
    }

    // QQ 音乐「歌曲淡入淡出」档位：关闭 / 0.5 秒 / 1 秒 / 2 秒
    setFadeMs (ms) {
        this.fadeMs = FADE_STEPS.includes(Number(ms)) ? Number(ms) : 1000
        this.emit()
    }

    effectiveVolume () {
        return this.muted ? 0 : this.volume
    }

    // ----- 淡入淡出（每个元素独立计时，支持交叉淡化同时进行） -----

    _cancelFade (el) {
        if (el._fadeTimer) { clearInterval(el._fadeTimer); el._fadeTimer = null }
        el._fadeSeq = (el._fadeSeq || 0) + 1
    }

    _fade (el, target, ms) {
        this._cancelFade(el)
        const seq = el._fadeSeq
        const from = el.volume
        if (!ms || this._fadeDisabled || Math.abs(from - target) < 0.005) {
            el.volume = target
            return Promise.resolve()
        }
        return new Promise(resolve => {
            const t0 = Date.now()
            el._fadeTimer = setInterval(() => {
                if (seq !== el._fadeSeq) { resolve(); return }
                const p = Math.min(1, (Date.now() - t0) / ms)
                el.volume = clamp(from + (target - from) * p, 0, 1)
                if (p >= 1) {
                    clearInterval(el._fadeTimer)
                    el._fadeTimer = null
                    resolve()
                }
            }, 40)
        })
    }

    // 释放一个不再使用的音频元素（淡出完成或立即）
    _discard (el) {
        this._cancelFade(el)
        this._retiring.delete(el)
        try {
            el.pause()
            el.removeAttribute('src')
            el.load()
        } catch { /* 释放即可 */ }
    }

    // 切歌时把当前主元素转入淡出池；开启淡入淡出时旧曲渐退、新曲渐入（QQ 交叉淡化）
    _retireCurrent () {
        const old = this.audio
        this.audio = this._makeAudio()
        if (old.paused) {
            this._discard(old)
            return
        }
        this._retiring.add(old)
        if (this.fadeMs > 0 && !this._fadeDisabled) {
            this._fade(old, 0, this.fadeMs).then(() => this._discard(old))
        } else {
            this._discard(old)
        }
    }

    // ----- 曲目 -----

    setTracks (tracks) {
        // IndexedDB 每次读取都返回新的 Blob 对象；已存在记录的字节不会原地改变，
        // 备份恢复会整页重载，因此按 id 复用 objectURL 是安全的。
        for (const [id, url] of this.urls) {
            if (!tracks.some(t => t.id === id)) {
                URL.revokeObjectURL(url)
                this.urls.delete(id)
                this.durations.delete(id)
            }
        }
        this.tracks = tracks
        this._shuffleOrder = null
        if (this.currentId && !tracks.some(t => t.id === this.currentId)) {
            this._cancelFade(this.audio)
            this.audio.pause()
            this.audio.removeAttribute('src')
            this.currentId = null
        }
        this.emit()
    }

    urlFor (id) {
        if (!this.urls.has(id)) {
            const t = this.tracks.find(t => t.id === id)
            if (!t) return null
            this.urls.set(id, URL.createObjectURL(t.data))
        }
        return this.urls.get(id)
    }

    durationOf (id) {
        if (id === this.currentId && Number.isFinite(this.audio.duration) && this.audio.duration > 0) {
            return this.audio.duration
        }
        return this.durations.get(id) || 0
    }

    // 为列表补时长：用临时 audio 读元数据，结果缓存并广播。
    // 限制并发，避免曲库很大时同时创建大量 Audio 元素。
    probeDuration (id) {
        if (this.durations.has(id) || this._probing.has(id) || !this.tracks.some(t => t.id === id)) return Promise.resolve(0)
        if (this._probing.size >= 3) return Promise.resolve(0)
        const url = this.urlFor(id)
        if (!url) return Promise.resolve(0)
        this._probing.add(id)
        return new Promise(resolve => {
            const el = new Audio()
            el.preload = 'metadata'
            let settled = false
            const finish = value => {
                if (settled) return
                settled = true
                clearTimeout(timer)
                el.removeAttribute('src')
                try { el.load() } catch { /* 释放即可 */ }
                this._probing.delete(id)
                if (value > 0) {
                    this.durations.set(id, value)
                    this.emit()
                }
                resolve(value)
            }
            const timer = setTimeout(() => finish(0), 10000)
            el.addEventListener('loadedmetadata', () => {
                finish(Number.isFinite(el.duration) && el.duration > 0 ? el.duration : 0)
            }, { once: true })
            el.addEventListener('error', () => finish(0), { once: true })
            el.src = url
        })
    }

    // ----- 播放控制 -----

    async play (id) {
        if (!id) id = this.currentId || this.tracks[0]?.id
        if (!id) return
        this._pauseToken++ // 作废可能正在进行的暂停淡出
        const isNew = this.currentId !== id
        if (isNew) {
            // 交叉淡化：旧曲转入淡出池，新曲从新元素渐入
            this._retireCurrent()
            this.currentId = id
            this.audio.src = this.urlFor(id)
            this.audio.currentTime = 0
        } else if (!this.audio.paused) {
            // 已在播放同一曲目：若正处在暂停淡出中，撤销它并恢复音量
            this._cancelFade(this.audio)
            this.audio.volume = this.effectiveVolume()
            return
        }
        const target = this.effectiveVolume()
        this.audio.volume = this.fadeMs > 0 && !this._fadeDisabled ? 0 : target
        try {
            await this.audio.play()
        } catch (e) {
            this.audio.volume = target
            this.dispatchEvent(new CustomEvent('audioerror', {
                detail: '浏览器阻止了播放或媒体无法解码：' + (e?.message || e),
            }))
            return
        }
        await this._fade(this.audio, target, this.fadeMs)
    }

    async pause () {
        if (this.audio.paused) {
            for (const el of [...this._retiring]) this._discard(el)
            return
        }
        const token = ++this._pauseToken
        const target = this.effectiveVolume()
        // 暂停时同时收掉交叉淡化中的旧元素
        for (const el of [...this._retiring]) this._discard(el)
        // 暂停的淡出比切歌短，避免按了暂停还要等一秒才安静
        if (this.fadeMs > 0 && !this._fadeDisabled) await this._fade(this.audio, 0, Math.min(this.fadeMs, 600))
        // 淡出期间用户又点了播放，就不要把音频停掉
        if (token !== this._pauseToken) { this.audio.volume = this.effectiveVolume(); return }
        this.audio.pause()
        this._cancelFade(this.audio)
        this.audio.volume = target
        this.emit()
    }

    async toggle () {
        if (!this.currentId) return this.play()
        if (this.audio.paused) return this.play(this.currentId)
        return this.pause()
    }

    stop () {
        this._cancelFade(this.audio)
        for (const el of [...this._retiring]) this._discard(el)
        this.audio.pause()
        this.audio.currentTime = 0
        this.audio.volume = this.effectiveVolume()
        this.emit()
    }

    seek (seconds) {
        const d = this.audio.duration
        if (!this.currentId || !Number.isFinite(d) || d <= 0) return
        this.audio.currentTime = clamp(seconds, 0, d)
        this.emit()
    }

    seekBy (delta) {
        this.seek((this.audio.currentTime || 0) + delta)
    }

    // ----- 播放顺序（QQ 音乐四态：列表循环 / 单曲循环 / 顺序 / 随机） -----

    order () {
        const ids = this.tracks.map(t => t.id)
        if (this.playMode !== 'shuffle') return ids
        const stale = !this._shuffleOrder ||
            this._shuffleOrder.length !== ids.length ||
            !this._shuffleOrder.every(id => ids.includes(id))
        if (stale) this._shuffleOrder = shuffleIds(ids, this.currentId)
        return this._shuffleOrder
    }

    setPlayMode (mode) {
        this.playMode = PLAY_MODES.includes(mode) ? mode : 'repeatAll'
        this._shuffleOrder = this.playMode === 'shuffle' ? shuffleIds(this.tracks.map(t => t.id), this.currentId) : null
        this.emit()
    }

    next (auto = false) {
        if (!this.tracks.length) return
        const order = this.order()
        const i = order.indexOf(this.currentId)
        // 顺序播放自动推进到底：停在最后一曲末尾，不回绕（QQ 行为）
        if (auto && this.playMode === 'sequential' && (i < 0 || i === order.length - 1)) {
            this.emit()
            return
        }
        const j = i < 0 ? 0 : (i + 1) % order.length
        this.play(order[j])
    }

    prev () {
        if (!this.tracks.length) return
        // 播放超过 3 秒时，"上一首"先回到本曲开头（与常见播放器一致）
        if (this.currentId && this.audio.currentTime > 3) { this.seek(0); return }
        const order = this.order()
        const i = order.indexOf(this.currentId)
        const j = i <= 0 ? order.length - 1 : i - 1
        this.play(order[j])
    }

    onEnded () {
        if (this.sleepAfterTrack) {
            this.sleepAfterTrack = false
            this._cancelFade(this.audio)
            this.audio.volume = this.effectiveVolume()
            this.audio.currentTime = 0
            this.dispatchEvent(new CustomEvent('sleepdone', { detail: { reason: 'track' } }))
            this.emit()
            return
        }
        if (this.playMode === 'repeatOne') {
            this.audio.currentTime = 0
            this.play(this.currentId)
        } else {
            this.next(true)
        }
    }

    // ----- 音量 -----

    setVolume (v) {
        this.volume = clamp(Number(v) || 0, 0, 1)
        if (this.volume > 0) this.muted = false
        this._cancelFade(this.audio)
        this.audio.volume = this.effectiveVolume()
        this.emit()
    }

    setMuted (m) {
        this.muted = Boolean(m)
        this._cancelFade(this.audio)
        this.audio.volume = this.effectiveVolume()
        this.emit()
    }

    // ----- 睡眠定时 -----

    setSleep (spec) {
        clearTimeout(this._sleepTimer)
        this._sleepTimer = null
        this.sleepUntil = null
        this.sleepAfterTrack = false
        if (spec && spec.type === 'track') {
            this.sleepAfterTrack = true
        } else if (spec && spec.type === 'minutes') {
            const ms = clamp(Number(spec.minutes) || 0, 1, 600) * 60000
            this.sleepUntil = Date.now() + ms
            this._sleepTimer = setTimeout(() => this.triggerSleep('time'), ms)
        }
        this.emit()
    }

    triggerSleep (reason) {
        clearTimeout(this._sleepTimer)
        this._sleepTimer = null
        this.sleepUntil = null
        this.sleepAfterTrack = false
        this.pause()
        this.dispatchEvent(new CustomEvent('sleepdone', { detail: { reason } }))
        this.emit()
    }

    // ----- 系统媒体键 / 控制中心 -----

    installMediaSession () {
        if (typeof navigator === 'undefined' || !navigator.mediaSession) return
        const ms = navigator.mediaSession
        const set = (action, handler) => { try { ms.setActionHandler(action, handler) } catch { /* 浏览器不支持该动作 */ } }
        set('play', () => this.play())
        set('pause', () => this.pause())
        set('stop', () => this.stop())
        set('previoustrack', () => this.prev())
        set('nexttrack', () => this.next())
        set('seekbackward', d => this.seekBy(-(d?.seekOffset || 10)))
        set('seekforward', d => this.seekBy(d?.seekOffset || 10))
        set('seekto', d => { if (Number.isFinite(d?.seekTime)) this.seek(d.seekTime) })
    }

    updateMediaSession () {
        if (typeof navigator === 'undefined' || !navigator.mediaSession) return
        const ms = navigator.mediaSession
        if (!this.currentId) {
            try { ms.metadata = null; ms.playbackState = 'none' } catch { /* 忽略 */ }
            return
        }
        const track = this.tracks.find(t => t.id === this.currentId)
        const art = defaultArtwork()
        try {
            if (typeof MediaMetadata !== 'undefined') {
                ms.metadata = new MediaMetadata({
                    title: track?.name || '本地音乐',
                    artist: '沉浸阅读器',
                    album: `本地音乐（${this.tracks.length} 首）`,
                    artwork: art ? [{ src: art, sizes: '256x256', type: 'image/png' }] : [],
                })
            }
            ms.playbackState = this.audio.paused ? 'paused' : 'playing'
            if (Number.isFinite(this.audio.duration) && this.audio.duration > 0) {
                ms.setPositionState?.({
                    duration: this.audio.duration,
                    position: clamp(this.audio.currentTime || 0, 0, this.audio.duration),
                    playbackRate: this.audio.playbackRate || 1,
                })
            }
        } catch { /* 位置状态在部分浏览器上会抛错，忽略 */ }
    }

    // ----- 状态 -----

    getState () {
        const track = this.tracks.find(t => t.id === this.currentId) || null
        const duration = Number.isFinite(this.audio.duration) && this.audio.duration > 0
            ? this.audio.duration
            : (this.currentId ? this.durations.get(this.currentId) || 0 : 0)
        return {
            playing: !this.audio.paused && !this.audio.ended && Boolean(this.currentId),
            waiting: this._waiting && !this.audio.paused,
            started: Boolean(this.currentId) && this.audio.currentTime > 0,
            currentId: this.currentId,
            currentName: track?.name || null,
            index: this.tracks.findIndex(t => t.id === this.currentId),
            time: this.audio.currentTime || 0,
            duration,
            volume: this.volume,
            muted: this.muted,
            playMode: this.playMode,
            fadeMs: this.fadeMs,
            sleepUntil: this.sleepUntil,
            sleepAfterTrack: this.sleepAfterTrack,
            trackCount: this.tracks.length,
        }
    }
}
