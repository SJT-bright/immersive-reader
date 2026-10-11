// 目录「页级明细」的纯函数单测：把 js/main.js 里 TOC-PURE-START / TOC-PURE-END 标记间的
// 那段源码抽出来当独立模块跑（main.js 本身依赖 DOM，不能被 import），
// 再用 foliate 真实的 SectionProgress 反向校验「第 p 页」折算出的全书 fraction 能否落回第 p 页。
//
// 运行：node --test tests/toc-pages.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SectionProgress } from '../vendor/foliate-js/progress.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const mainSrc = readFileSync(join(root, 'js/main.js'), 'utf8')

// 抽取纯函数段：标记丢了就当场失败，避免测试悄悄变成空跑
const pure = (() => {
    const from = mainSrc.indexOf('// ==== TOC-PURE-START ====')
    const to = mainSrc.indexOf('// ==== TOC-PURE-END ====')
    assert.ok(from > 0 && to > from, 'js/main.js 里找不到 TOC-PURE 标记，页级纯函数无法单测')
    const body = mainSrc.slice(from, to)
    const load = new Function(`${body}
        return { tocPageCoverage, tocPageState, tocPageAnchor, tocChapterPageFraction }`)
    return load()
})()
const { tocPageCoverage, tocPageState, tocPageAnchor, tocChapterPageFraction } = pure

const almost = (t, actual, expected, eps = 1e-9, msg = '') =>
    assert.ok(Math.abs(actual - expected) < eps, `${msg}期望 ${expected}，实得 ${actual}`)

test('抽取到的纯函数段是自包含的（不引用 reader / DOM）', () => {
    const from = mainSrc.indexOf('// ==== TOC-PURE-START ====')
    const to = mainSrc.indexOf('// ==== TOC-PURE-END ====')
    // 注释里提到 reader/foliate 是必要的说明，剥离注释后再检查真正的代码体
    const code = mainSrc.slice(from, to).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
    for (const forbidden of ['reader.', 'document', 'window.', 'localStorage', 'coverageOf']) {
        assert.equal(code.includes(forbidden), false, `纯函数段不应依赖 ${forbidden}`)
    }
})

test('整章读满：每一页都是 100%', t => {
    const out = tocPageCoverage([[0, 1]], 13)
    assert.equal(out.length, 13)
    for (const [i, r] of out.entries()) {
        almost(t, r, 1, 1e-9, `第 ${i + 1} 页 `)
        assert.equal(tocPageState(r), 'read')
    }
    // 合并后的多段区间（读满 = 两段拼接）与整段等价
    assert.deepEqual(tocPageCoverage([[0, 0.4], [0.4, 1]], 13).map(x => Math.round(x)), out.map(x => Math.round(x)))
})

test('读半章：前半页读满、分界那页按比例、后半页为 0', t => {
    const out = tocPageCoverage([[0, 0.5]], 13)
    assert.equal(out.length, 13)
    for (let p = 1; p <= 6; p++) almost(t, out[p - 1], 1, 1e-9, `第 ${p} 页 `)
    almost(t, out[6], 0.5, 1e-9, '第 7 页（0.5 正好落在页中）')
    for (let p = 8; p <= 13; p++) assert.equal(out[p - 1], 0, `第 ${p} 页未读`)
    assert.equal(tocPageState(out[6]), 'part')
    assert.equal(tocPageState(out[7]), 'none')
    // 覆盖总量守恒：Σ(页比例)/页数 = 区间覆盖率
    almost(t, out.reduce((a, b) => a + b, 0) / 13, 0.5, 1e-9)
})

test('跳读中间页：只有被读到的那几页有比例，其余为 0', t => {
    // 读过第 5、6 页（章内区间 [4/13, 6/13]）
    const out = tocPageCoverage([[4 / 13, 6 / 13]], 13)
    assert.deepEqual(out.map(x => Math.round(x)), [0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0])
    // 只读中间一页的一半
    const half = tocPageCoverage([[6 / 13, 6.5 / 13]], 13)
    almost(t, half[6], 0.5, 1e-9, '第 7 页读了一半 ')
    assert.equal(tocPageState(half[6]), 'part')
    // 重叠/乱序区间要先归并，不能重复计数
    const dup = tocPageCoverage([[6 / 13, 7 / 13], [6.4 / 13, 6.8 / 13], [0 / 13, 1 / 13]], 13)
    almost(t, dup.reduce((a, b) => a + b, 0) / 13, 2 / 13, 1e-9, '重叠区间归并后的总覆盖率 ')
})

test('pages=0 与非法入参一律降级为空数组 / 零覆盖', t => {
    for (const pages of [0, -3, 1.5, NaN, undefined, null, '13']) {
        assert.deepEqual(tocPageCoverage([[0, 1]], pages), [], `pages=${pages} 应返回空数组`)
    }
    // 区间非法（缺失、非数字、越界、长度不合法）时不抛异常，全 0
    const zeros = [null, undefined, 'x', [], [null], [[0]], [[NaN, 1]], [[2, 3]], [['a', 'b']]]
    for (const ranges of zeros) {
        const out = tocPageCoverage(ranges, 10)
        assert.equal(out.length, 10)
        assert.equal(out.every(x => x === 0), true, `${JSON.stringify(ranges)} 应全为 0，实得 ${out}`)
    }
    // 越界区间裁剪到 [0,1] 后仍然有效
    almost(t, tocPageCoverage([[-0.5, 1.5]], 10).reduce((a, b) => a + b, 0) / 10, 1, 1e-9)
    assert.equal(tocPageState(NaN), 'none')
    assert.equal(tocPageState(1.4), 'read')
    assert.equal(tocPageState(-1), 'none')
})

