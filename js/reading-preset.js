// 三档阅读预设：专注阅读 / 轻氛围 / 完整场景。
// 切换前把用户的自定义环境保存为快照，随时可恢复；新用户默认轻氛围。
// 正文可读性保护（对比度底色）在任何预设下都不降低。

export const READING_PRESETS = [
    { key: 'focus', label: '专注阅读', hint: '静止背景、稳定底色，翻页与滚动渐隐关闭' },
    { key: 'light', label: '轻氛围', hint: '周边缓慢运动，正文后方保持稳定' },
    { key: 'full', label: '完整场景', hint: '雨雪、动态风景、闪电等全部保留' },
]

// 组合环境预设（阅读环境面板一键切换）
export const ENV_PRESETS = [
    { key: 'rain-night', label: '小雨夜读', set: { weather: 'rain', rain: 0.35, fog: 0.28, ambience: 'rain', wind: 0.2 } },
    { key: 'quiet-snow', label: '安静雪景', set: { weather: 'snow', snow: 0.62, fog: 0.1, ambience: 'snow', wind: 0.15 } },
    { key: 'sunny-window', label: '晴窗', set: { weather: 'clear', ambience: null } },
]

const snapKeys = ['atmosphere', 'background', 'pageBreathe', 'scrollFade', 'showReadingTimer']

export function capturePresetSnapshot (settings) {
    return {
        atmosphere: { ...settings.atmosphere },
        background: { ...settings.background },
        pageBreathe: settings.misc.pageBreathe !== false,
        scrollFade: settings.misc.scrollFade !== false,
        showReadingTimer: settings.misc.showReadingTimer !== false,
    }
}

export function restorePresetSnapshot (settings, snap) {
    if (!snap) return false
    Object.assign(settings.atmosphere, snap.atmosphere)
    Object.assign(settings.background, snap.background)
    settings.misc.pageBreathe = snap.pageBreathe
    settings.misc.scrollFade = snap.scrollFade
    settings.misc.showReadingTimer = snap.showReadingTimer
    return true
}

// 应用预设（直接修改 settings，由调用方 persist + scene.onSettingsChanged）
export function applyReadingPreset (settings, key) {
    const a = settings.atmosphere
    if (key === 'focus') {
        // 专注：关掉雨雪与折射（天气切到晴空）、冻结背景与画面动画、
        // 翻页呼吸与滚动渐隐关闭、隐藏计时。
        a.weather = 'clear'
        a.enabled = false
        a.lightning = false
        a.motion = false
        a.sceneFx = false
        settings.background.animate = false
        settings.misc.pageBreathe = false
        settings.misc.scrollFade = false
        settings.misc.showReadingTimer = false
    } else if (key === 'light') {
        // 轻氛围：雨势收敛到轻档、无闪电、背景缓慢流动、正文动画保留。
        a.enabled = true
        if (a.weather === 'rain' && a.rain > 0.4) a.rain = 0.35
        a.lightning = false
        a.motion = true
        settings.background.animate = true
        settings.misc.pageBreathe = true
        settings.misc.scrollFade = true
        settings.misc.showReadingTimer = true
    } else if (key === 'full') {
        // 完整场景 = 用户自己的全部设置（若被预设改过则从快照恢复）
        return false
    }
    return true
}
