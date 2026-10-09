// Hover previews share the same open/close paths as clicks. Touch remains click-only.
const OPEN_DELAY = 200
const CLOSE_DELAY = 220
const mouseHover = event => event.pointerType === 'mouse' && matchMedia('(hover: hover)').matches
const editing = root => root.contains(document.activeElement) &&
    document.activeElement.matches('input, textarea, select, :focus-visible')

export function installTocHover ({ trigger, surface, open, close, isOpen, openRow, closeRow }) {
    let opening = null, closing = null
    const rowTimers = new Map()
    const clear = () => { clearTimeout(opening); clearTimeout(closing); opening = closing = null }
    const reset = () => {
        clear()
        for (const timer of rowTimers.values()) clearTimeout(timer)
        rowTimers.clear()
    }
    const cancelRow = key => { clearTimeout(rowTimers.get(key)); rowTimers.delete(key) }
    const laterRow = (row, expanding) => {
        const key = row.dataset.plain
        cancelRow(key)
        rowTimers.set(key, setTimeout(() => {
            rowTimers.delete(key)
            // Progress can replace the directory DOM; always resolve the current row.
            const current = surface.querySelector(`li[data-plain="${key}"]`)
            if (!current || !isOpen()) return
            if (expanding) {
                if (current.querySelector('.toc-expand:hover')) openRow(current)
            } else if (!current.matches(':hover') && !editing(current)) closeRow(current)
        }, expanding ? OPEN_DELAY : CLOSE_DELAY))
    }
    const leaveSurface = () => {
        clearTimeout(opening)
        clearTimeout(closing)
        closing = setTimeout(() => {
            closing = null
            if (!trigger.matches(':hover') && !surface.matches(':hover') &&
                !editing(surface) && !trigger.matches(':focus-visible')) close()
        }, CLOSE_DELAY)
    }
    trigger.addEventListener('pointerenter', event => {
        if (!mouseHover(event)) return
        clear()
        if (!isOpen()) opening = setTimeout(() => { opening = null; open() }, OPEN_DELAY)
        else open() // reverse an exit immediately when returning to the trigger
    })
    trigger.addEventListener('pointerleave', event => { if (mouseHover(event)) leaveSurface() })
    surface.addEventListener('pointerenter', event => {
        if (!mouseHover(event)) return
        clear()
        open()
    })
    surface.addEventListener('pointerleave', event => { if (mouseHover(event)) leaveSurface() })
    surface.addEventListener('pointerover', event => {
        if (!mouseHover(event)) return
        const row = event.target.closest('li[data-plain]')
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
    surface.addEventListener('pointerout', event => {
        if (!mouseHover(event)) return
        const row = event.target.closest('li[data-plain]')
        if (!row) return
        const chip = event.target.closest('.toc-expand')
        if (chip && !chip.contains(event.relatedTarget)) cancelRow(row.dataset.plain)
        if (!row.contains(event.relatedTarget)) laterRow(row, false)
    })
    for (const root of [trigger, surface]) {
        root.addEventListener('focusin', () => clearTimeout(closing))
        root.addEventListener('focusout', () => {
            if (isOpen()) leaveSurface()
        })
    }
    surface.addEventListener('focusout', event => {
        const row = event.target.closest('li[data-plain]')
        if (row && !row.contains(event.relatedTarget)) laterRow(row, false)
    })
    surface.addEventListener('toggle', event => { if (event.newState === 'closed') reset() })
    window.addEventListener('pagehide', reset)
    return { reset }
}

const rowMotion = new WeakMap()
export function animateTocPages (box, expanded, { animate = true } = {}) {
    const running = rowMotion.get(box)
    const from = box.hidden ? 0 : box.getBoundingClientRect().height
    const opacity = box.hidden ? 0 : Number(getComputedStyle(box).opacity)
    running?.cancel()
    rowMotion.delete(box)
    box.hidden = false
    if (!animate || matchMedia('(prefers-reduced-motion: reduce)').matches) {
        box.hidden = !expanded
        return
    }
    const to = expanded ? box.getBoundingClientRect().height : 0
    const motion = box.animate([
        { height: `${from}px`, opacity },
        { height: `${to}px`, opacity: expanded ? 1 : 0 },
    ], { duration: 180, easing: 'cubic-bezier(.22,.72,.28,1)' })
    rowMotion.set(box, motion)
    motion.finished.then(() => {
        if (rowMotion.get(box) !== motion) return
        rowMotion.delete(box)
        box.hidden = !expanded
    }, () => {})
}
