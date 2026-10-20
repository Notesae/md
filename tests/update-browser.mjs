// 在隔离 CI 中运行真实设置组件；原生 IPC、版本和进度为合成数据，不联网或执行安装器。
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';

const out = path.resolve('.tools/updater-ui');
mkdirSync(out, { recursive: true });
const executablePath = [process.env.CHROME_PATH,
  path.join(process.env.PROGRAMFILES || 'C:/Program Files', 'Google/Chrome/Application/chrome.exe'),
  path.join(process.env['PROGRAMFILES(X86)'] || 'C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe'),
  '/usr/bin/google-chrome'].find(value => value && existsSync(value));
assert.ok(executablePath, 'An existing Chrome or Edge is required; this test never installs a browser');

const fixture = `(() => {
 const phase = new URLSearchParams(location.search).get('phase') || 'idle';
 if(new URLSearchParams(location.search).get('theme')==='dark')document.documentElement.dataset.theme='dark';
 const offer={version:'0.1.3',tag:'v0.1.3',prerelease:false,releaseUrl:'https://github.com/Notesae/md/releases/tag/v0.1.3',notes:'合成版本，用于界面审查；不是已发布版本。',bytes:4194304,sha256:'a'.repeat(64)};
 const data=window.__updateFixture={calls:{},failSave:false,state:{phase,job:1,currentVersion:'0.1.2',channel:'stable',offer:phase==='ready'?offer:null,downloaded:phase==='ready'?offer.bytes:0,total:offer.bytes,message:phase==='ready'?'下载和 SHA-256 校验已完成，尚未安装。':'尚未检查更新。',retryAt:null,canInstall:true}};
 window.__TAURI_INTERNALS__={invoke:async(command,args={})=>{
   data.calls[command]=(data.calls[command]||0)+1;
   if(command==='check_for_updates')Object.assign(data.state,{phase:'available',offer,channel:args.channel,message:'发现可用版本，尚未下载。'});
   if(command==='download_update')Object.assign(data.state,{phase:'downloading',downloaded:2097152,message:'正在下载安装包，阅读可以继续。'});
   if(command==='cancel_update')Object.assign(data.state,{phase:'cancelled',offer:null,message:'已取消下载，当前应用未改变。'});
   if(command==='install_update')throw new Error('合成安装失败；测试未运行安装程序。');
   if(command==='open_update_release')return;
   return structuredClone(data.state);
 }};
})();`;
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MD 应用更新 · 隔离审查</title>
<style>body{overflow:auto!important}.review{max-width:660px;margin:30px auto;padding:0 24px 32px}h1{font-size:22px;margin-bottom:8px}.note{color:var(--muted);line-height:1.8;margin-bottom:24px}</style></head><body><main class="review"><h1>应用更新</h1><p class="note">真实设置组件 · 合成版本与下载状态；不联网、不运行安装器。</p><div id="component"></div></main><script>${fixture}</script><script type="module">
import '/src/styles.css';import {UpdateSettings} from '/src/update-settings.ts';
new UpdateSettings(document.querySelector('#component'),async()=>{if(window.__updateFixture.failSave)throw new Error('合成保存失败');}).activate();
</script></body></html>`;
const server = await createServer({ configFile: false, server: {host:'127.0.0.1',port:0,hmr:false},
  plugins:[{name:'isolated-updater-component',configureServer(server){server.middlewares.use(async(req,res,next)=>{
    if(!req.url?.startsWith('/update-review'))return next();
    try {res.setHeader('Content-Type','text/html; charset=utf-8');res.end(await server.transformIndexHtml(req.url,html));}
    catch(error){res.statusCode=500;res.end(String(error));}
  });}}] });
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
let browser;
const images = [];
try {
  browser = await chromium.launch({executablePath,headless:true,chromiumSandbox:true});
  const page = await browser.newPage({viewport:{width:800,height:800},deviceScaleFactor:1});
  // 非本机请求一律中止，确保合成发布地址不能发起真实下载。
  await page.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
  const screenshot = async(name,inline=false)=>{
    const bytes=await page.screenshot({type:'jpeg',quality:68,fullPage:true,path:path.join(out,name+'.jpg')});
    images.push({name:name+'.jpg',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
    if(inline)console.log('MD_UPDATER_IMAGE '+name+' '+bytes.toString('base64'));
  };
  await page.goto(origin+'/update-review');
  await page.locator('#update-current-version').filter({hasText:'0.1.2'}).waitFor();
  assert.equal(await page.evaluate(()=>window.__updateFixture.calls.check_for_updates||0),0);
  await screenshot('01-idle-800');
  await page.getByRole('button',{name:'检查更新',exact:true}).click();
  await page.getByRole('heading',{name:'MD 0.1.3 · 稳定版'}).waitFor();
  await screenshot('02-available-800',true);
  await page.getByRole('button',{name:'下载安装包',exact:true}).click();
  assert.equal(await page.locator('#update-progress').getAttribute('value'),'2097152');
  await screenshot('03-downloading-800');
  await page.getByRole('button',{name:'取消',exact:true}).click();
  assert.equal(await page.evaluate(()=>window.__updateFixture.calls.install_update||0),0);
  await page.goto(origin+'/update-review?phase=ready&theme=dark');
  await page.getByRole('button',{name:'安装更新…',exact:true}).click();
  const dialog=page.getByRole('dialog');await dialog.waitFor();
  assert.equal(await page.evaluate(()=>document.activeElement?.textContent),'暂不安装');
  await screenshot('04-confirm-dark-800',true);
  await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
  assert.equal(await page.evaluate(()=>window.__updateFixture.calls.install_update||0),0);
  assert.equal(await page.evaluate(()=>document.activeElement?.textContent),'安装更新…');
  await page.getByRole('button',{name:'安装更新…',exact:true}).click();
  await page.evaluate(()=>{window.__updateFixture.failSave=true;});
  await page.getByRole('button',{name:'退出并打开安装向导',exact:true}).click();
  await page.locator('#update-install-status[role="alert"]').filter({hasText:'合成保存失败'}).waitFor();
  assert.equal(await page.evaluate(()=>window.__updateFixture.calls.install_update||0),0);
  await page.evaluate(()=>{window.__updateFixture.failSave=false;});
  await page.getByRole('button',{name:'退出并打开安装向导',exact:true}).click();
  await page.locator('#update-install-status[role="alert"]').filter({hasText:'合成安装失败'}).waitFor();
  assert.equal(await page.evaluate(()=>window.__updateFixture.calls.install_update),1);
  await screenshot('05-launch-failure-dark-800');
  await page.setViewportSize({width:390,height:844});
  await page.goto(origin+'/update-review?phase=ready');
  await page.getByRole('button',{name:'安装更新…',exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await screenshot('06-component-390');
  await page.setViewportSize({width:1440,height:900});
  await page.goto(origin+'/update-review');
  await page.locator('#update-current-version').filter({hasText:'0.1.2'}).waitFor();
  await screenshot('07-component-1440');
  writeFileSync(path.join(out,'report.json'),JSON.stringify({sourceHead:process.env.MD_UPDATER_HEAD||null,
    evidence:'Actual UpdateSettings and product CSS in headless browser; synthetic IPC only, no native application or installer execution. 390px verifies the component host; MD desktop minimum remains 800x580.',
    checks:['manual-only check','byte progress and cancel','dialog focus/Escape return','save failure blocks handoff','explicit failed handoff preserves controls','component overflow at 390px'],images},null,2));
  console.log('Updater browser checks passed; '+images.length+' synthetic-state screenshots');
} finally {await browser?.close();await server.close();}
