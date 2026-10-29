// Multiple real tabs and frames, using original local pages and a mock translator.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { openExtensionBrowser } from './lib/extension-browser.mjs';
import { browserTarget, verifyBrowserIdentity } from './lib/browser-target.mjs';

const root = fileURLToPath(new URL('..', import.meta.url)), target = browserTarget();
const output = path.join(root, '.npm-cache/paragraph-sync', target.kind);
await fs.mkdir(output, { recursive: true });
const states = new Map(), commands = new Map(), calls = [], checks = [];
let origin, cross, sequence = 0;
const documentPage = (name, frames) => `<!doctype html><html lang="en"><meta charset="utf-8"><title>${name}</title>
<style>body{margin:24px;font:18px/1.6 Arial}iframe{width:420px;height:180px}main{max-width:1000px}</style><body><main>
<p id="paragraph">${name}: A complete paragraph should translate only when the reader chooses it.</p>
${frames ? `<iframe src="${cross}/child?name=${name}-child"></iframe><iframe src="${cross}/excluded?name=${name}-excluded"></iframe>` : ''}
</main><script>
const name=${JSON.stringify(name)},generation=crypto.randomUUID();let completed=0,remembered=null,busy=false;
const report=()=>fetch('/report',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,generation,completed,
 mode:document.documentElement.classList.contains('wupage-paragraph-mode'),floating:!!document.querySelector('#wupage-floating-ball'),
 button:document.querySelector('[data-action="paragraph-mode"]')?.getAttribute('aria-pressed'),
 translations:[...document.querySelectorAll('.wupage-translation')].map(e=>e.textContent),
 pending:document.querySelectorAll('.wupage-translation-pending').length,same:remembered&&remembered===document.querySelector('.wupage-translation')&&remembered.isConnected})}).catch(()=>{});
setInterval(async()=>{if(busy)return;busy=true;try{const tasks=await(await fetch('/commands?name='+encodeURIComponent(name))).json();
 for(const task of tasks){if(task.action==='click')document.querySelector('#paragraph').dispatchEvent(new MouseEvent('click',{ctrlKey:true,button:0,bubbles:true,cancelable:true}));
 if(task.action==='remember')remembered=document.querySelector('.wupage-translation');completed=task.id;}await report();}finally{busy=false}},100);
new MutationObserver(report).observe(document.documentElement,{subtree:true,childList:true,characterData:true,attributes:true});report();
</script></body></html>`;
const server = createServer(async (request, response) => {
  const url = new URL(request.url, origin || 'http://localhost');
  if (request.method === 'POST') {
    let raw = ''; for await (const part of request) raw += part;
    const data = JSON.parse(raw);
    if (url.pathname === '/report') { states.set(data.name, data); response.writeHead(204).end(); return; }
    calls.push(...data.texts);
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ translations: data.texts.map(text =>
      text.includes('⟪WUPAGESEGMENT') ? text.replace(/(⟪WUPAGESEGMENT\d+⟫\n)/gu, '$1译文：') : `译文：${text}`) }));
    return;
  }
  if (url.pathname === '/commands') {
    const name = url.searchParams.get('name'), queue = commands.get(name) || [];
    commands.delete(name); response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(queue)); return;
  }
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(documentPage(url.searchParams.get('name') || 'fixture', url.searchParams.has('frames')));
});
await new Promise(resolve => server.listen(0, resolve));
origin = `http://127.0.0.1:${server.address().port}`; cross = `http://localhost:${server.address().port}`;
const waitFor = async (read, test, label) => {
  const until = Date.now() + 30000; let value;
  do { value = await read(); if (test(value)) return value; await delay(100); } while (Date.now() < until);
  throw new Error(`${label}: ${JSON.stringify(value)}`);
};
const act = async (name, action) => {
  const id = ++sequence; commands.set(name, [...(commands.get(name) || []), { id, action }]);
  await waitFor(() => states.get(name), state => state?.completed >= id, `${name}/${action}`);
};
const expected = new Map();
const addPage = name => {
  expected.set(name, true); expected.set(`${name}-child`, true); expected.set(`${name}-excluded`, false);
};
const assertModes = enabled => waitFor(() => Object.fromEntries(states), value => [...expected].every(([name, allowed]) =>
  value[name]?.mode === (enabled && allowed) && (!allowed || name.includes('-child') || value[name].button === String(enabled))), `all tabs ${enabled}`);
