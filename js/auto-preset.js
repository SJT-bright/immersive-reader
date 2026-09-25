// 速度预设的档位表与判定：纯数据、无 DOM，供 node:test 直接调用。
// 「定时翻页」按速度取向排布 —— 停留越短翻得越快，所以 快=30 秒、慢=70 秒。
export const AUTO_PRESETS = Object.freeze([
    { speed: 10, seconds: 70, label: '慢' },
    { speed: 20, seconds: 50, label: '适中' },
    { speed: 40, seconds: 30, label: '快' },
])

// 返回当前档位对应的 data-speed，用作按钮标识
export function activePresetSpeed (autoRead) {
    const a = autoRead || {}
    if (a.mode === 'page') {
        const s = Number(a.pageSeconds)
        return s <= 40 ? 40 : s <= 60 ? 20 : 10
    }
    const v = Number(a.pixelsPerSecond)
    return v <= 12 ? 10 : v <= 30 ? 20 : 40
}
