import { parseQQLink } from './qq-music.js?v=1.5.0'
import { emptyLog, normalizeReadingLog } from './reading-log.js?v=1.0.0'
// 设置：保存在 localStorage（小体量键值）；书籍/背景等大二进制在 IndexedDB。
const KEY = 'immersive-reader-settings-v1'

export const DEFAULT_SETTINGS = {
    layout: {
        fontSize: 21, // px
        lineHeight: 1.9,
        maxWidth: 640, // px，正文列宽
        fontFamily: 'song', // song | hei | kai
    },
    autoRead: { flow: 'paginated', mode: 'scroll', pixelsPerSecond: 20, pageSeconds: 20, endDwellSeconds: 8 },
    background: {
        mode: 'fixed', // fixed | slot | rotate
        fixedId: 'builtin:fluid',
        animate: true, // mode=fixed 时使用的背景
        slotMap: {
            // 早晨 5:00-10:00 / 白天 10:00-17:00 / 傍晚 17:00-20:00 / 夜间 20:00-5:00
            morning: 'builtin:garden-dawn',
            day: 'builtin:grassland-day',
            evening: 'builtin:forest-dusk',
            night: 'builtin:lake-night',
        },
        rotateMinutes: 15, // mode=rotate 时轮换间隔
    },
    atmosphere: { enabled: true, weather: 'rain', rain: 0.35, snow: 0.62, snowDepth: 0.65, fog: 0.28, refraction: 1.33, motion: true, wind: 0.25, lightning: false, sceneFx: true, dropSize: 1, fallSpeed: 1, trail: 1, flowSpeed: 1, brightness: 1, warmth: 0, parallax: 1, paperOpacity: 1, lightningEvery: 0.35 },
    ambience: { enabled: false, kind: 'rain', volume: 0.5, thunder: true },
    readability: {
        theme: 'auto', // auto | dark-text | light-text（用户强制）
        maskBias: 0, // -1 更透 .. +1 更厚
    },
    music: {
        qqLink: null,
        netease: null, // { type: 2|0|1, id: '数字' } 严格解析后才写入
        volume: 0.8,
        muted: false,
        playMode: 'repeatAll', // repeatAll | repeatOne | sequential | shuffle（QQ 音乐四态）
        fadeMs: 1000, // 歌曲淡入淡出：0/500/1000/2000，0 = 关闭
        tab: 'local', // 'local' | 'netease' 音乐面板当前分页
        lastTrackId: null, // 上次播放的曲目（刷新后恢复但不自动播放）
        order: [], // 曲目 id 顺序（拖拽排序后写入）
    },
    misc: {
        keepToolbarWhenIdle: false,
        shelfView: 'shelf', // shelf（3D 书架） | list（紧凑列表）
        pageBreathe: true, // 翻页呼吸过渡（专注预设关闭）
        scrollFade: true, // 滚动模式上下渐隐（专注预设关闭）
        showReadingTimer: true, // 左上角阅读计时是否显示
        readingPreset: 'light', // light（新用户轻氛围）| focus | full | custom
    },
    readingLog: emptyLog(),
}

const object = x => x && typeof x === 'object' && !Array.isArray(x) ? x : {}
const number = (x, lo, hi, fallback) => typeof x === 'number' && Number.isFinite(x) ? Math.max(lo, Math.min(hi, x)) : fallback
const choice = (x, options, fallback) => options.includes(x) ? x : fallback
const ref = (x, fallback) => typeof x === 'string' && /^[a-zA-Z0-9:_-]{1,120}$/.test(x) ? x : fallback