let browser;
try {
  browser = await openExtensionBrowser(root, output, target.kind === 'firefox');
  const identity = verifyBrowserIdentity(target, await browser.evaluate('return navigator.userAgent;'));
  const runtime = async request => {
    const result = await browser.api('return chrome.runtime.sendMessage(input[0]);', [request]);
    assert.equal(result?.ok, true, JSON.stringify(result)); return result.data;
  };
  const settings = await runtime({ type: 'GET_SETTINGS' });
  settings.providers.push({ id: 'paragraph-sync-test', type: 'http-template', label: 'Paragraph sync test', method: 'POST', url: `${origin}/translate`,
    headers: { 'Content-Type': 'application/json' }, bodyTemplate: '{"texts":{{json texts}}}', responsePath: 'translations' });
  Object.assign(settings, { activeProviderId: 'paragraph-sync-test', sourceLang: 'en', targetLang: 'zh-CN', cacheEnabled: false,
    translationDisplayMode: 'bilingual', frameTranslation: { enabled: true, excludeMatches: [`${cross}/excluded*`] } });
  settings.selectionTranslation.enabled = false;
  await runtime({ type: 'SAVE_SETTINGS', settings });
  const create = url => browser.api('return chrome.tabs.create({url:input[0],active:false});', [url]);
  const send = async (tab, request) => {
    const result = await browser.api('return chrome.tabs.sendMessage(input[0],input[1],{frameId:0});', [tab.id, request]);
    assert.equal(result?.ok, true, JSON.stringify(result)); return result.data;
  };
  const firstUrl = `${origin}/page?name=first&frames=1`;
  await browser.navigate(firstUrl); addPage('first');
  const first = await browser.api('return (await chrome.tabs.query({})).find(t=>t.url===input[0]);', [firstUrl]); assert.ok(first?.id);
  const second = await create(`${origin}/page?name=second&frames=1`); addPage('second');
  await create('about:blank');
  await assertModes(false);
  await browser.press('Alt+Shift+L'); await assertModes(true);
  assert.equal(calls.length, 0, 'enabling the global mode does not translate pages');
  checks.push('keyboard toggle reaches two existing tabs and cross-origin frames, while excluded frames stay disabled');

  await act('second', 'click');
  await waitFor(() => states.get('second'), state => state?.translations.length === 1 && !state.pending, 'second tab translates one paragraph');
  await act('second', 'remember'); const count = calls.length;
  await send(first, { type: 'SET_PARAGRAPH_MODE', enabled: false }); await assertModes(false);
  assert.equal(states.get('second').same, true); assert.equal(calls.length, count);
  await act('second', 'click'); await delay(200);
  assert.equal(states.get('second').same, true, 'disabled Ctrl-click does not restore or modify a previous result');
  assert.equal(calls.length, count);
  await send(second, { type: 'SET_PARAGRAPH_MODE', enabled: true }); await assertModes(true);
  checks.push('a change in either tab updates all controls without clearing a completed paragraph or sending extra translations');

  const third = await create(`${origin}/page?name=third&frames=1`); addPage('third'); await assertModes(true);
  const previous = states.get('first').generation;
  await browser.navigate(firstUrl);
  await waitFor(() => states.get('first'), state => state?.generation !== previous && state?.mode, 'reload restores shared mode');
  await browser.evaluate(`const frame=document.createElement('iframe');frame.src=${JSON.stringify(`${cross}/child?name=late-child`)};document.querySelector('main').append(frame);`);
  expected.set('late-child', true); await assertModes(true);
  assert.equal(states.get('second').same, true);
  checks.push('new tabs, refreshed documents and late embedded documents inherit the saved mode');

  await send(first, { type: 'TRANSLATE_PAGE' });
  await waitFor(() => states.get('first'), state => state?.translations.length > 0 && !state.pending, 'whole-page translation');
  await act('first', 'remember'); const translated = calls.length;
  await send(third, { type: 'SET_PARAGRAPH_MODE', enabled: false }); await assertModes(false);
  assert.equal((await send(first, { type: 'GET_TRANSLATION_STATE' })).translated, true);
  await waitFor(() => states.get('first')?.same, Boolean, 'whole-page output survives global toggle');
  assert.equal(calls.length, translated);
  checks.push('global paragraph toggles preserve an active whole-page translation in another tab');

  await Promise.all([true, false, true].map(enabled => runtime({ type: 'SET_PARAGRAPH_MODE', enabled })));
  await assertModes(true); assert.equal((await runtime({ type: 'GET_PARAGRAPH_MODE' })).enabled, true);
  await runtime({ type: 'SAVE_SETTINGS', settings }); await assertModes(true);
  await browser.press('Alt+Shift+L'); await assertModes(false);
  assert.equal((await runtime({ type: 'GET_PARAGRAPH_MODE' })).enabled, false);
  checks.push('rapid writes keep the final state; saving an older settings form cannot reset it; a keyboard toggle disables all tabs');
  for (const [name, state] of states) if (name.includes('-child') || name.includes('-excluded')) assert.equal(state.floating, false);
  await browser.capture('synchronized.png');
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ ...identity, checks, states: Object.fromEntries(states), calls }, null, 2));
  console.log(JSON.stringify({ ...identity, checks, output }, null, 2));
} catch (error) {
  await browser?.capture('failure.png').catch(() => {});
  await fs.writeFile(path.join(output, 'failure.json'), JSON.stringify({ error: String(error), states: Object.fromEntries(states), calls }, null, 2));
  throw error;
} finally { await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
