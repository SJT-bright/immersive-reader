// 翻页动画（v1.0.0）。
//
// 做法：先让分页器把内容跳到目标页（这一步 foliate 是瞬时写 scrollLeft），
// 在同一个 requestAnimationFrame 里把版面元素用 transform 拉回原位，再动画归零。
// 于是屏幕上看到的是「纸面从旧位置滑到新位置」，而浏览器只做合成、不重排，
// 也不会出现新旧两套文字叠在一起的情况——文字自始至终只有一份。
//
// 跨章时（旧版面元素被替换）不能沿用同一套位移，退化为纸面淡入 + 纸边扫过。
// 「减少动态效果」和滚动模式直接跳过。
//
// 另有一层 .turn-veil 覆盖在书页上：一条带高光的纸边从一侧扫到另一侧，
// 配合中缝阴影短暂加深，用来交代「这是一张纸翻过去」而不是「画面平移」。

import { reducedMotion } from './button-fx.js?v=2026.9.28.1'

export const TURN_MS = 340
export const TURN_EASE = 'cubic-bezier(.24,.68,.28,1)'

export class PageTurn {
    constructor (host) {
        this.host = host
        this.veil = null
        this.edge = null
        this.spine = null
        this.current = null
        this.lastTurn = null
    }

    #ensureVeil () {
        if (this.veil?.isConnected || !this.host) return
        this.veil = document.createElement('div')
        this.veil.className = 'turn-veil'
        this.veil.setAttribute('aria-hidden', 'true')
        this.edge = document.createElement('i')
        this.spine = document.createElement('b')
        this.veil.append(this.edge, this.spine)
        this.host.append(this.veil)
    }

    #sweep (dir) {
        if (!this.host || reducedMotion()) return
        this.#ensureVeil()
        const live = this.veil.getAnimations()
        live.forEach(a => a.cancel())
        this.veil.style.opacity = '1'
        // dir = 1 向右翻页：纸边从右侧离开中缝往左扫；dir = -1 反向
        const from = dir >= 0 ? '150%' : '-150%'
        const to = dir >= 0 ? '-165%' : '165%'
        const timing = { duration: TURN_MS, easing: TURN_EASE, fill: 'none' }
        this.edge.animate(
            [{ transform: `translateX(${from}) skewX(${dir >= 0 ? -5 : 5}deg)`, opacity: 0 },
             { transform: `translateX(${dir >= 0 ? '45%' : '-45%'}) skewX(${dir >= 0 ? -3 : 3}deg)`, opacity: 1, offset: .34 },
             { transform: `translateX(${to}) skewX(${dir >= 0 ? -1 : 1}deg)`, opacity: 0 }],
            timing)
        this.spine.animate(
            [{ opacity: 0 }, { opacity: .62, offset: .4 }, { opacity: 0 }], timing)
        this.veil.animate(
            [{ opacity: 1 }, { opacity: 1, offset: .82 }, { opacity: 0 }],
            { ...timing, fill: 'forwards' })
    }

    // 分页器在 shadow DOM 里的滚动容器；拿不到就放弃动画，绝不因此影响翻页本身。
    static scrollerOf (view) {
        return view?.renderer?.__readerShadow?.getElementById('container') || null
    }

    // action 是真正执行翻页的函数（view.next() / view.prev()）。
    async run (view, action, dir) {
        const scroller = PageTurn.scrollerOf(view)
        const quiet = !scroller || reducedMotion() || view?.renderer?.scrolled
        if (quiet) return action()

        this.current?.forEach(a => a.cancel())
        const renderer = view.renderer
        // 正文页 = pages - 2（foliate 在两端各留一栏空白）。落在正文页边界意味着这一翻会换章，
        // 提前判断就能选择"按住旧页等新版面"而不是"先滑进空白栏"。
        const textPages = Math.max(1, (Number(renderer.pages) || 0) - 2)
        const page = Number.isFinite(renderer.page) ? renderer.page : 1
        const boundary = dir > 0 ? page >= textPages : page <= 1

        const before = { left: scroller.scrollLeft, top: scroller.scrollTop }
        const at = (axis, v) => (axis === 'x' ? `translate3d(${v}px,0,0)` : `translate3d(0,${v}px,0)`)
        let failure = null
        let settled = false
        const done = action()
        done.then(() => { settled = true }, error => { settled = true; failure = error })

        // 阶段一：等位置真的变了。同章翻页立刻拿到位移就进阶段二；
        // 跨章时先把旧页用 transform 按在原地（此刻 DOM 里还是旧内容，能按住），等新版面挂上来。
        const found = await new Promise(resolve => {
            let leaf = scroller.firstElementChild
            const deadline = performance.now() + (boundary ? 1200 : 240)
            const release = () => leaf?.style.removeProperty('transform')
            const tick = () => {
                if (failure) return resolve({ kind: 'failed' })
                const next = scroller.firstElementChild
                if (next !== leaf) { release(); leaf = next; return resolve({ kind: 'section', leaf }) }
                const dx = scroller.scrollLeft - before.left
                const dy = scroller.scrollTop - before.top
                const axis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y'
                const offset = axis === 'x' ? dx : dy
                const limit = (axis === 'x' ? scroller.clientWidth : scroller.clientHeight) * 2.2
                if (offset) {
                    if (Math.abs(offset) > limit) { release(); return resolve({ kind: 'section', leaf }) }
                    if (!boundary) return resolve({ kind: 'slide', leaf, axis, offset })
                    leaf.style.transform = at(axis, offset)
                }
                if (settled || performance.now() > deadline) { release(); return resolve({ kind: 'none' }) }
                requestAnimationFrame(tick)
            }
            requestAnimationFrame(tick)
        })

        const animations = []
        if (found.kind === 'slide') {
            const { leaf, axis, offset } = found
            // 此刻仍在同一帧的 rAF 回调内：先写回原位再挂动画，中间不会闪出终态
            leaf.style.transform = at(axis, offset)
            const restore = () => leaf.style.removeProperty('transform')
            const slide = leaf.animate(
                [{ transform: at(axis, offset) }, { transform: at(axis, 0) }],
                { duration: TURN_MS, easing: TURN_EASE, fill: 'none' })
            slide.finished.then(restore, restore)
            animations.push(slide)
        } else if (found.kind === 'section') {
            // 新版面从书口一侧推进来，配合同方向的纸边扫光，读起来仍是"纸翻过去"而不是硬切
            const axis = scroller.clientWidth >= scroller.clientHeight ? 'x' : 'y'
            const span = axis === 'x' ? scroller.clientWidth : scroller.clientHeight
            const from = (dir >= 0 ? 1 : -1) * 0.12 * span
            const leaf = found.leaf
            const restore = () => leaf.style.removeProperty('transform')
            const turn = leaf.animate([
                { transform: at(axis, from), opacity: .3 },
                { transform: at(axis, 0), opacity: 1 },
            ], { duration: TURN_MS, easing: TURN_EASE, fill: 'none' })
            turn.finished.then(restore, restore)
            animations.push(turn)
        }
        this.lastTurn = { kind: found.kind, boundary, dir }
        this.#sweep(dir)
        this.current = animations

        await Promise.all([done.catch(() => {}), ...animations.map(a => a.finished.catch(() => {}))])
        if (this.current === animations) this.current = null
        if (failure) throw failure
    }

    destroy () {
        this.current?.forEach(a => a.cancel())
        this.current = null
        this.veil?.remove()
        this.veil = this.edge = this.spine = null
    }
}