test('tocPageAnchor：页中点在分页/滚动两种落点公式下都精确命中第 p 页', () => {
    for (const T of [2, 3, 5, 13, 40, 137]) {
        for (let p = 1; p <= T; p++) {
            const a = tocPageAnchor(p, T)
            // 必须严格落在 (0,1) 内：压到边界会让全书 fraction 反解串到相邻章节
            assert.ok(a > 0 && a < 1, `T=${T} p=${p} 的 anchor ${a} 越界`)
            // 分页模式：foliate paginator 用 round(anchor*(T-1))+1
            assert.equal(Math.round(a * (T - 1)) + 1, p, `分页模式 T=${T} p=${p} 落点错`)
            // 滚动模式：paginator 落在 floor(anchor*T)+1
            assert.equal(Math.floor(a * T) + 1, p, `滚动模式 T=${T} p=${p} 落点错`)
        }
    }
    // 降级入参
    assert.equal(tocPageAnchor(1, 0), 0)
    assert.equal(tocPageAnchor(0, 13), 0)
    assert.equal(tocPageAnchor(14, 13), 0)
    assert.equal(tocPageAnchor(1, 1), 0)
})

test('tocChapterPageFraction：用 foliate 真实 SectionProgress 反解，章节与页码都不串位', t => {
    // 各章权重（字符量，与 reading-stats.sectionSizesFrom 同口径），含一个 0 权重章
    const rawSizes = [1200, 900, 0, 480, 2600, 1500, 700]
    const sp = new SectionProgress(rawSizes.map(s => ({ size: s, linear: 'yes' })), 1500, 1600)
    for (let index = 0; index < rawSizes.length; index++) {
        if (!rawSizes[index]) {
            // 权重为 0 的章定位不了：返回 null，由调用方退回章首，绝不猜
            assert.equal(tocChapterPageFraction(index, 1, 5, rawSizes), null, `第 ${index} 章权重为 0 应返回 null`)
            continue
        }
        for (const T of [2, 7, 13]) {
            for (let page = 1; page <= T; page++) {
                const f = tocChapterPageFraction(index, page, T, rawSizes)
                assert.ok(f != null && f > 0 && f < 1, `第 ${index} 章第 ${page} 页的 fraction 越界：${f}`)
                const [gotIndex, anchor] = sp.getSection(f)
                assert.equal(gotIndex, index, `fraction ${f} 落到了第 ${gotIndex} 章，应为第 ${index} 章`)
                // 分页模式的落点公式（paginator.#scrollToAnchor）
                assert.equal(Math.round(anchor * (T - 1)) + 1, page,
                    `第 ${index} 章请求第 ${page} 页，实落 ${Math.round(anchor * (T - 1)) + 1}`)
                // 滚动模式的落点公式
                assert.equal(Math.floor(anchor * T) + 1, page, `滚动模式第 ${index} 章第 ${page} 页落点错`)
            }
        }
    }
    // sizes 缺失 / 越界 / 非数组都归 null
    assert.equal(tocChapterPageFraction(0, 1, 5, null), null)
    assert.equal(tocChapterPageFraction(9, 1, 5, rawSizes), null)
    assert.equal(tocChapterPageFraction(-1, 1, 5, rawSizes), null)
    assert.equal(tocChapterPageFraction('0', 1, 5, rawSizes), null)
})

test('页明细的接线：新接口按可选调用，降级路径与章跳转入口保持原样', () => {
    // reader.chapterPages 由并行会话补，必须先可选调用
    assert.match(mainSrc, /reader\.chapterPages\?\.\(index\)/)
    // 展开走独立控件，页码芯片另起一个 action，章行本身仍是跳转按钮
    assert.match(mainSrc, /data-action="toc-toggle-pages"/)
    assert.match(mainSrc, /data-action="toc-page-go"/)
    assert.equal((mainSrc.match(/data-action="toc-go" data-href/g) || []).length, 2,
        '开书抽屉与读书浮层的 toc-go 不能被改掉')
    assert.match(mainSrc, /data-action="home-toc-go"/)
    // 页内跳转不构造 CFI，走 foliate 的 { fraction } 导航；算不出来才退回章首
    const jump = mainSrc.slice(mainSrc.indexOf('async function goToChapterPage'),
        mainSrc.indexOf('// 目录过滤'))
    assert.ok(mainSrc.includes('async function goToChapterPage'), '缺少 goToChapterPage 跳转入口')
    assert.match(jump, /const target = fraction != null \? \{ fraction \} : href/)
    assert.match(jump, /reader\.goTo\(target\)/)
    assert.equal(jump.includes('getCFI'), false, '页内跳转不应退回去拼 CFI')
    // 样式：半透明叠色，不铺不透明白底
    const css = readFileSync(join(root, 'css/experience.css'), 'utf8')
    const at = css.indexOf('/* ==== 目录页级明细')
    assert.ok(at > 0, 'experience.css 末尾缺少页级明细样式段')
    const block = css.slice(at)
    assert.match(block, /\.toc-page\.read/)
    assert.match(block, /background:\s*(?:transparent|rgba\([^)]*,\s*\.0[0-9]+\))\s*!important/)
    assert.equal(/background:\s*#[0-9a-f]{3,8}\b/i.test(block), false, '页级明细不能铺实心底色')
    assert.equal(/background:\s*rgba?\([^)]*,\s*1\)/.test(block), false, '页级明细不能铺不透明叠色')
})
