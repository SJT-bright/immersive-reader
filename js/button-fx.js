// 全局动效层（v2.0.0）。
//
// 三件事：
//   1. 令牌：CSS 与 JS 共用同一套时长/缓动，改一处即可（css/experience.css 的 :root 有同名变量）；
//   2. 表面：任何「由隐藏到显示」的浮层都缓慢渐显弹出，关闭时反向退场后再真正隐藏；
//   3. 按钮：点击脉冲的高光从实际按下的位置扩散，而不是固定居中。
//
// 为什么退场必须由 JS 收尾：display:none 与 visibility:hidden 都会让 transition 失去起始态，
// 只有 animation 能在重新显示时自动重播；而「先淡出再隐藏」必须等动画结束，否则来不及看见。

// 与 css/experience.css 的 --dur-surface / --ease-surface 保持一致。
export const MOTION = {
    enterDuration: 340,
    enterEasing: 'cubic-bezier(.22,.72,.28,1)',
    exitDuration: 190,
    exitEasing: 'cubic-bezier(.4,0,.68,.32)',
}

export const reducedMotion = () =>
    typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

// 入场：位移 + 虚化 + 极轻的缩放。用独立的 translate/scale 属性，
// 不覆盖浮层自身的定位 transform（#reading-speed-popover 每帧被 JS 写 left/top）。
export function revealSurface (element, { dy = 14, blur = 9 } = {}) {
    if (!element || reducedMotion()) return null
    element.getAnimations().forEach(a => a.cancel())
    return element.animate([
        { opacity: 0, filter: `blur(${blur}px)`, translate: `0 ${dy}px`, scale: '0.985' },
        { opacity: 1, filter: 'blur(0px)', translate: '0 0', scale: '1' },
    ], { duration: MOTION.enterDuration, easing: MOTION.enterEasing })
}

// 退场：动画结束后执行 done（加 hidden / display:none）。元素在退场途中被重新显示时，
// revealSurface 会 cancel 掉这条动画，done 不再触发，界面不会闪回隐藏态。
export function dismissSurface (element, done, { dy = 10, blur = 7 } = {}) {
    if (!element) { done?.(); return null }
    if (reducedMotion() || typeof element.animate !== 'function') { done?.(); return null }
    const anim = element.animate([
        { opacity: 1, filter: 'blur(0px)', translate: '0 0', scale: '1' },
        { opacity: 0, filter: `blur(${blur}px)`, translate: `0 ${dy}px`, scale: '0.99' },
    ], { duration: MOTION.exitDuration, easing: MOTION.exitEasing })
    anim.finished.then(() => { if (anim.playState === 'finished') done?.() }, () => {})
    return anim
}

// 显示即渐显、隐藏即渐退的一体化封装：调用方只关心「要不要显示」。
export function setSurfaceVisible (element, visible, apply) {
    if (!element) return
    if (visible) {
        apply?.(true)
        revealSurface(element)
        return
    }
    dismissSurface(element, () => apply?.(false))
}

export function installButtonFx () {
    // 按下位置：::after 蒙层的径向高光以此为圆心
    document.addEventListener('pointerdown', e => {
        const button = e.target.closest('button')
        if (!button || button.disabled) return
        const rect = button.getBoundingClientRect()
        button.style.setProperty('--fx-x', `${Math.round(e.clientX - rect.left)}px`)
        button.style.setProperty('--fx-y', `${Math.round(e.clientY - rect.top)}px`)
    }, true)
    document.addEventListener('click', e => {
        const button = e.target.closest('button')
        if (!button || button.disabled) return
        button.classList.remove('is-clicked')
        void button.offsetWidth // 强制同步重排，连续点击也能重启动画
        button.classList.add('is-clicked')
    }, true)
    document.addEventListener('animationend', e => {
        if (e.target instanceof Element && e.animationName === 'btn-veil') e.target.classList.remove('is-clicked')
    }, true)
}
