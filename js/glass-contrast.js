import { sampleRegion, relativeLuminance } from './readability.js'

// 玻璃面对比度引擎（白字恒驻版）：
// 文字/图标永远白色 + 深色光晕；衬底为深色玻璃，不透明度按“面板实际覆盖的背景亮度”反推，
// 保证白字与最终混合底色的 WCAG 对比度 ≥ 4.5:1。背景越亮 → 衬底越深；视频背景逐秒平滑跟随。
// 对比度模型：最终底色 = 深色衬底(RGB SCRIM) 以 α 叠加在背景亮度 L_bg 之上。
//   L_mix = α·L_scrim + (1-α)·L_bg ≥ T ⇒ α ≥ (L_bg - T) / (L_bg - L_scrim)
// T = (白字亮度 + 0.05) / 4.5 - 0.05；L_scrim 取衬底色自身相对亮度。
// 深色背景时所需 α 可能为 0 —— 仍保留最低衬底 0.14 维持控件轮廓可辨。
//
// 性能分层（2026-10 修复，与旧的“每 250ms 对每个面做 72k 像素 pow + 全排序”不同）：
//   · 节拍分层：写 style 的收敛节拍仍是 250ms，但像素采样按源类型节流——
//     VIDEO/CANVAS 每 1s 一次；静态 IMG 只在换图、改窗口、表面集合变化时采样一次，
//     外加 4s 兜底（跟随字号/迷你条导致的几何变化）。已收敛的静态背景每个 tick 零写入。
//   · 读写分离：一轮里先把所有 getBoundingClientRect + sampleRegion 读完，再统一写 style，
//     因此每轮最多一次强制布局（旧实现是“读 rect → 写内联 style → 读下一个 rect”）。
//   · 零分配亮度统计：256 档查找表替代每像素 3 次 Math.pow；按步长抽样 + 复用直方图
//     替代「每像素 slice() 临时数组 + 数万元素 sort」。
//   · 同一矩形的多个面共享一次采样（缓存）。
//   · #atmosphere-panel 被塞进抽屉后是 background:transparent!important（css/glass-ui.css:199），
//     不消费 --scrim-a，已从选择器剔除（JS 侧；CSS 由另一代理负责）。

const SCRIM_RGB = [18, 24, 28] // #12181c 深墨色，与站点 theme_color 一族
const SCRIM_L = relativeLuminance(SCRIM_RGB)
const MIN_A = 0.14 // 无背景 / 采样失败 / 极暗背景时的轮廓底线
const MAX_A = 0.92 // 极端亮背景仍保留 ~8% 透底，不变成实心黑板
const DEAD_ZONE = 0.02 // 目标滞回：背景亮度微抖不改变目标值（防视频闪烁），但数值始终收敛到目标
const EASE = 0.5 // 收敛率：250ms 步长下 2.5s 内收敛到目标的 0.1% 以内，视觉平滑交给 CSS 过渡

const TICK_MS = 250 // 样式收敛节拍（纯写，不读几何）
const DYNAMIC_SAMPLE_MS = 1000 // 动态源（视频/three 画布）重新采样节拍
const STATIC_SAMPLE_MS = 4000 // 静态源兜底重采样（换图/改窗口/表面变化会立即触发）
const MAX_PROBES = 1536 // 单次采样的像素探测上限：超出按步长抽样
const T_LINT = (1 + 0.05) / 4.5 - 0.05 // 白字对比度恰为 4.5:1 的底色亮度上限
const SETTLE_EPS = 0.002 // 收敛残差小于此值直接落到目标，避免无限小抖动

// #atmosphere-panel 已剔除：它在抽屉里是透明背景，写了也没人读。
const SELECTOR = '#top-actions, #toolbar, #panel, #reading-heading, #reading-timer, #live-player, #mini-player, #reading-dock > *, .books-fold, #welcome button, #selection-tools, .live-slot.on, #reading-toc-popover, #reading-speed-popover'

// 256 档 sRGB→线性查找表。relativeLuminance([c,c,c]) 恰等于该通道的线性值
// （三系数 0.2126+0.7152+0.0722 === 1），因此与 readability.js 同一口径，
// 且不与它分叉：将来 readability.js 改公式时这里跟着它的导出值变。
const CHANNEL_L = (() => {
    const lut = new Float32Array(256)
    for (let c = 0; c < 256; c++) lut[c] = relativeLuminance([c, c, c])
    return lut
})()

const BINS = 256
const HISTOGRAM = new Int32Array(BINS) // 模块级复用：逐面零分配

// 75 分位亮度：面板上的亮部（水花、天空、灯光）主导可读性，比中位数保守。
// 抽样 + 直方图 → 每面最多 MAX_PROBES 次查表乘加、零临时数组、无排序。
// 返回所在档的上边界，取值偏亮（衬底更深），只会更安全不会更差。
export function brightLuminance (pixels, n) {
    HISTOGRAM.fill(0)
    const step = Math.max(1, Math.floor(n / MAX_PROBES))
    let probes = 0
    for (let i = 0; i < n; i += step) {
        const o = i * 4
        const l = 0.2126 * CHANNEL_L[pixels[o]] + 0.7152 * CHANNEL_L[pixels[o + 1]] + 0.0722 * CHANNEL_L[pixels[o + 2]]
        HISTOGRAM[Math.min(BINS - 1, (l * BINS) | 0)]++
        probes++
    }
    const want = probes * 0.75
    let acc = 0
    for (let b = 0; b < BINS; b++) {
        acc += HISTOGRAM[b]
        if (acc >= want) return Math.min(1, (b + 1) / BINS)
    }
    return 1
}

