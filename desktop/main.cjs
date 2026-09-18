'use strict';
const {app,BrowserWindow,Menu,dialog,shell}=require('electron');
const {spawn}=require('node:child_process');
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const os=require('node:os');
const BASE='http://127.0.0.1:8940/';
const LEGACY=path.join(os.homedir(),'Downloads/读书平台/沉浸阅读器/data');
const DATA=process.env.READER_DATA_DIR || path.join(os.homedir(),'Library/Application Support/immersive-reader-app/library');
let window=null, child=null;
function readerURL(args) {
  for(const arg of args) {
    try {
      const u=new URL(arg);
      if(u.origin!==new URL(BASE).origin || u.pathname!=='/' || u.username || u.password)continue;
      const result=new URL(BASE);
      for(const key of ['book','note']) {
        const value=u.searchParams.get(key);
        if(value && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value))result.searchParams.set(key,value);
      }
      return result.href;
    }catch{}
  }
  return null;
}
let target=readerURL(process.argv)||BASE;
const lock=app.requestSingleInstanceLock();
if(!lock)app.quit();
app.on('second-instance',(_,argv)=>{
  const url=readerURL(argv);if(url)target=url;
  if(window){if(window.isMinimized())window.restore();window.show();window.focus();if(url)window.loadURL(url);}
});
function health(){return new Promise(resolve=>{
  const request=http.get(BASE+'_reader/health',res=>{let raw='';res.on('data',c=>{raw+=c;if(raw.length>8192)request.destroy()});res.on('end',()=>{try{resolve(JSON.parse(raw))}catch{resolve(null)}})});
  request.setTimeout(1000,()=>request.destroy());request.on('error',()=>resolve(null));
})}
async function start(){
  const existing=await health();
  if(existing){if(existing.app!=='immersive-reader')throw Error('8940 端口被其他应用占用。');return;}
  fs.mkdirSync(DATA,{recursive:true});
  // The bundled Node runtime makes the installed app independent of Python and source files.
  const site=path.join(__dirname,'site');
  child=spawn(process.execPath,[path.join(site,'server.cjs')],{
    cwd:site,env:{...process.env,ELECTRON_RUN_AS_NODE:'1',HOST:'127.0.0.1',PORT:'8940',READER_STORAGE:'sqlite',READER_DESKTOP:'1',READER_DATA_DIR:DATA,READER_LEGACY_DATA_DIR:LEGACY},stdio:'ignore'
  });
  let failure=null;child.on('error',e=>{failure=e});child.on('exit',code=>{if(code)failure=Error('阅读服务启动失败（'+code+'）')});
  for(let i=0;i<100;i++){if(failure)throw failure;const h=await health();if(h?.app==='immersive-reader')return;await new Promise(r=>setTimeout(r,150));}
  throw Error('阅读服务未能启动，请重新打开 APP。');
}
function createWindow(){
  window=new BrowserWindow({width:1280,height:850,minWidth:390,minHeight:600,show:false,title:'沉浸阅读器',backgroundColor:'#12211d',webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}});
  window.once('ready-to-show',()=>window.show());
  window.webContents.setWindowOpenHandler(({url})=>{if(/^https?:/.test(url))shell.openExternal(url);return {action:'deny'}});
  window.webContents.on('will-navigate',(event,url)=>{if(new URL(url).origin!==new URL(BASE).origin){event.preventDefault();if(/^https?:/.test(url))shell.openExternal(url)}});
  window.on('closed',()=>{window=null});window.loadURL(target);
}
app.whenReady().then(async()=>{
  if(!lock)return;
  try {
    await start();
    Menu.setApplicationMenu(Menu.buildFromTemplate([{role:'appMenu'},{role:'editMenu'},{role:'viewMenu'},{role:'windowMenu'}]));
    createWindow();
  }catch(error){dialog.showErrorBox('沉浸阅读器',error.message);app.quit();}
});
app.on('activate',()=>{if(app.isReady()&&!window)createWindow()});
app.on('window-all-closed',()=>app.quit());
app.on('before-quit',()=>{if(child&&!child.killed)child.kill()});
