// 桌面壳监督助手的纯逻辑单测：健康三态归类与重启退避序列。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { classifyHealth, backoffDelay, MAX_RESTART_ATTEMPTS } = require('../desktop/supervisor.cjs')

test('健康检查三态：本应用 / 被占用 / 空闲', () => {
    assert.equal(classifyHealth({ kind: 'json', json: { app: 'immersive-reader' } }), 'ours')
    assert.equal(classifyHealth({ kind: 'json', json: { app: 'something-else' } }), 'occupied', '别的程序恰好返回 JSON 也是占用')
    assert.equal(classifyHealth({ kind: 'http' }), 'occupied', 'HTTP 可达但非 JSON：不再是「空闲」，避免 spawn 撞 EADDRINUSE')
    assert.equal(classifyHealth({ kind: 'unreachable' }), 'free')
    assert.equal(classifyHealth(null), 'occupied', '未知形态按占用处理，宁可误导为端口冲突也不 spawn')
})

test('重启退避：1s 起步、10s 封顶、永不小于 1s', () => {
    assert.deepEqual([0, 1, 2, 3, 4, 5, 10].map(backoffDelay), [1000, 2000, 4000, 8000, 10000, 10000, 10000])
})

test('重启上限存在且为正（防止无限重启风暴）', () => {
    assert.ok(Number.isInteger(MAX_RESTART_ATTEMPTS) && MAX_RESTART_ATTEMPTS >= 1 && MAX_RESTART_ATTEMPTS <= 20)
})
