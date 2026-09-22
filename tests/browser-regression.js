import { Reader } from '../js/reader.js?v=1.8.1'
import * as db from '../js/db.js?v=1.15.0'
import { importBook } from '../js/library.js?v=1.8.1'
import { buildBackup, restoreBackup, digest } from '../js/backup.js?v=1.10.0'
import { normalizeSettings, saveSettings, loadSettings } from '../js/settings.js?v=2.4.0'
import { SceneController } from '../js/background.js?v=2.2.1'
import { computeReadability, verifyContrast } from '../js/readability.js?v=1.4.0'
import { chaptersToEpubBlob } from '../js/txt2epub.js?v=1.5.0'
import { LocalAudioPlayer } from '../js/music.js?v=1.7.0'
const assert=(v,m)=>{if(!v)throw new Error(m)}
const errors=[]
window.addEventListener('error',e=>errors.push(e.error?.stack || e.message))
window.addEventListener('unhandledrejection',e=>errors.push(String(e.reason)))
const fixture=async(name,type)=>new File([await(await fetch('/tests/fixtures/'+encodeURIComponent(name))).blob()],name,{type})
const pause=ms=>new Promise(r=>setTimeout(r,ms))
let passed=0,failed=0
async function step(name,fn){
 const li=document.createElement('li');li.textContent=name+'：运行中';document.querySelector('#results').append(li)
 try {const result=await Promise.race([fn(),pause(20000).then(()=>{throw new Error('20 秒内未完成')})]);passed++;li.dataset.pass='true';li.textContent=name+'：通过'+(result?' · '+result:'')}
 catch(e){failed++;li.dataset.pass='false';li.textContent=name+'：失败 · '+e.message}
 document.querySelector('#summary').textContent=`${passed} 通过，${failed} 失败`
}
document.querySelector('#run').onclick=async()=>{
 if(location.port!=='8941'){document.querySelector('#summary').textContent='请用 8941 测试端口，拒绝修改日常阅读资料';return}
 document.querySelector('#run').disabled=true
 await db.clearAll();localStorage.clear()
 const settings=normalizeSettings(null);saveSettings(settings)
 const reader=new Reader(document.querySelector('#test-reader'))
 reader.addEventListener('readererror',e=>errors.push(e.detail))
 let book,txt,bg,audio,backup,position
 await step('真实 EPUB 导入与正文渲染',async()=>{
  book=await importBook(await fixture('三只松鼠的四季.epub','application/epub+zip'))
  await reader.open(book)
  assert(reader.toc.length>=3,'目录缺失')
  const doc=reader.view.renderer.getContents()[0]?.doc
  assert(doc?.body?.textContent.includes('松鼠'),'实际正文未渲染')
  return reader.toc.length+' 个章节'
 })
 await step('快速换章及同时改字号，无异步错误',async()=>{
  const jobs=[]
  for(let i=0;i<15;i++){jobs.push(reader.goTo(reader.toc[i%reader.toc.length].href));if(i%4===0)jobs.push(reader.setLayout({fontSize:20+i%8}))}
  jobs.push(reader.goTo(reader.toc[2].href));await Promise.all(jobs)
  assert(reader.lastProgress.tocLabel.includes(reader.toc[2].label),'未停在最后请求的章节')
  assert(!errors.length,errors.join(';'))
  return '15 次换章 + 4 次排版'
 })
 await step('字号真实生效，立即关书不残留样式回调',async()=>{
  await reader.setLayout({fontSize:28})
  const doc=reader.view.renderer.getContents()[0].doc
  assert(doc.defaultView.getComputedStyle(doc.documentElement).fontSize==='28px','字号没有实际生效')
  await reader.close();await pause(300)
  assert(!errors.length,errors.join(';'))
  await reader.open(await db.getBook(book.id))
  const reopened=reader.view.renderer.getContents()[0].doc
  assert(reopened.defaultView.getComputedStyle(reopened.documentElement).fontSize==='28px','新章节未应用字号')
 })
 await step('翻页立即关闭，再打开恢复同一位置',async()=>{
  await reader.goTo(reader.toc[1].href);await reader.next();position=reader.lastProgress.cfi
  await reader.close();const stored=await db.getBook(book.id)
  assert(stored.progress.cfi===position,'DB 保存的是旧位置')
  await reader.open(stored,{lastLocation:stored.progress.cfi})
  assert(reader.lastProgress.cfi===position,'重新打开位置不一致')
  return 'CFI 一致'
 })
 await step('TXT 导入、章节与文字安全',async()=>{
  txt=await importBook(await fixture('山中的信.txt','text/plain'));await reader.open(txt)
  assert(reader.toc.length>=2,'TXT 未拆分章节')
  assert(reader.view.renderer.getContents()[0].doc.body.textContent.includes('山'),'TXT 正文缺失')
  const old=await db.getBook(book.id);assert(old.progress.cfi===position,'切书污染了前一本的进度')
 })
 await step('损坏 EPUB 拒绝入库',async()=>{
  const before=(await db.listBooks()).length;let rejected=false
  try{await importBook(new File(['PK\x03\x04badzip'],'invalid.epub',{type:'application/epub+zip'}))}catch{rejected=true}
  assert(rejected,'损坏文件被接受');assert((await db.listBooks()).length===before,'损坏文件残留在书库')
 })
 await step('内嵌脚本不执行，出版物文字色与背景被阅读主题覆盖',async()=>{
  let blob=await chaptersToEpubBlob([{title:'颜色检查',paragraphs:['颜色测试']}],'排版测试','')
  // Use a real chapter document and publisher inline colors after load to test CSS cascade.
  const rec=await db.addBook({title:'排版测试',format:'epub',data:blob});await reader.open(rec)
  const doc=reader.view.renderer.getContents()[0].doc,p=doc.querySelector('p')
  p.style.color='white';p.style.backgroundColor='white'
  reader.setTextTheme({textColor:'#2b2620'})
  const style=doc.defaultView.getComputedStyle(p)
  assert(style.color==='rgb(43, 38, 32)','出版物颜色覆盖了主题')
  assert(style.backgroundColor==='rgba(0, 0, 0, 0)','出版物底色没有清除')
  const script=doc.createElement('script');script.textContent='document.body.dataset.executed="yes"';doc.body.append(script)
  assert(!doc.body.dataset.executed,'书内脚本被执行')
 })
 await step('上传背景落库，黑白细节及最薄遮罩仍达标',async()=>{
  bg=await db.addBackground({name:'测试棋盘',data:await fixture('checker.png','image/png')})
  const img=new Image();const url=URL.createObjectURL(bg.data);img.src=url;await img.decode()
  for(const theme of ['dark-text','light-text']){
   const plan=computeReadability({image:img,rect:{x:0,y:0,width:640,height:500},vw:1280,vh:800,forcedTheme:theme,maskBias:-1})
   for(const color of [[0,0,0],[255,255,255],[127,127,127]])assert(verifyContrast(plan,color)>=4.5,'极端色不达标')
  }
  URL.revokeObjectURL(url);assert((await db.listBackgrounds()).length===1,'图片未保存')
 })
 await step('快速切背景与删除正在使用的图，引用自动修复',async()=>{
  const scene=new SceneController({settings,getRect:()=>document.querySelector('#test-reader').getBoundingClientRect()})
  await scene.setUserBackgrounds(await db.listBackgrounds());await scene.applyDesired({animate:false})
  await Promise.all([scene.setRef('builtin:forest-dusk'),scene.setRef('builtin:garden-dawn'),scene.setRef(bg.id)])
  assert(scene.currentRef===bg.id,'最后选择未生效')
  settings.background.mode='fixed';settings.background.fixedId=bg.id;settings.background.slotMap.day=bg.id
  await db.deleteBackground(bg.id);await scene.setUserBackgrounds([])
  assert(scene.currentRef.startsWith('builtin:'),'删除后背景失效')
  assert(!Object.values(settings.background.slotMap).includes(bg.id),'时段残留删除引用')
  assert(settings.background.fixedId!==bg.id,'固定图残留删除引用')
  bg=await db.addBackground({name:'测试夜色',data:await fixture('dark-night.png','image/png')})
  await db.renameBackground(bg.id,'窗边夜色')
  assert((await db.getBackground(bg.id)).name==='窗边夜色','背景新名称未保存')
  scene.destroy()
 })
 await step('含书籍、背景、音频、CFI 的备份完整恢复',async()=>{
  await reader.close();audio=await db.addAudioTrack({name:'tone.wav',data:await fixture('tone.wav','audio/wav')})
  settings.music.volume=0.35;settings.music.playMode='repeatOne';saveSettings(settings)
  backup=await buildBackup();await db.clearAll();assert(!(await db.listBooks()).length,'测试库未清空')
  const result=await restoreBackup(backup);assert(Object.values(result.verify).every(Boolean),'恢复后的字节或元信息不一致')
  assert((await db.getBook(book.id)).progress.cfi===position,'CFI 未恢复')
  assert((await db.listAudioTracks())[0].data.type==='audio/wav','音频 MIME 丢失')
  assert(loadSettings().music.volume===0.35&&loadSettings().music.playMode==='repeatOne','音乐设置未恢复')
  return `${result.written.books} 本书、${result.written.backgrounds} 张图、${result.written.audio} 首音频；SHA-256 一致`
 })
 await step('损坏备份不覆盖现有文件',async()=>{
  const before=await digest((await db.listAudioTracks())[0].data)
  const bad=structuredClone(backup);bad.data.audio[0].data='QUJDRA=='
  let rejected=false;try{await restoreBackup(bad)}catch{rejected=true}
  assert(rejected,'未拒绝损坏备份');assert(await digest((await db.listAudioTracks())[0].data)===before,'当前音频被改写')
 })
 await step('刷新音频列表保留当前来源，删除后正确释放',async()=>{
  const player=new LocalAudioPlayer(), tracks=await db.listAudioTracks()
  player.setTracks(tracks)
  const url=player.urlFor(tracks[0].id)
  player.currentId=tracks[0].id;player.audio.src=url
  player.setTracks(await db.listAudioTracks())
  assert(player.currentId===tracks[0].id&&player.audio.src===url,'重新读取列表使当前音频被清空')
  assert(player.urlFor(tracks[0].id)===url,'同一音频被无故重建')
  player.setTracks([])
  assert(!player.currentId&&!player.audio.getAttribute('src'),'移除曲目未释放当前来源')
 })
 await step('本地音乐：真实播放推进、定位、音量与静音',async()=>{
  const player=new LocalAudioPlayer()
  player.setFadeEnabled(false) // 回归不等淡入完成
  player.setTracks([{id:'t1',name:'tone.wav',data:await fixture('tone.wav','audio/wav')}])
  player.setVolume(0.4)
  assert(player.getState().volume===0.4,'音量未生效')
  player.setMuted(true);assert(player.audio.volume===0,'静音未作用于实际音量')
  player.setMuted(false);assert(Math.abs(player.audio.volume-0.4)<0.001,'取消静音未恢复音量')
  await player.play('t1')
  await pause(900)
  const advanced=player.getState().time
  assert(advanced>0.2,`播放时间未推进：${advanced}`)
  player.seek(2)
  assert(Math.abs(player.getState().time-2)<0.35,'seek 未生效')
  await player.pause()
  assert(player.audio.paused,'暂停未生效')
  return `推进到 ${advanced.toFixed(2)}s，定位到 ${player.getState().time.toFixed(2)}s`
 })
 await step('播放模式四态：随机队列固定当前曲，退出恢复原顺序',async()=>{
  const player=new LocalAudioPlayer()
  player.setTracks(['a','b','c','d','e'].map(id=>({id,name:id+'.wav',data:new Blob([id])})))
  assert(JSON.stringify(player.order())===JSON.stringify(['a','b','c','d','e']),'初始顺序不正确')
  player.currentId='c';player.setPlayMode('shuffle')
  const shuffled=player.order()
  assert(shuffled.length===5&&new Set(shuffled).size===5,'随机顺序丢失或重复曲目')
  assert(shuffled[0]==='c','随机未固定当前曲目')
  player.setPlayMode('repeatAll')
  assert(JSON.stringify(player.order())===JSON.stringify(['a','b','c','d','e']),'退出随机未恢复顺序')
  player.setPlayMode('repeatOne');assert(player.getState().playMode==='repeatOne','播放模式未写入状态')
  player.setPlayMode('bogus');assert(player.getState().playMode==='repeatAll','非法播放模式未回退')
  assert(player.getState().fadeMs===1000,'淡入淡出档位默认值不正确')
  player.setFadeMs(2000);assert(player.getState().fadeMs===2000,'淡入淡出档位未生效')
  return `${shuffled.join('')} → 恢复 abcde`
 })
 await step('睡眠定时设置、触发事件与自动暂停',async()=>{
  const player=new LocalAudioPlayer()
  player.setFadeEnabled(false)
  player.setTracks([{id:'t1',name:'tone.wav',data:await fixture('tone.wav','audio/wav')}])
  await player.play('t1');await pause(300)
  let fired=0
  player.addEventListener('sleepdone',()=>{fired++})
  player.setSleep({type:'minutes',minutes:15})
  const until=player.getState().sleepUntil
  assert(until>Date.now()+14*60000,'睡眠定时未设置')
  player.triggerSleep('time')
  await pause(250)
  assert(fired===1,`睡眠定时未触发事件（${fired}）`)
  assert(player.audio.paused,'睡眠定时未暂停播放')
  assert(player.getState().sleepUntil===null,'睡眠定时未清除')
  player.setSleep({type:'track'})
  assert(player.getState().sleepAfterTrack===true,'播完本曲模式未设置')
  player.setSleep(null)
  assert(player.getState().sleepAfterTrack===false,'睡眠定时未关闭')
  return '15 分钟定时与播完本曲均已生效'
 })
 await step('系统媒体面板元数据可写入',async()=>{
  const player=new LocalAudioPlayer()
  player.setTracks([{id:'t1',name:'tone.wav',data:new Blob(['x'])}])
  player.currentId='t1'
  player.updateMediaSession()
  if('mediaSession' in navigator){
   const meta=navigator.mediaSession.metadata
   assert(meta&&meta.title==='tone.wav',`媒体元数据标题不正确：${meta&&meta.title}`)
   assert(meta.artist==='沉浸阅读器','媒体元数据缺少来源')
   return '标题与来源已写入系统媒体面板'
  }
  return '当前浏览器无 mediaSession，已跳过'
 })
 await step('最终异步异常检查',async()=>{assert(!errors.length,errors.join(';'));return '0 个错误'})
 document.querySelector('#summary').dataset.complete='true'
}
