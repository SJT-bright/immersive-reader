// F5（氛围 / 特效 / 渲染）修复的纯 node 核对。
// 口径：全部用假 DOM / 假 WebGL / 假 AudioContext 取「状态与收支」，不测毫秒、不依赖墙钟、不开浏览器。
// 这些断言证明的是「接线存在、工作量有界、状态转换正确」，不是「实测省了多少 ms」——
// 后者必须在浏览器里量（见交付说明的待运行时清单）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { relativeLuminance } from '../js/readability.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const src = rel => readFileSync(join(ROOT, rel), 'utf8')
const mod = rel => import(pathToFileURL(join(ROOT, rel)).href)

// 只替换指定全局，跑完原样还原；body 返回 Promise 时等它落地再还原（同文件共享进程）
function withGlobals (extras, body) {
    const names = Object.keys(extras)
    const saved = names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)])
    const restore = () => {
        for (const [name, descriptor] of saved) {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor)
            else delete globalThis[name]
        }
    }
    for (const name of names) globalThis[name] = extras[name]
    try {
        const out = body()
        if (out && typeof out.then === 'function') return out.finally(restore)
        restore()
        return out
    } catch (error) {
        restore()
        throw error
    }
}

// 括号配平地取出每个 xxx( 调用的完整文本；opener 必须以 '(' 结尾
function callTexts (source, opener) {
    const out = []
    let at = 0
    while ((at = source.indexOf(opener, at)) >= 0) {
        let depth = 0
        let i = at + opener.length - 1
        for (; i < source.length; i++) {
            const ch = source[i]
            if (ch === '(') depth++
            else if (ch === ')') { depth--; if (!depth) break }
        }
        out.push(source.slice(at, i + 1))
        at = i + 1
    }
    return out
}

// ---------------------------------------------------------------- glass-contrast

test('glass-contrast：75 分位用直方图近似，小样本面与全排序逐值一致且单调', async () => {
    const { brightLuminance } = await mod('js/glass-contrast.js')
    // n ≤ MAX_PROBES 时步长为 1 → 直方图就是全量分布，只允许一档（1/256）的量化差
    const w = 40; const h = 20; const n = w * h
    const pixels = new Uint8ClampedArray(n * 4)
    for (let i = 0; i < n; i++) {
        const v = (i * 37 + 11) % 256
        pixels[i * 4] = v; pixels[i * 4 + 1] = (v * 3) % 256; pixels[i * 4 + 2] = 255 - v
    }
    const exact = []
    for (let i = 0; i < n; i++) exact.push(relativeLuminance([pixels[i * 4], pixels[i * 4 + 1], pixels[i * 4 + 2]]))
    exact.sort((a, b) => a - b)
    const want = exact[Math.floor(exact.length * 0.75)]
    assert.ok(Math.abs(brightLuminance(pixels, n) - want) <= 1 / 256, '直方图分位与全排序相差不超过一档')
    // 单调：整体提亮后分位不许变暗（「背景更亮 → 衬底更深」不能被抽样破坏）
    const brighter = new Uint8ClampedArray(pixels.map((v, i) => (i % 4 === 3 ? v : Math.min(255, v + 40))))
    assert.ok(brightLuminance(brighter, n) >= brightLuminance(pixels, n))
})

