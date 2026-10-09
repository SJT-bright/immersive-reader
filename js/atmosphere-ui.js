// Small, independent inspector. Opening it does not rebuild reading or music DOM.
const ICONS = {
    rain: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="M12 3C10 6 5.5 10.4 5.5 14.4a6.5 6.5 0 0 0 13 0C18.5 10.4 14 6 12 3Z"/><path d="M8.5 14.5a3.5 3.5 0 0 0 3.5 3.5"/></svg>',
    snow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v18"/><path d="m5.4 7.2 13.2 9.6"/><path d="m5.4 16.8 13.2-9.6"/><path d="M12 6.4 10.4 4.8M12 6.4l1.6-1.6M12 17.6l-1.6 1.6M12 17.6l1.6 1.6"/></svg>',
    clear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="1.4"/><path d="M3.5 10.2h17"/><path d="M12 10.2v9.3"/><path d="M5.8 16.4c1.4-1.6 2.6-1.7 3.7 0 1.3 1.8 2.4 1.7 3.7 0"/></svg>',
}
const TITLES = { rain: '雨窗', snow: '窗外雪', clear: '晴空' }

function rangeRow(id, label, min, max, step) {
    return `<div class="atmo-range" data-range="${id}"><label for="atmo-${id}">${label}</label><output for="atmo-${id}" id="atmo-value-${id}"></output><input id="atmo-${id}" data-atmosphere="${id}" type="range" min="${min}" max="${max}" step="${step}"></div>`
}

