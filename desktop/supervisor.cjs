'use strict';
// 桌面壳的纯逻辑助手：与 Electron 解耦，node --test 可直接单测。
// classifyHealth：把对 _reader/health 的三种探测结果归成三态——
//   ours      健康检查返回本应用 JSON（端口上是我们的服务，直接复用）
//   occupied  HTTP 可达但不是本应用（含返回非 JSON、超时前收到异构响应）
//   free      连接被拒绝 / 无响应（端口空闲，可以 spawn）
// 旧实现把「HTTP 可达但非 JSON」也当成空闲，随后 spawn 撞 EADDRINUSE，
// 用户看到的是误导性的「阅读服务启动失败（1）」而不是真实的端口冲突。
function classifyHealth (result) {
    if (result && result.kind === 'json' && result.json && result.json.app === 'immersive-reader') return 'ours'
    if (result && result.kind === 'unreachable') return 'free'
    return 'occupied'
}

// 服务子进程重启退避：1s、2s、4s、8s、10s 封顶。attempt 从 0 计。
function backoffDelay (attempt) {
    return Math.min(1000 * 2 ** Math.max(0, attempt), 10000)
}

// 连续失败多少次后放弃自动重启，改弹窗请用户重开 APP。
const MAX_RESTART_ATTEMPTS = 5

const fs = require('node:fs')
const path = require('node:path')

// 服务日志滚动：超过 maxBytes 就把当前日志挪到 <name>.old（覆盖上一份），
// 返回一个可供 spawn stdio 使用的追加写 fd；目录不存在时先建。
// 没有它，桌面壳 spawn 用 stdio:'ignore'，服务崩溃后没有任何可诊断的输出。
function openRotatedLog (dir, name = 'service.log', maxBytes = 2 * 1024 * 1024) {
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, name)
    try {
        if (fs.existsSync(file) && fs.statSync(file).size > maxBytes) {
            fs.rmSync(path.join(dir, name.replace(/\.log$/, '.old.log')), { force: true })
            fs.renameSync(file, path.join(dir, name.replace(/\.log$/, '.old.log')))
        }
    } catch { /* 滚动失败不影响服务启动 */ }
    const fd = fs.openSync(file, 'a')
    fs.appendFileSync(fd, `\n[main] ${new Date().toISOString()} spawn server\n`)
    return fd
}

module.exports = { classifyHealth, backoffDelay, MAX_RESTART_ATTEMPTS, openRotatedLog }
