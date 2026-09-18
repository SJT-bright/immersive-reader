// One in-flight operation; no timers accumulate while reading/navigation is busy.
export class AutoReading extends EventTarget {
    constructor(reader,settings,onError,persist=()=>{}) {
        super();Object.assign(this,{reader,settings,onError,persist});this.running=false;this.generation=0
        reader.addEventListener('manualnavigation',()=>this.stop())
        document.addEventListener('visibilitychange',()=>{if(document.hidden)this.stop()})
        window.addEventListener('pagehide',()=>this.stop())
    }
    notify(){this.dispatchEvent(new Event('change'))}
    async start() {
        if(!this.reader.view?.renderer?.getContents().some(({doc})=>doc?.body)) {this.onError('请先打开一本书');return}
        const generation=++this.generation;this.starting=true;this.notify()
        try {
            await this.reader.setFlow(this.settings.mode==='scroll'?'scrolled':'paginated')
            this.settings.flow=this.reader.flow;this.persist()
            if(generation!==this.generation)return
            this.running=true;this.starting=false;this.elapsed=0;this.last=0;this.notify();this.schedule(generation)
        } catch(e){this.stop();this.onError('自动阅读未能开始：'+e.message)}
    }
    stop(reason='') {
        this.generation++;this.running=false;this.starting=false;cancelAnimationFrame(this.raf);clearTimeout(this.timer)
        this.reader.flushProgress().catch(e=>this.onError('阅读位置未能保存：'+e.message))
        this.notify();if(reason)this.onError(reason)
    }
    schedule(generation){
        if(this.settings.mode==='page')this.timer=setTimeout(()=>this.tick(performance.now(),generation),this.settings.pageSeconds*1000)
        else this.timer=setTimeout(()=>this.tick(performance.now(),generation),33)
    }
    async tick(now,generation) {
        if(!this.running||generation!==this.generation)return
        const dt=this.last?Math.min((now-this.last)/1000,.1):0
        if(this.settings.mode==='scroll'&&this.last&&now-this.last<32){this.schedule(generation);return}
        this.last=now;this.elapsed+=dt
        try {
            if(this.settings.mode==='scroll'||this.settings.mode==='page'){
                this.elapsed=0
                const done=await this.reader.autoAdvance(this.settings.mode,this.settings.pixelsPerSecond*dt,()=>this.running&&this.generation===generation)
                if(done&&this.generation===generation){this.stop('已到书末，自动阅读已停止');return}
            }
        } catch(e){this.stop();this.onError('自动阅读已暂停：'+e.message);return}
        if(this.running&&generation===this.generation)this.schedule(generation)
    }
}