test('glass-contrast：宽扁面读取量被步长抽样压住，源码里不再逐像素 slice/全排序', async () => {
    const { brightLuminance } = await mod('js/glass-contrast.js')
    const source = src('js/glass-contrast.js')
    const maxProbes = Number(/const MAX_PROBES = (\d+)/.exec(source)[1])
    // readability.js:84 把 aspect<0.2 夹到 0.2 → 600×120 正是线上最坏的那一面
    const n = 600 * 120
    const pixels = new Uint8ClampedArray(n * 4)
    for (let i = 0; i < n; i++) {
        const v = ((i * 2654435761) >>> 13) & 255
        pixels[i * 4] = v; pixels[i * 4 + 1] = v; pixels[i * 4 + 2] = v
    }
    let reads = 0
    const counted = new Proxy(pixels, { get: (t, k) => { if (typeof k === 'number') reads++; return t[k] } })
    const value = brightLuminance(counted, n)
    assert.ok(value >= 0 && value <= 1, '分位亮度必须是合法亮度')
    assert.ok(reads <= (maxProbes + 128) * 3, `读取次数应被抽样压住：实测 ${reads}，上限 ${(maxProbes + 128) * 3}`)
    assert.ok(reads < (n * 3) / 10, `比旧的全量遍历至少省 10 倍：实测 ${reads} vs ${n * 3}`)
    assert.ok(!/pixels\.slice\(/.test(source), '不再逐像素 slice() 分配临时数组')
    assert.ok(!/values\.sort/.test(source), '不再有数万元素的全排序')
    const hot = source.slice(source.indexOf('export function brightLuminance'))
    const body = hot.slice(0, hot.indexOf('\n}') + 2)
    assert.ok(!/Math\.pow/.test(body), '分位热路径里没有每像素 3 次 Math.pow（换成了 256 档查找表）')
    assert.ok(/CHANNEL_L\[pixels\[/.test(body), '热路径走查找表')
})

test('glass-contrast：静态背景不进定时器采样、读写不交错、#atmosphere-panel 已剔除', async () => {
    const { startGlassContrast } = await mod('js/glass-contrast.js')
    const buffer = new Uint8ClampedArray(300 * 4)
    for (let i = 0; i < 300; i++) { buffer[i * 4] = 200; buffer[i * 4 + 1] = 200; buffer[i * 4 + 2] = 200 }
    const log = []
    let sampleCalls = 0
    const sample = () => { sampleCalls++; log.push('sample'); return { pixels: buffer, n: 300 } }
    let clock = 0
    const surface = rect => ({
        dataset: {},
        getBoundingClientRect () { log.push('rect'); return rect },
        style: { setProperty (name, value) { log.push(`write:${name}=${value}`) } },
    })
    // 4 个面、3 种矩形：同一矩形只应采样一次
    const nodes = [
        surface({ x: 0, y: 0, width: 200, height: 60 }),
        surface({ x: 0, y: 0, width: 200, height: 60 }),
        surface({ x: 10, y: 100, width: 120, height: 40 }),
        surface({ x: 0, y: 700, width: 300, height: 50 }),
    ]
    const win = { listeners: {}, addEventListener (type, fn) { this.listeners[type] = fn } }
    let tick = null
    let image = { tagName: 'IMG' }
    const sandbox = {
        document: { hidden: false, addEventListener () {}, querySelectorAll: () => nodes },
        window: win,
        innerWidth: 1200, innerHeight: 800,
        setInterval: fn => { tick = fn; return 7 },
        clearInterval () {},
        setTimeout: fn => { fn(); return 1 },
        clearTimeout () {},
    }
    const result = withGlobals(sandbox, () => {
        startGlassContrast(() => image, { sample, now: () => clock })
        const firstPass = { samples: sampleCalls, lines: log.slice() }
        log.length = 0
        // 静态背景：连跑 12 个 tick（3s）不应再采样、不应再写
        for (let i = 0; i < 12; i++) { clock += 250; tick() }
        const idlePass = { samples: sampleCalls, writes: log.filter(line => line.startsWith('write')).length }
        log.length = 0
        clock += 4000
        tick()
        const afterStaticInterval = sampleCalls
        image = { tagName: 'IMG' }
        tick()
        const afterSceneChange = sampleCalls
        log.length = 0
        image = { tagName: 'VIDEO' }
        tick()
        const videoFirst = sampleCalls
        for (let i = 0; i < 3; i++) { clock += 250; tick() }
        const videoWithinSecond = sampleCalls
        clock += 1000
        tick()
        const videoAfterSecond = sampleCalls
        win.listeners.resize()
        const afterResize = sampleCalls
        return { ...firstPass, idlePass, afterStaticInterval, afterSceneChange, videoFirst, videoWithinSecond, videoAfterSecond, afterResize }
    })
    assert.equal(result.samples, 3, '4 个面共享 3 种矩形 → 只采样 3 次')
    const firstWrite = result.lines.findIndex(line => line.startsWith('write'))
    const lastRead = Math.max(result.lines.lastIndexOf('rect'), result.lines.lastIndexOf('sample'))
    assert.ok(firstWrite >= 0 && lastRead < firstWrite, '先收齐 rect＋sample，再统一写 style（不出现读-写-读交错）')
    assert.equal(result.idlePass.samples, 3, '静态背景收敛后的 12 个 tick 零次采样')
    assert.equal(result.idlePass.writes, 0, '静态背景收敛后的 12 个 tick 零次样式写入')
    assert.equal(result.afterStaticInterval, 6, '静态源兜底重采样每 4s 一轮，不是每 250ms')
    assert.equal(result.afterSceneChange, 9, '换图立即重采样一轮')
    assert.equal(result.videoFirst, 12, '动态源切回来立即采一轮')
    assert.equal(result.videoWithinSecond, 12, '动态源同一 1s 窗口内的 3 个 tick 不重复采样')
    assert.equal(result.videoAfterSecond, 15, '动态源每 1s 采一轮')
    assert.equal(result.afterResize, 18, 'resize 立即重采样一轮')
    const selector = /SELECTOR = '([^']+)'/.exec(src('js/glass-contrast.js'))[1]
    assert.ok(!selector.includes('#atmosphere-panel'), '#atmosphere-panel 已剔除（抽屉内 background:transparent!important，不消费 --scrim-a）')
    for (const keep of ['#top-actions', '#toolbar', '#panel', '#reading-dock > *', '#live-player', '#mini-player', '#reading-toc-popover']) {
        assert.ok(selector.includes(keep), `采样面保持：${keep}`)
    }
    assert.ok(!/setInterval\(update, 250\)/.test(src('js/glass-contrast.js')))
})

test('glass-contrast：定时器与监听收支平衡', () => {
    const source = src('js/glass-contrast.js')
    assert.equal((source.match(/setInterval\(/g) || []).length, 1, '只剩一个收敛定时器')
    assert.equal((source.match(/clearInterval\(/g) || []).length, 1, '它有唯一一个清理点')
    const opts = source.match(/const opts = \{ signal: abort\.signal \}/)
    assert.ok(opts, '监听统一走 abort signal')
    const listeners = callTexts(source, 'addEventListener(')
    assert.equal(listeners.length, 5, 'visibilitychange + resize + orientationchange + popover toggle + pagehide')
    for (const call of listeners) assert.ok(/opts|signal/.test(call), `监听必须可摘除：${call.slice(0, 60)}`)
    assert.ok(/new AbortController\(\)/.test(source) && /abort\.abort\(\)/.test(source))
})

// ---------------------------------------------------------------- ambience

function fakeAudioContext (state = 'running') {
    const counts = { bufferSource: 0, oscillator: 0, gain: 0, filter: 0, constantSource: 0 }
    const stats = { connect: 0, disconnect: 0, start: 0, stop: 0 }
    const param = () => ({
        value: 0, cancelScheduledValues () {}, setValueAtTime () {}, linearRampToValueAtTime () {},
        exponentialRampToValueAtTime () {}, setTargetAtTime () {}, setValueCurveAtTime () {},
    })
    const ctx = {
        kind: 'ctx', state, currentTime: 12.5, sampleRate: 4000, counts, stats, nodes: [],
        createBuffer: (channels, length) => ({ length, getChannelData: () => new Float32Array(length) }),
        // 注意：假节点一律带 stop()（真实 GainNode 没有，生产代码用 try/catch 兜住）
        node (kind) {
            const n = {
                kind, gain: param(), frequency: param(), Q: param(), detune: param(), offset: param(),
                buffer: null, loop: false, type: 'sine',
                connect () { stats.connect++ }, disconnect () { stats.disconnect++ },
                start () { stats.start++ }, stop () { stats.stop++ },
            }
            ctx.nodes.push(n)
            return n
        },
        createGain () { counts.gain++; return ctx.node('gain') },
        createBiquadFilter () { counts.filter++; return ctx.node('filter') },
        createBufferSource () { counts.bufferSource++; return ctx.node('source') },
        createOscillator () { counts.oscillator++; return ctx.node('osc') },
        createConstantSource () { counts.constantSource++; return ctx.node('constant') },
        suspend () { ctx.state = 'suspended'; return Promise.resolve() },
        resume () { ctx.state = 'running'; return Promise.resolve() },
        close () { ctx.state = 'closed'; return Promise.resolve() },
    }
    ctx.destination = ctx.node('destination')
    return ctx
}

function withAudio (body) {
    const timers = new Map()
    const cleared = []
    let nextId = 1
    let ctx = null
    const doc = { hidden: false, listeners: {}, addEventListener (type, fn) { this.listeners[type] = fn } }
    const sandbox = {
        document: doc,
        window: { AudioContext: function FakeAC () { ctx = fakeAudioContext(); return ctx } },
        setTimeout: (fn, ms) => { const id = nextId++; timers.set(id, { fn, ms }); return id },
        clearTimeout: id => { if (timers.delete(id)) cleared.push(id); return id },
    }
    const api = {
        timers, cleared, doc,
        get ctx () { return ctx },
        run (filter = () => true) {
            const due = [...timers.entries()].filter(([, item]) => filter(item.ms))
            for (const [id, item] of due) { timers.delete(id); item.fn() }
            return due.length
        },
    }
    return withGlobals(sandbox, () => body(api))
}

test('ambience：页面隐藏 / ctx 未 running 时不给 crackle 与 flakes 排产 burst', async () => {
    const { Ambience } = await mod('js/ambience.js')
    await withAudio(async api => {
        const amb = new Ambience()
        await amb.play('fire')
        assert.equal(amb.ctx, api.ctx, '已建上下文')
        const sourcesBefore = api.ctx.counts.bufferSource
        // 模拟切走标签页：visibilitychange → ctx.suspend()，旧写法此时仍照常排产
        api.ctx.state = 'suspended'
        api.doc.hidden = true
        assert.equal(amb.quiet(), true, 'quiet() 判据与 thunder() 同口径')
        for (let i = 0; i < 40; i++) {
            assert.equal(api.run(), 1, '每一轮只有一个待发定时器')
            assert.equal(api.timers.size, 1, '退避只留一个定时器，不累计')
        }
        assert.equal(api.ctx.counts.bufferSource, sourcesBefore, '挂起期间不得新建白噪 burst 源')
        assert.equal([...api.timers.values()][0].ms, 1000, '退避到 1s 后复查')
        // 回到前台 → 自动续排并真的出声
        api.doc.hidden = false
        api.ctx.state = 'running'
        assert.equal(amb.quiet(), false)
        api.run()
        assert.equal(api.ctx.counts.bufferSource, sourcesBefore + 1, '恢复 running 后 crackle 继续出声')
        assert.equal([...api.timers.values()][0].ms < 1000, true, '回到正常节拍下 90-510ms 排产')
        // 落雪同理
        await amb.play('snow')
        api.ctx.state = 'suspended'
        api.doc.hidden = true
        const after = api.ctx.counts.bufferSource
        for (let i = 0; i < 20; i++) api.run()
        assert.equal(api.ctx.counts.bufferSource, after, '挂起期间 flakes 也不产生 burst')
    })
})

test('ambience：stop() 不取消上一代的释放回调（定时器分属两个集合）', async () => {
    const { Ambience } = await mod('js/ambience.js')
    await withAudio(async api => {
        const amb = new Ambience()
        await amb.play('fire')
        const gen1Group = amb.group
        const gen1Parts = [...amb.parts]
        amb.stop(true)
        assert.equal(amb.timers.size, 0, '排产集合被清空')
        assert.equal(amb.teardown.size, 1, '释放集合保留自己那一条')
        const teardownId = [...amb.teardown][0]
        assert.ok(!api.cleared.includes(teardownId), 'stop() 绝不 clearTimeout 未完成的释放回调')
        await amb.play('rain') // → stop 上一代（此刻 group 已被置空，不产生新释放）
        await amb.play('snow')
        await amb.play('waves')
        assert.equal(amb.teardown.size, 3, `三代释放都在等待：实测 ${amb.teardown.size}`)
        const disconnectBefore = api.ctx.stats.disconnect
        api.run(ms => ms === 1200)
        assert.equal(amb.teardown.size, 0, '跑完自动出集合')
        assert.equal(api.ctx.stats.disconnect - disconnectBefore, 3, '每一代 group 各断开一次')
        assert.ok(gen1Parts.length > 0, '第一代确实持有若干循环源')
    })
})

test('ambience：多代快速连点后所有 group 都断开，没有常驻循环源', async () => {
    const { Ambience } = await mod('js/ambience.js')
    const kinds = ['rain', 'snow', 'waves', 'stream', 'fire', 'crickets', 'wind', 'white', 'pink', 'brown']
    await withAudio(async api => {
        const amb = new Ambience()
        const partsPerGeneration = []
        for (let i = 0; i < 20; i++) {
            await amb.play(kinds[i % kinds.length])
            partsPerGeneration.push(amb.parts.length)
        }
        // 第一代在第一次 play 前不存在，故 20 次 play 只留下 19 代待释放
        assert.equal(amb.teardown.size, 19, `19 代释放回调全部存活：实测 ${amb.teardown.size}`)
        const disconnectBefore = api.ctx.stats.disconnect
        const stopBefore = api.ctx.stats.stop
        api.run(ms => ms === 1200)
        assert.equal(api.ctx.stats.disconnect - disconnectBefore, 19, '每代 group 都被断开')
        const expectedStops = partsPerGeneration.slice(0, 19).reduce((a, b) => a + b, 0)
        assert.equal(api.ctx.stats.stop - stopBefore, expectedStops, '每代的循环源/振荡器都被 stop')
        assert.equal(amb.teardown.size, 0)
    })
})

test('ambience：destroy 把两个集合都收干净', async () => {
    const { Ambience } = await mod('js/ambience.js')
    await withAudio(async api => {
        const amb = new Ambience()
        await amb.play('fire')
        await amb.play('rain')
        assert.ok(amb.teardown.size >= 1)
        amb.destroy()
        assert.equal(amb.timers.size, 0, '排产集合已清')
        assert.equal(amb.teardown.size, 0, '释放集合也已清（ctx.close 会带走全部节点）')
        assert.equal(api.ctx.state, 'closed')
    })
})

test('ambience：源码收支 —— 两个集合、两处守卫、一套清理', () => {
    const source = src('js/ambience.js')
    assert.equal((source.match(/this\.timers = new Set\(\)/g) || []).length, 1)
    assert.equal((source.match(/this\.teardown = new Set\(\)/g) || []).length, 1)
    assert.equal((source.match(/this\.timers\.clear\(\)/g) || []).length, 1, 'stop 只清排产集合')
    assert.equal((source.match(/laterTeardown\(/g) || []).length, 2, '一处定义 + stop() 一处调用')
    assert.equal((source.match(/if \(this\.quiet\(\)\) \{ this\.later\((flakes|crackle), 1000\); return \}/g) || []).length, 2,
        'flakes 与 crackle 各一处 quiet() 守卫')
    assert.ok(/quiet\(\) \{ return document\.hidden \|\| !this\.ctx \|\| this\.ctx\.state !== 'running' \}/.test(source),
        'quiet() 判据与 thunder() 一致')
    assert.ok(/if \(!this\.ctx \|\| this\.ctx\.state !== 'running'\) return/.test(source), 'thunder 原守卫保留')
    assert.ok(/for \(const id of this\.teardown\) clearTimeout\(id\)/.test(source), 'destroy 清释放集合')
    assert.ok(/this\.abort\.abort\(\)/.test(source) && /new AbortController\(\)/.test(source), 'visibilitychange 监听可摘')
})

// ---------------------------------------------------------------- three-scene

test('three-scene：极光逐像素重算被限到 ~10fps，帧门控没有被绕过', async () => {
    const { AuroraLayer, ThreeSceneRenderer } = await mod('js/three-scene.js')
    let puts = 0
    const auroraCtx = {
        createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
        putImageData () { puts++ },
    }
    const sandbox = { document: { hidden: false, createElement: () => ({ width: 0, height: 0, getContext: () => auroraCtx }) } }
    const result = withGlobals(sandbox, () => {
        const layer = new AuroraLayer()
        for (let i = 0; i < 30; i++) layer.draw(i / 30) // 30fps 主循环下的 30 次「每帧调用」
        const afterThirtyFrames = puts
        layer.draw(0.95) // 距上次重算 50ms < 90ms 阈值 → 复用
        const afterReplay = puts - afterThirtyFrames
        layer.draw(1.0)
        const afterAdvance = puts - afterThirtyFrames - afterReplay
        const fresh = new AuroraLayer()
        const firstDrawBuilds = (puts = 0, fresh.draw(6), puts)
        return { afterThirtyFrames, afterReplay, afterAdvance, firstDrawBuilds }
    })
    assert.ok(result.afterThirtyFrames >= 9 && result.afterThirtyFrames <= 11,
        `30 帧只重算 ~10 次（实测 ${result.afterThirtyFrames}），不再每帧跑 20,736 像素 + putImageData`)
    assert.equal(result.afterReplay, 0, '未超过 90ms 的帧复用已画好的离屏画布')
    assert.equal(result.afterAdvance, 1, 't 前进够一帧后重算一次')
    assert.equal(result.firstDrawBuilds, 1, '新建的层第一次 draw 必算（snapshot 拿得到图）')
    const source = src('js/three-scene.js')
    assert.ok(/if \(!document\.hidden && now - this\._last >= 31\)/.test(source), '主帧门控（30fps 预算 + 后台停帧）保持原样')
    assert.ok(/if \(!this\.active \|\| !this\.motionEnabled \|\| this\.raf\) return/.test(source), 'scheduleFrame 的 motion 门控保持原样')
    assert.ok(/this\.motionEnabled = motion/.test(source) && /sceneMotionEnabled\(\)/.test(src('js/background.js')),
        'atmosphere.motion 与 prefers-reduced-motion 仍在背景层统一决定')
    // motion=false 时不排帧（极光不会被自己的节流偷偷唤醒）
    const stubCtx = {
        createLinearGradient: () => ({ addColorStop () {} }), createRadialGradient: () => ({ addColorStop () {} }),
        fillRect () {}, beginPath () {}, arc () {}, fill () {}, moveTo () {}, lineTo () {}, closePath () {},
        save () {}, restore () {}, clip () {}, translate () {}, scale () {}, stroke () {}, drawImage () {},
        putImageData () {}, createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    }
    withGlobals({
        document: { hidden: false, createElement: () => ({ width: 0, height: 0, getContext: () => stubCtx }) },
        performance: { now: () => 0 },
        requestAnimationFrame: () => 1,
        cancelAnimationFrame: () => {},
    }, () => {
        const renderer = new ThreeSceneRenderer()
        const canvas = renderer.start('three:mountains-dawn', { motion: false })
        assert.ok(canvas, '静态场景照常出图')
        assert.equal(renderer.raf, 0, 'motion=false 时不排帧')
        renderer.stop()
    })
})

// ---------------------------------------------------------------- rain-glass / rain-shaders

function fakeGL ({ fboComplete = true } = {}) {
    const base = {
        calls: [],
        FRAMEBUFFER_COMPLETE: 'FRAMEBUFFER_COMPLETE',
        MAX_TEXTURE_SIZE: 'MAX_TEXTURE_SIZE',
        getParameter: name => (name === 'MAX_TEXTURE_SIZE' ? 8192 : 0),
        getShaderParameter: () => true,
        getProgramParameter: () => true,
        getShaderInfoLog: () => '',
        getProgramInfoLog: () => '',
        getUniformLocation: (program, name) => ({ name }),
        createProgram: () => ({}),
        createShader: () => ({}),
        createTexture: () => ({}),
        createFramebuffer: () => ({}),
        shaderSource () {}, compileShader () {}, attachShader () {}, deleteShader () {}, linkProgram () {},
        checkFramebufferStatus: () => (fboComplete ? 'FRAMEBUFFER_COMPLETE' : 'FRAMEBUFFER_INCOMPLETE_ATTACHMENT'),
        isContextLost: () => false,
        drawArrays () {},
    }
    return new Proxy(base, {
        get (target, key) {
            if (key in target) return target[key]
            if (typeof key === 'symbol') return undefined
            target[key] = () => { target.calls.push(key) }
            return target[key]
        },
    })
}

function rainHarness (options = {}) {
    const { fboComplete = true, settings = {} } = options
    const gl = fakeGL({ fboComplete })
    const canvas = {
        className: '', dataset: {}, style: {}, listeners: {}, width: 0, height: 0,
        addEventListener (type, fn) { this.listeners[type] = fn },
        remove () {},
        getContext (kind, attrs) { canvas.attrs = attrs; return gl },
    }
    const win = { listeners: {}, addEventListener (type, fn) { this.listeners[type] = fn } }
    const doc = { hidden: false, listeners: {}, addEventListener (type, fn) { this.listeners[type] = fn }, createElement: () => canvas }
    const frames = new Map()
    const removedFrames = []
    let nextFrame = 1
    let clock = 0
    const atmos = Object.assign({
        enabled: true, motion: true, weather: 'rain', rain: 0.6, snow: 0, fog: 0.4, refraction: 1.2,
        wind: 0, lightning: false, sceneFx: true, dropSize: 1, fallSpeed: 1, trail: 1, flowSpeed: 1,
        brightness: 1, warmth: 0, parallax: 1, paperOpacity: 0.82, snowDepth: 0.65,
    }, settings)
    const sandbox = {
        document: doc, window: win, innerWidth: 1200, innerHeight: 800, devicePixelRatio: 1,
        matchMedia: () => ({ matches: false, addEventListener () {} }),
        requestAnimationFrame: fn => { const id = nextFrame++; frames.set(id, fn); return id },
        cancelAnimationFrame: id => { removedFrames.push(id); frames.delete(id) },
        performance: { now: () => clock },
        console: { ...console, warn: (...a) => { (sandbox.warnings ||= []).push(a.join(' ')) } },
        warnings: [],
    }
    return {
        sandbox, gl, canvas, win, doc, frames, removedFrames, atmos,
        clock: value => { clock = value },
        withRun: body => withGlobals(sandbox, body),
    }
}

test('rain-glass：FBO 重建失败时 safeResize 兜住异常并切到普通背景', async () => {
    const { RainGlass } = await mod('js/rain-glass.js')
    const h = rainHarness({ fboComplete: false })
    const result = await h.withRun(async () => {
        let thrown = null
        let rain = null
        try { rain = new RainGlass({ append () {} }, h.atmos) } catch (error) { thrown = error }
        const constructed = thrown
        thrown = null
        if (rain) {
            try { h.win.listeners.resize() } catch (error) { thrown = error }
            const fromListener = thrown
            thrown = null
            // resize 现在走 200ms 防抖：在沙箱内把定时器真实睡过去，
            // 让延迟重建在全局仍在位时发生（safeResize 内部兜错，wake 用沙箱 rAF）
            await new Promise(resolve => setTimeout(resolve, 260))
            try { rain.applyQuality(0.75, 999999) } catch (error) { thrown = error }
            return { constructed, fromListener, fromApplyQuality: thrown, rain }
        }
        return { constructed }
    })
    assert.equal(result.constructed, null, '构造过程中的 resize 失败不再抛给 SceneController')
    assert.equal(result.fromListener, null, 'window resize 监听器不再抛出（旧缺陷：异常冒出后 wake() 不执行）')
    assert.equal(result.fromApplyQuality, null, '自适应换档路径不再抛出（旧缺陷：回调抛出后不再续帧）')
    clearTimeout(result.rain?._resizeT)
    const rain = result.rain
    assert.equal(rain.available, false, '判定为不可用')
    assert.equal(h.canvas.dataset.state, 'unsupported', '面板据此显示「当前浏览器使用普通背景」')
    assert.equal(h.canvas.style.opacity, '0')
    assert.equal(h.frames.size, 0, '渲染循环停掉，不留旧 raf id')
    assert.ok(h.sandbox.warnings.some(line => line.includes('雨窗')), '留了一条可诊断的 console.warn')
    const source = src('js/rain-glass.js')
    assert.equal((source.match(/this\.resize\(\)/g) || []).length, 1, '只有 safeResize 内部直接调 resize()')
    assert.equal((source.match(/this\.safeResize\(\)/g) || []).length, 4, '构造 / contextrestored / window resize / 换档')

    // 反向对照：FBO 正常时不能误降级
    const okHarness = rainHarness()
    const ok = okHarness.withRun(() => new RainGlass({ append () {} }, okHarness.atmos))
    assert.equal(ok.available, true, '正常机器仍然启用雨窗')
    assert.equal(okHarness.canvas.dataset.state, 'ready')
    assert.ok(okHarness.frames.size >= 1, '正常机器照常排队渲染帧')
    assert.ok(okHarness.canvas.attrs && okHarness.canvas.attrs.alpha === false)
    assert.ok(!('preserveDrawingBuffer' in okHarness.canvas.attrs), 'preserveDrawingBuffer 不再请求')
})

test('rain-glass：自适应降档后可以升回，quality 不再只降不升', async () => {
    const { RainGlass } = await mod('js/rain-glass.js')
    const h = rainHarness()
    const result = h.withRun(() => {
        const rain = new RainGlass({ append () {} }, h.atmos)
        rain.mix = 1
        rain.transitionStart = -1e6
        let now = 20000
        rain.lastFrame = now
        // 掉帧段：每帧 50ms（>46）
        for (let i = 0; i < 400 && rain.quality === 1; i++) { now += 50; h.clock(now); rain.frame(now) }
        const downgraded = rain.quality
        const widthAfterDowngrade = rain.width
        const downgradedAt = now
        // 恢复段：每帧 33.4ms（跟得上 32ms 预算）
        for (let i = 0; i < 1200 && rain.quality < 1; i++) { now += 33.4; h.clock(now); rain.frame(now) }
        const recovered = rain.quality
        for (let i = 0; i < 400; i++) { now += 33.4; h.clock(now); rain.frame(now) }
        return {
            downgraded, recovered, final: rain.quality, widthAfterDowngrade, widthFinal: rain.width,
            dataset: h.canvas.dataset.quality, frames: rain.frames, downgradedAt,
        }
    })
    assert.ok(result.downgraded < 1, `持续掉帧后降了一档：${result.downgraded}`)
    assert.equal(result.recovered, 1, '负载退去后必须升回满分辨率（旧版只降不升，画面永久发糊到刷新）')
    assert.equal(result.final, 1, '回升封顶 1，不会越升越糊')
    assert.ok(result.widthFinal > result.widthAfterDowngrade, '回升真的重建了更大的缓冲区')
    assert.equal(result.dataset, '1.00')
    const source = src('js/rain-glass.js')
    assert.ok(!/this\.lastDowngrade/.test(source), 'lastDowngrade 已被升降共用的 lastQualityChange 取代')
    assert.ok(/fastFrames = elapsed <= 36/.test(source), '快帧判据以本循环 32ms 预算为下限（写成 <22 的话永远为假）')
    assert.ok(/applyQuality\(Math\.min\(1, this\.quality \/ \.75\)/.test(source), '升档走 .75 的逆运算')
})

test('rain-shaders：uniform 声明、GLSL 使用与 JS 赋值三方配平', async () => {
    const shaders = await mod('js/rain-shaders.js')
    const js = src('js/rain-glass.js')
    const declared = code => {
        const names = []
        for (const match of code.matchAll(/uniform\s+\w+\s+([^;]+);/g)) {
            for (const part of match[1].split(',')) {
                const name = part.trim().replace(/\[\d+\]$/, '')
                if (name) names.push(name)
            }
        }
        return names
    }
    const assignedInJs = [...js.matchAll(/this\.uniform\((?:p|r), '([^']+)'/g)].map(m => m[1])
    const check = (label, code) => {
        const names = declared(code)
        assert.ok(names.length, `${label} 应有 uniform 声明`)
        for (const name of names) {
            const uses = (code.match(new RegExp(`\\b${name}\\b`, 'g')) || []).length
            assert.ok(uses >= 2, `${label} 的 ${name} 必须既声明又被使用（实测 ${uses} 处）`)
            const stem = name.replace(/\d$/, '')
            const hit = assignedInJs.some(a => a === name || a === stem || a === stem.replace(/0$/, '') || `${a}0` === name || `${a}1` === name)
            assert.ok(hit, `${label} 的 ${name} 在 JS 侧找不到赋值点`)
        }
        return names
    }
    const background = check('BACKGROUND', shaders.BACKGROUND)
    assert.equal(background.length, 11, `BACKGROUND 现在 11 个 uniform：${background.join(',')}`)
    assert.ok(background.includes('u_single'), '新增 u_single')
    assert.ok(/uniform bool u_fluid0,u_fluid1,u_single;/.test(shaders.BACKGROUND),
        'u_single 与 u_fluid0/1 一样按 bool 声明、由 uniform1i 写入（ANGLE/Chrome 走 setBoolean，写法保持不变）')
    assert.ok(/if\(u_single\)c=sampleSource\(u_tex1,u_size1,u_fluid1\);/.test(shaders.BACKGROUND), '过渡结束后走单源分支')
    assert.ok(/else c=mix\(sampleSource\(u_tex0,u_size0,u_fluid0\),sampleSource\(u_tex1,u_size1,u_fluid1\)/.test(shaders.BACKGROUND),
        '过渡期保留双源混合分支')
    assert.ok(/smoothstep\(0\.,1\.,u_mix\)/.test(shaders.BACKGROUND), '过渡期仍然按 u_mix 交叉')
    assert.ok(/if\(c\.a>=1\.\)return c\.rgb;/.test(shaders.BACKGROUND),
        '不透明素材不再无条件再算一次 fluid(v_uv)（mix(fluid,rgb,1.) 恒等于 rgb，逐位等价）')
    const glass = check('GLASS', shaders.GLASS)
    assert.equal(glass.length, 18, 'GLASS 的 18 个 uniform 数量不变')
    assert.ok(!/undefined/.test(shaders.GLASS))
    const jsSource = js
    assert.ok(/const single = this\.mix >= 1/.test(jsSource))
    assert.ok(/this\.uniform\(p, 'u_single', 'uniform1i', single \? 1 : 0\)/.test(jsSource), 'u_single 每帧都被赋值')
    assert.ok(/const upload = i === 1 \|\| !single/.test(jsSource) && /if \(upload && e &&/.test(jsSource),
        '单源分支下 u_tex0 不再每帧上传（旧版连已暂停的视频背景都会反复重传）')
    for (const shader of [shaders.VERTEX, shaders.BACKGROUND, shaders.GLASS]) {
        assert.ok(/#version 300 es/.test(shader), 'GLSL ES 3.0 头')
        // 结构性自检：括号配平是本地唯一能做的 GLSL 静态检查（本机没有 glslangValidator），
        // 真正的编译状态只能由浏览器里 getShaderParameter(COMPILE_STATUS) 决定 —— 待运行时。
        const count = ch => [...shader].filter(c => c === ch).length
        assert.equal(count('{'), count('}'), '花括号配平')
        assert.equal(count('('), count(')'), '圆括号配平')
    }
    const source = src('js/rain-shaders.js')
    assert.ok(source.includes('Heartfelt') && source.includes('BigWings') && source.includes('CC BY-NC-SA'), '署名与许可头注释保留')
})

// ---------------------------------------------------------------- background.js

test('background：只留一路动态亮度巡检，pagehide 带 signal，applyPlan 区分即时与平滑', () => {
    const source = src('js/background.js')
    assert.ok(!/startDynamicTracking \(\) \{/.test(source), 'startDynamicTracking 的定义已删除')
    assert.ok(!/this\.startDynamicTracking\(\)/.test(source), 'startDynamicTracking 的调用点已删除')
    assert.ok(!/_dynTimer/.test(source), '另一路定时器与它的清理点一起删除（不留悬空 clearInterval）')
    assert.ok(!/this\._dynLum\b/.test(source), '那一路的独立基线字段也已删除')
    assert.equal((source.match(/_dynamicTimer = setInterval/g) || []).length, 1, '动态巡检只剩一个定时器')
    assert.equal((source.match(/clearInterval\(this\._dynamicTimer\)/g) || []).length, 2, 'destroy 与 pagehide 两个清理点')
    const pagehide = callTexts(source, 'window.addEventListener(').filter(text => text.includes("'pagehide'"))
    assert.equal(pagehide.length, 1)
    assert.ok(/signal: this\.abort\.signal/.test(pagehide[0]), 'pagehide 监听带上了 abort signal（F5-11，once:true 会被 bfcache 复用漏掉）')
    const listeners = callTexts(source, 'addEventListener(')
    assert.equal(listeners.length, 4, 'init 3 个 + 动态巡检 1 个')
    for (const call of listeners) assert.ok(/signal/.test(call), `每个监听都可摘：${call.slice(0, 50)}`)
    assert.ok(/applyPlan\(plan, \{ instant = true \} = \{\}\)/.test(source),
        'applyPlan 接受 instant 选项（旧签名把 recomputeReadability 传的 {instant:false} 静默丢掉了）')
    assert.ok(/instant \? 'none'[\s\S]{0,80}: `opacity \$\{MASK_EASE_MS\}ms ease/.test(source), '非即时路径恢复过渡，兑现「平滑过渡到新的遮罩强度」')
    assert.ok(/this\.applyPlan\(plan, \{ instant: false \}\)/.test(source), 'recomputeReadability 走平滑路径')
    assert.match(source, /this\.applyPlan\(plan\)\n/, 'setRef 走即时路径（不与交叉渐变叠加）')
    assert.ok(!/pixels\.slice/.test(source), '巡检均值不再逐像素 slice')
    assert.ok(/acceptThemeSwitch/.test(source) && /THEME_HYSTERESIS = 0\.03/.test(source), '深浅字方案滞回已接入')
})

test('background：meanLuminance 与 relativeLuminance 同口径且读取量有界', async () => {
    const { meanLuminance } = await mod('js/background.js')
    const maxProbes = Number(/const MAX_PROBES = (\d+)/.exec(src('js/background.js'))[1])
    const n = 900
    const pixels = new Uint8ClampedArray(n * 4)
    for (let i = 0; i < n; i++) {
        const v = (i * 61 + 7) % 256
        pixels[i * 4] = v; pixels[i * 4 + 1] = (v * 5) % 256; pixels[i * 4 + 2] = 255 - v
    }
    let exactSum = 0
    for (let i = 0; i < n; i++) exactSum += relativeLuminance([pixels[i * 4], pixels[i * 4 + 1], pixels[i * 4 + 2]])
    assert.ok(Math.abs(meanLuminance(pixels, n) - exactSum / n) < 1e-9, '小样本（步长 1）与逐像素均值一致')
    let reads = 0
    const big = new Uint8ClampedArray(120 * 600 * 4)
    const counted = new Proxy(big, { get: (t, k) => { if (typeof k === 'number') reads++; return t[k] } })
    meanLuminance(counted, 120 * 600)
    assert.ok(reads <= (maxProbes + 64) * 3, `正文列 72,000 像素只读 ${(maxProbes + 64) * 3} 次以内：实测 ${reads}`)
})

test('background：深浅字方案滞回不在交叉点来回切，强制主题立即生效', async () => {
    const { SceneController } = await mod('js/background.js')
    const pick = SceneController.prototype.acceptThemeSwitch
    const mk = (theme, dark, light) => ({
        sampled: true,
        theme,
        maskColor: theme === 'dark-text' ? '#f7f3ea' : '#1a1712',
        textColor: theme === 'dark-text' ? '#2b2620' : '#f2ede3',
        maskAlpha: theme === 'dark-text' ? dark : light,
        plan: { 'dark-text': { maskColor: '#f7f3ea', maskAlpha: dark }, 'light-text': { maskColor: '#1a1712', maskAlpha: light } },
        otherAlpha: 0,
    })
    const self = { currentPlan: mk('dark-text', 0.30, 0.34), _themeFlip: 0, settings: { readability: { theme: 'auto' } } }
    const held = pick.call(self, mk('light-text', 0.33, 0.34))
    assert.equal(held.theme, 'dark-text', '成本打平（差 0.01 < 0.03）时不换方案 → 正文墨色不硬闪')
    assert.ok(Math.abs(held.maskAlpha - 0.33) < 1e-9, '但仍采用新采样出的该方案遮罩强度')
    assert.equal(held.maskColor, self.currentPlan.maskColor, '颜色沿用当前方案')
    const first = pick.call(self, mk('light-text', 0.34, 0.28))
    assert.equal(first.theme, 'dark-text', '确实更省时，第一轮也只是确认')
    assert.equal(self._themeFlip, 1)
    const second = pick.call(self, mk('light-text', 0.34, 0.28))
    assert.equal(second.theme, 'light-text', '第二轮成立才切换')
    assert.equal(self._themeFlip, 0, '切换后计数归零，不会连着切')
    self.currentPlan = mk('light-text', 0.34, 0.28)
    assert.equal(pick.call(self, mk('light-text', 0.35, 0.27)).maskAlpha, 0.27, '同方案的强度变化原样采纳')
    self.currentPlan = mk('dark-text', 0.30, 0.34)
    self.settings.readability.theme = 'light-text'
    assert.equal(pick.call(self, mk('light-text', 0.34, 0.33)).theme, 'light-text', '用户强制主题不等确认轮')
    self.currentPlan = null
    self.settings.readability.theme = 'auto'
    assert.equal(pick.call(self, mk('dark-text', 0.2, 0.9)).theme, 'dark-text', '首帧没有旧 plan 时原样采纳')
})

// ---------------------------------------------------------------- book-lighting

test('book-lighting：渐变与宽度无关，resize 只重写三个 px 值', async () => {
    const { buildBookLighting, prepareBookLighting, createBookLighting, BOOK_LIGHTING } = await mod('js/book-lighting.js')
    const a = buildBookLighting(640)
    const b = buildBookLighting(1500)
    assert.equal(a.gradient, b.gradient, '171 段百分比 stop 与宽度无关')
    assert.equal(a.vars['--book-paper-light'], b.vars['--book-paper-light'])
    assert.equal(a.vars['--book-edge-light'], b.vars['--book-edge-light'])
    assert.equal(a.vars['--book-cast-opacity'], b.vars['--book-cast-opacity'])
    assert.ok(Math.abs(b.shadow.x / a.shadow.x - 1500 / 640) < 1e-9, 'cast-x 随宽度线性缩放')
    const base = prepareBookLighting({})
    assert.equal(prepareBookLighting({}), base, '同一参数命中缓存（返回同一个对象）')
    assert.notEqual(prepareBookLighting({ key: 0 }), base, '参数变了就重算')
    const writes = []
    const host = { clientWidth: 800, style: { setProperty (name, value) { writes.push([name, value]) } } }
    const frames = []
    const result = withGlobals({
        requestAnimationFrame: fn => { frames.push(fn); return frames.length },
        cancelAnimationFrame () {},
        ResizeObserver: class { constructor (cb) { this.cb = cb } observe () {} disconnect () {} },
    }, () => {
        const lighting = createBookLighting(host)
        lighting.setScene('builtin:fp-valley')
        frames.shift()()
        const first = writes.length
        writes.length = 0
        host.clientWidth = 812
        lighting.setScene('builtin:fp-valley') // 同场景改宽度（拖窗 / 迷你条出现 / 改字号）
        frames.shift()()
        const widthOnly = writes.map(w => w[0])
        writes.length = 0
        host.clientWidth = 900
        lighting.setScene('builtin:fp-cafe')
        frames.shift()()
        const sceneChange = writes.map(w => w[0])
        writes.length = 0
        host.clientWidth = 901
        lighting.setScene('builtin:fp-cafe') // 同场景再来一次
        frames.shift()()
        const later = writes.map(w => w[0])
        lighting.destroy()
        return { first, widthOnly, sceneChange, later, frames: frames.length }
    })
    assert.equal(result.first, 7, '首次落位写 7 条（4 条与宽度无关 + 3 条 px）')
    assert.deepEqual(result.widthOnly, ['--book-cast-x', '--book-cast-y', '--book-cast-blur'],
        '同场景改宽度只重算三个 px 值，171-stop 串不再每帧重建')
    assert.equal(result.sceneChange.length, 7, '换场景重新落全部 7 条')
    assert.deepEqual(result.later, ['--book-cast-x', '--book-cast-y', '--book-cast-blur'])
    assert.equal(result.frames, 0, 'destroy 后没有待执行帧')
    // 数值等价性：与旧实现一致的 gradient / shadow / vars（逐值对照在交付说明里另有脚本）
    assert.ok(!buildBookLighting(1200, undefined).gradient.includes('NaN'), '无场景覆盖时按默认参数出图')
    assert.ok(buildBookLighting(1000, { light: [-0.85, -0.75, 1.1] }).gradient.length > 1000, '有覆盖参数时也完整出图')
})

test('book-lighting：castOpacity 与 light 方向仍按参数走（缓存不吞参数差异）', async () => {
    const { buildBookLighting, BOOK_LIGHTING } = await mod('js/book-lighting.js')
    const base = buildBookLighting(1200)
    const noKey = buildBookLighting(1200, { key: 0 })
    assert.equal(noKey.vars['--book-cast-opacity'], 0)
    assert.notEqual(buildBookLighting(1200, { ambient: 1 }).vars['--book-cast-opacity'], base.vars['--book-cast-opacity'])
    const mirrored = buildBookLighting(1200, { light: [-BOOK_LIGHTING.light[0], BOOK_LIGHTING.light[1], BOOK_LIGHTING.light[2]] })
    assert.ok(mirrored.shadow.x < 0 && base.shadow.x > 0, '缓存不能把镜像光源算回正值')
    assert.notEqual(mirrored.gradient, base.gradient, '不同光源必须有不同的渐变')
    assert.throws(() => buildBookLighting(0), RangeError)
    assert.throws(() => buildBookLighting(1200, { light: [0, 0, 0] }), RangeError)
})

// ---------------------------------------------------------------- atmosphere-ui

test('atmosphere-ui：不可见入口的写入改成变化才写，死分支与死方法删除', () => {
    const source = src('js/atmosphere-ui.js')
    assert.ok(!/this\.toggle\.innerHTML=ICONS\[weather\]\|\|ICONS\.rain/.test(source), '不再每个 status 事件重解析一遍 SVG')
    assert.equal((source.match(/innerHTML = ICONS/g) || []).length, 1, '图标写入只剩一处，且在天气变化分支内')
    assert.ok(/if \(this\._paintedWeather !== weather\) \{/.test(source), '天气相关写入被 _paintedWeather 守卫')
    assert.ok(/if \(this\._paintedActive !== active\) \{/.test(source), 'data-active 只在状态变化时写')
    assert.ok(!/^\s*open\(\)\{/m.test(source), 'open() 已删除：无调用点，且与 renderPanel 的 hidden 位互斥')
    assert.ok(!/key==='rain'&&this\.ambience/.test(source), 'data-atmosphere="rain" 死分支已删')
    assert.ok(!/ambience\.setRainAmount/.test(source), '本文件不再驱动雨声（现由 main.js 正常驱动）')
    assert.ok(!/rangeRow\('rain'/.test(source), '面板里确实没有 rain 滑杆 → 上面那条分支原本不可达')
    assert.match(source, /close\(focus=true\)\{[\s\S]*?getComputedStyle\(this\.toggle\)[\s\S]*?this\.toggle\.focus\(\)/,
        '对 display:none 的 toggle 不再盲目 focus()')
    assert.ok(!/this\.toggle\.offsetParent/.test(source), 'position:fixed 的元素不能用 offsetParent 判可见（恒为 null）')
    assert.ok(/this\.toggle\?\.setAttribute\('aria-label', '天气设置'\)/.test(source), '常量 aria-label/title 挪到构造函数，一次写入')
    assert.ok(/this\.toggle\?\.addEventListener\('click', \(\) => onOpen\(\)\)/.test(source),
        '入口监听保留（常驻零成本；CSS 若恢复可见入口自动生效）')
    assert.ok(/this\.toggle\?\.setAttribute\('aria-expanded','false'\)/.test(source), '入口元素被删时不抛')
    assert.equal((source.match(/TITLES\[weather\]/g) || []).length, 1)
})

// ---------------------------------------------------------------- liquid-motion

test('liquid-motion：二次安装自动卸掉前一份，监听收支仍然 7/7', async () => {
    const { installLiquidMotion } = await mod('js/liquid-motion.js')
    const added = []
    const removed = []
    const record = bag => (type, fn, capture) => bag.push([type, fn, capture])
    const sandbox = {
        document: { addEventListener: record(added), removeEventListener: record(removed), querySelector: () => null, documentElement: {} },
        window: { addEventListener: record(added), removeEventListener: record(removed), matchMedia: () => ({ matches: false }) },
    }
    const result = withGlobals(sandbox, () => {
        const dispose1 = installLiquidMotion({ bindings: [] })
        const afterFirst = { added: added.length, removed: removed.length }
        // main.js:1950 丢掉了返回值；这里不接住它也只会存在一套
        const dispose2 = installLiquidMotion({ bindings: [{ trigger: '#a', surface: '#b' }] })
        const afterSecond = { added: added.length, removed: removed.length }
        dispose2()
        const afterDispose = { added: added.length, removed: removed.length }
        dispose2(); dispose1()
        const afterDouble = { added: added.length, removed: removed.length }
        installLiquidMotion({ bindings: [] })
        const afterThird = { added: added.length, removed: removed.length }
        return { afterFirst, afterSecond, afterDispose, afterDouble, afterThird }
    })
    assert.equal(result.afterFirst.added, 7, '一份安装 = 6 个 document 捕获 + 1 个 window blur')
    assert.equal(result.afterFirst.removed, 0)
    assert.deepEqual(result.afterSecond, { added: 14, removed: 7 }, '二次安装先把上一份干净卸掉')
    assert.deepEqual(result.afterDispose, { added: 14, removed: 14 }, 'disposer 收支平衡')
    assert.deepEqual(result.afterDouble, { added: 14, removed: 14 }, '重复调用 disposer 不再多摘')
    assert.deepEqual(result.afterThird, { added: 21, removed: 14 }, '前一份已卸时不再摘')
    const source = src('js/liquid-motion.js')
    assert.equal((source.match(/addEventListener\(/g) || []).length, 7)
    assert.equal((source.match(/removeEventListener\(/g) || []).length, 7)
    assert.ok(/if \(activeDispose\) activeDispose\(\)/.test(source))
})

test('氛围各模块源码收支：新建点都有对应释放点', () => {
    const amb = src('js/ambience.js')
    assert.ok(/for \(const id of this\.timers\) clearTimeout\(id\)/.test(amb))
    assert.ok(/for \(const id of this\.teardown\) clearTimeout\(id\)/.test(amb))
    assert.equal((amb.match(/new AbortController\(\)/g) || []).length, 1)
    assert.equal((amb.match(/this\.abort\.abort\(\)/g) || []).length, 1)
    const rain = src('js/rain-glass.js')
    assert.equal((rain.match(/cancelAnimationFrame/g) || []).length, 4, 'contextlost / wake / safeResize / destroy')
    assert.ok(/destroy\(\) \{[\s\S]*deleteTexture[\s\S]*deleteProgram[\s\S]*deleteFramebuffer/.test(rain), 'GL 对象在 destroy 里删除')
    assert.ok(/this\.abort = new AbortController\(\)/.test(rain) && /this\.abort\.abort\(\)/.test(rain))
    const scene = src('js/three-scene.js')
    assert.equal((scene.match(/requestAnimationFrame/g) || []).length, 1)
    assert.equal((scene.match(/cancelAnimationFrame/g) || []).length, 2, 'setMotionEnabled 与 stop')
    const bg = src('js/background.js')
    assert.match(bg, /destroy \(\) \{[\s\S]*?clearInterval\(this\._dynamicTimer\)/)
    assert.ok(/this\.abort\.abort\(\)/.test(bg) && /this\.rain\.destroy\(\)/.test(bg))
    assert.ok(/this\._lastDynLum = null \/\/ 新背景/.test(bg), 'startDynamicWatch 无条件重置基线（定时器已在跑时也重置）')
    const light = src('js/book-lighting.js')
    assert.equal((light.match(/requestAnimationFrame/g) || []).length, 1)
    assert.equal((light.match(/cancelAnimationFrame/g) || []).length, 1)
    assert.ok(/observer\.disconnect\(\)/.test(light), 'ResizeObserver 有断开点')
    assert.ok(/PREPARE_LIMIT/.test(light) && /PREPARED\.delete\(PREPARED\.keys\(\)\.next\(\)\.value\)/.test(light), '缓存有上限与淘汰')
})

test('js 模块之间不再携带 ?v= 版本查询（模块身份唯一）', () => {
    // 2026-10-05 主会话决定：模块间 import 一律用裸 specifier。
    // 浏览器按「含 query 的完整 URL」认定模块身份，过去 settings.js 同时以 2.4.0/2.5.1 被加载、
    // qq-music.js 以 1.5.0/1.6.1、icons.js 以裸路径与 1.1.0 —— 同一份代码存在两份实例。
    // 裸 specifier 让「同一模块两份实例」在结构上不可能发生；入口缓存失效只由 index.html 的 ?v= 负责。
    for (const f of ['background.js', 'glass-contrast.js', 'rain-glass.js', 'main.js', 'db.js', 'reader.js']) {
        const bad = [...src('js/' + f).matchAll(/['"]\.\/[A-Za-z0-9_-]+\.js\?v=[^'"]*['"]/g)]
        assert.deepEqual(bad.map(m => m[0]), [], `js/${f} 仍带版本查询`)
    }
})
