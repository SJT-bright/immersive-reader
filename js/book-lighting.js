// Analytic 2.5D lighting: an extruded paper cross-section, not a full 3D room renderer.
// World units are millimetres; x points right, y down, z toward the reader.
export const BOOK_LIGHTING = Object.freeze({
    halfWidth: 140, pageCamber: 12, gutterDepth: 3.8, gutterRadius: 6,
    paper: [250, 246, 234], light: [-0.85, -0.75, 1.10],
    key: 0.70, ambient: 0.42, warmth: [1, 0.985, 0.95],
    sourceRadius: 0.30, occlusion: 0.38,
    edgeProjection: 0.15, clearance: 5.5, contactOpacity: 0.28, castOpacity: 0.28,
})
// Art-directed to the visible built-in light positions; no claim of HDRI measurement.
export const BOOK_LIGHT_SCENES = Object.freeze({
    'builtin:fp-valley': { light: [-0.85, -0.75, 1.10] },
    'builtin:fp-desk': { light: [-0.8, -1.0, 1.25], sourceRadius: 0.20, warmth: [1, 0.96, 0.88] },
    'builtin:fp-cafe': { light: [-1.0, -0.5, 1.35], sourceRadius: 0.38 },
    'builtin:fp-cliff': { light: [0.55, -0.45, 1.35], sourceRadius: 0.32 },
})
const clamp = (x, min, max) => Math.min(max, Math.max(min, x))
const normalize = a => { const l = Math.hypot(...a); return a.map(x => x / l) }
const dot = (a, b) => a.reduce((v, x, i) => v + x * b[i], 0)
const linear = x => x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4
const srgb = x => x <= .0031308 ? x * 12.92 : 1.055 * x ** (1 / 2.4) - .055
const rgb = a => `rgb(${a.map(v => Math.round(v)).join(' ')})`

export function paperHeight (x, p = BOOK_LIGHTING) {
    // Two softly bowed leaves sink into one narrow binding. Smooth at the spine.
    const u = Math.min(1, Math.abs(x) / p.halfWidth)
    const camber = p.pageCamber * Math.sin(Math.PI * u) ** 2
    return camber - p.gutterDepth * Math.exp(-((x / p.gutterRadius) ** 2))
}
function normalAt (x, p) {
    const epsilon = .04
    const slope = (paperHeight(x + epsilon, p) - paperHeight(x - epsilon, p)) / (2 * epsilon)
    return normalize([-slope, 0, 1])
}
function visibleLight (x, l, p) {
    // Ray test on the cross-section: a raised leaf can occlude its own binding.
    const z = paperHeight(x, p) + .015
    for (let t = .25; t < 32; t += .5) {
        const sx = x + l[0] * t
        if (Math.abs(sx) > p.halfWidth) break
        if (paperHeight(sx, p) > z + l[2] * t) return 0
    }
    return 1
}
function lightSamples (p) {
    // 9 deterministic positions across a finite emitter, no frame-to-frame noise.
    return [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1],
        [-.7, -.7], [-.7, .7], [.7, -.7], [.7, .7]]
        .map(([x, y]) => normalize([p.light[0] + x * p.sourceRadius,
            p.light[1] + y * p.sourceRadius, p.light[2]]))
}
export function samplePaper (x, options = {}) {
    return makeSampler({ ...BOOK_LIGHTING, ...options })(x)
}

// 一次构建、多点复用：9 光源归一化与射线求交只跟参数有关，与画布宽度无关。
// 旧写法每个采样点都 {...BOOK_LIGHTING,...options} + lightSamples(p)（9 次 normalize）
// + p.paper.map(...)，171 个采样点 × 最多 63 步求交 ≈ 10 万次高度场求值全在 resize 回调里。
function makeSampler (p) {
    const samples = lightSamples(p)
    const linearPaper = p.paper.map(c => linear(c / 255))
    return x => {
        const n = normalAt(x, p)
        let direct = 0
        for (const l of samples) {
            const cos = dot(n, l)
            if (cos <= 0) continue // 背面不受光：省掉一次射线求交
            direct += cos * visibleLight(x, l, p)
        }
        direct /= samples.length
        // Narrow binding admits less ambient sky. AO modulates ambient only, not ink.
        const aperture = 1 - p.occlusion * Math.exp(-((x / (p.gutterRadius * .60)) ** 2))
        const out = new Array(3)
        for (let i = 0; i < 3; i++) {
            out[i] = 255 * srgb(clamp(linearPaper[i] * (p.ambient * aperture + p.key * direct * p.warmth[i]), 0, 1))
        }
        return out
    }
}

// 与宽度无关的那半部分（171 段百分比 stop 的渐变串、边缘光、两个 opacity）按参数签名缓存。
// 渐变里的百分比 stop 与宽度无关，只有 --book-cast-x/y/blur 的 px 偏移需要跟着 scale 走，
// 所以 resize 只需要重算这三个值。上限 PREPARE_LIMIT，超出按插入顺序淘汰最旧的。
const PREPARED = new Map()
const PREPARE_LIMIT = 8

