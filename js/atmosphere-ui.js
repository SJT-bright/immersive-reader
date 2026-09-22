// Small, independent inspector. Opening it does not rebuild reading or music DOM.
const ICONS = {
    rain: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="M12 3C10 6 5.5 10.4 5.5 14.4a6.5 6.5 0 0 0 13 0C18.5 10.4 14 6 12 3Z"/><path d="M8.5 14.5a3.5 3.5 0 0 0 3.5 3.5"/></svg>',
    snow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v18"/><path d="m5.4 7.2 13.2 9.6"/><path d="m5.4 16.8 13.2-9.6"/><path d="M12 6.4 10.4 4.8M12 6.4l1.6-1.6M12 17.6l-1.6 1.6M12 17.6l1.6 1.6"/></svg>',
    clear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="1.4"/><path d="M3.5 10.2h17"/><path d="M12 10.2v9.3"/><path d="M5.8 16.4c1.4-1.6 2.6-1.7 3.7 0 1.3 1.8 2.4 1.7 3.7 0"/></svg>',
}
const WEATHER = [
    ['rain', '雨窗', '玻璃上的雨滴'],
    ['snow', '窗外雪', '风景清晰，雪花落下'],
    ['clear', '晴空', '直接看见窗外'],
]
const TITLES = { rain: '雨窗', snow: '窗外雪', clear: '晴空' }

function rangeRow(id, label, min, max, step) {
    return `<div class="atmo-range" data-range="${id}"><label for="atmo-${id}">${label}</label><output for="atmo-${id}" id="atmo-value-${id}"></output><input id="atmo-${id}" data-atmosphere="${id}" type="range" min="${min}" max="${max}" step="${step}"></div>`
}

