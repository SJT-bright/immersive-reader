// 内置氛围音乐清单。全部由 scripts/generate_builtin_music.py 确定性合成，
// 不含任何采样或下载的录音；新增曲目请同时补 tests/builtin-music.test.mjs 的文件存在性校验。
//
// loop: true 表示该曲按无缝循环制作（结尾折回开头），适合长时间播放；
// 《林间慢读》是早期作品，首尾有淡入淡出，循环时会有呼吸感。
export const BUILTIN_TRACKS = [
    { key: 'forest-reading', file: 'assets/audio/forest-reading.mp3', title: '林间慢读', seconds: 48, loop: false, tag: '拨奏 · 明亮' },
    { key: 'rain-window', file: 'assets/audio/rain-window.mp3', title: '雨窗随想', seconds: 66, loop: true, tag: '细雨 · 中速' },
    { key: 'night-desk', file: 'assets/audio/night-desk.mp3', title: '深夜书房', seconds: 78, loop: true, tag: '低吟 · 很慢' },
    { key: 'valley-dawn', file: 'assets/audio/valley-dawn.mp3', title: '山谷晨光', seconds: 66, loop: true, tag: '琶音 · 渐亮' },
    { key: 'hearth-snow', file: 'assets/audio/hearth-snow.mp3', title: '壁炉与雪', seconds: 72, loop: true, tag: '和声 · 有噼啪' },
    { key: 'slow-tide', file: 'assets/audio/slow-tide.mp3', title: '海边慢板', seconds: 84, loop: true, tag: '浪涌 · 最慢' },
]

export const builtinTrackByKey = key => BUILTIN_TRACKS.find(t => t.key === key) || null

// 曲目名与导入后的文件名一致（标题 + .mp3），用来判断某首内置音乐是否已在列表里。
export function missingBuiltinTracks (tracks) {
    const names = new Set(tracks.map(t => t.name))
    return BUILTIN_TRACKS.filter(t => !names.has(`${t.title}.mp3`))
}
