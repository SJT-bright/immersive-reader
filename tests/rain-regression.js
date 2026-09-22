import { SceneController } from '../js/background.js?v=2.2.4'
import { normalizeSettings, saveSettings, loadSettings } from '../js/settings.js?v=2.2.0'
import { validateBackground, loadBackgroundVideo, releaseVideo } from '../js/background-media.js?v=1.4.0'
import { buildBackup, restoreBackup, digest } from '../js/backup.js?v=1.10.0'
import * as db from '../js/db.js?v=1.15.0'
const assert=(v,m)=>{if(!v)throw new Error(m)}
const pause=ms=>new Promise(r=>setTimeout(r,ms))
const until=async(fn,ms=10000)=>{const end=performance.now()+ms;while(!fn()){if(performance.now()>end)throw new Error('等待状态超时');await pause(40)}}
const fixture=async(name,type)=>new File([await(await fetch('/tests/fixtures/'+name)).blob()],name,{type})
const errors=[]
window.addEventListener('error',e=>errors.push(e.message))
window.addEventListener('unhandledrejection',e=>errors.push(String(e.reason)))
let passed=0,failed=0
async function step(name,fn){
 const li=document.createElement('li');li.textContent=name+'：运行中';document.querySelector('#results').append(li)
 try{const detail=await fn();passed++;li.dataset.pass='true';li.textContent=name+'：通过'+(detail?' · '+detail:'')}
 catch(e){failed++;li.dataset.pass='false';li.textContent=name+'：失败 · '+e.message}
 document.querySelector('#summary').textContent=`${passed} 通过，${failed} 失败`
}
document.querySelector('#run').onclick=async()=>{
 if(location.port!=='8941')throw new Error('只允许测试端口8941')
 document.querySelector('#run').disabled=true
 await db.clearAll();localStorage.clear()
 const settings=normalizeSettings(null);settings.atmosphere.motion=false
 const scene=new SceneController({settings,getRect:()=>document.querySelector('#report').getBoundingClientRect()})
 const rain=scene.rain
 const pixels=()=>{rain.draw();const out=new Uint8Array(rain.width*rain.height*4);rain.gl.readPixels(0,0,rain.width,rain.height,rain.gl.RGBA,rain.gl.UNSIGNED_BYTE,out);return out}
 const diff=(a,b)=>{let n=0;for(let i=0;i<a.length;i+=4)if(Math.abs(a[i]-b[i])+Math.abs(a[i+1]-b[i+1])+Math.abs(a[i+2]-b[i+2])>3)n++;return n/(a.length/4)}
 let videoRecord
 await step('WebGL2 双通道编译、流体真实像素与预算',async()=>{
  await scene.init();assert(rain.available,'WebGL2不可用')
  const p=pixels();assert(p.some((v,i)=>i%4!==3&&v>50),'背景为空')
  assert(rain.width*rain.height<1310000,'超过像素预算')
  assert(rain.gl.getError()===rain.gl.NO_ERROR,'GPU错误')
  return rain.width+'×'+rain.height
 })
 await step('雨势、雾气、折射率改变 GPU 输出',async()=>{
  await scene.setUserBackgrounds([{id:'checker',name:'棋盘',data:await fixture('checker.png','image/png')}])
  await scene.setRef('checker',{animate:false})
  Object.assign(settings.atmosphere,{rain:0,fog:0});let dry=pixels()
  settings.atmosphere.rain=1;let wet=pixels();const raindiff=diff(dry,wet)
  assert(raindiff>.001,'雨势没有可见变化')
  settings.atmosphere.fog=1;let fog=pixels();assert(diff(wet,fog)>.001,'雾气没有可见变化')
  settings.atmosphere.refraction=1;let straight=pixels();settings.atmosphere.refraction=1.6;let bent=pixels()
  assert(diff(straight,bent)>.001,'折射率没有可见变化')
  return (raindiff*100).toFixed(1)+'% 像素随雨勢变化'
 })
 await step('雨滴随时间移动，关闭雨效恢复清晰背景',async()=>{
  let before=pixels();rain.time+=2;assert(diff(before,pixels())>.001,'雨滴未移动')
  Object.assign(settings.atmosphere,{enabled:false});const disabled=pixels()
  Object.assign(settings.atmosphere,{enabled:true,rain:0,fog:0});assert(diff(disabled,pixels())===0,'关闭雨效仍有雨雾')
 })
 await step('窗外雪不模糊场景，雪花随时间落下',async()=>{
  const neighbor=p=>{let s=0,n=0,w=rain.width,h=rain.height;for(let y=2;y<h-2;y+=3)for(let x=2;x<w-2;x+=3){const i=(y*w+x)*4,j=(y*w+x+1)*4;s+=Math.abs(p[i]-p[j])+Math.abs(p[i+1]-p[j+1])+Math.abs(p[i+2]-p[j+2]);n++}return s/n}
  Object.assign(settings.atmosphere,{enabled:true,weather:'rain',rain:0,fog:1,snow:0})
  const foggy=pixels();const fogC=neighbor(foggy)
  Object.assign(settings.atmosphere,{weather:'snow',snow:0,fog:1})
  const sharp=pixels();const sharpC=neighbor(sharp)
  assert(sharpC>fogC*1.15,'雪景仍被玻璃雾化')
  Object.assign(settings.atmosphere,{snow:1,wind:0})
  const snowy=pixels()
  assert(diff(sharp,snowy)>.001,'雪量没有可见变化')
  settings.atmosphere.wind=1;const blown=pixels()
  assert(diff(snowy,blown)>.001,'风没有吹动雪')
  const before=pixels();rain.time+=2.4;assert(diff(before,pixels())>.001,'雪花未移动')
  Object.assign(settings.atmosphere,{weather:'clear',snow:1})
  const clear=pixels()
  assert(diff(sharp,clear)<.02,'晴空模式仍有落雪或雾')
  Object.assign(settings.atmosphere,{weather:'rain',rain:.58,fog:.32,snow:0})
  return `雾对比 ${fogC.toFixed(1)} / 雪清晰 ${sharpC.toFixed(1)}`
 })
 await step('视频解码验证、损坏文件拒绝与 MIME 保存',async()=>{
  const file=await fixture('rain-video.mp4','video/mp4'),blob=await validateBackground(file)
  videoRecord=await db.addBackground({name:'验收视频',data:blob})
  assert((await db.getBackground(videoRecord.id)).data.type==='video/mp4','视频MIME丢失')
  let rejected=false;try{await validateBackground(new File(['broken'],'bad.mp4',{type:'video/mp4'}))}catch{rejected=true}
  assert(rejected,'损坏视频被接受')
 })
 await step('视频真实播放、静音循环、暂停冻结',async()=>{
  await scene.setUserBackgrounds(await db.listBackgrounds());await scene.setRef(videoRecord.id,{animate:false})
  const video=scene.currentImage
  settings.atmosphere.motion=true;rain.update(settings.atmosphere)
  await until(()=>video.currentTime>.3)
  assert(video.muted&&video.loop&&!video.paused,'视频未静音循环')
  const before=pixels();await pause(350);assert(diff(before,pixels())>.01,'视频画面没有更新')
  settings.atmosphere.motion=false;rain.update(settings.atmosphere);await pause(50)
  const t=video.currentTime;await pause(150);assert(video.paused&&Math.abs(video.currentTime-t)<.03,'视频暂停无效')
  return '时间推进到 '+t.toFixed(2)+'s'
 })
 await step('背景视频与雨窗设置完整备份恢复',async()=>{
  settings.background.fixedId=videoRecord.id;Object.assign(settings.atmosphere,{weather:'snow',snow:.7,rain:.8,fog:.4,refraction:1.5});saveSettings(settings)
  const backup=await buildBackup(),hash=await digest(videoRecord.data)
  await db.clearAll();await restoreBackup(backup)
  const restored=(await db.listBackgrounds())[0]
  assert(restored.data.type==='video/mp4'&&await digest(restored.data)===hash,'视频恢复字节/MIME不一致')
  const atmo=loadSettings().atmosphere
  assert(atmo.refraction===1.5&&atmo.weather==='snow'&&atmo.snow===.7,'天气设置未恢复')
 })
 await step('快速换景、删除视频，解码资源正确释放',async()=>{
  const old=scene.currentImage
  await Promise.all([scene.setRef('builtin:garden-dawn',{animate:false}),scene.setRef('builtin:fluid',{animate:false})])
  assert(scene.currentRef==='builtin:fluid','最后选择失效')
  assert(old.paused&&!old.getAttribute('src'),'旧视频未释放')
  await db.deleteBackground(videoRecord.id);await scene.setUserBackgrounds([])
  assert(settings.background.fixedId==='builtin:fluid','删除引用未修复')
 })
 await step('宽幅图片在 GPU 前缩小，原图不受影响',async()=>{
  const canvas=document.createElement('canvas');canvas.width=5000;canvas.height=20
  const c=canvas.getContext('2d');c.fillStyle='#77aa88';c.fillRect(0,0,5000,20)
  const image=new Image();image.src=canvas.toDataURL();await image.decode()
  rain.setSource({kind:'image',element:image},false);pixels()
  assert(rain.textureSource(rain.current).width<=4096,'纹理未限制大小')
  assert(image.naturalWidth===5000&&rain.gl.getError()===rain.gl.NO_ERROR,'原图损坏或GPU错误')
 })
 await step('WebGL 上下文丢失时降级、恢复后继续渲染',async()=>{
  const ext=rain.gl.getExtension('WEBGL_lose_context');assert(ext,'没有上下文测试扩展')
  ext.loseContext();await until(()=>rain.canvas.dataset.state==='lost')
  assert(rain.canvas.style.opacity==='0','未显示普通背景')
  ext.restoreContext();await until(()=>rain.available)
  pixels();assert(rain.gl.getError()===rain.gl.NO_ERROR,'恢复后GPU错误')
 })
 await step('清理场景后没有残留画布或异步错误',async()=>{
  scene.destroy();await pause(100)
  assert(!document.querySelector('.rain-canvas'),'画布未释放')
  assert(!errors.length,errors.join(';'))
 })
 document.querySelector('#summary').dataset.complete='true'
}
