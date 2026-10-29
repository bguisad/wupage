// Sanitized reproduction of the supplied Partner Center task-menu structure.
// Uses only local components and mock translations; never opens the account.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { openExtensionBrowser } from './lib/extension-browser.mjs';
import { browserTarget, verifyBrowserIdentity } from './lib/browser-target.mjs';

const root=fileURLToPath(new URL('..',import.meta.url));
const target=browserTarget(), baseline=process.argv.includes('--baseline');
const output=path.join(root,'.npm-cache/task-menu',target.kind);
const labels=['Extension overview','Packages','Availability','Properties','Privacy','Store listings','Analytics','Reviews'];
const translated=['扩展概述','程序包','可用性','属性','隐私','商店条目','分析','评论'];
const calls=[],reports=[];
const fixture=shadow=>`<!doctype html><html lang="en"><meta charset="utf-8"><title>Task menu regression</title><style>
body{margin:0;font:14px/20px 'Segoe UI',Arial;color:#292827}header{height:96px;padding:24px;background:#333;color:white;font-size:20px}
main{display:block}app-focus-nav{display:block;position:fixed;top:98px;bottom:0;left:0;width:280px;border-right:1px solid #eee}
article{margin-left:312px;padding:24px}h1{font-size:24px}#items{display:block}
</style><body><header>Menu layout reproduction</header><main role="main"><app-focus-nav>
<v6_he-task-menu task-menu item-type="page" auto-collapse breakpoint="1083px" class="he-task-menu"><div id="items">${labels.map((label,i)=>
`<v6_he-task-item role="listitem" tabindex="0" class="he-task-item he-focusable" task-item aria-label="${label}"${i===0?' selected':''}>${label}${i>0&&i<6?'<v6_he-icon slot="end" name="completedsolid" class="he-icon" aria-label="Step Completed"></v6_he-icon>':''}</v6_he-task-item>`).join('')}</div></v6_he-task-menu>
</app-focus-nav><article><h1>Extension overview</h1><p>Readable content stays separate from the navigation.</p></article></main><script>
const mode=${JSON.stringify(shadow)};
customElements.define('v6_he-task-menu',class extends HTMLElement{constructor(){super();this.attachShadow({mode}).innerHTML=
  '<style>:host{display:block;width:280px;height:100%;overflow:hidden}::slotted(div){display:block}</style><slot></slot>';}});
customElements.define('v6_he-task-item',class extends HTMLElement{constructor(){super();this.attachShadow({mode}).innerHTML=
  '<style>:host{display:block;height:36px;font:14px/20px Segoe UI,Arial;color:#292827;cursor:pointer}'+
  ':host([selected]){background:#edebe9;border-left:3px solid #0078d4}.control{box-sizing:border-box;display:flex;align-items:center;justify-content:space-between;padding:0 16px;height:36px;overflow:hidden;white-space:nowrap}'+
  '.text{overflow:hidden;text-overflow:ellipsis;min-width:0}::slotted([slot=end]){flex:0 0 16px}</style><div class="control"><span class="text"><slot></slot></span><slot name="end"></slot></div>';}});
customElements.define('v6_he-icon',class extends HTMLElement{constructor(){super();this.attachShadow({mode}).innerHTML=
  '<style>:host{display:inline-block;width:16px;height:16px;border-radius:50%;background:#14831b}</style>';}});
for(const item of document.querySelectorAll('[task-item]'))item.addEventListener('click',()=>{
  document.querySelector('[selected]')?.removeAttribute('selected');item.setAttribute('selected','');});
</script></body></html>`;
const server=createServer(async(req,res)=>{
  if(req.method!=='POST'){res.writeHead(200,{'content-type':'text/html; charset=utf-8'}).end(fixture(req.url.includes('closed')?'closed':'open'));return;}
  let body='';for await(const part of req)body+=part;
  const payload=JSON.parse(body);calls.push(...payload.texts);await delay(150);
  res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({translations:payload.texts.map(text=>{
    for(let i=0;i<labels.length;i++)text=text.replaceAll(labels[i],translated[i]);return text;
  })}));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
const waitFor=async(read,test,label)=>{const until=Date.now()+30000;let value;do{value=await read();if(test(value))return value;await delay(100);}while(Date.now()<until);throw new Error(`${label}: ${JSON.stringify(value)}`);};
let browser;
try{
  const browserRoot=baseline?path.join(output,'../baseline-v1.5.4'):root;
  browser=await openExtensionBrowser(browserRoot,output,target.kind==='firefox');
  const identity=verifyBrowserIdentity(target,await browser.evaluate('return navigator.userAgent;'));
  const runtime=async request=>{const result=await browser.api('return chrome.runtime.sendMessage(input[0]);',[request]);assert.equal(result?.ok,true,JSON.stringify(result));return result.data;};
  const settings=await runtime({type:'GET_SETTINGS'});
  settings.providers.push({id:'task-test',type:'http-template',label:'Task menu test',method:'POST',url:origin+'/translate',headers:{'Content-Type':'application/json'},bodyTemplate:'{"texts":{{json texts}}}',responsePath:'translations'});
  Object.assign(settings,{activeProviderId:'task-test',sourceLang:'en',targetLang:'zh-CN',translationDisplayMode:'replace',cacheEnabled:false});
  await runtime({type:'SAVE_SETTINGS',settings});
  const inspect=()=>browser.evaluate(`const box=e=>{const b=e.getBoundingClientRect();return{x:b.x,y:b.y,width:b.width,height:b.height}};
    return {outside:document.querySelectorAll('#items > .wupage-translation').length,rows:[...document.querySelectorAll('[task-item]')].map(item=>{
      const text=item.querySelector('.wupage-translation');const range=document.createRange();range.selectNodeContents(text||item.firstChild);
      const row=box(item);return{text:(text?.textContent||[...item.childNodes].filter(n=>n.nodeType===3).map(n=>n.data).join('')).trim(),box:row,
        visible:[...range.getClientRects()].some(b=>b.width>1&&b.height>1&&b.left<row.x+row.width&&b.right>row.x&&b.top<row.y+row.height&&b.bottom>row.y),
        aria:item.getAttribute('aria-label'),selected:item.hasAttribute('selected'),icons:[...item.querySelectorAll('[slot=end]')].map(icon=>({slot:icon.slot,box:box(icon)}))};})};`);
  for(const shadow of ['open','closed']){
    const url=origin+'/'+shadow;await browser.navigate(url);
    await waitFor(()=>browser.evaluate('return !!document.querySelector("#wupage-floating-ball")'),Boolean,'content runtime');
    const send=async type=>{const result=await browser.api('const tab=(await chrome.tabs.query({})).find(t=>t.url===input[0]);return chrome.tabs.sendMessage(tab.id,{type:input[1]},{frameId:0});',[url,type]);assert.equal(result?.ok,true,JSON.stringify(result));return result.data;};
    await browser.evaluate(`const w=window.wrappedJSObject||window;w.taskOriginal={html:document.querySelector('#items').innerHTML,nodes:[...document.querySelector('#items').querySelectorAll('*')],text:[...document.querySelectorAll('[task-item]')].map(e=>e.firstChild)};`);
    for(const width of [1400,760]){
      await send('CLEAR_TRANSLATION');await browser.resize(width,750);
      const before=await inspect();await browser.capture(`${shadow}-${width}-before.png`);
      await send('TRANSLATE_PAGE');await delay(250);
      const callCount=calls.length;
      for(const mode of ['replace','bilingual','bilingual-accent','replace']){
        settings.translationDisplayMode=mode;await runtime({type:'SAVE_SETTINGS',settings});
        if(!baseline) await waitFor(inspect,state=>state.rows.every(row=>translated.includes(row.text)),mode);
        const after=await inspect();reports.push({shadow,width,mode,before,after});
        await browser.capture(`${baseline?'baseline-':''}${shadow}-${width}-${mode}.png`);
        if(!baseline){
          assert.equal(after.outside,0,'no aggregate translation outside task items');
          assert.deepEqual(after.rows.map(row=>row.text),translated,'each item has its own translation');
          assert.ok(after.rows.every(row=>row.visible),'all eight labels are visibly rendered');
          assert.deepEqual(after.rows.map(row=>row.aria),labels,'accessibility labels remain intact');
          assert.deepEqual(after.rows.map(row=>row.box),before.rows.map(row=>row.box),'row geometry preserved');
          assert.deepEqual(after.rows.map(row=>row.icons),before.rows.map(row=>row.icons),'status icons keep their original slots');
          assert.equal(calls.length,callCount,'mode switches reuse results');
        }
      }
      if(!baseline){
        await browser.evaluate('document.querySelectorAll("[task-item]")[1].click();');
        assert.deepEqual((await inspect()).rows.map(row=>row.selected),[false,true,false,false,false,false,false,false],'task click still works');
        await browser.evaluate('document.querySelector("[task-item]").click();');
      }
      await send('CLEAR_TRANSLATION');
      assert.equal(await browser.evaluate(`const w=window.wrappedJSObject||window,o=w.taskOriginal;return document.querySelector('#items').innerHTML===o.html&&o.nodes.every(n=>n.isConnected)&&o.text.every((n,i)=>document.querySelectorAll('[task-item]')[i].firstChild===n);`),true,'original nodes and exact menu HTML restored');
    }
  }
  await fs.writeFile(path.join(output,baseline?'baseline.json':'report.json'),JSON.stringify({...identity,baseline,reports,calls},null,2));
  console.log(JSON.stringify({...identity,baseline,cases:reports.length,output},null,2));
}finally{if(browser)await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
