import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getDraft, setDraft, clearDraft, pruneDrafts, draftKey, draftCount } from '../js/note-drafts.js?v=1.0.0'

// localStorage shim（Node 无 DOM）
const store = new Map()
globalThis.localStorage = {
    getItem: k => store.has(k) ? store.get(k) : null,
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
}

test('草稿写入与读取往返', () => {
    setDraft('b1', 'n1', '未写完的想法')
    assert.equal(getDraft('b1', 'n1'), '未写完的想法')
})

test('无草稿返回空串；ignoreSaved 与已保存一致时视为无草稿', () => {
    setDraft('b1', 'n2', '已保存的心得')
    assert.equal(getDraft('b1', 'n2', '已保存的心得'), '')
    assert.equal(getDraft('b1', 'n2', '别的'), '已保存的心得')
    assert.equal(getDraft('b1', '不存在'), '')
})

test('清空草稿：空文本写入等价删除', () => {
    pruneDrafts([])
    setDraft('b1', 'n3', 'x')
    clearDraft('b1', 'n3')
    assert.equal(getDraft('b1', 'n3'), '')
    setDraft('b1', 'n3', '')
    assert.equal(draftCount(), 0)
})

test('pruneDrafts 只保留现存笔记的草稿', () => {
    setDraft('b1', 'keep1', 'a')
    setDraft('b2', 'keep2', 'b')
    setDraft('b1', 'gone', 'c')
    pruneDrafts([['b1', 'keep1'], ['b2', 'keep2']])
    assert.equal(getDraft('b1', 'keep1'), 'a')
    assert.equal(getDraft('b2', 'keep2'), 'b')
    assert.equal(getDraft('b1', 'gone'), '')
})

test('超长文本截断；条数超限时淘汰最旧', () => {
    const long = 'x'.repeat(200001)
    setDraft('b9', 'n0', long)
    assert.equal(getDraft('b9', 'n0').length, 100000)
    clearDraft('b9', 'n0')
    for (let i = 0; i < 205; i++) setDraft('bx', 'n' + i, 'v' + i)
    assert.ok(draftCount() <= 200)
    // 最旧的被淘汰，最新仍在
    assert.equal(getDraft('bx', 'n0'), '')
    assert.equal(getDraft('bx', 'n204'), 'v204')
})

test('损坏的存储内容安全降级为空', () => {
    store.set('reader.noteDrafts', 'not json{{{')
    assert.equal(getDraft('b', 'n'), '')
    setDraft('b', 'n', 'ok') // 不抛错
    assert.equal(getDraft('b', 'n'), 'ok')
    store.set('reader.noteDrafts', '[1,2,3]')
    assert.equal(getDraft('b', 'n'), '')
})

test('draftKey 转义为字符串', () => {
    assert.equal(draftKey(1, 2), '1:2')
})
