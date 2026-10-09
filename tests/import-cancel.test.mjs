// txt-detect 判定补丁：无 BOM UTF-16 嗅探、非中文候选的评分下限。
// 以及导入取消约定：signal 在协作循环让步点抛 name='AbortError'。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { detectText } from '../js/txt-detect.js'
import { splitChaptersAsync, chaptersToEpubBlob } from '../js/txt2epub.js'

test('无 BOM 的 UTF-16（ASCII 内容）被嗅探；中文无 BOM UTF-16 至少不再谎报「精确」', () => {
    const le = detectText(Buffer.from('Hello, 无 BOM 世界！', 'utf16le'))
    assert.equal(le.encoding, 'utf-16le')
    assert.equal(le.text, 'Hello, 无 BOM 世界！')
    assert.equal(le.quality, 'exact')
    // 带 BOM 的 BE 走原路径，作回归对照（Buffer 不支持 utf16be，手工换字节序）
    const leBytes = Buffer.from('测试文本', 'utf16le')
    const be = Buffer.alloc(2 + leBytes.length)
    be[0] = 0xFE; be[1] = 0xFF
    for (let i = 0; i < leBytes.length; i += 2) {
        be[2 + i] = leBytes[i + 1]
        be[2 + i + 1] = leBytes[i]
    }
    const beDetected = detectText(be)
    assert.equal(beDetected.encoding, 'utf-16be')
    assert.equal(beDetected.text, '测试文本')
    // 已知边界：中文的无 BOM UTF-16 没有 NUL 字节可嗅探（CJK 码位高字节常 <0x80），
    // 字节级无法与 GBK/UTF-8 可靠区分——要求它不再谎报「精确识别」，降级为 best-effort
    // 让 UI 提示「编码无法确定」。
    const cn = detectText(Buffer.from('山居小记', 'utf16le'))
    assert.equal(cn.quality, 'best-effort', `中文无 BOM UTF-16 应诚实降级，实际 ${cn.quality}`)
})

test('西文旧编码不再拿到「精确识别」的乱码；真 GBK 中文仍 exact', () => {
    // Windows-1252 系西文：UTF-8 严格解码失败，gb18030 能「严格解出」但全是非 CJK 噪声
    const latin = Buffer.from('Caf\xe9 r\xe9sum\xe9 na\xefve fa\xe7ade — plain western text.', 'latin1')
    const r = detectText(latin)
    assert.equal(r.quality, 'best-effort', `西文旧编码必须降级为 best-effort，实际 ${r.quality}`)
    // 真 GBK 中文（手工字节：「中文，测试」）不受影响：仍然 gb18030 + exact
    const gbk = Buffer.from([0xD6, 0xD0, 0xCE, 0xC4, 0xA3, 0xAC, 0xB2, 0xE2, 0xCA, 0xD4])
    const g = detectText(gbk)
    assert.equal(g.encoding, 'gb18030')
    assert.equal(g.quality, 'exact')
})

test('取消约定：signal 已中止时协作循环在让步点抛 AbortError', async () => {
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
        () => splitChaptersAsync(Array(50000).fill('一行内容').join('\n'), { signal: controller.signal }),
        err => err.name === 'AbortError',
    )
    await assert.rejects(
        () => chaptersToEpubBlob([{ title: '甲', paragraphs: ['内容。'] }], '书名', '', { cooperative: true, signal: controller.signal }),
        err => err.name === 'AbortError',
    )
})

test('取消约定：导入中途取消（先创建后中止）也会中止', async () => {
    const controller = new AbortController()
    const promise = splitChaptersAsync(Array(200000).fill('一行足够长的中文内容用来跨过分片阈值。').join('\n'), {
        slice: 20000,
        signal: controller.signal,
    })
    controller.abort() // 切分进行中中止
    await assert.rejects(promise, err => err.name === 'AbortError')
})
