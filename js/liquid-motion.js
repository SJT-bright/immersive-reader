// Optional interaction layer. It observes existing controls; it never opens, closes, or
// changes the state of a surface. CSS owns the visual treatment of these classes.
const PRESS_MIN_MS = 180
const PRESS_RELEASE_MS = 90
const SURFACE_WAIT_MS = 1200
const SURFACE_ENTER_MS = 720

const prefersReducedMotion = () =>
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

const now = () => typeof performance === 'undefined' ? Date.now() : performance.now()

function isVisible (element) {
    if (!(element instanceof Element) || !element.isConnected) return false
    if (element.closest('[hidden], [inert]')) return false
    const style = getComputedStyle(element)
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false
    const rect = element.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
}

function actionableButton (target) {
    if (!(target instanceof Element)) return null
    const button = target.closest('button, summary, [role="button"]')
    if (!button || button.disabled || button.hasAttribute('data-reader-static-control') || button.getAttribute('aria-disabled') === 'true') return null
    if (button.closest('[hidden], [inert]')) return null
    return button
}

/**
 * Add press feedback to buttons and reveal feedback to bound surfaces.
 *
 * `bindings` contains `{ trigger: CSS selector, surface: CSS selector or
 * (trigger) => Element }` pairs. `when` may skip a no-op control.
 * `replayWhenVisible: true` also animates a visible surface after its content is
 * rebuilt (for example, switching tabs inside an already open settings panel).
 * The returned function removes all listeners, observers, pending timers and classes.
 *
 * 幂等：模块自己记住「当前那一份」，重复调用先干净地卸掉上一份再装新的。
 * main.js:1950 把返回的 disposer 丢掉了，全靠「全应用只安装一次」才没漏；
 * 一旦将来二次调用就会得到两套 pointerdown/click 捕获监听和两份 MutationObserver。
 * 现在调用方不接返回值也不会造成双份（本文件仍是 addEventListener/removeEventListener 收支平衡的）。
 */
let activeDispose = null

