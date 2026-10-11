'use strict';
const {app,BrowserWindow,Menu,dialog,shell}=require('electron');
const {spawn}=require('node:child_process');
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const os=require('node:os');
const {classifyHealth,backoffDelay,MAX_RESTART_ATTEMPTS,openRotatedLog,defaultLibraryDir}=require('./supervisor.cjs');
const PORT=Number(process.env.READER_PORT || 8940);
if(!Number.isInteger(PORT)||PORT<1024||PORT>65535)throw Error('阅读服务端口无效');
if(PORT!==8940 && (!process.env.READER_DATA_DIR || !process.env.READER_PROFILE_DIR))throw Error('隔离端口必须同时指定资料目录与浏览器配置目录');
if(process.env.READER_PROFILE_DIR)app.setPath('userData',process.env.READER_PROFILE_DIR);
const BASE='http://127.0.0.1:'+PORT+'/';
const LEGACY=process.platform==='darwin'?path.join(os.homedir(),'Downloads/读书平台/沉浸阅读器/data'):'';
const DATA=process.env.READER_DATA_DIR || defaultLibraryDir();
let window=null, child=null, quitting=false;
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
// 健康检查三态：json=本应用 / http=端口被别的 HTTP 程序占用 / unreachable=空闲。
// 旧实现把「HTTP 可达但非 JSON」塌缩成空闲，随后 spawn 撞 EADDRINUSE，
// 用户看到误导性的「启动失败（1）」而不是真实的端口冲突。
function health(){return new Promise(resolve=>{
  const request=http.get(BASE+'_reader/health',res=>{
    let raw='';res.on('data',c=>{raw+=c;if(raw.length>8192)request.destroy()});
    res.on('end',()=>{try{resolve({kind:'json',json:JSON.parse(raw)})}catch{resolve({kind:'http'})}});
  });
  request.setTimeout(1000,()=>request.destroy());
  request.on('error',()=>resolve({kind:'unreachable'}));
  request.on('close',()=>resolve({kind:'unreachable'}));
})}
// ── 服务子进程监督：崩溃后带退避自动重启，连续失败达到上限才弹窗放弃 ──
let restartAttempts=0, restartTimer=null;
function spawnServer(){
  fs.mkdirSync(DATA,{recursive:true});
  const site=path.join(__dirname,'site');
  // 服务输出落到滚动日志（DATA/service.log，超 2MB 挪 .old）：崩溃后第一次有据可查
  const logFd=openRotatedLog(DATA,'service.log');
  const proc=spawn(process.execPath,[path.join(site,'server.cjs')],{
    cwd:site,env:{...process.env,ELECTRON_RUN_AS_NODE:'1',HOST:'127.0.0.1',PORT:String(PORT),READER_STORAGE:'sqlite',READER_DESKTOP:'1',READER_DATA_DIR:DATA,READER_LEGACY_DATA_DIR:process.env.READER_DATA_DIR?'':LEGACY},stdio:['ignore',logFd,logFd]
  });
  proc.on('exit',()=>{
    try{fs.closeSync(logFd)}catch{}
    if(child===proc)child=null;
    if(quitting)return; // 正常退出流程杀掉的子进程不复活
    scheduleRestart();
  });
  child=proc;
  return proc;
}
function scheduleRestart(){
  if(restartTimer||quitting)return;
  if(restartAttempts>=MAX_RESTART_ATTEMPTS){
    dialog.showErrorBox('沉浸阅读器','阅读服务反复退出，已停止自动重启。请保存工作后重新打开 APP。');
    return;
  }
  const delay=backoffDelay(restartAttempts++);
  restartTimer=setTimeout(async()=>{
    restartTimer=null;
    try{
      for(let i=0;i<100;i++){
        if(!child)spawnServer();
        const h=await health();
        if(h.kind==='json'&&h.json?.app==='immersive-reader'){
          restartAttempts=0;
          // 服务回来了：把可能停在错误页/白屏的窗口拉回正文
          if(window&&!window.isDestroyed())window.loadURL(target).catch(()=>{});
          return;
        }
        await new Promise(r=>setTimeout(r,150));
      }
    }catch{/* exit 监听器会再次排期 */}
    scheduleRestart();
  },delay);
}
async function start(){
  const existing=await health();
  const state=classifyHealth(existing);
  if(state==='ours')return;
  if(state==='occupied')throw Error('端口 '+PORT+' 已被其他程序占用（它不是阅读器的服务）。请退出占用该端口的程序，或重启电脑后再打开 APP。');
  spawnServer();
  for(let i=0;i<100;i++){
    const h=await health();
    if(h.kind==='json'&&h.json?.app==='immersive-reader'){restartAttempts=0;return;}
    await new Promise(r=>setTimeout(r,150));
  }
  throw Error('阅读服务未能启动，请重新打开 APP。');
}
// 服务短暂不可用时的兜底页：纯 HTML 链接 + meta 自动重试，不依赖 JS。
function fallbackPage(){
  return 'data:text/html;charset=utf-8,'+encodeURIComponent(
    '<meta http-equiv="refresh" content="3;url='+BASE+'">'+
    '<body style="background:#12211d;color:#e8e4d8;font-family:-apple-system,Segoe UI,Microsoft YaHei,sans-serif;display:grid;place-items:center;height:100vh;margin:0;text-align:center">'+
    '<div><p style="font-size:17px">阅读服务暂时没有响应，正在自动重连…</p>'+
    '<p style="margin-top:18px"><a href="'+BASE+'" style="color:#9fb8a6;font-size:15px">立即重试</a></p></div>')
}
function createWindow(){
  window=new BrowserWindow({width:1280,height:850,minWidth:390,minHeight:600,show:false,title:'沉浸阅读器',backgroundColor:'#12211d',webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}});
  window.once('ready-to-show',()=>window.show());
  window.webContents.on('did-fail-load',(event,code,desc,url,main)=>{
    // -3 = ERR_ABORTED：reload/关窗等正常取消不算失败；只兜主框架的意外失败
    if(!main||quitting||code===-3)return;
    event.preventDefault();
    window.loadURL(fallbackPage()).then(()=>{if(!window.isVisible())window.show()}).catch(()=>{});
  });
  window.webContents.setWindowOpenHandler(({url})=>{if(/^https?:/.test(url))shell.openExternal(url);return {action:'deny'}});
  window.webContents.on('will-navigate',(event,url)=>{if(new URL(url).origin!==new URL(BASE).origin){event.preventDefault();if(/^https?:/.test(url))shell.openExternal(url)}});
  window.on('closed',()=>{window=null});window.loadURL(target);
}
app.whenReady().then(async()=>{
  if(!lock)return;
  try {
    await start();
    const fileMenu=process.platform==='darwin'?{role:'appMenu'}:{label:'文件',submenu:[{role:'quit',label:'退出'}]};
    Menu.setApplicationMenu(Menu.buildFromTemplate([fileMenu,{role:'editMenu'},{role:'viewMenu'},{role:'windowMenu'}]));
    createWindow();
  }catch(error){dialog.showErrorBox('沉浸阅读器',error.message);app.quit();}
});
app.on('activate',()=>{if(app.isReady()&&!window&&child)createWindow()});
app.on('window-all-closed',()=>app.quit());
app.on('before-quit',()=>{quitting=true;if(restartTimer){clearTimeout(restartTimer);restartTimer=null}if(child&&!child.killed)child.kill()});
