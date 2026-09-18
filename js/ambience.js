// 程序生成环境声床：雨声、落雪、篝火、虫鸣、山风与闷雷，全部用 Web Audio 合成，
// 不包含任何音频素材，因此没有版权与离线问题。
// 浏览器要求首次出声由用户手势触发：面板里的开关/ Chips 点击即满足。
// window.__readerAmbience 暴露实例，仅供自动化验证与调试。
const KINDS = ['rain', 'snow', 'waves', 'stream', 'fire', 'crickets', 'wind', 'white', 'pink', 'brown']

export class Ambience {
    constructor() {
        this.ctx = null
        this.master = null
        this.group = null      // 当前 kind 的节点，停止时整体淡出断开
        this.kind = null
        this.volume = 0.5
        this.rainAmount = 0.58
        this.timers = new Set()
        this.buffers = {}
        this.abort = new AbortController()
        document.addEventListener('visibilitychange', () => {
            if (!this.ctx) return
            if (document.hidden) this.ctx.suspend().catch(() => {})
            else if (this.kind) this.ctx.resume().catch(() => {})
        }, { signal: this.abort.signal })
    }

    get running() { return !!this.kind && !!this.ctx }

    async ensure() {
        if (!this.ctx) {
            const AC = window.AudioContext || window.webkitAudioContext
            if (!AC) throw new Error('当前浏览器不支持 Web Audio')
            this.ctx = new AC()
            this.master = this.ctx.createGain()
            this.master.gain.value = this.volume
            this.master.connect(this.ctx.destination)
        }
        if (this.ctx.state !== 'running') { try { await this.ctx.resume() } catch { /* 需要用户手势 */ } }
        return this.ctx
    }

    noise(type) {
        if (this.buffers[type]) return this.buffers[type]
        const length = this.ctx.sampleRate * 2
        const buffer = this.ctx.createBuffer(1, length, this.ctx.sampleRate)
        const data = buffer.getChannelData(0)
        if (type === 'white') {
            for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1
        } else if (type === 'pink') {
            let b0 = 0, b1 = 0, b2 = 0
            for (let i = 0; i < length; i++) {
                const w = Math.random() * 2 - 1
                b0 = .997 * b0 + .029 * w; b1 = .985 * b1 + .032 * w; b2 = .95 * b2 + .048 * w
                data[i] = (b0 + b1 + b2 + w * .05) * 2.2
            }
        } else { // brown
            let last = 0
            for (let i = 0; i < length; i++) {
                last = (last + .02 * (Math.random() * 2 - 1)) / 1.02
                data[i] = last * 3.5
            }
        }
        this.buffers[type] = buffer
        return buffer
    }

    source(type, loop = true) {
        const src = this.ctx.createBufferSource()
        src.buffer = this.noise(type)
        src.loop = loop
        return src
    }

    gain(value) {
        const g = this.ctx.createGain()
        g.gain.value = value
        return g
    }

    filter(type, freq, q = 1) {
        const f = this.ctx.createBiquadFilter()
        f.type = type; f.frequency.value = freq; f.Q.value = q
        return f
    }

    lfo(freq, depth, target, phase = 0) {
        const osc = this.ctx.createOscillator()
        osc.type = 'sine'; osc.frequency.value = freq
        const g = this.gain(depth)
        osc.connect(g); g.connect(target)
        osc.start(this.ctx.currentTime + phase)
        return [osc, g]
    }

    later(fn, ms) {
        const id = setTimeout(() => { this.timers.delete(id); fn() }, ms)
        this.timers.add(id)
        return id
    }

