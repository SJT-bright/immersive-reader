// 修复批次 F2 的 txt-detect 单测：UTF-8 BOM 后的 GBK 正文要走候选评分而不是直接吐乱码；
// 编码判定只读文件头样本、确定后整体解码一次。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { detectText } from '../js/txt-detect.js'

// 「第一章 山中的信\n雾从谷底慢慢涨上来，淹没了来时那条路。」的 GB18030 字节
const GBK_FRAGMENT = Buffer.from(
    'tdrSu9XCIMm91tC1xNDFCs7ttNO5yLXXwv3C/dXHyc/AtKOs0c3Du8HLwLTKscTHzPXCt6Gj', 'base64')
const GBK_TEXT = new TextDecoder('gb18030').decode(GBK_FRAGMENT)
const utf8Bytes = text => Buffer.from(text, 'utf-8')

test('F2-9 UTF-8 BOM ＋ GBK 正文：落到候选评分，认出 gb18030 且正文可读', () => {
    const withBom = new Uint8Array(Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), GBK_FRAGMENT]))
    const r = detectText(withBom)
    assert.equal(r.encoding, 'gb18030', `BOM 后的 GBK 正文应经候选评分判为 gb18030，实得 ${r.encoding}`)
    assert.equal(r.quality, 'exact')
    assert.equal(r.text.includes('\uFFFD'), false, '正文含替换字符＝解码是乱的')
    assert.equal(r.text, GBK_TEXT)
    assert.ok(r.text.includes('第一章'))
})

test('F2-9 真正的 BOM＋UTF-8 文件仍判 utf-8-bom/exact（回归位）', () => {
    const bytes = new Uint8Array(Buffer.concat([
        Buffer.from([0xEF, 0xBB, 0xBF]), utf8Bytes('第一章 山中的信\n雾从谷底涨上来。')]))
    const r = detectText(bytes)
    assert.deepEqual({ encoding: r.encoding, quality: r.quality }, { encoding: 'utf-8-bom', quality: 'exact' })
    assert.ok(r.text.startsWith('第一章'))
    assert.equal(r.text.includes('\uFFFD'), false)
})

test('F2-9 BOM＋正文两边都解不通时仍按 best-effort 报告，不谎称 exact', () => {
    // BOM + 0xA0：严格 UTF-8、gb18030、big5 三种解码都拒绝这个字节
    // → 只剩「容错 UTF-8」这一个候选，名字仍报 utf-8-bom，但质量必须是 best-effort
    const bytes = new Uint8Array(Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from([0xA0])]))
    const r = detectText(bytes)
    assert.equal(r.encoding, 'utf-8-bom')
    assert.equal(r.quality, 'best-effort', `不可证实的解码必须标 best-effort，实得 ${r.quality}`)
    assert.ok(r.text.includes('\uFFFD'))
})

test('F2-13 大文件只按样本判定编码，确定后整体解码一次', () => {
    // 4MB 的 GBK 语料：旧实现会做「utf-8 严格→gb18030 严格→big5 严格→整体容错」
    // 加两遍全量逐码点评分，实测 20MB 卡主线程 1.7 秒。
    const big = Buffer.from(GBK_FRAGMENT.toString('latin1').repeat(98000), 'latin1')
    assert.ok(big.length > 4 * 1024 * 1024, `样本用例本身要够大，实得 ${big.length}`)
    const native = TextDecoder
    const seen = []
    globalThis.TextDecoder = class Counting extends native {
        decode(input, options) {
            seen.push(input?.byteLength || 0)
            return super.decode(input, options)
        }
    }
    const started = performance.now()
    let r
    try { r = detectText(new Uint8Array(big)) } finally { globalThis.TextDecoder = native }
    const elapsed = performance.now() - started
    // 判定阶段的每一次解码都只能读文件头（512KB 样本），全量解码只允许一次
    const oversized = seen.filter(n => n > 600 * 1024)
    assert.equal(oversized.length, 1, `全量解码 ${oversized.length} 次，应当只有确定编码后的那一次`)
    const totalBytes = seen.reduce((a, b) => a + b, 0)
    assert.ok(totalBytes < big.length * 1.5, `累计解码 ${totalBytes} 字节，超过文件本身 1.5 倍`)
    assert.equal(r.encoding, 'gb18030')
    assert.equal(r.quality, 'exact')
    assert.equal(r.text.includes('\uFFFD'), false)
    assert.equal(r.text.length, 98000 * GBK_TEXT.length)
    assert.ok(elapsed < 800, `识别耗时 ${elapsed.toFixed(0)}ms，仍在主线程上偏久`)
})

test('F2-13 样本过关但文件后半段有坏字节：仍按 UTF-8 容错，不退成 gb18030 乱码', () => {
    const body = utf8Bytes('第一章 山中的信\n'.repeat(50000).slice(0, 700 * 1024))
    const broken = Buffer.from(body)
    broken[broken.length - 100] = 0xC3 // 尾部塞一个不完整的 UTF-8 前导字节
    const r = detectText(new Uint8Array(broken))
    assert.equal(r.encoding, 'utf-8')
    assert.equal(r.quality, 'best-effort')
    assert.ok(r.text.startsWith('第一章 山中的信'), '正文主体必须仍然是 UTF-8 解出来的')
})

test('F2-13 样本切点不砍断多字节字符（严格判定不误报）', () => {
    // 让 512KB 正好落在一个三字节汉字的中间：切点回退到最近的 ASCII 之后才算严格通过
    const head = '山'.repeat(200000) // 600KB 的 UTF-8 正文，无 ASCII
    const bytes = new Uint8Array(utf8Bytes(head))
    const r = detectText(bytes)
    assert.deepEqual({ encoding: r.encoding, quality: r.quality }, { encoding: 'utf-8', quality: 'exact' })
    assert.equal(r.text.length, 200000)
})