// Restore only known fields; malformed imports cannot replace nested settings with null or arbitrary objects.
export function normalizeSettings(raw) {
    const src = object(raw), out = structuredClone(DEFAULT_SETTINGS)
    const l = object(src.layout), b = object(src.background), r = object(src.readability), m = object(src.music)
    out.layout = {
        fontSize: number(l.fontSize, 15, 34, out.layout.fontSize),
        lineHeight: number(l.lineHeight, 1.5, 2.8, out.layout.lineHeight),
        maxWidth: number(l.maxWidth, 420, 860, out.layout.maxWidth),
        fontFamily: choice(l.fontFamily, ['song', 'hei', 'kai'], 'song'),
    }
    out.background.mode = choice(b.mode, ['fixed', 'slot', 'rotate'], out.background.mode)
    out.background.fixedId = ref(b.fixedId, out.background.fixedId)
    out.background.animate = b.animate !== false
    out.background.rotateMinutes = number(b.rotateMinutes, 1, 60, 15)
    for (const slot of Object.keys(out.background.slotMap)) {
        out.background.slotMap[slot] = ref(object(b.slotMap)[slot], out.background.slotMap[slot])
    }
    const a = object(src.atmosphere)
    out.atmosphere = {
        enabled: a.enabled !== false,
        weather: choice(a.weather, ['rain', 'snow', 'clear'], 'rain'),
        rain: number(a.rain, 0, 1, 0.58),
        snow: number(a.snow, 0, 1, 0.62),
        snowDepth: number(a.snowDepth, 0, 1, 0.65),
        fog: number(a.fog, 0, 1, 0.32),
        refraction: number(a.refraction, 1, 1.6, 1.33),
        motion: a.motion !== false,
        wind: number(a.wind, 0, 1, 0.25),
        lightning: a.lightning === true,
        sceneFx: a.sceneFx !== false,
        dropSize: number(a.dropSize, 0.6, 1.6, 1),
        fallSpeed: number(a.fallSpeed, 0.5, 2, 1),
        trail: number(a.trail, 0, 1.6, 1),
        flowSpeed: number(a.flowSpeed, 0.5, 2, 1),
        brightness: number(a.brightness, 0.75, 1.3, 1),
        warmth: number(a.warmth, -1, 1, 0),
        parallax: number(a.parallax, 0, 2, 1),
        paperOpacity: number(a.paperOpacity, 0.55, 1, 1),
        lightningEvery: number(a.lightningEvery, 0, 1, 0.35),
    }
    const am = object(src.ambience)
    out.ambience = {
        enabled: am.enabled === true,
        kind: choice(am.kind, ['rain', 'snow', 'waves', 'stream', 'fire', 'crickets', 'wind', 'white', 'pink', 'brown'], 'rain'),
        volume: number(am.volume, 0, 1, 0.5),
        thunder: am.thunder !== false,
    }
    out.readability.theme = choice(r.theme, ['auto', 'dark-text', 'light-text'], 'auto')
    out.readability.maskBias = number(r.maskBias, -1, 1, 0)
    out.music.volume = number(m.volume, 0, 1, 0.8)
    out.music.muted = m.muted === true
    // 播放模式四态（QQ 音乐对齐）；旧版 loop+shuffle 组合迁移为等价模式
    let playMode = choice(m.playMode, ['repeatAll', 'repeatOne', 'sequential', 'shuffle'], null)
    if (!playMode) {
        if (m.shuffle === true) playMode = 'shuffle'
        else if (m.loop === 'one') playMode = 'repeatOne'
        else if (m.loop === 'none') playMode = 'sequential'
        else playMode = 'repeatAll'
    }
    out.music.playMode = playMode
    // 歌曲淡入淡出档位（QQ 音乐「歌曲淡入淡出」）；旧版布尔 fade 迁移
    out.music.fadeMs = [0, 500, 1000, 2000].includes(Number(m.fadeMs)) ? Number(m.fadeMs)
        : (m.fade === false ? 0 : 1000)
    out.music.tab = choice(m.tab, ['local', 'netease', 'qq'], 'local')
    const qq = parseQQLink(m.qqLink)
    out.music.qqLink = qq.ok ? qq.url : null
    const ar = object(src.autoRead)
    out.autoRead = {flow:choice(ar.flow,['paginated','scrolled'],'paginated'), mode:choice(ar.mode, ['scroll','page'], 'scroll'), pixelsPerSecond:number(ar.pixelsPerSecond,5,80,20), pageSeconds:number(ar.pageSeconds,5,120,20), endDwellSeconds:number(ar.endDwellSeconds,3,15,8)}
    out.music.lastTrackId = ref(m.lastTrackId, null)
    out.music.order = Array.isArray(m.order)
        ? [...new Set(m.order.filter(id => ref(id, null)))].slice(0, 500)
        : []
    const n = object(m.netease), kinds = { 0: 'playlist', 2: 'song', 1: 'album' }
    // Migrate the incorrect album type written by the initial version.
    const type = n.type === 8 ? 1 : n.type
    if ([0, 1, 2].includes(type) && /^\d{1,20}$/.test(String(n.id))) {
        out.music.netease = { type, id: String(n.id), kind: kinds[type] }
    }
    out.misc.hideReadingTools = object(src.misc).hideReadingTools === true
    out.misc.keepToolbarWhenIdle = object(src.misc).keepToolbarWhenIdle === true
    out.misc.shelfView = object(src.misc).shelfView === 'list' ? 'list' : 'shelf'
    const misc = object(src.misc)
    out.misc.pageBreathe = misc.pageBreathe !== false
    out.misc.scrollFade = misc.scrollFade !== false
    out.misc.showReadingTimer = misc.showReadingTimer !== false
    out.misc.readingPreset = ['light','focus','full','custom'].includes(misc.readingPreset) ? misc.readingPreset : 'light'
    out.readingLog = normalizeReadingLog(src.readingLog)
    return out
}

export function loadSettings() {
    try {
        const raw = JSON.parse(localStorage.getItem(KEY))
        const settings = normalizeSettings(raw)
        if (raw && Object.hasOwn(raw, 'readaloud')) {
            try { saveSettings(settings) } catch { /* 清理旧字段失败不影响读取设置 */ }
        }
        return settings
    }
    catch { return normalizeSettings(null) }
}
export function saveSettings(settings) {
    localStorage.setItem(KEY, JSON.stringify(normalizeSettings(settings)))
}
