// Two-pass background renderer: media/fluid -> mipmapped texture -> refractive wet glass.
// No text is drawn into this canvas. See rain-shaders.js for the Heartfelt attribution.
import { VERTEX, BACKGROUND, GLASS } from './rain-shaders.js'

// 质量档位的最小变更间隔（毫秒）：升降档共用一条绝对冷却，
// 防止 30fps 临界设备以 10-15s 周期反复重建 FBO、画面分辨率跟着闪。
const MIN_QUALITY_INTERVAL = 20000

export class RainGlass extends EventTarget {
    constructor(root, settings) {
        super()
        this.settings = settings
        this.canvas = document.createElement('canvas')
        this.canvas.className = 'rain-canvas'
        this.canvas.dataset.state = 'loading'
        root.append(this.canvas)
        this.current = { kind: 'fluid', element: null }
        this.previous = this.current
        this.time = 26
        this.mix = 1
        this.flash = 0
        this.lum = 0.5
        this.quality = 1        // 性能自适应：持续掉帧时降低内部渲染分辨率，负载退去后再升回
        this.slowFrames = 0
        this.fastFrames = 0
        this.lastQualityChange = 0
        this.frames = 0
        this.transitionStart = 0
        this.imageTextures = new WeakMap()
        this.reduced = matchMedia('(prefers-reduced-motion: reduce)')
        this.abort = new AbortController()
        const opts = { signal: this.abort.signal }
        this.canvas.addEventListener('webglcontextlost', e => {
            e.preventDefault(); this.available = false; this.canvas.style.opacity = '0'
            cancelAnimationFrame(this.raf); this.canvas.dataset.state = 'lost'; this.emitStatus()
        }, opts)
        this.canvas.addEventListener('webglcontextrestored', () => {
            this.initialize(); this.dirty = true; this.safeResize(); this.wake()
        }, opts)
        window.addEventListener('resize', () => {
            // 防抖 200ms：拖拽窗口时每个 resize 事件都会触发 FBO+纹理全量重建，
            // 低端机上掉帧明显（对齐 background.js 可读性重算的防抖节奏）。
            // contextrestored 路径保持立即调用，不走这里。
            clearTimeout(this._resizeT)
            this._resizeT = setTimeout(() => { this.safeResize(); this.wake() }, 200)
        }, opts)
        document.addEventListener('visibilitychange', () => this.syncMotion(), opts)
        this.reduced.addEventListener('change', () => this.syncMotion(), opts)
        this.initialize(); this.safeResize(); this.syncMotion()
    }
    initialize() {
        try {
            // preserveDrawingBuffer 关掉：它只为注释里「resize 同任务内立刻补画」而开着，而那次补画
            // 本身就保证合成器拿到有内容的一帧；开着它等于让合成器额外保留一份可读后备缓冲（约 1.3M 像素）。
            // 全仓没有任何对雨窗画布的 toDataURL，也没有“下一帧再读”的 readPixels
            //（tests/rain-regression.js:27 与 tests/scene-controls-check.mjs:51 都是 draw() 之后立即读），
            // 所以像素取证路径不依赖它。静止帧由合成器保留，与旧行为一致（待运行时再确认一次）。
            this.gl = this.canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, powerPreference: 'low-power' })
            if (!this.gl) throw new Error('WebGL2 unavailable')
            const gl = this.gl
            const program = fragment => {
                const p = gl.createProgram()
                for (const [type, code] of [[gl.VERTEX_SHADER, VERTEX], [gl.FRAGMENT_SHADER, fragment]]) {
                    const s = gl.createShader(type); gl.shaderSource(s, code); gl.compileShader(s)
                    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { const error=gl.getShaderInfoLog(s);gl.deleteShader(s);throw new Error(error) }
                    gl.attachShader(p, s); gl.deleteShader(s)
                }
                gl.linkProgram(p)
                if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p))
                return p
            }
            this.sourceProgram = program(BACKGROUND); this.glassProgram = program(GLASS)
            this.uniforms = new Map()
            this.textures = [this.texture(), this.texture()]
            this.background = this.texture(true)
            this.fbo = gl.createFramebuffer()
            this.width = this.height = 0
            this.available = true; this.dirty = true
            this.canvas.style.opacity = '1'; this.canvas.dataset.state = 'ready'
        } catch (error) {
            console.warn('雨窗未启用，保留普通背景：', error.message)
            this.available = false; this.canvas.style.opacity = '0'; this.canvas.dataset.state = 'unsupported'
        }
        this.emitStatus()
    }
    texture(mip = false) {
        const gl = this.gl, texture = gl.createTexture()
        gl.bindTexture(gl.TEXTURE_2D, texture)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mip ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([30, 60, 56, 255]))
        return texture
    }
    uniform(program, name, type, ...values) {
        let map = this.uniforms.get(program)
        if (!map) { map = new Map(); this.uniforms.set(program, map) }
        if (!map.has(name)) map.set(name, this.gl.getUniformLocation(program, name))
        this.gl[type](map.get(name), ...values)
    }
    resize() {
        if (!this.available) return
        // Fixed fill-rate budget even on Retina / 4K displays, further scaled by adaptive quality.
        const ratio = Math.min(devicePixelRatio || 1, 1.5, Math.sqrt(1300000 / Math.max(1, innerWidth * innerHeight))) * (this.quality || 1)
        const w = Math.max(1, Math.round(innerWidth * ratio)), h = Math.max(1, Math.round(innerHeight * ratio))
        if (w === this.width && h === this.height) return
        this.width = this.canvas.width = w; this.height = this.canvas.height = h
        const gl = this.gl
        gl.bindTexture(gl.TEXTURE_2D, this.background)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
        gl.generateMipmap(gl.TEXTURE_2D)
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo)
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.background, 0)
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('背景缓冲区不可用')
        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
        this.dirty = true
        // Resizing clears WebGL's drawing buffer. Refill it in this same task,
        // before the browser can composite a blank frame between animation ticks.
        this.draw()
    }
    // resize() 会抛（FBO 不完整 → 「背景缓冲区不可用」，末段的补画 draw() 也可能抛）。
    // 所有调用点都必须走这一层：异常一旦冒出 window 监听器或渲染回调，wake() 不再执行、
    // this.raf 停在旧 id，雨窗静止在最后一帧而 available 仍是 true，
    // 面板也就永远不会切到「当前浏览器使用普通背景」。
    safeResize() {
        if (!this.available) return
        try { this.resize() } catch (error) {
            console.warn('雨窗缓冲区重建失败，改用普通背景：', error.message)
            this.available = false
            cancelAnimationFrame(this.raf); this.raf = 0
            this.canvas.dataset.state = 'unsupported'
            this.canvas.style.opacity = '0'
            this.emitStatus()
        }
    }
    // 换档：重建 FBO（resize 内部会补画一帧，避免糊/黑的一帧）。走 safeResize，
    // 降载路径上的 FBO 失败同样不能把渲染回调打断。
    applyQuality(quality, now) {
        this.quality = quality
        this.slowFrames = 0; this.fastFrames = 0
        this.lastQualityChange = now
        this.width = 0
        this.safeResize()
        this.canvas.dataset.quality = this.quality.toFixed(2)
    }
    get moving() { return this.settings.motion && !this.reduced.matches && !document.hidden }
    get weather() {
        const w = this.settings.weather
        return w === 'snow' || w === 'clear' ? w : 'rain'
    }
    get weatherIndex() { return this.weather === 'snow' ? 1 : this.weather === 'clear' ? 2 : 0 }
    get weatherOn() {
        if (!this.settings.enabled) return false
        if (this.weather === 'snow') return (this.settings.snow ?? 0) > 0
        if (this.weather === 'clear') return false
        return this.settings.rain > 0
    }
    get needsAnimation() {
        return this.moving && (this.mix < 1 || this.current.kind === 'video' || this.current.kind === 'three' || this.current.kind === 'fluid' || this.weatherOn || this.flash > 0.001)
    }
    // 场景亮度（0-1）由可读性采样层提供，用于雨滴高光与雾感的场景联动。
    setLuminance(v) { this.lum = Math.max(0, Math.min(1, Number(v) || 0)) }
    // 远处闪电：外部调度器触发，渲染循环内自行衰减。
    strike(strength = 1) { if (this.available && this.settings.motion && !this.reduced.matches) this.flash = Math.min(1, Math.max(this.flash, strength)) }
    textureSource(source) {
        const image = source.element
        if (source.kind === 'three' || source.kind === 'video') return image
        if (this.imageTextures.has(image)) return this.imageTextures.get(image)
        const limit = Math.min(4096, this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE))
        const scale = Math.min(1, limit / Math.max(image.naturalWidth, image.naturalHeight))
        if (scale === 1) return image
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
        canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height)
        this.imageTextures.set(image, canvas)
        return canvas
    }
    setSource(source, animate = true) {
        if (this.previous !== this.current && this.previous.kind === 'video') this.previous.element?.pause?.()
        this.previous = this.current; this.current = source
        this.videoBlocked = false
        this.mix = animate && this.moving ? 0 : 1
        this.transitionStart = performance.now()
        this.dirty = true; this.canvas.dataset.mode = source.kind
        this.syncMotion()
    }
    update(settings) { this.settings = settings; this.dirty = true; this.syncMotion() }
    syncMotion() {
        for (const source of new Set([this.previous, this.current])) {
            if (source.kind !== 'video' || !source.element) continue
            if (this.moving && (source === this.current || this.mix < 1)) source.element.play().catch(() => {
                this.videoBlocked = true; this.emitStatus()
            })
            else source.element.pause()
        }
        if (!this.moving) this.mix = 1
        this.lastFrame = 0
        this.wake(); this.emitStatus()
    }
    wake() {
        cancelAnimationFrame(this.raf)
        if (!this.available || document.hidden) return
        this.lastFrame = 0
        this.raf = requestAnimationFrame(t => this.frame(t))
    }
    frame(now) {
        if (!this.available || document.hidden) return
        const elapsed = this.lastFrame ? now - this.lastFrame : 34
        if (elapsed >= 32) {
            const dt = Math.min(elapsed / 1000, .08)
            this.lastFrame = now
            if (this.moving) { this.time += dt; this.mix = Math.min(1, (now - this.transitionStart) / 1200) }
            if (this.flash > 0) this.flash = Math.max(0, this.flash - dt * 2.4)
            // 自适应升降档：持续掉帧（>46ms/帧）约 3 秒后降一档渲染分辨率；
            // 反过来持续跟上 30fps 预算（本循环的 elapsed 下限就是 32ms）约 8 秒后升回去。
            // 旧版只降不升，一次偶发卡顿就把画面永久糊到刷新为止。
            // 两个门统一为 20s 绝对冷却：30fps 临界设备上 10s/15s 的旧门会以
            // 10-15s 周期无限横跳，每次换档都重建 FBO、画面分辨率跟着闪一下。
            if (this.moving && this.mix >= 1) {
                this.slowFrames = elapsed > 46 ? this.slowFrames + 1 : Math.max(0, this.slowFrames - 1)
                this.fastFrames = elapsed <= 36 ? this.fastFrames + 1 : 0
                if (this.slowFrames > 90 && this.quality > .55 && now - this.lastQualityChange > MIN_QUALITY_INTERVAL) {
                    this.applyQuality(Math.max(.55, this.quality * .75), now)
                } else if (this.quality < 1 && this.fastFrames > 240 && now - this.lastQualityChange > MIN_QUALITY_INTERVAL) {
                    this.applyQuality(Math.min(1, this.quality / .75), now)
                }
            }
            // 升降档中的 safeResize 可能已把雨窗判死（FBO 不可用）：此时不能再画一帧
            if (!this.available) return
            try { this.draw() } catch (error) {
                console.warn('雨窗渲染暂停：', error.message)
                this.available = false; this.canvas.dataset.state = 'unsupported'; this.canvas.style.opacity = '0';this.emitStatus();return
            }
            if (this.mix === 1 && this.previous.kind === 'video' && this.previous !== this.current) this.previous.element?.pause?.()
            this.frames++
            this.canvas.dataset.state = this.moving ? 'ready' : 'paused'
            if (this.frames % 30 === 0 || !this.needsAnimation) this.canvas.dataset.frames = String(this.frames)
        }
        if (this.needsAnimation) this.raf = requestAnimationFrame(t => this.frame(t))
    }
    draw() {
        const gl = this.gl, p = this.sourceProgram
        gl.viewport(0, 0, this.width, this.height)
        gl.useProgram(p)
        this.uniform(p, 'u_resolution', 'uniform2f', this.width, this.height)
        this.uniform(p, 'u_time', 'uniform1f', this.time)
        this.uniform(p, 'u_mix', 'uniform1f', this.mix)
        this.uniform(p, 'u_fspeed', 'uniform1f', this.settings.flowSpeed ?? 1)
        // 过渡早已结束（u_mix===1）时启用单源分支：mix() 不是分支，旧写法即使上一背景完全不可见，
        // GPU 仍要对 u_tex0 做 cover 采样 + 整套 fluid() 噪声，背景片元成本约 2 倍。
        const single = this.mix >= 1
        this.uniform(p, 'u_single', 'uniform1i', single ? 1 : 0)
        for (const [i, source] of [this.previous, this.current].entries()) {
            gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, this.textures[i])
            const e = source.element
            const isThree = source.kind === 'three'
            // 单源分支不读 u_tex0 → 旧素材（尤其是已暂停的视频）不再每帧白传一遍纹理
            const upload = i === 1 || !single
            if (upload && e && (source.kind !== 'video' || e.readyState >= 2) && (this.dirty || source.kind === 'video' || (isThree && this.moving))) {
                gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.textureSource(source))
            }
            this.uniform(p, 'u_tex' + i, 'uniform1i', i)
            this.uniform(p, 'u_fluid' + i, 'uniform1i', source.kind === 'fluid' ? 1 : 0)
            this.uniform(p, 'u_size' + i, 'uniform2f', e?.videoWidth || e?.naturalWidth || e?.width || 1, e?.videoHeight || e?.naturalHeight || e?.height || 1)
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo); gl.drawArrays(gl.TRIANGLES, 0, 3)
        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.background)
        const rainGlass = this.weatherIndex === 0
        if (rainGlass) gl.generateMipmap(gl.TEXTURE_2D)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, rainGlass ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR)
        const r = this.glassProgram; gl.useProgram(r)
        const on = this.settings.enabled !== false
        const isSnow = this.weather === 'snow'
        this.uniform(r, 'u_bg', 'uniform1i', 0)
        this.uniform(r, 'u_resolution', 'uniform2f', this.width, this.height)
        this.uniform(r, 'u_time', 'uniform1f', this.time)
        this.uniform(r, 'u_rain', 'uniform1f', on && rainGlass ? this.settings.rain : 0)
        this.uniform(r, 'u_fog', 'uniform1f', on && rainGlass ? this.settings.fog : 0)
        this.uniform(r, 'u_ior', 'uniform1f', rainGlass ? this.settings.refraction : 1)
        this.uniform(r, 'u_wind', 'uniform1f', on ? this.settings.wind ?? 0 : 0)
        this.uniform(r, 'u_flash', 'uniform1f', rainGlass ? this.flash : 0)
        this.uniform(r, 'u_lum', 'uniform1f', this.lum)
        this.uniform(r, 'u_depthMix', 'uniform1f', this.settings.sceneFx === false ? 0 : 1)
        this.uniform(r, 'u_dropScale', 'uniform1f', this.settings.dropSize ?? 1)
        this.uniform(r, 'u_speed', 'uniform1f', on ? this.settings.fallSpeed ?? 1 : 1)
        this.uniform(r, 'u_trail', 'uniform1f', this.settings.trail ?? 1)
        this.uniform(r, 'u_bright', 'uniform1f', this.settings.brightness ?? 1)
        this.uniform(r, 'u_warm', 'uniform1f', this.settings.warmth ?? 0)
        this.uniform(r, 'u_weather', 'uniform1f', this.weatherIndex)
        this.uniform(r, 'u_snow', 'uniform1f', on && isSnow ? this.settings.snow ?? 0 : 0)
        this.uniform(r, 'u_snowDepth', 'uniform1f', this.settings.snowDepth ?? 0.65)
        gl.drawArrays(gl.TRIANGLES, 0, 3)
        this.canvas.dataset.weather = this.weather
        this.dirty = false
    }
    emitStatus() { this.dispatchEvent(new Event('status')) }
    destroy() {
        this.abort.abort(); cancelAnimationFrame(this.raf)
        clearTimeout(this._resizeT) // 残留的 resize 定时器会对已删除的 program/fbo 做 GL 调用
        for (const source of [this.current, this.previous]) if (source?.kind === 'video') source.element?.pause?.()
        if (this.gl && !this.gl.isContextLost()) {
            for (const t of [...(this.textures || []), this.background]) if(t)this.gl.deleteTexture(t)
            for (const p of [this.sourceProgram, this.glassProgram]) if(p)this.gl.deleteProgram(p)
            if(this.fbo)this.gl.deleteFramebuffer(this.fbo)
        }
        this.canvas.remove()
    }
}
