// One in-flight operation; no timers accumulate while reading/navigation is busy.
// restart（手动翻页触发）：不打断自动阅读，仅把定时器从零重新计时；非运行（含 starting 阶段）时是 no-op，绝不主动开启自动阅读。
//
// 调度序号（seq）是这里的正确性核心：tick 会 await reader.autoAdvance()，在 await 期间
// restart/stop 仍能到达。此时 this.timer 存的是「那个已经触发、正在执行」的句柄，
// clearTimeout 对它无效；若无序号，await 返回后旧链会再 schedule 一次，与 restart 新建的
// 那条并存成两条定时器链（实测 maxInFlight=2、调用次数约为单链的 1.6 倍）。
// 规则：每次 schedule 领取一个新 seq；回调只有在「自己仍是最新 seq」时才进入 tick、才续期；
// stop/restart 先作废当前 seq，旧链自灭。
export class AutoReading extends EventTarget {
    constructor(reader,settings,onError,persist=()=>{}) {
        super();Object.assign(this,{reader,settings,onError,persist});this.running=false;this.generation=0;this.seq=0
        this.busy=false;this.restartPending=false
        reader.addEventListener('manualnavigation',()=>this.restart())
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
            // 期间被 stop()/再次 start() 取代：状态必须归位，不能把 starting=true 留给调用侧兜。
            // main.js 用 running||starting 判「暂停」，残留的 starting 会让按钮卡在「准备中…」。
            if(generation!==this.generation){this.starting=false;this.notify();return}
            this.running=true;this.starting=false;this.elapsed=0;this.last=0;this.notify();this.schedule(generation)
        } catch(e){this.stop();this.onError('自动阅读未能开始：'+e.message)}
    }
    // 作废在飞的调度：seq++ 让已触发正在 await 的旧链不再续期，clearTimeout 清掉尚未触发的。
    cancelSchedule() {this.seq++;clearTimeout(this.timer);this.timer=null}
    stop(reason='') {
        this.generation++;this.running=false;this.starting=false;this.restartPending=false;this.cancelSchedule()
        this.reader.flushProgress().catch(e=>this.onError('阅读位置未能保存：'+e.message))
        this.notify();if(reason)this.onError(reason)
    }
    // 手动翻页：只把倒计时归零，不打断正在进行的翻页动作。
    // 若此刻有 autoAdvance 在飞，就绝不另起一条与之并跑（那会真的翻两页），
    // 而是把「归零后的重排」托付给在飞的那条链，由它收尾时统一续期。
    restart(){
        if(!this.running)return
        this.cancelSchedule();this.last=0;this.elapsed=0
        if(this.busy)this.restartPending=true;else this.schedule(this.generation)
        this.notify()
    }
    schedule(generation){
        const seq=++this.seq
        const delay=this.settings.mode==='page'?this.settings.pageSeconds*1000:33
        this.timer=setTimeout(()=>{if(seq!==this.seq)return;this.tick(performance.now(),generation,seq)},delay)
    }
    async tick(now,generation,seq) {
        if(!this.running||generation!==this.generation||seq!==this.seq)return
        const dt=this.last?Math.min((now-this.last)/1000,.1):0
        if(this.settings.mode==='scroll'&&this.last&&now-this.last<32){this.schedule(generation);return}
        this.last=now;this.elapsed+=dt
        this.busy=true;let done=false
        try {
            if(this.settings.mode==='scroll'||this.settings.mode==='page'){
                this.elapsed=0
                const dwell=(Number(this.settings.endDwellSeconds)||8)*1000
                done=await this.reader.autoAdvance(this.settings.mode,this.settings.pixelsPerSecond*dt,()=>this.running&&this.generation===generation,dwell)
            }
        } catch(e){this.busy=false;this.stop();this.onError('自动阅读已暂停：'+e.message);return}
        this.busy=false
        if(done&&this.generation===generation){this.stop('已到书末，自动阅读已停止');return}
        if(!this.running||generation!==this.generation)return
        // seq 不是自己且没人托付 → restart 已自行排期，本条链就此退场（这是不再双链的关键）。
        if(seq!==this.seq&&!this.restartPending)return
        this.restartPending=false
        this.schedule(generation)
    }
}