export class AtmosphereUI {
    constructor({settings, scene, persist, ambience, pickMedia, onOpen, useFluid}) {
        this.settings=settings;this.scene=scene;this.persist=persist;this.ambience=ambience
        this.toggle=document.querySelector('#atmosphere-toggle')
        this.panel=document.querySelector('#atmosphere-panel')
        this.panel.innerHTML=`<header><div><span class="atmo-eyebrow">窗外的天气</span><h2 id="atmo-title">雨窗</h2></div><button class="atmo-close" aria-label="关闭天气设置">×</button></header>
            <div class="atmo-weather" role="radiogroup" aria-label="天气">
            ${WEATHER.map(([id,label,hint])=>`<button type="button" class="atmo-weather-btn" data-weather="${id}" aria-pressed="false">${label}<small>${hint}</small></button>`).join('')}
            </div>
            <div class="atmo-media"><button id="atmo-upload" data-background-drop title="点击选择，或将图片视频拖到此按钮" class="atmo-primary">上传图片或视频 <span aria-hidden="true">↗</span></button>
            <button id="atmo-fluid" class="atmo-text">回到双色流体</button></div>
            <p id="atmo-source" class="atmo-caption"></p>
            <div class="atmo-controls">
            ${rangeRow('rain','雨势',0,1,.01)}
            ${rangeRow('snow','雪量',0,1,.01)}
            ${rangeRow('snowDepth','景深层次',0,1,.01)}
            ${rangeRow('fog','玻璃雾气',0,1,.01)}
            ${rangeRow('refraction','折射率',1,1.6,.01)}
            ${rangeRow('wind','微风',0,1,.01)}
            </div>
            <div class="atmo-options">
            <label id="atmo-enabled-wrap"><input type="checkbox" id="atmo-enabled"> <span id="atmo-enabled-label">玻璃雨滴</span></label>
            <label><input type="checkbox" id="atmo-motion"> 画面流动</label>
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
            <div class="atmo-ambience">
                <span class="atmo-ambience-title">氛围声</span>
                <div class="atmo-chips" role="group" aria-label="环境声">
                ${[['rain','雨声'],['snow','落雪'],['waves','海浪'],['stream','溪流'],['fire','篝火'],['crickets','虫鸣'],['wind','山风'],['white','白噪'],['pink','粉噪'],['brown','棕噪']].map(([k,label])=>`<button type="button" class="atmo-chip" data-ambience="${k}" aria-pressed="false">${label}</button>`).join('')}
                </div>
                <div class="atmo-range"><label for="atmo-amb-volume">声量</label><output id="atmo-amb-volume-value"></output><input id="atmo-amb-volume" data-ambience-volume type="range" min="0" max="1" step="0.01"></div>
                <label class="atmo-thunder-label" id="atmo-thunder-wrap"><input type="checkbox" id="atmo-thunder"> 闪电配闷雷</label>
            </div>
            <p id="atmo-status" class="atmo-caption" role="status"></p>
            <a class="atmo-credit" href="https://www.shadertoy.com/view/ltffzl" target="_blank" rel="noreferrer">雨滴源自 Heartfelt · BigWings</a>`
        this.toggle.addEventListener('click',()=>onOpen())
        this.panel.querySelector('.atmo-close').addEventListener('click',()=>this.close())
        this.panel.querySelector('#atmo-upload').addEventListener('click',pickMedia)
        this.panel.querySelector('#atmo-fluid').addEventListener('click',useFluid)
        this.panel.addEventListener('click',e=>{
            const btn=e.target.closest('[data-weather]')
            if(!btn)return
            const weather=btn.dataset.weather
            settings.atmosphere.weather=weather
            if(weather!=='clear')settings.atmosphere.enabled=true
            if(weather==='snow'&&settings.atmosphere.snow<.08)settings.atmosphere.snow=.62
            scene.rain.update(settings.atmosphere);persist();this.update()
            if(this.ambience)this.ambience.setRainAmount(settings.atmosphere.enabled&&weather==='rain'?settings.atmosphere.rain:0)
        })
        this.panel.addEventListener('input',e=>{
            const key=e.target.dataset.atmosphere
            if(key){
                settings.atmosphere[key]=Number(e.target.value)
                scene.rain.update(settings.atmosphere);persist();this.update();
                if(key==='rain'&&this.ambience)this.ambience.setRainAmount(settings.atmosphere.enabled&&settings.atmosphere.weather==='rain'?settings.atmosphere.rain:0)
                if(key==='paperOpacity')document.documentElement.style.setProperty('--paper-a',String(settings.atmosphere.paperOpacity))
                return
            }
            if(e.target.dataset.ambienceVolume!==undefined){
                settings.ambience.volume=Number(e.target.value)
                if(this.ambience)this.ambience.setVolume(settings.ambience.volume)
                persist();this.update()
            }
        })
        for(const [id,key] of [['atmo-enabled','enabled'],['atmo-motion','motion'],['atmo-lightning','lightning'],['atmo-scenefx','sceneFx']]){
            this.panel.querySelector('#'+id).addEventListener('change',e=>{
                settings.atmosphere[key]=e.target.checked
                scene.rain.update(settings.atmosphere);persist();this.update()
            })
        }
        for(const chip of this.panel.querySelectorAll('.atmo-chip')){
            chip.addEventListener('click',async()=>{
                const kind=chip.dataset.ambience,a=settings.ambience
                if(!this.ambience)return
                try{
                    if(a.enabled&&a.kind===kind){a.enabled=false;this.ambience.stop()}
                    else{a.enabled=true;a.kind=kind;await this.ambience.play(kind);this.ambience.setVolume(a.volume);this.ambience.setRainAmount(settings.atmosphere.enabled&&settings.atmosphere.weather==='rain'?settings.atmosphere.rain:0)}
                    persist();this.update()
                }catch(error){this.panel.querySelector('#atmo-status').textContent='环境声未能播放：'+error.message}
            })
        }
        this.panel.querySelector('#atmo-thunder').addEventListener('change',e=>{
            settings.ambience.thunder=e.target.checked;persist();this.update()
        })
        document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!this.panel.hidden){e.preventDefault();this.close()}},true)
        scene.addEventListener('scenechange',()=>this.update())
        scene.rain.addEventListener('status',()=>this.update())
        this.update()
    }
    open(){this.panel.hidden=false;this.toggle.setAttribute('aria-expanded','true');this.panel.querySelector('#atmo-upload').focus()}
    close(focus=true){const wasOpen=!this.panel.hidden;this.panel.hidden=true;this.toggle.setAttribute('aria-expanded','false');if(focus&&wasOpen)this.toggle.focus()}
    update(){
        const a=this.settings.atmosphere,amb=this.settings.ambience,rain=this.scene.rain
        const weather=a.weather==='snow'||a.weather==='clear'?a.weather:'rain'
        this.toggle.innerHTML=ICONS[weather]||ICONS.rain
        this.toggle.setAttribute('aria-label','天气设置')
        this.toggle.title='天气设置'
        this.panel.querySelector('#atmo-title').textContent=TITLES[weather]
        for(const btn of this.panel.querySelectorAll('[data-weather]')){
            btn.setAttribute('aria-pressed',String(btn.dataset.weather===weather))
        }
        const show={
            rain: weather==='rain',
            snow: weather==='snow',
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
        this.panel.querySelector('#atmo-motion').checked=a.motion
        this.panel.querySelector('#atmo-lightning').checked=a.lightning
        this.panel.querySelector('#atmo-scenefx').checked=a.sceneFx!==false
        this.panel.querySelector('#atmo-lightning-wrap').hidden=weather!=='rain'
        this.panel.querySelector('#atmo-scenefx-wrap').hidden=weather!=='rain'
        this.panel.querySelector('#atmo-thunder-wrap').hidden=weather!=='rain'
        this.panel.querySelector('.atmo-credit').hidden=weather!=='rain'
        for(const chip of this.panel.querySelectorAll('.atmo-chip')){
            const active=!!(amb.enabled&&this.ambience&&this.ambience.running&&this.ambience.kind===chip.dataset.ambience)
            chip.setAttribute('aria-pressed',String(active))
        }
        this.panel.querySelector('#atmo-amb-volume').value=amb.volume
        this.panel.querySelector('#atmo-amb-volume-value').textContent=Math.round(amb.volume*100)+'%'
        this.panel.querySelector('#atmo-thunder').checked=amb.thunder
        this.panel.querySelector('#atmo-source').textContent=this.scene.currentRef?this.scene.refName(this.scene.currentRef):'双色流体'
        const weatherLine=weather==='snow'?'雪在窗外落下，风景保持清晰。':weather==='clear'?'窗外风景没有雾气，书页保持清晰。':'雨在窗外流动，书页保持清晰。'
        this.panel.querySelector('#atmo-status').textContent=!rain.available?'当前浏览器使用普通背景，天气特效暂不可用。':rain.reduced.matches?'已遵循系统减少动态效果，画面保持静止。':!a.motion?'画面已静止，文字与音乐仍可使用。':rain.videoBlocked?'视频暂未播放，请切换一次画面流动。':rain.current.kind==='video'?'背景视频静音循环，书页保持清晰。':weatherLine
        this.toggle.dataset.active=String((weather==='clear'||a.enabled)&&rain.available)
        this.toggle.dataset.weather=weather
    }
}
