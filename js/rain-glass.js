// Two-pass background renderer: media/fluid -> mipmapped texture -> refractive wet glass.
// No text is drawn into this canvas. See rain-shaders.js for the Heartfelt attribution.
import { VERTEX, BACKGROUND, GLASS } from './rain-shaders.js?v=2.2.0'

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
        this.quality = 1        // 性能自适应：持续掉帧时降低内部渲染分辨率
        this.slowFrames = 0
        this.lastDowngrade = 0
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
            this.initialize(); this.dirty = true; this.resize(); this.wake()
        }, opts)
        window.addEventListener('resize', () => { this.resize(); this.wake() }, opts)
        document.addEventListener('visibilitychange', () => this.syncMotion(), opts)
        this.reduced.addEventListener('change', () => this.syncMotion(), opts)
        this.initialize(); this.resize(); this.syncMotion()
    }
    initialize() {
        try {
            this.gl = this.canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, preserveDrawingBuffer: true, powerPreference: 'low-power' })
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
            // 自适应降载：持续掉帧（>46ms/帧）约 3 秒后降一档渲染分辨率，每档至少间隔 10 秒
            if (this.moving && this.mix >= 1) {
                this.slowFrames = elapsed > 46 ? this.slowFrames + 1 : Math.max(0, this.slowFrames - 1)
                if (this.slowFrames > 90 && this.quality > .55 && now - this.lastDowngrade > 10000) {
                    this.quality = Math.max(.55, this.quality * .75)
                    this.slowFrames = 0
                    this.lastDowngrade = now
                    this.width = 0
                    this.resize()
                    this.canvas.dataset.quality = this.quality.toFixed(2)
                }
            }
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
        for (const [i, source] of [this.previous, this.current].entries()) {
            gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, this.textures[i])
            const e = source.element
            const isThree = source.kind === 'three'
            if (e && (source.kind !== 'video' || e.readyState >= 2) && (this.dirty || source.kind === 'video' || (isThree && this.moving))) {
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
        for (const source of [this.current, this.previous]) if (source?.kind === 'video') source.element?.pause?.()
        if (this.gl && !this.gl.isContextLost()) {
            for (const t of [...(this.textures || []), this.background]) if(t)this.gl.deleteTexture(t)
            for (const p of [this.sourceProgram, this.glassProgram]) if(p)this.gl.deleteProgram(p)
            if(this.fbo)this.gl.deleteFramebuffer(this.fbo)
        }
        this.canvas.remove()
    }
}