export function installLiquidMotion ({ bindings = [] } = {}) {
    if (typeof document === 'undefined') return () => {}
    if (activeDispose) activeDispose()

    const pairs = bindings.filter(pair =>
        pair && typeof pair.trigger === 'string' &&
        (typeof pair.surface === 'string' || typeof pair.surface === 'function'))
    const pressed = new Map()
    const pointers = new Map()
    const keys = new Map()
    const entering = new Map()
    const pending = new Map()
    let observer = null
    let frame = 0

    function finishPress (button, immediate = false) {
        const state = pressed.get(button)
        if (!state) return
        clearTimeout(state.timer)
        const delay = immediate ? 0 : Math.max(PRESS_RELEASE_MS, PRESS_MIN_MS - (now() - state.start))
        state.timer = setTimeout(() => {
            button.classList.remove('liquid-press')
            pressed.delete(button)
        }, delay)
    }

    function beginPress (button) {
        const previous = pressed.get(button)
        if (previous) clearTimeout(previous.timer)
        pressed.set(button, { start: now(), timer: 0 })
        button.classList.add('liquid-press')
    }

    function endWatchingIfIdle () {
        if (pending.size || !observer) return
        observer.disconnect()
        observer = null
    }

    function clearPending (selector) {
        const item = pending.get(selector)
        if (!item) return
        clearTimeout(item.timer)
        pending.delete(selector)
        endWatchingIfIdle()
    }

    function enterSurface (surface, x, y) {
        if (prefersReducedMotion()) return
        // A second tab can replace this surface before its first reveal ends.
        // Restart from the new control, so rapid clicks follow the latest input.
        if (entering.has(surface)) {
            clearTimeout(entering.get(surface))
            surface.classList.remove('liquid-surface-enter')
            void surface.offsetWidth
        }
        const rect = surface.getBoundingClientRect()
        const localX = Math.min(rect.width, Math.max(0, x - rect.left))
        const localY = Math.min(rect.height, Math.max(0, y - rect.top))
        surface.style.setProperty('--liquid-origin-x', `${Math.round(localX)}px`)
        surface.style.setProperty('--liquid-origin-y', `${Math.round(localY)}px`)
        surface.classList.add('liquid-surface-enter')
        const timer = setTimeout(() => {
            surface.classList.remove('liquid-surface-enter')
            entering.delete(surface)
        }, SURFACE_ENTER_MS)
        entering.set(surface, timer)
    }

    function scanPending () {
        frame = 0
        for (const [key, item] of pending) {
            const surface = typeof key === 'string' ? document.querySelector(key) : key
            if (!isVisible(surface)) continue
            clearPending(key)
            enterSurface(surface, item.x, item.y)
        }
    }

    function scheduleScan () {
        if (!frame) frame = requestAnimationFrame(scanPending)
    }

    function watchPending () {
        if (!observer) {
            observer = new MutationObserver(scheduleScan)
        }
        // Watch the awaited surface and its visibility ancestors, rather than
        // every style change in the scenery / document root on pointer movement.
        observer.disconnect()
        const targets = new Map()
        let needsInsertion = false
        const addTarget = (target, subtree) => targets.set(target, Boolean(targets.get(target) || subtree))
        for (const key of pending.keys()) {
            const surface = typeof key === 'string' ? document.querySelector(key) : key
            if (!surface) { needsInsertion = true; continue }
            addTarget(surface, true)
            for (let parent = surface.parentElement; parent && parent !== document.documentElement; parent = parent.parentElement) addTarget(parent, false)
        }
        // Rebuilt panels may insert a selector that did not exist at click time.
        if (needsInsertion) targets.delete(document.body)
        for (const [target, subtree] of targets) observer.observe(target, {
            attributes: true,
            attributeFilter: ['class', 'hidden', 'style', 'open'],
            // An ancestor may replace the awaited node while a tab rebuilds.
            childList: true,
            subtree,
        })
        if (needsInsertion) observer.observe(document.body, { childList: true, subtree: true })
        scheduleScan()
    }

    function queueSurface (key, x, y) {
        clearPending(key)
        const timer = setTimeout(() => clearPending(key), SURFACE_WAIT_MS)
        pending.set(key, { x, y, timer })
        watchPending()
    }

    function onPointerDown (event) {
        if (event.button !== 0) return
        const button = actionableButton(event.target)
        if (!button) return
        beginPress(button)
        pointers.set(event.pointerId, button)
    }

    function onPointerUp (event) {
        const button = pointers.get(event.pointerId)
        if (!button) return
        pointers.delete(event.pointerId)
        finishPress(button, event.type === 'pointercancel')
    }

    function onKeyDown (event) {
        if (event.repeat || (event.key !== 'Enter' && event.key !== ' ')) return
        const button = actionableButton(event.target)
        if (!button) return
        beginPress(button)
        keys.set(event.key, button)
    }

    function onKeyUp (event) {
        const button = keys.get(event.key)
        if (!button) return
        keys.delete(event.key)
        finishPress(button)
    }

    function onClick (event) {
        const button = actionableButton(event.target)
        // Synthetic clicks and assistive activation may have no down event.
        if (button && !pressed.has(button)) {
            beginPress(button)
            finishPress(button)
        }
        if (prefersReducedMotion() || !(event.target instanceof Element)) return

        const clickOrigin = trigger => {
            const rect = trigger.getBoundingClientRect()
            const pointerClick = event.detail > 0 && Number.isFinite(event.clientX) && Number.isFinite(event.clientY)
            return pointerClick ? [event.clientX, event.clientY] :
                [rect.left + rect.width / 2, rect.top + rect.height / 2]
        }

        for (const pair of pairs) {
            const trigger = event.target.closest(pair.trigger)
            if (!trigger || trigger.closest('[hidden], [inert]')) continue
            if (pair.when && !pair.when(trigger)) continue
            const key = typeof pair.surface === 'function' ? pair.surface(trigger) : pair.surface
            if (!key) continue
            const surface = typeof key === 'string' ? document.querySelector(key) : key
            // A surface already open may be in the middle of closing. Replaying
            // it is opt-in for controls known to replace its visible contents.
            if (isVisible(surface) && !pair.replayWhenVisible) continue

            const [x, y] = clickOrigin(trigger)
            queueSurface(key, x, y)
        }

        // Native details are added by several dynamic panels. Their content
        // appears after the summary's default click action, so watch each child.
        const summary = event.target.closest('summary')
        const details = summary?.parentElement
        if (details?.tagName === 'DETAILS' && !details.open &&
            !details.classList.contains('books-fold') && details.id !== 'reading-speed-details') {
            const [x, y] = clickOrigin(summary)
            for (const child of details.children) {
                if (child !== summary) queueSurface(child, x, y)
            }
        }
    }

    function onBlur () {
        pointers.clear()
        keys.clear()
        for (const button of pressed.keys()) finishPress(button, true)
    }

    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('pointerup', onPointerUp, true)
    document.addEventListener('pointercancel', onPointerUp, true)
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('keyup', onKeyUp, true)
    document.addEventListener('click', onClick, true)
    window.addEventListener('blur', onBlur)
    let disposed = false
    const dispose = () => {
        if (disposed) return // 重复卸载也要保持收支平衡
        disposed = true
        document.removeEventListener('pointerdown', onPointerDown, true)
        document.removeEventListener('pointerup', onPointerUp, true)
        document.removeEventListener('pointercancel', onPointerUp, true)
        document.removeEventListener('keydown', onKeyDown, true)
        document.removeEventListener('keyup', onKeyUp, true)
        document.removeEventListener('click', onClick, true)
        window.removeEventListener('blur', onBlur)
        if (frame) cancelAnimationFrame(frame)
        observer?.disconnect()
        for (const item of pending.values()) clearTimeout(item.timer)
        for (const [button, state] of pressed) {
            clearTimeout(state.timer)
            button.classList.remove('liquid-press')
        }
        for (const [surface, timer] of entering) {
            clearTimeout(timer)
            surface.classList.remove('liquid-surface-enter')
        }
        pending.clear()
        pressed.clear()
        pointers.clear()
        keys.clear()
        entering.clear()
        if (activeDispose === dispose) activeDispose = null
    }
    activeDispose = dispose
    return dispose
}
