import {collapse,compare} from '../vendor/foliate-js/epubcfi.js'
import {Reader} from '../js/reader.js?v=1.8.1'
import {AutoReading} from '../js/auto-reading.js?v=1.4.0'
import {chaptersToEpubBlob} from '../js/txt2epub.js?v=1.5.0'
import * as db from '../js/db.js?v=1.13.0'
const pause=ms=>new Promise(r=>setTimeout(r,ms)),assert=(v,m)=>{if(!v)throw new Error(m)}
async function until(fn,ms=10000){const end=performance.now()+ms;while(!fn()){if(performance.now()>end)throw new Error('等待超时');await pause(40)}}
const errors=[];window.addEventListener('error',e=>errors.push(e.error?.stack||e.message));window.addEventListener('unhandledrejection',e=>errors.push(String(e.reason)))
let passed=0,failed=0
async function step(name,fn){const el=document.createElement('li');document.querySelector('#results').append(el);el.textContent=name+'：运行中';try{const detail=await fn();el.textContent=name+'：通过'+(detail?' · '+detail:'');el.dataset.pass=true;passed++}catch(e){el.textContent=name+'：失败 · '+e.message;el.dataset.pass=false;failed++}document.querySelector('#summary').textContent=`${passed}通过，${failed}失败`}
document.querySelector('#run').onclick=async()=>{
 if(location.port!=='8941')throw new Error('只允许8941')
 document.querySelector('#run').disabled=true
 const reader=new Reader(document.querySelector('#test-reader')),settings={mode:'scroll',pixelsPerSecond:20,pageSeconds:5},messages=[]
 const auto=new AutoReading(reader,settings,m=>messages.push(m))
 const data=await chaptersToEpubBlob([0,1,2].map(i=>({title:'第'+(i+1)+'章 测试',paragraphs:Array.from({length:30},(_,j)=>`第${j+1}段。树影慢慢移过窗前，读书的人随着文字继续向前。`.repeat(4))})),'自动阅读测试','')
 const book=await db.addBook({title:'自动阅读测试',format:'epub',data});await reader.open(book)
 const renderer=()=>reader.view.renderer
 await step('连续下滑确实移动正文',async()=>{await auto.start();const start=renderer().start;await until(()=>renderer().start>start+15);auto.stop();assert(renderer().scrolled,'未切到滚动模式');return `${start.toFixed(1)} → ${renderer().start.toFixed(1)}px`})
 await step('暂停后位置保持',async()=>{await reader._queue;const start=renderer().start;await pause(500);assert(Math.abs(renderer().start-start)<1,'暂停后还在移动')})
 await step('调速改变真实移动距离',async()=>{
  const distance=async speed=>{settings.pixelsPerSecond=speed;await auto.start();const start=renderer().start;await pause(1200);auto.stop();await reader._queue;return renderer().start-start}
  const slow=await distance(10),fast=await distance(60);assert(slow>3&&fast>slow*3,`速度未生效：slow=${slow}, fast=${fast}`);return `10px/s:${slow.toFixed(1)}px；60px/s:${fast.toFixed(1)}px`
 })
 await step('滚到章节末尾自动接下一章',async()=>{await auto.start();const index=renderer().getContents()[0].index;await reader.enqueue(()=>renderer().scrollToAnchor(1));const since=performance.now();await pause(700);assert(renderer().getContents()[0].index===index,'末页缓冲尚未读完就换章');await until(()=>renderer().getContents()[0].index>index,12000);assert(performance.now()-since>=7800,'末页停留不足8秒');auto.stop();return '底部停留8秒后换章'})
 await step('书末停止，不跳到无效章节',async()=>{await reader.goTo(reader.toc[2].href);await auto.start();await reader.enqueue(()=>renderer().scrollToAnchor(1));await until(()=>!auto.running);assert(messages.some(m=>m.includes('书末')),'未报告末尾')})
 await step('定时翻页在5秒后生效',async()=>{settings.mode='page';await reader.goTo(reader.toc[0].href);await auto.start();const cfi=reader.lastProgress.cfi,t=performance.now();await until(()=>reader.lastProgress.cfi!==cfi,9000);auto.stop();assert(performance.now()-t>=4700,'未等待指定时间');return ((performance.now()-t)/1000).toFixed(2)+'s'})
 await step('手动翻页立即停自动阅读',async()=>{await auto.start();await reader.next();assert(!auto.running,'手动翻页后仍在自动阅读')})
 await step('开始与停止竞态，不会迟到启动',async()=>{const pending=auto.start();auto.stop();await pending;assert(!auto.running&&!auto.starting,'停止后又自行启动')})
 await step('滚动暂停CFI落库，关书重开可恢复',async()=>{settings.mode='scroll';settings.pixelsPerSecond=60;await auto.start();const start=renderer().start;await until(()=>renderer().start>start+20);auto.stop();await reader.flushProgress();const cfi=reader.lastProgress.cfi;await reader.close();const stored=await db.getBook(book.id);assert(stored.progress.cfi===cfi,'暂停位置未写入');await reader.open(stored,{lastLocation:cfi});assert(compare(collapse(reader.lastProgress.cfi),collapse(cfi))===0,`重开起始CFI不一致：${cfi} → ${reader.lastProgress.cfi}`)})
 await step('无运行期异常',async()=>{auto.stop();await reader.close();assert(!errors.length,errors.join(';'));assert(!messages.some(m=>m.includes('未能')||m.includes('已暂停：')),messages.join(';'))})
 document.querySelector('#summary').dataset.complete='true'
}
