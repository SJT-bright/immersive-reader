// 已读页进度模型：阅读进度以「真正看过的页」计量，跳读跳过的页不计入。
// 已读记录 readMap = { [sectionIndex]: [[a,b], ...] }，区间为 section 内 fraction(0-1)，
// 与字号/窗口宽度无关（页数变化时区间语义不变）；section 权重沿用 foliate 的 size（字符量）。
// v1.0.0

const clamp01 = x => Math.max(0, Math.min(1, x))

// 排序、合并、裁剪区间列表；相邻与重叠区间合并为一个
export function normalizeRanges (ranges) {
    const list = []
    for (const r of Array.isArray(ranges) ? ranges : []) {
        if (!Array.isArray(r) || r.length < 2) continue
        const a = clamp01(Number(r[0])), b = clamp01(Number(r[1]))
        if (Number.isFinite(a) && Number.isFinite(b) && b > a) list.push([a, b])
    }
    list.sort((x, y) => x[0] - y[0] || x[1] - y[1])
    const out = []
    for (const [a, b] of list) {
        const last = out[out.length - 1]
        if (last && a <= last[1] + 1e-9) { if (b > last[1]) last[1] = b }
        else out.push([a, b])
    }
    return out
}

const sameRanges = (x, y) => x === y || (x.length === y.length && x.every(([a, b], i) =>
    a === y[i][0] && b === y[i][1]))

// 把已读区间 [a,b] 记入 readMap[index]；区间未带来新增覆盖时返回原对象（滚动模式高频触发）
export function addRange (readMap, index, a, b) {
    if (!Number.isInteger(index) || index < 0) return readMap
    const merged = normalizeRanges([...(readMap[index] || []), [a, b]])
    if (sameRanges(merged, readMap[index] || [])) return readMap
    return { ...readMap, [index]: merged }
}

// 区间总覆盖长度（0-1）
export function coverageOf (ranges) {
    let sum = 0
    for (const [a, b] of normalizeRanges(ranges)) sum += b - a
    return Math.min(1, sum)
}

// section 权重：与 foliate SectionProgress 同规则（非 linear==='no' 且 size>0）
export function sectionSizesFrom (sections) {
    return (Array.isArray(sections) ? sections : [])
        .map(s => s && s.linear !== 'no' && s.size > 0 ? s.size : 0)
}

// 加权已读比例 = Σ(section 覆盖 × section size) / sizeTotal
export function readFraction (readMap, sizes) {
    if (!readMap || !Array.isArray(sizes)) return 0
    let total = 0, read = 0
    for (let i = 0; i < sizes.length; i++) {
        const size = sizes[i]
        if (!size) continue
        total += size
        const ranges = readMap[i] || readMap[String(i)]
        if (ranges) read += coverageOf(ranges) * size
    }
    if (!total) return 0
    return clamp01(read / total)
}

// 旧数据一次性迁移：只有位置比例时，把位置之前的章节视为已读（延续旧语义作为初始值），
// 此后按页精确记录——跳读不再虚增进度。
export function initReadMapFromPercent (percent, sizes) {
    const map = {}
    if (!Array.isArray(sizes) || !sizes.length) return map
    let total = 0
    for (const s of sizes) total += s
    if (!total) return map
    let acc = 0
    const target = clamp01(Number(percent) || 0) * total
    for (let i = 0; i < sizes.length; i++) {
        const size = sizes[i]
        if (!size) continue
        if (acc + size <= target + 1e-9) { map[i] = [[0, 1]]; acc += size }
        else {
            const within = (target - acc) / size
            if (within > 1e-9) map[i] = [[0, Math.min(1, within)]]
            break
        }
    }
    return map
}

// 结构校验（journal / 备份导入用）：非法输入返回 null
export function sanitizeReadMap (value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const out = {}
    for (const [k, ranges] of Object.entries(value)) {
        const i = Number(k)
        if (!Number.isInteger(i) || i < 0) continue
        const norm = normalizeRanges(ranges)
        if (norm.length) out[i] = norm
    }
    return Object.keys(out).length ? out : null
}
