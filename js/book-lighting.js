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
    const p = { ...BOOK_LIGHTING, ...options }
    const n = normalAt(x, p)
    const direct = lightSamples(p).reduce((v, l) =>
        v + Math.max(0, dot(n, l)) * visibleLight(x, l, p), 0) / 9
    // Narrow binding admits less ambient sky. AO modulates ambient only, not ink.
    const aperture = 1 - p.occlusion * Math.exp(-((x / (p.gutterRadius * .60)) ** 2))
    return p.paper.map((c, i) => 255 * srgb(clamp(linear(c / 255) *
        (p.ambient * aperture + p.key * direct * p.warmth[i]), 0, 1)))
}
export function buildBookLighting (width, options = {}) {
    const p = { ...BOOK_LIGHTING, ...options }
    if (!Number.isFinite(width) || width <= 0 || p.light[2] <= 0) throw new RangeError('Positive width and front-facing light required')
    // Dense samples at the binding, fewer on almost-flat leaves; responsive CSS strip.
    const positions = new Set(Array.from({ length: 81 }, (_, i) => -p.halfWidth + i * p.halfWidth / 40))
    for (let x = -12; x <= 12; x += .25) positions.add(x)
    const stops = [...positions].sort((a, b) => a - b).map(x =>
        `${rgb(samplePaper(x, p))} ${((x / p.halfWidth + 1) * 50).toFixed(3)}%`)
    const scale = width / (p.halfWidth * 2)
    const shadow = {
        x: -p.light[0] / p.light[2] * p.clearance * scale,
        y: -p.light[1] / p.light[2] * p.clearance * scale,
        blur: Math.max(2, p.sourceRadius * p.clearance * scale * 2.5),
    }
    // Project the same height field into a subtle upper/lower paper silhouette.
    // It stays inside the existing padding; no text reflow or curved DOM glyphs.
    const rim = Math.min(10, Math.max(3, scale * 2.2))
    const contour = Array.from({ length: 81 }, (_, i) => {
        const x = -p.halfWidth + i * p.halfWidth / 40
        return { x: `${(i * 100 / 80).toFixed(2)}%`, rise: paperHeight(x, p) * scale * p.edgeProjection }
    })
    const top = contour.map(c => `${c.x} ${(rim - c.rise).toFixed(2)}px`)
    const bottom = [...contour].reverse().map(c => `${c.x} calc(100% - ${(rim + c.rise).toFixed(2)}px)`)
    const edgeTop = contour.map(c => `${c.x} calc(100% - ${(10 + rim + c.rise).toFixed(2)}px)`)
    const edgeBottom = [...contour].reverse().map(c => `${c.x} calc(100% - ${(rim + c.rise).toFixed(2)}px)`)
    const edge = p.paper.map(c => 255 * srgb(linear(c / 255) * p.ambient * .88))
    return {
        gradient: `linear-gradient(90deg, ${stops.join(', ')})`, shadow,
        vars: {
            '--book-paper-outline': `polygon(${[...top, ...bottom].join(', ')})`,
            '--book-edge-outline': `polygon(${[...edgeTop, ...edgeBottom].join(', ')})`,
            '--book-paper-light': `linear-gradient(90deg, ${stops.join(', ')})`,
            '--book-edge-light': `linear-gradient(180deg, ${rgb(samplePaper(p.halfWidth, p))}, ${rgb(edge)})`,
            '--book-cast-x': `${shadow.x.toFixed(2)}px`, '--book-cast-y': `${shadow.y.toFixed(2)}px`,
            '--book-cast-blur': `${shadow.blur.toFixed(2)}px`,
            // Calibrated default opacity; more fill reduces shadow contrast, key=0 removes cast.
            '--book-cast-opacity': p.castOpacity * (p.key / Math.max(.001, p.key + p.ambient)) /
                (BOOK_LIGHTING.key / (BOOK_LIGHTING.key + BOOK_LIGHTING.ambient)),
            '--book-contact-opacity': p.contactOpacity,
        },
    }
}
export function createBookLighting (host) {
    let scene = null, frame = 0, previous = ''
    const render = () => {
        frame = 0
        if (!scene || host.clientWidth < 1) return
        const width = host.clientWidth
        const signature = `${scene}:${width}`
        if (signature === previous) return
        const { vars } = buildBookLighting(width, BOOK_LIGHT_SCENES[scene])
        for (const [key, value] of Object.entries(vars)) host.style.setProperty(key, value)
        previous = signature
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(render) }
    const observer = new ResizeObserver(schedule)
    observer.observe(host)
    return {
        setScene (ref) { scene = ref; schedule() },
        destroy () { observer.disconnect(); cancelAnimationFrame(frame) },
    }
}
