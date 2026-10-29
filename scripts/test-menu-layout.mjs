// Real options and popup documents with isolated browser profiles; no remote service.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { openExtensionBrowser } from './lib/extension-browser.mjs';
import { browserTarget, verifyBrowserIdentity } from './lib/browser-target.mjs';

const root = fileURLToPath(new URL('..', import.meta.url)), target = browserTarget();
const output = path.join(root, '.npm-cache/menu-layout', target.kind), checks = [];
await fs.mkdir(output, { recursive: true });
const waitFor = async (read, test, label) => {
  const until = Date.now() + 30000; let value;
  do { value = await read(); if (test(value)) return value; await delay(100); } while (Date.now() < until);
  throw new Error(`${label}: ${JSON.stringify(value)}`);
};
let browser;
try {
  browser = await openExtensionBrowser(root, output, target.kind === 'firefox');
  const identity = verifyBrowserIdentity(target, await browser.evaluate('return navigator.userAgent;'));
  const runtime = async request => {
    const result = await browser.api('return chrome.runtime.sendMessage(input[0]);', [request]);
    assert.equal(result?.ok, true, JSON.stringify(result)); return result.data;
  };
  const initial = await runtime({ type: 'GET_SETTINGS' });
  const functionalState = value => JSON.stringify([value.floatingBallEnabled, value.contextMenuTranslationEnabled,
    value.selectionTranslation, value.imageTranslationEnabled, value.videoTranslation]);
  const popupUrl = await browser.api('return chrome.runtime.getURL("popup.html");');
  const optionsUrl = await browser.api('return chrome.runtime.getURL("options.html#appearanceSettings");');
  await browser.api('location.hash="appearanceSettings";');
  await waitFor(() => browser.api('return document.querySelectorAll("[data-menu-visible]").length;'), count => count === 12, 'menu editor');
  await browser.api('document.querySelector("#appearanceMenuTab").click();');
  await browser.navigate(popupUrl); await browser.resize(330, 850);
  const inspect = () => browser.evaluate(`const read=group=>[...group.children].filter(e=>e.hasAttribute('data-popup-menu-item')&&getComputedStyle(e).display!=='none').map(e=>e.dataset.popupMenuItem);
    return {loading:document.querySelector('.popup')?.hasAttribute('data-menu-loading'),width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,
      groups:Object.fromEntries([...document.querySelectorAll('[data-popup-menu-group]')].map(e=>[e.dataset.popupMenuGroup,e.hidden?[]:read(e)])),
      settingsVisible:document.querySelector('#openOptions').getBoundingClientRect().width>0,
      hintVisible:!document.querySelector('#paragraphModeHint').hidden};`);
  const defaultLayout = await waitFor(inspect, value => value.loading === false && value.groups.features.length === 5, 'default popup');
  await browser.evaluate(`const w=window.wrappedJSObject||window;w.menuNodes=[...document.querySelectorAll('[data-popup-menu-item]')];`);
  await browser.capture('default-popup.png');
  const customize = () => browser.api(`for(const id of ['imageTranslation','videoTranslation','debug','openGithub','openWebsite']){
    const input=document.querySelector('[data-menu-visible="'+id+'"]');if(input.checked)input.click();}
    document.querySelector('[data-menu-move="floatingBall:-1"]').click();
    document.querySelector('[data-menu-move="clearCache:-1"]').click();document.querySelector('[data-menu-move="clearCache:-1"]').click();`);
  const custom = { features: ['floatingBall', 'contextMenuTranslation', 'selectionTranslation'], translation: ['pageToggle', 'paragraphMode'],
    tools: ['clearCache', 'openPdfWorkspace'], links: [] };
  const save = async () => {
    await browser.api('document.querySelector("#save").click();');
    await waitFor(() => browser.api('return document.querySelector("#status").textContent;'), text => text === '已保存。', 'save');
    // The status may already say "saved" from an earlier operation. Read the
    // persisted draft as well, rather than using that message as completion.
    await waitFor(() => browser.api(`const {data}=await chrome.runtime.sendMessage({type:'GET_SETTINGS'});
      const draft=[...document.querySelectorAll('[data-menu-visible]')].filter(e=>!e.checked).map(e=>e.dataset.menuVisible).sort();
      return JSON.stringify(data.appearance.popupMenu.hidden.slice().sort())===JSON.stringify(draft);`), Boolean, 'stored draft');
  };
  await customize();
  const preview = await browser.api(`return Object.fromEntries([...document.querySelectorAll('#popupMenuPreview [data-popup-menu-group]')].map(g=>
    [g.dataset.popupMenuGroup,[...g.children].filter(e=>!e.hasAttribute('data-popup-menu-hidden')).map(e=>e.dataset.popupMenuItem)]));`);
  assert.deepEqual(preview, custom);
  assert.deepEqual((await inspect()).groups, defaultLayout.groups, 'unsaved preview does not change the real popup');
  await save();
  await waitFor(inspect, value => JSON.stringify(value.groups) === JSON.stringify(custom), 'live popup layout');
  assert.equal(await browser.evaluate(`const w=window.wrappedJSObject||window;return w.menuNodes.every(e=>e.isConnected&&document.querySelector('[data-popup-menu-item="'+e.dataset.popupMenuItem+'"]')===e);`), true);
  assert.equal(functionalState(await runtime({ type: 'GET_SETTINGS' })), functionalState(initial), 'hiding entries does not change feature switches');
  checks.push('12 optional entries, grouped ordering, unsaved preview, live saving, unchanged feature state and original control nodes');

  await browser.evaluate('document.querySelector("#floatingBall").click();');
  await waitFor(() => runtime({ type: 'GET_SETTINGS' }), value => value.floatingBallEnabled === false, 'reordered control works');
  await browser.evaluate('document.querySelector("#floatingBall").click();');
  const afterPopupSave = await waitFor(() => runtime({ type: 'GET_SETTINGS' }), value => value.floatingBallEnabled === true, 'control restored');
  assert.ok(afterPopupSave.appearance.popupMenu.hidden.includes('videoTranslation'));
  await browser.navigate(popupUrl);
  await waitFor(inspect, value => !value.loading && JSON.stringify(value.groups) === JSON.stringify(custom), 'reopened popup');
  for (const width of [264, 330, 420]) {
    await browser.resize(width, 850); const state = await inspect(); assert.equal(state.overflow, false);
    await browser.capture(`custom-popup-${width}.png`);
  }
  checks.push('reordered controls retain actions; popup saves preserve the layout; reopening and three widths keep the selection');

  await browser.api(`const ids=[...document.querySelectorAll('[data-menu-visible]')].map(e=>e.dataset.menuVisible);
    for(const id of ids){const e=document.querySelector('[data-menu-visible="'+id+'"]');if(e.checked)e.click();}`);
  await save();
  const empty = await waitFor(inspect, value => Object.values(value.groups).every(items => !items.length), 'empty groups collapse');
  assert.equal(empty.settingsVisible, true); assert.equal(empty.hintVisible, false);
  await browser.capture('minimal-popup.png');
  await browser.api('document.querySelector("#resetPopupMenu").click();'); await save();
  await waitFor(inspect, value => JSON.stringify(value.groups) === JSON.stringify(defaultLayout.groups), 'default layout restored');
  assert.equal(functionalState(await runtime({ type: 'GET_SETTINGS' })), functionalState(initial));
  checks.push('all entries may be hidden without losing settings access; empty groups and hints collapse; restoring defaults retains feature settings');

  await browser.navigate(optionsUrl); await browser.resize(1400, 1100);
  await waitFor(() => browser.evaluate('return document.querySelectorAll("[data-menu-visible]").length;'), count => count === 12, 'options preview');
  await browser.evaluate('document.querySelector("#appearanceMenuTab").click();');
  await browser.capture('editor-desktop.png');
  for (const width of [720, 390]) {
    await browser.resize(width, 1100);
    assert.equal(await browser.evaluate('return document.documentElement.scrollWidth<=innerWidth;'), true);
    await browser.capture(`editor-${width}.png`);
  }
  checks.push('options editor and layout preview fit desktop, tablet and narrow windows');
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ ...identity, checks, defaultLayout, custom, final: await runtime({ type: 'GET_SETTINGS' }) }, null, 2));
  console.log(JSON.stringify({ ...identity, checks, output }, null, 2));
} catch (error) {
  await browser?.capture('failure.png').catch(() => {}); throw error;
} finally { await browser?.close(); }
