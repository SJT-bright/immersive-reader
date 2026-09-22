// 内联 SVG 图标集（自绘几何图形，无第三方图标库依赖）。
// 全部使用 currentColor，跟随文字颜色；默认 24×24，可用 CSS 的 width/height 缩放。
// 用法：icon('play') 返回字符串，直接插入 innerHTML。

const STROKE = 'fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"'
const FILL = 'fill="currentColor" stroke="none"'

const wrap = (body, attrs = STROKE) =>
    `<svg class="icon" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false" ${attrs}>${body}</svg>`

const PATHS = {
    // 播放 / 暂停
    play: ['<path d="M8 5.3 18.4 12 8 18.7Z"/>', FILL],
    pause: ['<path d="M7.6 5h3.1v14H7.6zM13.3 5h3.1v14h-3.1z"/>', FILL],
    stop: ['<rect x="7" y="7" width="10" height="10" rx="1.6"/>', FILL],

    // 上一首 / 下一首
    prev: ['<path d="M6.2 5.6h1.9v12.8H6.2zM18.9 6.1v11.8L9.6 12z"/>', FILL],
    next: ['<path d="M15.9 5.6h1.9v12.8h-1.9zM5.1 6.1v11.8L14.4 12z"/>', FILL],

    // 播放模式
    shuffle: [
        '<path d="M3.5 6.5h2.9c1.5 0 2.9.7 3.8 1.9l3.6 5.2c.9 1.2 2.3 1.9 3.8 1.9h2.9"/>' +
        '<path d="M17.8 12.9 20.5 15.5l-2.7 2.6"/>' +
        '<path d="M3.5 17.5h2.9c1.5 0 2.9-.7 3.8-1.9l.7-1"/>' +
        '<path d="M13.1 9.4l.7-1c.9-1.2 2.3-1.9 3.8-1.9h2.9"/>' +
        '<path d="M17.8 3.9 20.5 6.5l-2.7 2.6"/>', STROKE],
    repeat: [
        '<path d="M4 9.2V7.6A2.6 2.6 0 0 1 6.6 5H17"/>' +
        '<path d="M14.6 2.6 17.2 5l-2.6 2.4"/>' +
        '<path d="M20 14.8v1.6a2.6 2.6 0 0 1-2.6 2.6H7"/>' +
        '<path d="M9.4 21.4 6.8 19l2.6-2.4"/>', STROKE],
    repeatOne: [
        '<path d="M4 9.2V7.6A2.6 2.6 0 0 1 6.6 5H17"/>' +
        '<path d="M14.6 2.6 17.2 5l-2.6 2.4"/>' +
        '<path d="M20 14.8v1.6a2.6 2.6 0 0 1-2.6 2.6H7"/>' +
        '<path d="M9.4 21.4 6.8 19l2.6-2.4"/>' +
        '<path d="M11.6 9.7 12.9 9v4.6" stroke-width="1.5"/>', STROKE],
    // 顺序播放（列表 + 箭头，QQ 音乐顺序模式图标语义）
    sequential: [
        '<path d="M4.5 6.8h11.5"/>' +
        '<path d="M4.5 12h11.5"/>' +
        '<path d="M4.5 17.2h7"/>' +
        '<path d="M16.6 14.4v5.6l4.4-2.8z" fill="currentColor" stroke="none"/>', STROKE],

    // 音量
    volume: [
        '<path d="M4 9.4h3.1L12 5.4v13.2L7.1 14.6H4z"/>' +
        '<path d="M15.4 9.2a4 4 0 0 1 0 5.6" stroke-width="1.6"/>' +
        '<path d="M17.9 6.6a7.6 7.6 0 0 1 0 10.8" stroke-width="1.6"/>', STROKE],
    volumeMute: [
        '<path d="M4 9.4h3.1L12 5.4v13.2L7.1 14.6H4z"/>' +
        '<path d="M15.6 9.8l5 4.4M20.6 9.8l-5 4.4" stroke-width="1.6"/>', STROKE],

    // 睡眠定时
    timer: [
        '<circle cx="12" cy="13.2" r="7.4"/>' +
        '<path d="M12 9.4v3.9l2.4 1.7"/>' +
        '<path d="M9.2 2.6h5.6"/>', STROKE],

    // 通用
    close: ['<path d="M6.2 6.2 17.8 17.8M17.8 6.2 6.2 17.8"/>', STROKE],
    plus: ['<path d="M12 5.2v13.6M5.2 12h13.6"/>', STROKE],
    check: ['<path d="M5 12.8 9.6 17.4 19 8"/>', STROKE],
    edit: [
        '<path d="M4.5 19.5h4.1L19 9.1a1.9 1.9 0 0 0 0-2.7l-1.4-1.4a1.9 1.9 0 0 0-2.7 0L4.5 15.4z"/>' +
        '<path d="M14.2 6.6 17.4 9.8"/>', STROKE],
    trash: [
        '<path d="M4.4 7.1h15.2"/>' +
        '<path d="M9.6 7.1V5.2h4.8v1.9"/>' +
        '<path d="M6.6 7.1 7.5 20h9l.9-12.9"/>' +
        '<path d="M10.3 10.6v6M13.7 10.6v6" stroke-width="1.4"/>', STROKE],
    note: [
        '<path d="M9.2 17.8V6.6l9.6-1.9v11.1"/>' +
        '<ellipse cx="6.7" cy="17.9" rx="2.5" ry="2.2"/>' +
        '<ellipse cx="16.3" cy="15.9" rx="2.5" ry="2.2"/>', STROKE],
    chevronUp: ['<path d="M6.5 14.8 12 9.3l5.5 5.5"/>', STROKE],
    chevronDown: ['<path d="M6.5 9.2 12 14.7l5.5-5.5"/>', STROKE],
    // 拖拽手柄
    grip: [
        '<path d="M9.4 6.4h.02M14.6 6.4h.02M9.4 12h.02M14.6 12h.02M9.4 17.6h.02M14.6 17.6h.02" stroke-width="2.4"/>',
        STROKE],
    // 音乐（工具栏/迷你条）
    music: [
        '<path d="M9.2 17.8V6.6l9.6-1.9v11.1"/>' +
        '<ellipse cx="6.7" cy="17.9" rx="2.5" ry="2.2"/>' +
        '<ellipse cx="16.3" cy="15.9" rx="2.5" ry="2.2"/>', STROKE],
    // 音量脉冲（正在播放指示）
    wave: [
        '<path d="M4.5 10.5v3M8.25 7.5v9M12 5.5v13M15.75 8.5v7M19.5 10.5v3"/>', STROKE],
}

export function icon (name, { size } = {}) {
    const entry = PATHS[name]
    if (!entry) return ''
    const svg = wrap(entry[0], entry[1])
    return size ? svg.replace('width="24" height="24"', `width="${size}" height="${size}"`) : svg
}

export const ICON_NAMES = Object.keys(PATHS)
