// 音乐播放引擎。
//
// 两条来源：
//   1. 网易云官方外链播放器（严格白名单解析，iframe 由固定模板生成，绝不注入用户 HTML）；
//   2. 本地音频（IndexedDB 中的 Blob，由本模块播放）。
//
// 本模块不依赖 DOM 结构，可被 Node 单元测试直接导入；所有浏览器 API 都在方法内、
// 并在使用前做能力检测。播放能力包括：定位、随机、淡入淡出、睡眠定时、系统媒体键。

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

export class LocalAudioPlayer extends EventTarget {
    constructor () {
        super()
        this.audio = new Audio()
        this.audio.preload = 'metadata'
        this.tracks = [] // [{ id, name, data(Blob) }]，顺序由调用方决定
        this.urls = new Map()
        this.durations = new Map() // id -> 秒
        this.currentId = null
        this.loop = 'all' // all | one | none
        this.shuffle = false
        this.volume = 0.8
        this.muted = false
        this.fadeMs = 900
        this.sleepUntil = null // 睡眠定时的到期时间戳（分钟模式）
        this.sleepAfterTrack = false
        this._shuffleOrder = null
        this._fadeTimer = null
        this._fadeSeq = 0
        this._pauseToken = 0
        this._sleepTimer = null
        this._probing = new Set()
        this._fadeDisabled = false
        this._waiting = false

        this.audio.volume = this.effectiveVolume()

        const emit = () => this.emit()
        this.audio.addEventListener('timeupdate', emit)
        this.audio.addEventListener('durationchange', emit)
        this.audio.addEventListener('loadedmetadata', emit)
        this.audio.addEventListener('waiting', () => { this._waiting = true; emit() })
        this.audio.addEventListener('playing', () => { this._waiting = false; this.updateMediaSession(); emit() })
        this.audio.addEventListener('play', () => { this.updateMediaSession(); emit() })
        this.audio.addEventListener('pause', () => { this._waiting = false; this.updateMediaSession(); emit() })
        this.audio.addEventListener('ended', () => this.onEnded())
        this.audio.addEventListener('error', () => {
            this._waiting = false
            this.dispatchEvent(new CustomEvent('audioerror', {
                detail: '本地音频播放失败：格式不受浏览器支持或文件损坏',
            }))
            emit()
        })
        this.installMediaSession()
    }

    emit () {
        this.dispatchEvent(new CustomEvent('state', { detail: this.getState() }))
    }

    // 淡入淡出对"减少动态效果"用户是干扰，由主装配在启动时关闭
    setFadeEnabled (on) {
        this._fadeDisabled = on === false
        if (this._fadeDisabled) this.cancelFade()
        this.emit()
    }

    effectiveVolume () {
        return this.muted ? 0 : this.volume
    }

    // ----- 淡入淡出 -----

    cancelFade () {
        if (this._fadeTimer) { clearInterval(this._fadeTimer); this._fadeTimer = null }
        this._fadeSeq++
    }

    fadeTo (target, ms) {
        this.cancelFade()
        const seq = this._fadeSeq
        const from = this.audio.volume
        if (!ms || this._fadeDisabled || Math.abs(from - target) < 0.005) {
            this.audio.volume = target
            return Promise.resolve()
        }
        return new Promise(resolve => {
            const t0 = Date.now()
            this._fadeTimer = setInterval(() => {
                if (seq !== this._fadeSeq) { resolve(); return }
                const p = Math.min(1, (Date.now() - t0) / ms)
                this.audio.volume = clamp(from + (target - from) * p, 0, 1)
                if (p >= 1) {
                    clearInterval(this._fadeTimer)
                    this._fadeTimer = null
                    resolve()
                }
            }, 40)
        })
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
            this.cancelFade()
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
            this.cancelFade()
            this.currentId = id
            this.audio.src = this.urlFor(id)
            this.audio.currentTime = 0
        } else if (!this.audio.paused) {
            // 已在播放同一曲目：若正处在暂停淡出中，撤销它并恢复音量
            this.cancelFade()
            this.audio.volume = this.effectiveVolume()
            return
        }
        const target = this.effectiveVolume()
        this.audio.volume = this.fadeMs && !this._fadeDisabled ? 0 : target
        try {
            await this.audio.play()
        } catch (e) {
            this.audio.volume = target
            this.dispatchEvent(new CustomEvent('audioerror', {
                detail: '浏览器阻止了播放或媒体无法解码：' + (e?.message || e),
            }))
            return
        }
        await this.fadeTo(target, this.fadeMs)
    }

    async pause () {
        if (this.audio.paused) return
        const token = ++this._pauseToken
        const target = this.effectiveVolume()
        if (this.fadeMs && !this._fadeDisabled) await this.fadeTo(0, Math.min(this.fadeMs, 450))
        // 淡出期间用户又点了播放，就不要把音频停掉
        if (token !== this._pauseToken) { this.audio.volume = this.effectiveVolume(); return }
        this.audio.pause()
        this.cancelFade()
        this.audio.volume = target
        this.emit()
    }

    async toggle () {
        if (!this.currentId) return this.play()
        if (this.audio.paused) return this.play(this.currentId)
        return this.pause()
    }

    stop () {
        this.cancelFade()
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

    // ----- 顺序：顺序 / 随机 -----

    order () {
        const ids = this.tracks.map(t => t.id)
        if (!this.shuffle) return ids
        const stale = !this._shuffleOrder ||
            this._shuffleOrder.length !== ids.length ||
            !this._shuffleOrder.every(id => ids.includes(id))
        if (stale) this._shuffleOrder = shuffleIds(ids, this.currentId)
        return this._shuffleOrder
    }

    setShuffle (on) {
        this.shuffle = Boolean(on)
        this._shuffleOrder = this.shuffle ? shuffleIds(this.tracks.map(t => t.id), this.currentId) : null
        this.emit()
    }

    next (auto = false) {
        if (!this.tracks.length) return
        const order = this.order()
        const i = order.indexOf(this.currentId)
        const j = i < 0 ? 0 : (i + 1) % order.length
        if (auto && this.loop === 'none' && (i < 0 || j === 0)) {
            this.stop()
            return
        }
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
            this.cancelFade()
            this.audio.volume = this.effectiveVolume()
            this.audio.currentTime = 0
            this.dispatchEvent(new CustomEvent('sleepdone', { detail: { reason: 'track' } }))
            this.emit()
            return
        }
        if (this.loop === 'one') {
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
        this.cancelFade()
        this.audio.volume = this.effectiveVolume()
        this.emit()
    }

    setMuted (m) {
        this.muted = Boolean(m)
        this.cancelFade()
        this.audio.volume = this.effectiveVolume()
        this.emit()
    }

    setLoop (mode) {
        this.loop = ['all', 'one', 'none'].includes(mode) ? mode : 'all'
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
            loop: this.loop,
            shuffle: this.shuffle,
            fade: !this._fadeDisabled,
            sleepUntil: this.sleepUntil,
            sleepAfterTrack: this.sleepAfterTrack,
            trackCount: this.tracks.length,
        }
    }
}
