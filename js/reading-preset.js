// 三档阅读预设：专注阅读 / 轻氛围 / 完整场景。
// 切换前把用户的自定义环境保存为快照，随时可恢复；新用户默认轻氛围。
// 正文可读性保护（对比度底色）在任何预设下都不降低。

export const READING_PRESETS = [
    // 文案只承诺这个预设真正改动的东西：专注阅读不动 background.mode，
    // 「按分钟轮换」仍会换图（换图与可读性重算在 background.js 里），所以不再写「静止背景」（F3-17）。
    { key: 'focus', label: '专注阅读', hint: '收掉雨雪、画面动效与滚动渐隐，底色保持稳定（背景图仍按背景模式轮换）' },
    { key: 'light', label: '轻氛围', hint: '周边缓慢运动，正文后方保持稳定' },
    { key: 'full', label: '完整场景', hint: '雨雪、动态风景、闪电等全部保留' },
]

// 组合环境预设（阅读环境面板一键切换）
export const ENV_PRESETS = [
    { key: 'rain-night', label: '小雨夜读', set: { weather: 'rain', rain: 0.35, fog: 0.28, ambience: 'rain', wind: 0.2 } },
    { key: 'quiet-snow', label: '安静雪景', set: { weather: 'snow', snow: 0.62, fog: 0.1, ambience: 'snow', wind: 0.15 } },
    { key: 'sunny-window', label: '晴窗', set: { weather: 'clear', ambience: null } },
]

const snapKeys = ['atmosphere', 'background', 'scrollFade', 'showReadingTimer']

export function capturePresetSnapshot (settings) {
    return {
        atmosphere: { ...settings.atmosphere },
        background: { ...settings.background },
        scrollFade: settings.misc.scrollFade !== false,
        showReadingTimer: settings.misc.showReadingTimer !== false,
    }
}

export function restorePresetSnapshot (settings, snap) {
    if (!snap) return false
    Object.assign(settings.atmosphere, snap.atmosphere)
    Object.assign(settings.background, snap.background)
    settings.misc.scrollFade = snap.scrollFade
    settings.misc.showReadingTimer = snap.showReadingTimer
    return true
}

// 当前设置是否已经等于这个预设要落笔的字段。
// 判定必须看真实字段，不能看芯片上的 .on 标签：标签是 misc.readingPreset，
// 用户之后自定义过环境也还挂着「轻氛围」，于是切预设时就不留快照，把用户的雨势直接盖掉（F3-17）。
export function settingsMatchPreset (settings, key) {
    const a = settings.atmosphere
    const b = settings.background
    const m = settings.misc
    if (key === 'focus') {
        return a.weather === 'clear' && a.enabled === false && a.lightning === false &&
            a.motion === false && a.sceneFx === false && b.animate === false &&
            m.scrollFade === false && m.showReadingTimer === false
    }
    if (key === 'light') {
        // applyReadingPreset('light') 只在雨势过重时收敛，其余字段无条件写成下面的值
        return a.enabled === true && a.lightning === false && a.motion === true &&
            b.animate === true && m.scrollFade === true && m.showReadingTimer !== false &&
            !(a.weather === 'rain' && a.rain > 0.4)
    }
    // full 不改任何字段：它等于「用户自己的设置」，没有需要保护的自定义值
    return true
}

// 应用预设（直接修改 settings，由调用方 persist + scene.onSettingsChanged）
export function applyReadingPreset (settings, key) {
    const a = settings.atmosphere
    if (key === 'focus') {
        // 专注：关掉雨雪与折射（天气切到晴空）、冻结背景与画面动画、
        // 滚动渐隐关闭、隐藏计时。
        a.weather = 'clear'
        a.enabled = false
        a.lightning = false
        a.motion = false
        a.sceneFx = false
        settings.background.animate = false
        settings.misc.scrollFade = false
        settings.misc.showReadingTimer = false
    } else if (key === 'light') {
        // 轻氛围：雨势收敛到轻档、无闪电、背景缓慢流动、正文动画保留。
        a.enabled = true
        if (a.weather === 'rain' && a.rain > 0.4) a.rain = 0.35
        a.lightning = false
        a.motion = true
        settings.background.animate = true
        settings.misc.scrollFade = true
        settings.misc.showReadingTimer = true
    } else if (key === 'full') {
        // 完整场景 = 用户自己的全部设置（若被预设改过则从快照恢复）
        return false
    }
    return true
}
