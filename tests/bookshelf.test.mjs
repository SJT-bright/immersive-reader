// 书架渲染单元测试
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { coverTheme, coverSpec, THEME_COUNT, LAYOUT_COUNT, shelfHTML } from '../js/bookshelf.js'

test('封面主题由 id 稳定决定且落在主题数内', () => {
    for (let i = 0; i < 200; i++) {
        const id = 'book-' + i
        const theme = coverTheme(id)
        assert.equal(theme, coverTheme(id), '同 id 主题必须一致')
        for (const key of ['c1', 'c2', 'ink', 'accent']) {
            assert.match(theme[key], /^#[0-9a-f]{6}$/i, key + ' 必须是 6 位十六进制色')
        }
    }
    assert.ok(THEME_COUNT >= 12)
    assert.ok(coverTheme('a').c1 !== undefined)
    assert.equal(coverTheme('a').c1, coverSpec('a').palette.a)
})

test('多个 id 命中多个主题与多种分区（分布非单一）', () => {
    const palettes = new Set()
    const layouts = new Set()
    for (let i = 0; i < 80; i++) {
        const spec = coverSpec('id-' + i)
        palettes.add(spec.palette.a)
        layouts.add(spec.layout)
    }
    assert.ok(palettes.size >= 6, '80 个 id 只命中 ' + palettes.size + ' 种主色')
    assert.ok(layouts.size >= 4, '80 个 id 只命中 ' + layouts.size + ' 种分区')
    assert.ok(LAYOUT_COUNT >= 6)
})

test('书架条目包含打开/删除动作与 id', () => {
    const html = shelfHTML([{ id: 'b1', title: '测试书', author: '作者', format: 'epub', progress: { percent: 0.42 } }])
    assert.match(html, /data-action="open-book" data-id="b1"/)
    assert.match(html, /data-action="del-book" data-id="b1"/)
    assert.match(html, /aria-label="打开《测试书》EPUB · 作者 · 42%"/)
    assert.match(html, /width:42%/)
    assert.match(html, /book-top/, '应包含顶部书页切面')
    assert.match(html, /data-layout="/, '封面带分区构图')
    assert.match(html, /cover-a/, '封面有色块区')
    assert.match(html, /cover-b/, '封面有书名区')
    assert.match(html, /book-progress/, '进度在书下方')
    assert.match(html, /--bt:\d+px/, '每本书有独立书脊厚度')
})

test('每本书带递增的入场序号 --i', () => {
    const books = [{ id: 'a', title: '甲', format: 'epub' }, { id: 'b', title: '乙', format: 'epub' }, { id: 'c', title: '丙', format: 'epub' }]
    const html = shelfHTML(books)
    const indices = [...html.matchAll(/--i:(\d+);/g)].map(m => Number(m[1]))
    assert.deepEqual(indices, [0, 1, 2])
})

test('书名与作者中的 HTML 被转义', () => {
    const html = shelfHTML([{ id: 'x', title: '<img src=x onerror=1>', author: 'a&b', format: 'txt' }])
    assert.ok(!html.includes('<img src=x'))
    assert.match(html, /&lt;img/)
    assert.match(html, /a&amp;b/)
})

test('进度越界被夹紧', () => {
    const over = shelfHTML([{ id: 'a', title: 't', format: 'epub', progress: { percent: 1.5 } }])
    assert.match(over, /width:100%/)
    const none = shelfHTML([{ id: 'b', title: 't', format: 'epub' }])
    assert.match(none, /width:0%/)
})

test('格式标签映射与空列表', () => {
    assert.match(shelfHTML([{ id: 'p', title: 't', format: 'pdf' }]), /PDF · 文字版/)
    assert.match(shelfHTML([{ id: 'e', title: 't', format: 'epub' }]), /EPUB/)
    assert.match(shelfHTML([{ id: 'x', title: 't', format: 'txt' }]), /TXT/)
    assert.equal(shelfHTML([]), '')
    assert.equal(shelfHTML(null), '')
})
