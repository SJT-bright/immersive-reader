import { sampleRegion, relativeLuminance } from './readability.js?v=1.4.0'

// 玻璃面对比度引擎（白字恒驻版）：
// 文字/图标永远白色 + 深色光晕；衬底为深色玻璃，不透明度按“面板实际覆盖的背景亮度”反推，
// 保证白字与最终混合底色的 WCAG 对比度 ≥ 4.5:1。背景越亮 → 衬底越深；视频背景逐秒平滑跟随。
// 对比度模型：最终底色 = 深色衬底(RGB SCRIM) 以 α 叠加在背景亮度 L_bg 之上。
//   L_mix = α·L_scrim + (1-α)·L_bg ≥ T ⇒ α ≥ (L_bg - T) / (L_bg - L_scrim)
// T = (白字亮度 + 0.05) / 4.5 - 0.05；L_scrim 取衬底色自身相对亮度。
// 深色背景时所需 α 可能为 0 —— 仍保留最低衬底 0.14 维持控件轮廓可辨。

const SCRIM_RGB = [18, 24, 28] // #12181c 深墨色，与站点 theme_color 一族
const SCRIM_L = relativeLuminance(SCRIM_RGB)
const MIN_A = 0.14 // 无背景 / 采样失败 / 极暗背景时的轮廓底线
const MAX_A = 0.92 // 极端亮背景仍保留 ~8% 透底，不变成实心黑板
const DEAD_ZONE = 0.02 // 目标滞回：背景亮度微抖不改变目标值（防视频闪烁），但数值始终收敛到目标
const EASE = 0.5 // 收敛率：250ms 步长下 2.5s 内收敛到目标的 0.1% 以内，视觉平滑交给 CSS 过渡

export function startGlassContrast (getImage) {
    const selector = '#top-actions, #toolbar, #panel, #atmosphere-panel, #reading-heading, #reading-timer, #live-player, #mini-player, #reading-dock > *, .books-fold, #welcome button, #selection-tools, .live-slot.on'
    const update = () => {
        if (document.hidden) return
        const image = getImage()
        for (const el of document.querySelectorAll(selector)) {
            let alpha
            if (!image) {
                alpha = MIN_A
            } else {
                const rect = el.getBoundingClientRect()
                if (!rect.width || !rect.height) continue
                const sample = sampleRegion(image, rect, innerWidth, innerHeight)
                if (!sample) { alpha = MIN_A } else {
                    const values = []
                    for (let i = 0; i < sample.n; i++) values.push(relativeLuminance(sample.pixels.slice(i * 4, i * 4 + 3)))
                    values.sort((a, b) => a - b)
                    // 75 分位：面板上的亮部（水花、天空、灯光）主导可读性，比中位数保守
                    const brightL = values[Math.floor(values.length * 0.75)]
                    // T：白字(相对亮度≈1)对比度恰为 4.5:1 的底色亮度上限
                    const tLint = (1 + 0.05) / 4.5 - 0.05
                    // +5% 保守余量：补偿收敛残差与实际渲染的半透明像素混合，确保最终对比度足额 4.5:1
                    const need = brightL > tLint
                        ? ((brightL - tLint) / (brightL - SCRIM_L)) * 1.05
                        : 0
                    alpha = Math.min(MAX_A, Math.max(MIN_A, need))
                }
            }
            // 目标滞回：目标本身微抖（<DEAD_ZONE）时沿用旧目标；数值用固定收敛率逼近目标（不再中途冻结）
            const prevTarget = Number(el.dataset.scrimTarget)
            if (Number.isFinite(prevTarget) && Math.abs(alpha - prevTarget) < DEAD_ZONE) alpha = prevTarget
            el.dataset.scrimTarget = alpha.toFixed(3)
            const prev = Number(el.dataset.scrimA)
            if (Number.isFinite(prev)) alpha = prev + (alpha - prev) * EASE
            el.dataset.scrimA = alpha.toFixed(3)
            el.style.setProperty('--scrim-a', alpha.toFixed(3))
        }
    }
    update()
    const timer = setInterval(update, 250)
    // 从后台切回时立即刷新一次，避免用旧亮度过渡
    document.addEventListener('visibilitychange', () => { if (!document.hidden) update() })
    window.addEventListener('pagehide', () => clearInterval(timer), { once: true })
}
