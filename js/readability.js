// 可读性引擎：
// 1. 把背景按 CSS cover 裁剪映射，采样“正文列实际覆盖区域”的像素（不是全图平均）。
// 2. 用 WCAG 相对亮度计算对比度，为深字/浅字两种方案分别求所需遮罩不透明度，
//    选成本小的方案（或用户强制），保证正文与最终混合底色对比度 ≥ 4.5:1。
// 3. 采样失败时给出保证可读的兜底（高不透明度遮罩）。
// 4. 提供交叉渐变期间不闪字的 alpha 策略（见 background.js 的 SceneController）。

export const TEXT_THEMES = {
    'dark-text': { color: '#2b2620', maskColor: '#f7f3ea' }, // 深字 + 暖纸遮罩
    'light-text': { color: '#f2ede3', maskColor: '#1a1712' }, // 浅字 + 墨色遮罩
}

const MIN_CONTRAST = 4.5

// ---------- 颜色工具 ----------
function srgbToLinear (c) {
    c /= 255
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

export function relativeLuminance ([r, g, b]) {
    return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b)
}

function hexToRgb (hex) {
    const n = parseInt(hex.slice(1), 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

// sRGB gamma 空间的普通 alpha 混合（与浏览器合成一致）
function mixRgb (a, b, t) {
    return [
        a[0] * (1 - t) + b[0] * t,
        a[1] * (1 - t) + b[1] * t,
        a[2] * (1 - t) + b[2] * t,
    ]
}

export function contrastRatio (rgb1, rgb2) {
    const l1 = relativeLuminance(rgb1)
    const l2 = relativeLuminance(rgb2)
    const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1]
    return (hi + 0.05) / (lo + 0.05)
}

// ---------- cover 裁剪映射 ----------
// 返回：视口矩形 rect 在图像坐标系中的源区域 {sx, sy, sw, sh}
export function coverSourceRect (img, vw, vh, rect) {
    const iw = img.videoWidth || img.naturalWidth || img.width
    const ih = img.videoHeight || img.naturalHeight || img.height
    if (!iw || !ih || !vw || !vh) return null
    const scale = Math.max(vw / iw, vh / ih)
    const dispW = iw * scale
    const dispH = ih * scale
    const offX = (dispW - vw) / 2 // background-position: center
    const offY = (dispH - vh) / 2
    const sx = (rect.x + offX) / scale
    const sy = (rect.y + offY) / scale
    const sw = rect.width / scale
    const sh = rect.height / scale
    // 与图像边界求交
    const x = Math.max(0, Math.min(sx, iw - 1))
    const y = Math.max(0, Math.min(sy, ih - 1))
    const w = Math.max(1, Math.min(sw, iw - x))
    const h = Math.max(1, Math.min(sh, ih - y))
    return { sx: x, sy: y, sw: w, sh: h }
}

// ---------- 采样 ----------
const SAMPLE_SIZE = 120

let sampleCanvas = null
function getSampleCanvas () {
    if (!sampleCanvas) sampleCanvas = document.createElement('canvas')
    return sampleCanvas
}

// 返回 { pixels: Uint8ClampedArray, n } 或 null（不可采样）
export function sampleRegion (image, rect, vw, vh) {
    const src = coverSourceRect(image, vw, vh, rect)
    if (!src) return null
    const canvas = getSampleCanvas()
    const aspect = src.sh / src.sw
    const cw = aspect >= 1 ? SAMPLE_SIZE : Math.round(SAMPLE_SIZE / Math.max(aspect, 0.2))
    const ch = aspect >= 1 ? Math.round(SAMPLE_SIZE * Math.min(aspect, 5)) : SAMPLE_SIZE
    canvas.width = cw
    canvas.height = ch
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return null
    try {
        ctx.drawImage(image, src.sx, src.sy, src.sw, src.sh, 0, 0, cw, ch)
        const data = ctx.getImageData(0, 0, cw, ch).data
        if (!data.length) return null
        return { pixels: data, n: cw * ch }
    } catch {
        // 画布被污染等异常 → 不可采样
        return null
    }
}

// 按亮度取分位平均色：mode 'bright' 取最亮 12%，'dark' 取最暗 12%
function patchColor (pixels, n, mode) {
    const idx = []
    for (let i = 0; i < n; i++) {
        const r = pixels[i * 4], g = pixels[i * 4 + 1], b = pixels[i * 4 + 2]
        idx.push([0.2126 * r + 0.7152 * g + 0.0722 * b, i])
    }
    idx.sort((a, b) => a[0] - b[0])
    const count = Math.max(1, Math.floor(n * 0.12))
    const range = mode === 'bright'
        ? idx.slice(Math.max(0, n - count))
        : idx.slice(0, count)
    let r = 0, g = 0, b = 0
    for (const [, i] of range) {
        r += pixels[i * 4]; g += pixels[i * 4 + 1]; b += pixels[i * 4 + 2]
    }
    return [r / range.length, g / range.length, b / range.length]
}

// Component-wise darkest/lightest possible backgrounds bound every sRGB pixel.
// Sampling chooses the text theme; this lower bound also covers tiny details, transparent
// images and every frame of a crossfade which thumbnail sampling cannot prove safe.
function requiredAlpha(worstPatch, maskRgb, textRgb, darkText) {
    const textL = relativeLuminance(textRgb)
    for (let i = 0; i <= 1000; i++) {
        const alpha = i / 1000, mixed = mixRgb(worstPatch, maskRgb, alpha)
        const correctSide = darkText ? relativeLuminance(mixed) > textL : relativeLuminance(mixed) < textL
        if (correctSide && contrastRatio(textRgb, mixed) >= MIN_CONTRAST + 0.25) return alpha
    }
    return 1
}
export function safeAlpha(theme) {
    const def = TEXT_THEMES[theme], dark = theme === 'dark-text'
    return requiredAlpha(dark ? [0, 0, 0] : [255, 255, 255], hexToRgb(def.maskColor), hexToRgb(def.color), dark)
}
function applyBias(alpha, bias, theme) {
    const floor = safeAlpha(theme)
    // The negative end removes comfort padding, never the readability floor.
    return Math.min(0.96, Math.max(floor, alpha) + (Math.max(-1, Math.min(1, bias || 0)) + 1) * 0.06)
}

// ---------- 主入口 ----------
// image: 已解码的 Image/HTMLImageElement/ImageBitmap
// rect: 正文列在视口中的矩形 {x,y,width,height}（视口坐标，可超出会被裁剪）
// vw, vh: 视口尺寸；forcedTheme: null | 'dark-text' | 'light-text'；maskBias: -1..1
export function computeReadability ({ image, rect, vw, vh, forcedTheme = null, maskBias = 0 }) {
    const sampled = sampleRegion(image, rect, vw, vh)
    if (!sampled) return guaranteedReadability(forcedTheme)

    const { pixels, n } = sampled
    const darkText = TEXT_THEMES['dark-text']
    const lightText = TEXT_THEMES['light-text']
    const brightPatch = patchColor(pixels, n, 'bright')
    const darkPatch = patchColor(pixels, n, 'dark')

    // 深字方案：最危险的是最暗区域（文字会沉进暗色里），用暖纸遮罩把暗区抬亮
    const alphaForDark = requiredAlpha(darkPatch, hexToRgb(darkText.maskColor), hexToRgb(darkText.color), true)
    // 浅字方案：最危险的是最亮区域（文字会消失在亮色里），用墨色遮罩把亮区压暗
    const alphaForLight = requiredAlpha(brightPatch, hexToRgb(lightText.maskColor), hexToRgb(lightText.color), false)

    let theme
    if (forcedTheme) theme = forcedTheme
    else theme = alphaForDark <= alphaForLight ? 'dark-text' : 'light-text'

    const rawAlpha = theme === 'dark-text' ? alphaForDark : alphaForLight
    const alpha = applyBias(rawAlpha, maskBias, theme)
    const otherAlpha = theme === 'dark-text' ? alphaForLight : alphaForDark

    // 渐变策略需要的两组 alpha（同一图像分别按两种主题配好）
    const alphaDarkFinal = applyBias(alphaForDark, maskBias, 'dark-text')
    const alphaLightFinal = applyBias(alphaForLight, maskBias, 'light-text')

    return {
        sampled: true,
        theme,
        maskColor: TEXT_THEMES[theme].maskColor,
        textColor: TEXT_THEMES[theme].color,
        maskAlpha: alpha,
        // 与主题无关的完整信息，供渐变协调使用
        plan: {
            'dark-text': { maskColor: darkText.maskColor, maskAlpha: alphaDarkFinal },
            'light-text': { maskColor: lightText.maskColor, maskAlpha: alphaLightFinal },
        },
        otherAlpha,
    }
}

// 无法可靠采样时：几乎不透明的纸色遮罩 + 深字，保证可读
export function guaranteedReadability (forcedTheme = null) {
    const theme = forcedTheme || 'dark-text'
    return {
        sampled: false,
        theme,
        maskColor: TEXT_THEMES[theme].maskColor,
        textColor: TEXT_THEMES[theme].color,
        maskAlpha: 0.96,
        plan: {
            'dark-text': { maskColor: TEXT_THEMES['dark-text'].maskColor, maskAlpha: 0.96 },
            'light-text': { maskColor: TEXT_THEMES['light-text'].maskColor, maskAlpha: 0.96 },
        },
        otherAlpha: 0.96,
    }
}

// 校验一个最终状态是否达标（用于自检与验证记录）
export function verifyContrast (readability, worstPatchRgb) {
    const maskRgb = hexToRgb(readability.maskColor)
    const textRgb = hexToRgb(readability.textColor)
    const blended = mixRgb(worstPatchRgb, maskRgb, readability.maskAlpha)
    return contrastRatio(textRgb, blended)
}
