// Keep transient controls above occupied bottom space, including dynamic audio docks.
const details = document.querySelector('#reading-speed-details')
const popup = document.querySelector('#reading-speed-popover')
const summary = details.querySelector('summary')
summary.setAttribute('aria-controls', popup.id)
summary.setAttribute('aria-expanded', 'false')
let frame = 0
function blocks (rect) {
    const nodes = document.querySelectorAll('#mini-player, #live-player.dock-mini:not(.tall), #reading-dock')
    for (const el of nodes) {
        const style = getComputedStyle(el)
        if (el.hidden || style.display === 'none' || style.visibility === 'hidden' || el.classList.contains('tucked')) continue
        const box = el.getBoundingClientRect()
        if (box.width < 2 || box.height < 2) continue
        const separated = rect.right <= box.left || rect.left >= box.right || rect.bottom <= box.top || rect.top >= box.bottom
        if (!separated) return true
    }
    return false
}
function layout () {
    frame = 0
    const viewport = window.visualViewport
    const height = viewport?.height || innerHeight
    const width = viewport?.width || innerWidth
    const offsetTop = viewport?.offsetTop || 0
    const offsetLeft = viewport?.offsetLeft || 0
    const anchor = summary.getBoundingClientRect()
    const gap = 8
    const popupWidth = Math.min(228, Math.max(188, anchor.width), width - 16)
    let left = anchor.left + (anchor.width - popupWidth) / 2
    left = Math.max(offsetLeft + 8, Math.min(left, offsetLeft + width - popupWidth - 8))
    popup.style.width = `${popupWidth}px`
    popup.style.left = `${left}px`
    popup.style.right = 'auto'
    popup.style.bottom = 'auto'
    popup.style.maxHeight = `${Math.max(120, height - 24)}px`
    const popupHeight = popup.offsetHeight || 168
    let top = anchor.top - gap - popupHeight
    const placed = { left, top, right: left + popupWidth, bottom: top + popupHeight }
    if (top < offsetTop + 8 || blocks(placed)) {
        let ceiling = anchor.top - gap
        for (const el of document.querySelectorAll('#mini-player, #live-player.dock-mini:not(.tall)')) {
            const style = getComputedStyle(el)
            if (el.hidden || style.display === 'none' || style.visibility === 'hidden' || el.classList.contains('tucked')) continue
            const box = el.getBoundingClientRect()
            const overlapsX = left < box.right && left + popupWidth > box.left
            if (box.height && overlapsX && box.top < anchor.top) ceiling = Math.min(ceiling, box.top - gap)
        }
        top = Math.max(offsetTop + 8, ceiling - popupHeight)
        popup.style.maxHeight = `${Math.max(96, ceiling - (offsetTop + 8))}px`
    }
    popup.style.top = `${top}px`
}
function schedule () { if (!frame) frame = requestAnimationFrame(layout) }
details.addEventListener('toggle', () => {
    summary.setAttribute('aria-expanded', String(details.open))
    if (details.open) {
        if (!popup.matches(':popover-open')) popup.showPopover()
        layout()
        requestAnimationFrame(layout)
    }
    else if (popup.matches(':popover-open')) popup.hidePopover()
})
popup.addEventListener('toggle', e => {
    if (e.newState === 'closed') details.open = false
})
// ResizeObserver also catches title wrapping and playlist player size changes.
const resize = new ResizeObserver(schedule)
resize.observe(document.querySelector('#reading-dock'))
const observed = new WeakSet()
function observePlayers () {
    for (const el of document.querySelectorAll('#mini-player, #live-player')) {
        if (!observed.has(el)) { observed.add(el); resize.observe(el) }
    }
    schedule()
}
new MutationObserver(observePlayers).observe(document.querySelector('#mini-player-host'), { childList: true, subtree: true, attributes: true })
new MutationObserver(schedule).observe(document.querySelector('#live-player'), { attributes: true })
window.addEventListener('resize', schedule)
window.visualViewport?.addEventListener('resize', schedule)
window.visualViewport?.addEventListener('scroll', schedule)
observePlayers()

// Escape dismisses only the active surface; do not also stop reading or move focus elsewhere.
document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !details.open) return
    event.preventDefault()
    event.stopImmediatePropagation()
    details.open = false
    if (popup.matches(':popover-open')) popup.hidePopover()
    summary.focus()
}, true)
