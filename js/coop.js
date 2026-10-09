// 协作式让步：把大文件的转换/编码切成小片，片间把主线程还给渲染与输入。
// 无 signal：优先 scheduler.yield，其次 MessageChannel 宏任务（不受 4ms 钳制）——
// 纯速度优先，用于备份导出等无需取消的任务。
// 传 signal：改走 setTimeout。关键原因：连续的 MessageChannel 消息会把任务队列
// 塞满，把「取消」的定时器/点击事件饿到任务结束才轮到（实测 153MB 导入时
// 700ms 的 abort 定时器被拖到 1649ms，导入已近尾声）。可取消路径必须给
// 定时器与输入事件留出插队窗口，让 checkAbort 能尽快看到 aborted。
const pendingYields = []
const channel = typeof MessageChannel === 'function' ? new MessageChannel() : null
if (channel) {
    channel.port1.onmessage = () => pendingYields.shift()?.()
    // Node（worker_threads 的 MessagePort）才有 unref；浏览器里不存在，跳过
    channel.port1.unref?.()
    channel.port2.unref?.()
}

export function yieldToUI (signal) {
    if (signal) {
        // 可取消路径：setTimeout 让步，定时器队列与输入事件有机会插队
        return new Promise(resolve => setTimeout(resolve, 0))
    }
    if (globalThis.scheduler?.yield) return globalThis.scheduler.yield()
    if (channel) return new Promise(resolve => { pendingYields.push(resolve); channel.port2.postMessage(0) })
    return new Promise(resolve => setTimeout(resolve, 0))
}

// 取消约定：所有支持取消的长任务在每个让步点调用 checkAbort(signal)。
// 统一抛 name='AbortError' 的 DOMException，调用方据 err.name 区分「用户取消」与「失败」。
export function abortError (message = '操作已取消') {
    return new DOMException(message, 'AbortError')
}
export function checkAbort (signal, message) {
    if (signal?.aborted) throw abortError(message)
}
