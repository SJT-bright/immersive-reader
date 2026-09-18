import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { detectText, parseTxtFilename } from '../js/txt-detect.js?v=1.0.0'

const fx = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url))

// 可读性断言：无替换字符、无 GBK 双重乱码特征串、CJK 表意文字占非 ASCII 字符比例 > 0.5
function assertReadable(text, label) {
    assert.ok(!text.includes('\uFFFD'), `${label}: 含替换字符`)
    for (const m of ['锟斤拷', '烫烫烫', '屯屯屯', '唳唳唳']) assert.ok(!text.includes(m), `${label}: 含乱码特征串 ${m}`)
    const chars = [...text], nonAscii = chars.filter(c => c.codePointAt(0) > 127)
    assert.ok(nonAscii.length > 0, `${label}: 无非 ASCII 字符`)
    const cjk = nonAscii.filter(c => { const n = c.codePointAt(0); return n >= 0x4E00 && n <= 0x9FFF })
    assert.ok(cjk.length / nonAscii.length > 0.5, `${label}: CJK 占比仅 ${(cjk.length / nonAscii.length).toFixed(2)}`)
}

test('六种 TXT 语料识别出正确编码且正文可读', () => {
    const u8 = detectText(fx('txt-utf8.txt'))
    assert.deepEqual({ encoding: u8.encoding, quality: u8.quality }, { encoding: 'utf-8', quality: 'exact' })
    assert.ok(u8.text.includes('第一章') && u8.text.includes('第二章'))

    const bom = detectText(fx('txt-utf8-bom.txt'))
    assert.deepEqual({ encoding: bom.encoding, quality: bom.quality }, { encoding: 'utf-8-bom', quality: 'exact' })
    assert.ok(bom.text.startsWith('第一章'))

    const le = detectText(fx('txt-utf16le.txt'))
    assert.deepEqual({ encoding: le.encoding, quality: le.quality }, { encoding: 'utf-16le', quality: 'exact' })
    assert.ok(le.text.includes('第二章'))

    const gb = detectText(fx('txt-gb18030.txt'))
    assert.deepEqual({ encoding: gb.encoding, quality: gb.quality }, { encoding: 'gb18030', quality: 'exact' })
    assertReadable(gb.text, 'gb18030')
    assert.ok(gb.text.includes('第一章'))

    // Big5 语料：评分选择 big5（实测 big5≈2.73 分 > gb18030 误解码≈0.80 分），若未来回落到 gb18030 也必须可读
    const big = detectText(fx('txt-big5.txt'))
    assert.ok(big.encoding === 'big5' || big.encoding === 'gb18030', big.encoding)
    assert.equal(big.quality, 'exact')
    assertReadable(big.text, 'big5')
    assert.ok(big.text.includes('第一章'))

    // 陷阱语料：UTF-8 中文必须被严格 UTF-8 先命中，不能被 gb18030 候选抢走
    const trap = detectText(fx('txt-mojibake-trap.txt'))
    assert.deepEqual({ encoding: trap.encoding, quality: trap.quality }, { encoding: 'utf-8', quality: 'exact' })
    assertReadable(trap.text, 'trap')
})

test('带 BOM 的 UTF-16BE 走 BOM 路径且解出原文', () => {
    const bytes = Buffer.from('\uFEFF第二章 風起', 'utf-16le')
    for (let i = 0; i + 1 < bytes.length; i += 2) { const t = bytes[i]; bytes[i] = bytes[i + 1]; bytes[i + 1] = t } // LE 字节对交换 → BE
    const be = detectText(bytes)
    assert.deepEqual({ encoding: be.encoding, quality: be.quality }, { encoding: 'utf-16be', quality: 'exact' })
    assert.equal(be.text, '第二章 風起')
})

test('detectText 接受 ArrayBuffer（契约入参形态）', () => {
    const r = detectText(new Uint8Array(fx('txt-utf8.txt')).buffer)
    assert.equal(r.encoding, 'utf-8')
    assert.ok(r.text.includes('第一章'))
})

test('空缓冲区返回空文本 utf-8 exact', () => {
    assert.deepEqual(detectText(new ArrayBuffer(0)), { text: '', encoding: 'utf-8', quality: 'exact' })
})

test('全部候选淘汰时回退 gb18030 容错解码', () => {
    const r = detectText(new Uint8Array([0x81])) // 畸形前导字节：utf-8/gb18030/big5 严格解码均抛错
    assert.deepEqual({ encoding: r.encoding, quality: r.quality }, { encoding: 'gb18030', quality: 'best-effort' })
    assert.ok(r.text.includes('\uFFFD'))
})

test('parseTxtFilename 覆盖全部识别模式', () => {
    const T = (n, title, author) => assert.deepEqual(parseTxtFilename(n), { title, author }, n)
    T('《三体》刘慈欣.txt', '三体', '刘慈欣')        // 契约示例：书名号在前
    T('《三体》刘慈欣.TXT', '三体', '刘慈欣')        // 扩展名大小写不敏感
    T('刘慈欣《三体》.txt', '三体', '刘慈欣')        // 作者在书名号前
    T('《三体》.txt', '三体', '')                    // 仅书名号
    T('三体 - 刘慈欣.txt', '三体', '刘慈欣')         // 横杠
    T('三体—刘慈欣.txt', '三体', '刘慈欣')           // 无空格破折号
    T('三体 - by 刘慈欣.txt', '三体', '刘慈欣')      // 横杠 + by
    T('三体 BY 刘慈欣.txt', '三体', '刘慈欣')        // by 大小写不敏感
    T('三体(刘慈欣).txt', '三体', '刘慈欣')          // 半角括号
    T('三体（刘慈欣）.txt', '三体', '刘慈欣')        // 全角括号
    T('三体[刘慈欣].txt', '三体', '刘慈欣')          // 方括号
    T('刘慈欣：三体.txt', '三体', '刘慈欣')          // 全角冒号
    T('刘慈欣: 三体.txt', '三体', '刘慈欣')          // 半角冒号 + 空格
    T('《三体》- 刘慈欣.txt', '三体', '刘慈欣')      // 书名号后紧邻横杠，作者段首部清理
    T('三体 - 《选集》.txt', '选集', '三体')         // 书名号模式优先于横杠，作者段尾部横杠清理
})

test('parseTxtFilename 边界：空串、纯数字名、超长截断、包裹符号', () => {
    assert.deepEqual(parseTxtFilename(''), { title: '', author: '' })
    assert.deepEqual(parseTxtFilename('   '), { title: '', author: '' })
    assert.deepEqual(parseTxtFilename('1984.txt'), { title: '1984', author: '' })
    assert.deepEqual(parseTxtFilename('  《围城》 钱钟书 .txt '), { title: '围城', author: '钱钟书' })
    assert.equal(parseTxtFilename('长'.repeat(100) + '.txt').title.length, 80)      // 书名上限 80 字
    assert.equal(parseTxtFilename('三体 - ' + '慈'.repeat(50) + '.txt').author.length, 40) // 作者上限 40 字
    assert.deepEqual(parseTxtFilename('“三体” - 刘慈欣.txt'), { title: '三体', author: '刘慈欣' }) // 引号包裹剥离
})