    build(kind) {
        const now = this.ctx.currentTime
        const group = this.gain(0)
        group.connect(this.master)
        group.gain.linearRampToValueAtTime(1, now + 1.6) // 缓慢淡入，不惊扰阅读
        const parts = []
        if (kind === 'rain') {
            const bed = this.gain(.3), hiss = this.gain(.1), patter = this.gain(.16)
            const b = this.source('white'), bf = this.filter('lowpass', 950, .4)
            b.connect(bf); bf.connect(bed); bed.connect(group)
            const h = this.source('white'), hf = this.filter('highpass', 3200, .5)
            h.connect(hf); hf.connect(hiss); hiss.connect(group)
            const p = this.source('brown'), pf = this.filter('bandpass', 2400, .9)
            p.connect(pf); pf.connect(patter); patter.connect(group)
            parts.push(b, h, p, ...this.lfo(.4, .07, patter.gain))
            this.rainGain = bed
        } else if (kind === 'snow') {
            // 落雪：低沉风垫 + 稀疏细碎击窗，音量压低，不盖过阅读。
            const bed = this.gain(.18)
            const b = this.source('pink'), bf = this.filter('lowpass', 380, .5)
            b.connect(bf); bf.connect(bed); bed.connect(group)
            parts.push(b, ...this.lfo(.037, .07, bed.gain))
            const flakes = () => {
                if (this.kind !== 'snow') return
                const burst = this.source('white', false)
                const f = this.filter('bandpass', 2600 + Math.random() * 2400, 3.2)
                const env = this.gain(0)
                const t = this.ctx.currentTime
                env.gain.setValueAtTime(0, t)
                env.gain.linearRampToValueAtTime(.03 + Math.random() * .04, t + .002)
                env.gain.exponentialRampToValueAtTime(.0001, t + .028 + Math.random() * .04)
                burst.connect(f); f.connect(env); env.connect(group)
                burst.start(t); burst.stop(t + .08)
                this.later(flakes, 50 + Math.random() * 220)
            }
            this.later(flakes, 240)
        } else if (kind === 'waves') {
            // 海浪：低频噪声床 + 两层缓慢潮汐起伏 + 远处浪花白沫
            const swell = this.gain(.4)
            const b = this.source('brown'), bf = this.filter('lowpass', 520, .5)
            b.connect(bf); bf.connect(swell); swell.connect(group)
            const foam = this.gain(.05)
            const w = this.source('white'), wf = this.filter('highpass', 2200, .5)
            w.connect(wf); wf.connect(foam); foam.connect(group)
            parts.push(b, w,
                ...this.lfo(.062, .45, swell.gain),
                ...this.lfo(.041, .28, swell.gain, .6),
                ...this.lfo(.062, .035, foam.gain))
        } else if (kind === 'stream') {
            // 溪流：窄带噪声 + 频率摆动，模拟流水绕石
            const body = this.gain(.17)
            const b = this.source('white'), hp = this.filter('highpass', 900, .5), bp = this.filter('bandpass', 2000, .7)
            b.connect(hp); hp.connect(bp); bp.connect(body); body.connect(group)
            parts.push(b, ...this.lfo(.5, 260, bp.frequency), ...this.lfo(.23, .05, body.gain))
        } else if (kind === 'white') {
            const g = this.gain(.12)
            const b = this.source('white')
            b.connect(g); g.connect(group)
            parts.push(b)
        } else if (kind === 'pink') {
            const g = this.gain(.26)
            const b = this.source('pink')
            b.connect(g); g.connect(group)
            parts.push(b)
        } else if (kind === 'brown') {
            const g = this.gain(.4)
            const b = this.source('brown'), bf = this.filter('lowpass', 420, .4)
            b.connect(bf); bf.connect(g); g.connect(group)
            parts.push(b)
        } else if (kind === 'wind') {
            const body = this.gain(.5)
            const b = this.source('brown'), f = this.filter('bandpass', 380, .6)
            b.connect(f); f.connect(body); body.connect(group)
            parts.push(b, ...this.lfo(.05, 160, f.frequency), ...this.lfo(.083, .22, body.gain))
            const whistle = this.gain(.05)
            const w = this.source('pink'), wf = this.filter('bandpass', 900, 6)
            w.connect(wf); wf.connect(whistle); whistle.connect(group)
            parts.push(w, ...this.lfo(.031, 220, wf.frequency))
        } else if (kind === 'fire') {
            const bed = this.gain(.34)
            const b = this.source('brown'), bf = this.filter('lowpass', 460, .5)
            b.connect(bf); bf.connect(bed); bed.connect(group)
            const glow = this.gain(.12)
            const g = this.source('pink'), gf = this.filter('lowpass', 140, .7)
            g.connect(gf); gf.connect(glow); glow.connect(group)
            parts.push(b, g, ...this.lfo(.23, .1, bed.gain))
            const crackle = () => {
                if (this.kind !== 'fire') return
                const burst = this.source('white', false)
                const f = this.filter('highpass', 1400 + Math.random() * 1800, 1)
                const env = this.gain(0)
                const t = this.ctx.currentTime
                const peak = .1 + Math.random() * .3
                env.gain.setValueAtTime(0, t)
                env.gain.linearRampToValueAtTime(peak, t + .004)
                env.gain.exponentialRampToValueAtTime(.0001, t + .05 + Math.random() * .09)
                burst.connect(f); f.connect(env); env.connect(group)
                burst.start(t); burst.stop(t + .2)
                this.later(crackle, 90 + Math.random() * 420)
            }
            this.later(crackle, 300)
        } else if (kind === 'crickets') {
            // 虫鸣：两支高频纯音做脉动合唱，音量刻意压低，只作氛围。
            const chorus = this.gain(.16)
            chorus.connect(group)
            for (const [freq, rate, detune] of [[4320, 21, 0], [4650, 17.3, .07]]) {
                const osc = this.ctx.createOscillator()
                osc.type = 'sine'; osc.frequency.value = freq; osc.detune.value = detune * 100
                const voice = this.gain(0)
                const pulse = this.ctx.createOscillator()
                pulse.type = 'square'; pulse.frequency.value = rate
                const depth = this.gain(.5), bias = this.ctx.createConstantSource ? this.ctx.createConstantSource() : null
                pulse.connect(depth); depth.connect(voice.gain)
                if (bias) { bias.offset.value = .5; bias.connect(voice.gain); bias.start(); parts.push(bias) }
                const swell = this.ctx.createOscillator()
                swell.type = 'sine'; swell.frequency.value = .13 + Math.random() * .1
                const swellDepth = this.gain(.35)
                swell.connect(swellDepth); swellDepth.connect(voice.gain)
                osc.connect(voice); voice.connect(chorus)
                osc.start(); pulse.start(); swell.start()
                parts.push(osc, pulse, swell)
            }
        }
        this.group = group
        this.parts = parts
        this.kind = kind
        this.applyRainAmount()
    }

