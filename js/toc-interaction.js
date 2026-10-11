// Hover is a preview. Explicit activation pins the surface/row until another
// activation closes it; a delayed hover must never undo a deliberate click.
const OPEN_DELAY = 200
const CLOSE_DELAY = 220
const media = query => typeof matchMedia === 'function' && matchMedia(query).matches
const mouseHover = event => event.pointerType === 'mouse' && media('(hover: hover)')
const editing = root => root.contains(document.activeElement) &&
    document.activeElement?.matches('input, textarea, select, :focus-visible')

export function installTocHover ({ trigger, surface, open, close, isOpen, openRow, closeRow }) {
    if (!trigger || !surface) return { reset () {}, dispose () {}, activateTrigger: () => false, activateRow: () => false }
    let opening = null, closing = null
    const rowTimers = new Map()
    const pinnedRows = new Set()
    const listeners = []
    let pinned = false, disposed = false
    const listen = (root, type, handler) => {
        root.addEventListener(type, handler)
        listeners.push(() => root.removeEventListener(type, handler))
    }
    const clear = () => { clearTimeout(opening); clearTimeout(closing); opening = closing = null }
    const reset = () => {
        clear()
        for (const timer of rowTimers.values()) clearTimeout(timer)
        rowTimers.clear()
        pinnedRows.clear()
        pinned = false
    }
    const cancelRow = key => { clearTimeout(rowTimers.get(key)); rowTimers.delete(key) }
    const laterRow = (row, expanding) => {
        const key = row.dataset.plain
        if (key == null) return
        cancelRow(key)
        rowTimers.set(key, setTimeout(() => {
            rowTimers.delete(key)
            // Progress can replace the directory DOM; always resolve the current row.
            const escaped = key.replace(/["\\]/g, '\\$&')
            const current = surface.querySelector(`li[data-plain="${escaped}"]`)
            if (!current || !isOpen()) return
            if (expanding) {
                if (current.querySelector('.toc-expand:hover')) openRow(current)
            } else if (!pinnedRows.has(key) && !current.matches(':hover') && !editing(current)) closeRow(current)
        }, expanding ? OPEN_DELAY : CLOSE_DELAY))
    }
    const leaveSurface = () => {
        clearTimeout(opening)
        clearTimeout(closing)
        opening = closing = null
        if (pinned) return
        closing = setTimeout(() => {
            closing = null
            if (!pinned && !trigger.matches(':hover') && !surface.matches(':hover') &&
                !editing(surface) && !trigger.matches(':focus-visible')) close()
        }, CLOSE_DELAY)
    }
    const activateTrigger = () => {
        if (disposed) return false
        clear()
        if (isOpen() && pinned) { reset(); close() }
        else {
            open()
            // Opening a new book's DOM may reset this controller synchronously.
            pinned = isOpen()
        }
        return true
    }
    const activateRow = row => {
        if (disposed || !row || !surface.contains(row)) return false
        const key = row.dataset.plain
        cancelRow(key)
        clear()
        pinned = true
        if (row.classList.contains('toc-expanded') && pinnedRows.has(key)) {
            pinnedRows.delete(key)
            closeRow(row)
        } else {
            openRow(row)
            if (row.classList.contains('toc-expanded')) pinnedRows.add(key)
        }
        return true
    }
    listen(trigger, 'pointerenter', event => {
        if (!mouseHover(event)) return
        clear()
        if (!isOpen()) opening = setTimeout(() => { opening = null; open() }, OPEN_DELAY)
        else open() // reverse an exit immediately when returning to the trigger
    })
    listen(trigger, 'pointerleave', event => { if (mouseHover(event)) leaveSurface() })
    listen(surface, 'pointerenter', event => {
        if (!mouseHover(event)) return
        clear()
        open()
    })
    listen(surface, 'pointerleave', event => { if (mouseHover(event)) leaveSurface() })
    // A click inside is explicit use (page navigation, filtering, or a control).
    // Keep the directory stable while the reader continues interacting with it.
    const pinInteraction = event => {
        clear()
        pinned = true
        const row = event.target.closest?.('li[data-plain]')
        if (!row) return
        cancelRow(row.dataset.plain)
        // The expand chip has its own explicit toggle policy. Navigating a page
        // or using the row's other controls confirms its hover preview instead.
        if (!event.target.closest?.('.toc-expand') && row.classList.contains('toc-expanded')) pinnedRows.add(row.dataset.plain)
    }
    listen(surface, 'click', pinInteraction)
    listen(surface, 'pointerdown', pinInteraction)
    listen(surface, 'pointerover', event => {
        if (!mouseHover(event)) return
        const row = event.target.closest?.('li[data-plain]')
        if (!row) return
        if (!row.contains(event.relatedTarget)) {
            cancelRow(row.dataset.plain)
            if (!row.classList.contains('toc-expanded') && row.querySelector('.toc-pages')?.hidden === false) {
                openRow(row) // reverse a running collapse before its content disappears
                return
            }
        }
        const chip = event.target.closest('.toc-expand')
        if (chip && !chip.contains(event.relatedTarget) && !row.classList.contains('toc-expanded')) laterRow(row, true)
    })
    listen(surface, 'pointerout', event => {
        if (!mouseHover(event)) return
        const row = event.target.closest?.('li[data-plain]')
        if (!row) return
        const chip = event.target.closest('.toc-expand')
        if (chip && !chip.contains(event.relatedTarget)) cancelRow(row.dataset.plain)
        if (!row.contains(event.relatedTarget)) laterRow(row, false)
    })
    for (const root of [trigger, surface]) {
        listen(root, 'focusin', () => { clearTimeout(closing); closing = null })
        listen(root, 'focusout', () => {
            if (isOpen()) leaveSurface()
        })
    }
    listen(surface, 'focusin', event => {
        const row = event.target.closest?.('li[data-plain]')
        if (row) cancelRow(row.dataset.plain)
    })
    listen(surface, 'focusout', event => {
        const row = event.target.closest?.('li[data-plain]')
        if (row && !row.contains(event.relatedTarget)) laterRow(row, false)
    })
    listen(surface, 'toggle', event => { if (event.newState === 'closed') reset() })
    listen(window, 'pagehide', reset)
    const dispose = () => {
        if (disposed) return
        disposed = true
        reset()
        for (const unlisten of listeners) unlisten()
        listeners.length = 0
    }
    return { reset, dispose, activateTrigger, activateRow }
}

const rowMotion = new WeakMap()
export function animateTocPages (box, expanded, { animate = true } = {}) {
    if (!box) return null
    const running = rowMotion.get(box)
    if (!animate || media('(prefers-reduced-motion: reduce)') || typeof box.animate !== 'function') {
        running?.cancel()
        rowMotion.delete(box)
        box.hidden = !expanded
        return null
    }
    const from = box.hidden ? 0 : box.getBoundingClientRect().height
    const opacity = box.hidden ? 0 : Number(getComputedStyle(box).opacity)
    running?.cancel()
    rowMotion.delete(box)
    box.hidden = false
    const to = expanded ? box.getBoundingClientRect().height : 0
    const motion = box.animate([
        { height: `${from}px`, opacity },
        { height: `${to}px`, opacity: expanded ? 1 : 0 },
    ], { duration: 180, easing: 'cubic-bezier(.22,.72,.28,1)', fill: 'both' })
    rowMotion.set(box, motion)
    motion.finished.then(() => {
        if (rowMotion.get(box) !== motion) return
        rowMotion.delete(box)
        box.hidden = !expanded
        // Hold the endpoint until hidden is applied, then release the effect so
        // expanded content can grow naturally when pagination/details change.
        motion.cancel()
    }, () => {})
    return motion
}
