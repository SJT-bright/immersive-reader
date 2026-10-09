// Runs real IndexedDB + HTTP/SQLite using a disposable Chrome profile and data directory.
// Never uses port 8940, production profiles or paid services.
import {spawn} from 'node:child_process'
import {mkdtemp,rm,writeFile,mkdir} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import net from 'node:net'
import assert from 'node:assert/strict'
const ROOT=resolve(process.env.READER_TEST_ROOT||'.')
const output=resolve(process.env.READER_TEST_OUTPUT||'.preview/storage-audit.json')
const dir=await mkdtemp(join(tmpdir(),'reader-storage-audit-'))
const freePort=()=>new Promise((r,j)=>{const s=net.createServer();s.on('error',j);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p))})})
const port=await freePort(), debug=await freePort(), base=`http://127.0.0.1:${port}`
const results=[];let ws,seq=0,sid,chrome
const pending=new Map()
const wait=ms=>new Promise(r=>setTimeout(r,ms))
const server=spawn(process.execPath,[join(ROOT,'cloud/server.js'),'--no-open'],{env:{...process.env,READER_DATA_DIR:join(dir,'data'),READER_STORAGE:'sqlite',PORT:String(port)},stdio:'ignore'})
const call=async v=>{const r=await fetch(base+'/_reader/library',{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify(v)});const data=await r.json();if(!r.ok)throw Error(data.error);return data}
const send=(method,params={},sessionId=sid)=>new Promise((r,j)=>{const id=++seq;const timer=setTimeout(()=>{pending.delete(id);j(Error(method+' timeout'))},20000);pending.set(id,{r:v=>{clearTimeout(timer);r(v)},j:e=>{clearTimeout(timer);j(e)}});ws.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}))})
const evalPage=async code=>{const r=await send('Runtime.evaluate',{expression:`(async()=>{${code}})()`,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value}
const step=async(name,fn)=>{try{await fn();results.push({name,pass:true});console.log('PASS '+name)}catch(e){results.push({name,pass:false,error:e.message});console.log('FAIL '+name+': '+e.message)}}
const load=async()=>{await send('Page.navigate',{url:base+'/tests/storage-audit.html'});await wait(200);for(let i=0;i<60;i++){try{if(await evalPage(`return document.title==='隔离存储回归'`))break}catch{}await wait(100)}await evalPage(`window.db=await import('/js/db.js?v=1.16.0'); window.backup=await import('/js/backup.js'); await db.initDiskLibrary();`)}
const offline=`window.realFetch=window.fetch;window.fetch=(...args)=>String(args[0]).includes('/_reader/library')?Promise.reject(Error('synthetic mirror outage')):realFetch(...args);`
const online=`if(window.realFetch)window.fetch=window.realFetch;`
const makeNote=(t,deletedAt)=>({id:'n',type:'quote',cfi:'epubcfi(/6/2)',text:'synthetic quote',comment:'synthetic reflection',createdAt:1,editedAt:t,...(deletedAt?{deletedAt}: {})})
try{
 for(let i=0;i<80;i++){try{if((await (await fetch(base+'/_reader/health')).json()).app)break}catch{}await wait(100)}
 await step('SQLite service uses isolated data directory',async()=>{assert.equal((await(await fetch(base+'/_reader/health')).json()).storage,'sqlite')})
 await call({op:'put',store:'books',id:'server-book',meta:{id:'server-book',lastOpenedAt:100,progress:{fraction:.8},notes:[]},data:'YQ==',mime:'text/plain'})
 await step('Late note edits and equal-timestamp edits cannot resurrect deletion',async()=>{
  await call({op:'note',store:'books',id:'server-book',note:makeNote(300,300)})
  await call({op:'note',store:'books',id:'server-book',note:makeNote(200)})
  await call({op:'note',store:'books',id:'server-book',note:makeNote(300)})
  assert.equal((await call({op:'get',store:'books',id:'server-book'})).notes[0].deletedAt,300)
 })
 await step('Note edits and stale progress writes cannot advance/revert reading clock',async()=>{
  const before=await call({op:'get',store:'books',id:'server-book'});assert.equal(before.lastOpenedAt,100)
  await call({op:'meta',store:'books',id:'server-book',meta:{id:'server-book',lastOpenedAt:50,progress:{fraction:.1},notes:[]}})
  assert.equal((await call({op:'get',store:'books',id:'server-book'})).progress.fraction,.8)
 })
 await call({op:'delete',store:'books',id:'server-book'})
 chrome=spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',[`--user-data-dir=${join(dir,'chrome')}`,`--remote-debugging-port=${debug}`,'--headless=new','--no-first-run','--no-default-browser-check','--disable-background-networking','about:blank'],{stdio:'ignore'})
 let version;for(let i=0;i<100;i++){try{version=await(await fetch(`http://127.0.0.1:${debug}/json/version`)).json();break}catch{}await wait(100)}
 if(!version)throw Error('Chrome debugging not available')
 ws=new WebSocket(version.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j})
 ws.onmessage=e=>{const r=JSON.parse(e.data);const p=pending.get(r.id);if(p){pending.delete(r.id);r.error?p.j(Error(r.error.message)):p.r(r.result)}}
 const {targetId}=await send('Target.createTarget',{url:'about:blank'},null);sid=(await send('Target.attachToTarget',{targetId,flatten:true},null)).sessionId
 await send('Page.enable');await load()
 await step('Offline delete survives module reload for book/background/audio/QQ',async()=>{
  await evalPage(`await db.clearAll();await db.putBook({id:'book-delete',title:'Synthetic',format:'epub',data:new Blob(['a']),notes:[]});window.bg=await db.addBackground({name:'BG',data:new Blob(['b'])});window.audio=await db.addAudioTrack({name:'Audio',data:new Blob(['c'])});window.qq=await db.addQQTrack({url:'https://y.qq.com/n/ryqq/songDetail/a',kind:'song',key:'songmid',ref:'a',title:'Synthetic'});${offline}await db.deleteBook('book-delete');await db.deleteBackground(bg.id);await db.deleteAudioTrack(audio.id);await db.deleteQQTrack(qq.id);`)
  await load();assert.equal((await call({op:'list'})).records.length,0)
  assert.deepEqual(await evalPage(`const all=await db.exportAll();return [all.books.length,all.backgrounds.length,all.audio.length,all.qqTracks.length]`),[0,0,0,0])
 })
 await step('Offline metadata edits retain background/audio names after reload',async()=>{
  await evalPage(`await db.clearAll();window.bg=await db.addBackground({name:'Old BG',data:new Blob(['b'])});window.audio=await db.addAudioTrack({name:'Old audio',data:new Blob(['c'])});${offline}await db.renameBackground(bg.id,'New BG');await db.renameAudioTrack(audio.id,'New audio');`)
  await load();assert.deepEqual(await evalPage(`return [(await db.listBackgrounds())[0].name,(await db.listAudioTracks())[0].name]`),['New BG','New audio'])
 })
 await step('Offline replacement restore excludes old books/notes after reload',async()=>{
  await evalPage(`await db.clearAll();await db.putBook({id:'keep',title:'Before',format:'epub',data:new Blob(['old']),lastOpenedAt:100,notes:[{id:'old-note',type:'quote',cfi:'epubcfi(/6/2)',createdAt:200,editedAt:200,text:'old'}]});await db.putBook({id:'discard',title:'Discard',format:'epub',data:new Blob(['x'])});${offline}try{await db.importAll({books:[{id:'keep',title:'Restored',format:'epub',data:new Blob(['new']),lastOpenedAt:10,progress:{fraction:.2},notes:[]}]})}catch{};`)
  await load();const all=await evalPage(`return (await db.exportAll()).books.map(b=>({id:b.id,title:b.title,notes:b.notes,progress:b.progress}))`)
  assert.deepEqual(all,[{id:'keep',title:'Restored',notes:[],progress:{fraction:.2}}])
  assert.deepEqual((await call({op:'list'})).records.map(r=>r.id),['keep'])
 })
 await step('Pre-upgrade browser-only books can sync note edits when disk record is missing',async()=>{
  await evalPage(`await db.clearAll();const database=await new Promise((r,j)=>{const q=indexedDB.open('immersive-reader',2);q.onsuccess=()=>r(q.result);q.onerror=()=>j(q.error)});await new Promise((r,j)=>{const tx=database.transaction('books','readwrite');tx.objectStore('books').put({id:'legacy',title:'Legacy synthetic',format:'epub',data:new Blob(['a']),lastOpenedAt:1,notes:[]});tx.oncomplete=r;tx.onerror=()=>j(tx.error)});database.close();await db.updateBookNote('legacy',{id:'n',type:'quote',cfi:'epubcfi(/6/2)',createdAt:1,text:'synthetic'});`)
  assert.equal((await call({op:'get',store:'books',id:'legacy'})).notes[0].id,'n')
 })
 await step('Repeated note edits and progress saves retain both latest values',async()=>{
  const got=await evalPage(`await db.clearAll();await db.putBook({id:'concurrent',title:'Synthetic',format:'epub',data:new Blob(['a']),lastOpenedAt:1,notes:[]});const note={id:'n',type:'quote',cfi:'epubcfi(/6/2)',createdAt:1,text:'synthetic'};await Promise.all([db.updateBookNote('concurrent',{...note,comment:'first'}),db.touchBook('concurrent',{fraction:.5}),db.updateBookNote('concurrent',{...note,comment:'second'})]);await db.flushMirror?.();const b=await db.getBook('concurrent');return {comment:b.notes[0].comment,progress:b.progress};`)
  assert.deepEqual(got,{comment:'second',progress:{fraction:.5}})
  const disk=await call({op:'get',store:'books',id:'concurrent'});assert.equal(disk.notes[0].comment,'second');assert.equal(disk.progress.fraction,.5)
 })
 await step('Corrupt backup is rejected before local records change',async()=>{
  assert.equal(await evalPage(`const before=JSON.stringify((await db.exportAll()).books.map(b=>b.id));try{await backup.restoreBackup({app:'immersive-reader',version:2,settings:{},data:{books:[{id:'bad',title:'Bad',format:'epub',data:'YQ==',byteLength:99,sha256:'wrong'}],backgrounds:[],audio:[]}})}catch{}return before===JSON.stringify((await db.exportAll()).books.map(b=>b.id));`),true)
 })
 await step('Backup roundtrip verifies content, notes, progress and QQ metadata',async()=>{
  assert.equal(await evalPage(`${online}const payload=await backup.buildBackup();await db.clearAll();const restored=await backup.restoreBackup(payload);return Object.values(restored.verify).every(Boolean);`),true)
 })
 await step('TXT/EPUB/text PDF imports persist; corrupt EPUB and empty PDF leave no records',async()=>{
  const got=await evalPage(`const {importBook}=await import('/js/library.js?v=1.10.3');const imported=[];for(const [name,path] of [['synthetic.txt','/tests/fixtures/山中的信.txt'],['synthetic.epub','/tests/fixtures/三只松鼠的四季.epub'],['synthetic.pdf','/tests/fixtures/pdf-text.pdf']]){const file=new File([await(await fetch(path)).blob()],name);const book=await importBook(file);imported.push(book.format);if(!(await db.getBook(book.id)))throw Error('not persisted');}let rejects=0;const before=(await db.listBooks()).length;for(const [name,path] of [['bad.epub','/tests/fixtures/corrupted.epub'],['empty.pdf','/tests/fixtures/pdf-empty.pdf']]){try{await importBook(new File([await(await fetch(path)).blob()],name))}catch{rejects++;}}return {imported,rejects,unchanged:before===(await db.listBooks()).length};`)
  assert.deepEqual(got,{imported:['txt','epub','pdf'],rejects:2,unchanged:true})
 })
 await step('Open superseded by close or a newer open cannot revive cancelled reader',async()=>{
  const got=await evalPage(`const {Reader}=await import('/js/reader.js');const {ensureSampleBook}=await import('/js/library.js?v=1.10.3');const rec=await ensureSampleBook();const box=document.createElement('div');box.style.cssText='width:640px;height:700px;position:relative';document.body.append(box);const r=new Reader(box);const cancelled=r.open(rec,{});await r.close();const first=await cancelled;const old=r.open(rec,{});const current=r.open(rec,{});const states=await Promise.all([old,current]);await r.close();box.remove();return {first,states,closed:r.bookId===null};`)
  assert.deepEqual(got,{first:false,states:[false,true],closed:true})
 })
 await step('Explicit chapter/note destination wins over saved position journal',async()=>{
  const got=await evalPage(`const {Reader}=await import('/js/reader.js'); const {ensureSampleBook}=await import('/js/library.js?v=1.10.3'); const rec=await ensureSampleBook();const box=document.createElement('div');box.style.cssText='width:640px;height:700px;position:relative';document.body.append(box);window.readerTest=new Reader(box);await readerTest.open(rec,{});const firstDoc=readerTest.view.renderer.getContents()[0].doc;const firstRange=firstDoc.createRange();firstRange.selectNodeContents(firstDoc.body);firstRange.collapse(true);const old=readerTest.view.getCFI(0,firstRange),target=readerTest.view.book.sections[2].id;await readerTest.close();localStorage.setItem('immersive-reader-position:'+rec.id,JSON.stringify({cfi:old}));await readerTest.open(rec,{lastLocation:target,useJournal:false});const actual=readerTest.view.renderer.getContents()[0].index;await readerTest.close();box.remove();return actual;`)
  assert.equal(got,2)
 })
 await step('Cancelling latest backup preview prevents late older selection from reappearing',async()=>{
  await send('Page.navigate',{url:base+'/'});await wait(250)
  for(let i=0;i<100;i++){if(await evalPage(`return !!window.__readerDb`))break;await wait(150)}
  await evalPage(`window.payloadText=JSON.stringify({app:'immersive-reader',version:2,settings:{},data:{books:[],backgrounds:[],audio:[]}});const input=document.querySelector('#file-backup');Object.defineProperty(input,'files',{configurable:true,value:[{size:1,name:'slow.json',text:()=>new Promise(r=>window.finishSlow=r)}]});input.dispatchEvent(new Event('change'));Object.defineProperty(input,'files',{configurable:true,value:[{size:1,name:'latest.json',text:async()=>payloadText}]});input.dispatchEvent(new Event('change'));`)
  for(let i=0;i<50;i++){if(await evalPage(`return !!document.querySelector('[data-action="backup-cancel"]')`))break;await wait(100)}
  await evalPage(`document.querySelector('[data-action="backup-cancel"]').click();finishSlow(payloadText);`);await wait(400)
  assert.equal(await evalPage(`return !!document.querySelector('[data-action="backup-overwrite"]')`),false)
 })
}catch(e){results.push({name:'harness',pass:false,error:e.stack});console.error(e)}
finally{
 if(ws){try{await send('Browser.close',{},null)}catch{}ws.close()}
 chrome?.kill();server.kill();await wait(400);await rm(dir,{recursive:true,force:true})
 await mkdir(resolve(output,'..'),{recursive:true});await writeFile(output,JSON.stringify({root:ROOT,results},null,2))
}
console.log(`${results.filter(r=>r.pass).length}/${results.length} passed`)
if(results.some(r=>!r.pass))process.exitCode=1