export class AtmosphereUI {
    constructor({settings, scene, persist, ambience, pickMedia, onOpen, useFluid}) {
        this.settings=settings;this.scene=scene;this.persist=persist;this.ambience=ambience
        this.panel=document.querySelector('#atmosphere-panel')
        this.toggle=document.querySelector('#atmosphere-toggle')
        this.panel.innerHTML=`<header><div><span class="atmo-eyebrow">窗外的天气</span><h2 id="atmo-title">雨窗</h2><p class="atmo-caption">天气与声音在「阅读环境」里调整，这里只管画面参数</p></div><button class="atmo-close" aria-label="关闭天气设置">×</button></header>
            <div class="atmo-media"><button id="atmo-upload" data-background-drop title="点击选择，或将图片视频拖到此按钮" class="atmo-primary">上传图片或视频 <span aria-hidden="true">↗</span></button>
            <button id="atmo-fluid" class="atmo-text">回到双色流体</button></div>
            <p id="atmo-source" class="atmo-caption"></p>
            <div class="atmo-controls">
            ${rangeRow('snowDepth','景深层次',0,1,.01)}
            ${rangeRow('fog','玻璃雾气',0,1,.01)}
            ${rangeRow('refraction','折射率',1,1.6,.01)}
            ${rangeRow('wind','微风',0,1,.01)}
            </div>
            <div class="atmo-options">
            <label id="atmo-enabled-wrap"><input type="checkbox" id="atmo-enabled"> <span id="atmo-enabled-label">玻璃雨滴</span></label>
            <label id="atmo-lightning-wrap"><input type="checkbox" id="atmo-lightning"> 远处闪电</label>
            <label id="atmo-scenefx-wrap"><input type="checkbox" id="atmo-scenefx"> 雨景联动</label>
            </div>
            <details class="atmo-advanced"><summary>进阶调参（默认收起）</summary>
            <div class="atmo-controls">
            ${rangeRow('dropSize','雨滴大小',.6,1.6,.01)}
            ${rangeRow('fallSpeed','下落速度',.5,2,.01)}
            ${rangeRow('trail','水痕',0,1.6,.01)}
            ${rangeRow('flowSpeed','流体速度',.5,2,.01)}
            ${rangeRow('brightness','画面亮度',.75,1.3,.01)}
            ${rangeRow('warmth','色温',-1,1,.01)}
            ${rangeRow('parallax','视差强度',0,2,.01)}
            ${rangeRow('paperOpacity','纸面浓度',.55,1,.01)}
            ${rangeRow('lightningEvery','雷电频率',0,1,.01)}
            </div></details>
            <p id="atmo-status" class="atmo-caption" role="status"></p>
            <a class="atmo-credit" href="https://www.shadertoy.com/view/ltffzl" target="_blank" rel="noreferrer">雨滴源自 Heartfelt · BigWings</a>`
        // 入口现状：#atmosphere-toggle 自 HEAD 起就被 css/glass-ui.css:49 长期 display:none!important，
        // 抽屉里的 header/.atmo-close 也被 css/glass-ui.css:201 藏掉 —— 两个入口既点不到也 Tab 不到。
        // 处理口径：监听留着（一个常驻监听不产生逐事件成本，CSS 若恢复入口则自动生效，无需重新接线），
        // 把「每次 status 事件重写不可见 DOM」的写入改成真的变了才写；确认无法到达的分支删掉（见下）。
        // 另外 aria-label/title 是常量，从 update() 挪到这里只写一次。
        this.toggle?.setAttribute('aria-label', '天气设置')
        if (this.toggle) this.toggle.title = '天气设置'
        this.toggle?.addEventListener('click', () => onOpen())
        this.panel.querySelector('.atmo-close').addEventListener('click',()=>this.close())
        this.panel.querySelector('#atmo-upload').addEventListener('click',pickMedia)
        this.panel.querySelector('#atmo-fluid').addEventListener('click',useFluid)
        // 最近一次真正写进 DOM 的天气，用于跳过重复写入（图标是一次 innerHTML 解析，最贵）
        this._paintedWeather = null
        this._paintedActive = null
        this.panel.addEventListener('input',e=>{
            const key=e.target.dataset.atmosphere
            if(!key)return
            settings.atmosphere[key]=Number(e.target.value)
            scene.rain.update(settings.atmosphere);persist();this.update();
            // 删掉的死分支：rain 滑杆联动雨声。面板里没有任何 data-atmosphere="rain" 的控件
            // （10-05 与「阅读环境」去重时一起摘掉了），所以 key 永远不等于 rain；
            // 雨声联动现由 main.js:1570 正常驱动。
            if(key==='paperOpacity')document.documentElement.style.setProperty('--paper-a',String(settings.atmosphere.paperOpacity))
        })
        for(const [id,key] of [['atmo-enabled','enabled'],['atmo-lightning','lightning'],['atmo-scenefx','sceneFx']]){
            this.panel.querySelector('#'+id).addEventListener('change',e=>{
                settings.atmosphere[key]=e.target.checked
                scene.rain.update(settings.atmosphere);persist();this.update()
            })
        }
        document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!this.panel.hidden){e.preventDefault();this.close()}},true)
        scene.addEventListener('scenechange',()=>this.update())
        scene.rain.addEventListener('status',()=>this.update())
        this.update()
    }
    // open() 已删除：main.js 没有任何调用点，而且 hidden 位现在由抽屉独占
    // （renderPanel 里 `$('#atmosphere-panel').hidden = activePanel !== 'rain'`），
    // 再留一个直接把浮窗掀开的 open() 只会和它打架 —— 旧浮窗设计的遗产。
    close(focus=true){
        const wasOpen=!this.panel.hidden
        this.panel.hidden=true
        this.toggle?.setAttribute('aria-expanded','false')
        // 对 display:none 的元素 focus() 是静默失败（焦点原地不动，键盘用户被卡住），所以先确认可见。
        // 注意 #atmosphere-toggle 是 position:fixed，不能用 offsetParent 判可见。
        const visible=this.toggle&&getComputedStyle(this.toggle).display!=='none'
        if(focus&&wasOpen&&visible)this.toggle.focus()
    }
    update(){
        const a=this.settings.atmosphere,rain=this.scene.rain
        const weather=a.weather==='snow'||a.weather==='clear'?a.weather:'rain'
        const active=String((weather==='clear'||a.enabled)&&rain.available)
        // 不可见入口（#atmosphere-toggle、抽屉里被隐藏的 header/#atmo-title）的写入
        // 只在天气真的变了时发生：图标那一次是 innerHTML 解析整段 SVG，原来每个 status 事件都重解析一遍。
        // 常量写入（aria-label/title）已挪到构造函数。
        if (this._paintedWeather !== weather) {
            this._paintedWeather = weather
            if (this.toggle) {
                this.toggle.innerHTML = ICONS[weather] || ICONS.rain
                this.toggle.dataset.weather = weather
            }
            const title=this.panel.querySelector('#atmo-title')
            if(title)title.textContent=TITLES[weather]
        }
        if (this._paintedActive !== active) {
            this._paintedActive = active
            if (this.toggle) this.toggle.dataset.active = active
        }
        const show={
            snowDepth: weather==='snow',
            fog: weather==='rain',
            refraction: weather==='rain',
            wind: weather!=='clear',
            dropSize: weather!=='clear',
            fallSpeed: weather!=='clear',
            trail: weather==='rain',
            lightningEvery: weather==='rain',
            flowSpeed: true, brightness: true, warmth: true, parallax: true, paperOpacity: true,
        }
        const decimals=new Set(['refraction','dropSize','fallSpeed','trail','flowSpeed','brightness','warmth','parallax','paperOpacity','lightningEvery'])
        for(const key of Object.keys(show)){
            const row=this.panel.querySelector(`[data-range="${key}"]`)
            if(!row)continue
            row.hidden=!show[key]
            const input=this.panel.querySelector('#atmo-'+key)
            if(!input)continue
            input.value=a[key]
            input.disabled=!rain.available||(weather!=='clear'&&!a.enabled&&key!=='flowSpeed'&&key!=='brightness'&&key!=='warmth'&&key!=='parallax'&&key!=='paperOpacity')
            this.panel.querySelector('#atmo-value-'+key).textContent=decimals.has(key)?Number(a[key]).toFixed(2):Math.round(a[key]*100)+'%'
        }
        const dropLabel=this.panel.querySelector('[data-range="dropSize"] label')
        if(dropLabel)dropLabel.textContent=weather==='snow'?'雪花大小':'雨滴大小'
        this.panel.querySelector('#atmo-enabled').checked=a.enabled
        this.panel.querySelector('#atmo-enabled').disabled=!rain.available
        this.panel.querySelector('#atmo-enabled-label').textContent=weather==='snow'?'窗外落雪':'玻璃雨滴'
        this.panel.querySelector('#atmo-enabled-wrap').hidden=weather==='clear'
        this.panel.querySelector('#atmo-lightning').checked=a.lightning
        this.panel.querySelector('#atmo-scenefx').checked=a.sceneFx!==false
        this.panel.querySelector('#atmo-lightning-wrap').hidden=weather!=='rain'
        this.panel.querySelector('#atmo-scenefx-wrap').hidden=weather!=='rain'
        this.panel.querySelector('.atmo-credit').hidden=weather!=='rain'
        this.panel.querySelector('#atmo-source').textContent=this.scene.currentRef?this.scene.refName(this.scene.currentRef):'双色流体'
        const weatherLine=weather==='snow'?'雪在窗外落下，风景保持清晰。':weather==='clear'?'窗外风景没有雾气，书页保持清晰。':'雨在窗外流动，书页保持清晰。'
        this.panel.querySelector('#atmo-status').textContent=!rain.available?'当前浏览器使用普通背景，天气特效暂不可用。':rain.reduced.matches?'已遵循系统减少动态效果，画面保持静止。':!a.motion?'画面已静止，文字与音乐仍可使用。':rain.videoBlocked?'视频暂未播放，请切换一次画面流动。':rain.current.kind==='video'?'背景视频静音循环，书页保持清晰。':weatherLine
        // 这里原来是每次 update 都重写 #atmosphere-toggle 的 dataset.active / dataset.weather，
        // 已并入上面「天气/状态真的变了才写」的分支。
    }
}