// getImage: () => 当前背景源（Image / VIDEO / CANVAS / null）
// inject: 测试注入口（{ sample, now }），生产调用不传即走真实实现
export function startGlassContrast (getImage, inject = {}) {
    const sample = inject.sample || sampleRegion
    const clock = inject.now || (() => performance.now())

    let surfaces = [] // 与 frame.targets 同序的元素数组（阶段 B 只按它写）
    let frame = null // { targets: (number|null)[], image, w, h }
    let sampledAt = -Infinity
    let idle = false

    const isDynamic = () => {
        const tag = frame && frame.image && frame.image.tagName
        return tag === 'VIDEO' || tag === 'CANVAS'
    }

    // 阶段 A：只读几何与像素，绝不写样式 → 一轮最多一次强制布局
    const measure = () => {
        const nodes = Array.from(document.querySelectorAll(SELECTOR))
        const image = getImage()
        const targets = new Array(nodes.length)
        if (!image) {
            targets.fill(MIN_A)
        } else {
            const cache = new Map() // 同一矩形只采样一次
            for (let i = 0; i < nodes.length; i++) {
                const rect = nodes[i].getBoundingClientRect()
                if (!rect.width || !rect.height) { targets[i] = null; continue }
                const key = `${rect.x.toFixed(1)}:${rect.y.toFixed(1)}:${rect.width.toFixed(1)}:${rect.height.toFixed(1)}`
                let bright = cache.get(key)
                if (bright === undefined) {
                    const region = sample(image, rect, innerWidth, innerHeight)
                    bright = region && region.n ? brightLuminance(region.pixels, region.n) : null
                    cache.set(key, bright)
                }
                if (bright === null) { targets[i] = MIN_A; continue }
                // +5% 保守余量：补偿收敛残差与实际渲染的半透明像素混合，确保最终对比度足额 4.5:1
                const need = bright > T_LINT ? ((bright - T_LINT) / (bright - SCRIM_L)) * 1.05 : 0
                targets[i] = Math.min(MAX_A, Math.max(MIN_A, need))
            }
        }
        surfaces = nodes
        frame = { targets, image, w: innerWidth, h: innerHeight }
        sampledAt = clock()
        idle = false
    }

    const staleSource = () => {
        if (!frame) return true
        const image = getImage()
        return frame.image !== image || frame.w !== innerWidth || frame.h !== innerHeight
    }

    const sameSurfaces = nodes => {
        if (nodes.length !== surfaces.length) return false
        for (let i = 0; i < nodes.length; i++) if (nodes[i] !== surfaces[i]) return false
        return true
    }

    // 阶段 B：统一写 style（本函数不读任何几何，因此不会与阶段 A 交错成 forced layout）
    const write = () => {
        let settled = true
        const targets = frame.targets
        for (let i = 0; i < surfaces.length; i++) {
            const target = targets[i]
            if (target === null || target === undefined) continue
            const el = surfaces[i]
            let alpha = target
            // 目标滞回：目标本身微抖（<DEAD_ZONE）时沿用旧目标；数值用固定收敛率逼近目标（不再中途冻结）
            const prevTarget = Number(el.dataset.scrimTarget)
            if (Number.isFinite(prevTarget) && Math.abs(alpha - prevTarget) < DEAD_ZONE) alpha = prevTarget
            el.dataset.scrimTarget = alpha.toFixed(3)
            const prev = Number(el.dataset.scrimA)
            if (Number.isFinite(prev)) alpha = prev + (alpha - prev) * EASE
            if (Math.abs(alpha - target) < SETTLE_EPS) alpha = target
            el.dataset.scrimA = alpha.toFixed(3)
            el.style.setProperty('--scrim-a', alpha.toFixed(3))
            if (alpha !== target) settled = false
        }
        idle = settled && !isDynamic()
    }

    const tick = () => {
        if (document.hidden) return
        const nodes = Array.from(document.querySelectorAll(SELECTOR))
        if (staleSource() || !sameSurfaces(nodes)) measure()
        else if (clock() - sampledAt >= (isDynamic() ? DYNAMIC_SAMPLE_MS : STATIC_SAMPLE_MS)) measure()
        else if (idle) return
        write()
    }

    tick()
    const timer = setInterval(tick, TICK_MS)
    const abort = new AbortController()
    const opts = { signal: abort.signal }
    let resizeT = 0
    const resample = () => {
        clearTimeout(resizeT)
        resizeT = setTimeout(() => { measure(); write() }, 160)
    }
    // 从后台切回时立即重采样一次，避免用旧亮度过渡
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) return
        measure()
        write()
    }, opts)
    window.addEventListener('resize', resample, opts)
    window.addEventListener('orientationchange', resample, opts)
    // 隐藏时没有采样矩形，展开后立即计算自己的衬底；不等静态背景的 4s 兜底节拍。
    document.addEventListener('toggle', event => {
        if (event.newState !== 'open' || !event.target.matches?.('#reading-toc-popover, #reading-speed-popover')) return
        measure()
        write()
    }, { capture: true, signal: abort.signal })
    window.addEventListener('pagehide', () => {
        clearInterval(timer)
        clearTimeout(resizeT)
        abort.abort()
    }, { once: true, signal: abort.signal })
}