    applyRainAmount() {
        if (this.kind !== 'rain' || !this.rainGain || !this.ctx) return
        const target = .25 + .75 * this.rainAmount
        this.rainGain.gain.setTargetAtTime(target, this.ctx.currentTime, .4)
    }

    setRainAmount(v) { this.rainAmount = Math.max(0, Math.min(1, Number(v) || 0)); this.applyRainAmount() }

    setVolume(v) {
        this.volume = Math.max(0, Math.min(1, Number(v) || 0))
        if (this.master && this.ctx) this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, .25)
    }

    async play(kind) {
        if (!KINDS.includes(kind)) throw new Error('未知环境声: ' + kind)
        await this.ensure()
        if (this.kind === kind) return
        this.stop(true)
        this.build(kind)
    }

    stop(keepContext = false) {
        this.kind = null
        for (const id of this.timers) clearTimeout(id)
        this.timers.clear()
        if (this.group && this.ctx) {
            const group = this.group, parts = this.parts || []
            group.gain.setTargetAtTime(0, this.ctx.currentTime, .35)
            this.later(() => {
                for (const part of parts) { try { part.stop() } catch { /* 已停止 */ } }
                try { group.disconnect() } catch { /* 已断开 */ }
            }, 1200)
        }
        this.group = null; this.parts = null; this.rainGain = null
        if (!keepContext && this.ctx) { /* 保留上下文，避免再次授权提示 */ }
    }

    // 闷雷：一声低频轰鸣，distance 0(近)~1(远)，远雷更闷更轻。
    thunder(distance = .7) {
        if (!this.ctx || this.ctx.state !== 'running') return
        const t = this.ctx.currentTime + .04
        const dur = 2.6 + Math.random() * 1.8
        const src = this.source('brown', false)
        const f = this.filter('lowpass', 0, .6)
        f.frequency.setValueAtTime(320 - 200 * distance, t)
        f.frequency.exponentialRampToValueAtTime(70, t + dur)
        const env = this.gain(0)
        const peak = .9 - .55 * distance
        env.gain.setValueAtTime(0, t)
        env.gain.linearRampToValueAtTime(peak, t + .09 + .12 * distance)
        // 衰减途中加两次随机起伏，模拟雷声滚动
        const curve = new Float32Array(24)
        for (let i = 0; i < curve.length; i++) {
            const phase = i / (curve.length - 1)
            curve[i] = Math.max(.0001, (1 - phase) * (.7 + .3 * Math.sin(phase * 9 + Math.random())))
        }
        env.gain.setValueCurveAtTime(curve, t + .15, dur - .15)
        src.connect(f); f.connect(env); env.connect(this.master)
        src.start(t); src.stop(t + dur + .1)
    }

    destroy() {
        this.abort.abort()
        this.stop()
        if (this.ctx) this.ctx.close().catch(() => {})
    }
}