export function prepareBookLighting (options = {}) {
    const p = { ...BOOK_LIGHTING, ...options }
    if (!(p.light[2] > 0)) throw new RangeError('Positive width and front-facing light required')
    const key = JSON.stringify(p)
    const hit = PREPARED.get(key)
    if (hit) return hit
    const sample = makeSampler(p)
    // Dense samples at the binding, fewer on almost-flat leaves; responsive CSS strip.
    const positions = new Set(Array.from({ length: 81 }, (_, i) => -p.halfWidth + i * p.halfWidth / 40))
    for (let x = -12; x <= 12; x += .25) positions.add(x)
    const stops = [...positions].sort((a, b) => a - b).map(x =>
        `${rgb(sample(x))} ${((x / p.halfWidth + 1) * 50).toFixed(3)}%`)
        .join(', ')
    const gradient = `linear-gradient(90deg, ${stops})`
    const edge = p.paper.map(c => 255 * srgb(linear(c / 255) * p.ambient * .88))
    const prepared = {
        halfWidth: p.halfWidth,
        gradient,
        // 世界单位（毫米）偏移，用时乘 scale 得 px；blur 的下限 2px 依赖 scale，所以留单位值。
        // 乘序保持与旧实现一致（sourceRadius*clearance*scale*2.5），避免末位 ULP 漂移。
        shadowUnit: {
            x: -p.light[0] / p.light[2] * p.clearance,
            y: -p.light[1] / p.light[2] * p.clearance,
            blur: p.sourceRadius * p.clearance,
        },
        vars: {
            '--book-paper-light': gradient,
            '--book-edge-light': `linear-gradient(180deg, ${rgb(sample(p.halfWidth))}, ${rgb(edge)})`,
            // Calibrated default opacity; more fill reduces shadow contrast, key=0 removes cast.
            '--book-cast-opacity': p.castOpacity * (p.key / Math.max(.001, p.key + p.ambient)) /
                (BOOK_LIGHTING.key / (BOOK_LIGHTING.key + BOOK_LIGHTING.ambient)),
            '--book-contact-opacity': p.contactOpacity,
        },
    }
    if (PREPARED.size >= PREPARE_LIMIT) PREPARED.delete(PREPARED.keys().next().value)
    PREPARED.set(key, prepared)
    return prepared
}

// 把与宽度无关的部分缓存起来，再按当前宽度算三个 px 值。签名与旧版一致（gradient/shadow/vars）。
export function buildBookLighting (width, options = {}) {
    if (!Number.isFinite(width) || width <= 0) throw new RangeError('Positive width and front-facing light required')
    const prepared = prepareBookLighting(options)
    const scale = width / (prepared.halfWidth * 2)
    const shadow = castShadow(prepared, scale)
    return {
        gradient: prepared.gradient, shadow,
        vars: {
            ...prepared.vars,
            '--book-cast-x': `${shadow.x.toFixed(2)}px`,
            '--book-cast-y': `${shadow.y.toFixed(2)}px`,
            '--book-cast-blur': `${shadow.blur.toFixed(2)}px`,
        },
    }
}

// 三个与宽度有关的 px 值：乘序与旧实现逐位一致
function castShadow (prepared, scale) {
    return {
        x: prepared.shadowUnit.x * scale,
        y: prepared.shadowUnit.y * scale,
        blur: Math.max(2, prepared.shadowUnit.blur * scale * 2.5),
    }
}

export function createBookLighting (host) {
    let scene = null, frame = 0, paintedScene = null, paintedWidth = 0
    const render = () => {
        frame = 0
        if (!scene || host.clientWidth < 1) return
        const width = host.clientWidth
        if (scene === paintedScene && width === paintedWidth) return
        let prepared
        try { prepared = prepareBookLighting(BOOK_LIGHT_SCENES[scene]) } catch { return }
        // ResizeObserver 每次 tick：scene 没变就只重写三个 px 值，
        // 171-stop 渐变字符串保持不动（不重新生成、也不让浏览器重新光栅化一条新串）。
        if (scene !== paintedScene) {
            for (const [key, value] of Object.entries(prepared.vars)) host.style.setProperty(key, value)
            paintedScene = scene
        }
        const scale = width / (prepared.halfWidth * 2)
        const shadow = castShadow(prepared, scale)
        host.style.setProperty('--book-cast-x', `${shadow.x.toFixed(2)}px`)
        host.style.setProperty('--book-cast-y', `${shadow.y.toFixed(2)}px`)
        host.style.setProperty('--book-cast-blur', `${shadow.blur.toFixed(2)}px`)
        paintedWidth = width
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(render) }
    const observer = new ResizeObserver(schedule)
    observer.observe(host)
    return {
        setScene (ref) { scene = ref; schedule() },
        destroy () { observer.disconnect(); cancelAnimationFrame(frame) },
    }
}
