// 已读页进度模型：阅读进度以「真正看过的页」计量，跳读跳过的页不计入。
// 已读记录 readMap = { [sectionIndex]: [[a,b], ...] }，区间为 section 内 fraction(0-1)，
// 与字号/窗口宽度无关（页数变化时区间语义不变）；section 权重沿用 foliate 的 size（字符量）。
// v1.1.0 起增加「读满 30 秒才算一页」的停留计时（DwellMeter）。

// 产品规则（用户 2026-10-02 明确要求）：某一页要读满 30 秒，才算增加进度。
// 旧行为是「进入页面立即计入」，被用户认定为 bug；这里集中放阈值，别处不再写死数字。
export const PAGE_DWELL_MS = 30_000
// 停留计时的采样间隔（js/reader.js 用它起定时器推进计时）。
export const DWELL_TICK_MS = 1000
// 两次采样之间的空洞上限。超过部分不计入任何一屏：系统休眠、标签页节流、
// 排版/翻页进行中都会留下这种空洞，把它们当成「在读」等于白送进度。
export const DWELL_MAX_GAP_MS = 2_000
// 滚动模式一屏的容差带宽度 = 屏宽 × 该倍数。带宽含起始那一屏，倍数 2 表示
// 「在起始屏之外还能再滑过一整屏」：慢读到这个边界时已经停留 ≥30s，正好等于
// 分页模式「30 秒读一屏」的节奏；快速拖动会在两三秒内冲出容差带，带内凑不满
// 30s 就被丢弃，所以不会把整章刷成已读。
export const DWELL_BAND_TOLERANCE = 2

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

// ── 停留计时（读满 30 秒才算一页）────────────────────────────────────────
// 纯逻辑状态机：不读时钟、不碰 DOM，时间一律由调用方传进来的 now（单调毫秒，
// 浏览器侧用 performance.now()）决定，这样单测可以任意加速推进，也让
// 「页面隐藏冻结计时」这种规则在 js/reader.js 里用 pause/resume 明确表达。
//
// 工作方式：把连续的阅读过程切成「带」（band）——
//   · 分页模式（discrete=true）：一屏就是一个带，区间完全相同才算还在同一屏。
//     换屏（翻页）、换章时旧带直接作废：积满 30s 的早已在 observe 里提交过，
//     没积满的就是「没读够就走了」，不计入。
//   · 滚动模式：位置随滚动连续变化，没有离散页。带 = 进入时的那一屏，
//     之后把视口扫过的区间并进带（这就是「最近连续 30 秒活动内的区间并集」）；
//     每积满 30s 计入一次并集，并集一旦超出「屏宽 × tolerance」就结算这一带并开新带。
//     于是连续慢读按实际阅读速度稳定涨进度；来回快速拖动因为每一带都凑不满 30s
//     而被丢弃，不会把整章刷成已读。
// 计时只在可见且未暂停时推进，且单次推进不超过 maxGapMs（见 DWELL_MAX_GAP_MS），
// 系统休眠、定时器被节流留下的空洞不会补给随便哪一屏。
export class DwellMeter {
    #band = null
    #last = null
    #paused = false

    constructor ({ dwellMs = PAGE_DWELL_MS, maxGapMs = DWELL_MAX_GAP_MS, tolerance = DWELL_BAND_TOLERANCE } = {}) {
        this.dwellMs = dwellMs
        this.maxGapMs = maxGapMs
        this.tolerance = tolerance
    }

    // 当前正在计时的带（调试与单测用）：{ index, a, b, elapsed, discrete } 或 null
    get pending () {
        if (!this.#band) return null
        const { index, a, b, elapsed, discrete } = this.#band
        return { index, a, b, elapsed, discrete }
    }

    // 推进内部时钟，返回这一次可计入的时长（ms）；暂停或首次观察记 0
    #advance (now) {
        const t = Number(now)
        if (!Number.isFinite(t)) return 0
        if (this.#paused || this.#last == null) { this.#last = t; return 0 }
        const dt = Math.max(0, Math.min(this.maxGapMs, t - this.#last))
        this.#last = t
        return dt
    }

    // 观察一次「当前屏」。返回需要计入 readMap 的区间 [[index,a,b], ...]（0 或 1 项）。
    // discrete=true 走分页规则，false 走滚动的滑动容差带规则。
    observe (index, a, b, now, discrete = true) {
        if (!Number.isFinite(Number(now))) return [] // 时间不可信就什么都不做，不乱推进也不清计时
        const range = normalizeRanges([[a, b]])[0]
        if (!Number.isInteger(index) || index < 0 || !range) return []
        const dt = this.#advance(now)
        const commits = []
        const band = this.#band
        const sameKind = band && band.index === index && band.discrete === discrete
        if (!sameKind) {
            // 换章、换书、换阅读模式：旧带未满 30s 的部分就此取消（满了的早已提交）
            this.#band = this.#newBand(index, range, dt, discrete)
            return commits
        }
        if (discrete) {
            // 分页：区间一模一样才算「还停在同一屏」，换屏即取消旧计时
            if (Math.abs(band.a - range[0]) < 1e-9 && Math.abs(band.b - range[1]) < 1e-9) band.elapsed += dt
            else { this.#band = this.#newBand(index, range, dt, discrete); return commits }
        } else {
            const lo = Math.min(band.a, range[0]), hi = Math.max(band.b, range[1])
            const allowed = Math.max(band.unit, range[1] - range[0]) * this.tolerance
            if (hi - lo <= allowed) { band.a = lo; band.b = hi; band.elapsed += dt }
            else {
                // 冲出容差带（滚动/拖动了一段距离）：这一带只有攒满 30s 的残量才结算
                if (band.elapsed - band.credited >= this.dwellMs) commits.push([band.index, band.a, band.b])
                this.#band = this.#newBand(index, range, dt, discrete)
                return commits
            }
        }
        const cur = this.#band
        // 满 30s 就地计入；原地久读会周期性重复命中同一段，调用方用 addRange 幂等去重
        if (cur.elapsed - cur.credited >= this.dwellMs) {
            commits.push([cur.index, cur.a, cur.b])
            cur.credited = cur.elapsed
        }
        return commits
    }

    #newBand (index, [a, b], elapsed, discrete) {
        return { index, a, b, unit: b - a, elapsed, credited: 0, discrete }
    }

    // document.hidden：切后台/切标签页期间不累积阅读时长，resume 后继续计同一带
    pause (now) { this.#paused = true; this.#last = Number.isFinite(Number(now)) ? Number(now) : this.#last }
    resume (now) { this.#paused = false; this.#last = Number.isFinite(Number(now)) ? Number(now) : this.#last }
    get paused () { return this.#paused }

    // 关书、回书架、进度归零：未读满 30s 的计时全部取消，不留残余
    cancel () { this.#band = null }
}
