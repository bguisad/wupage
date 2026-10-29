// Reproduce a popup opened on a tab that predates extension loading, then
// verify a retry after refreshing the page. Profiles and service are isolated.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { browserTarget, verifyBrowserIdentity } from './lib/browser-target.mjs';

const root = fileURLToPath(new URL('..', import.meta.url)), target = browserTarget();
if (target.kind === 'firefox') throw new Error('This popup regression uses Chromium automation.');
const baseline = process.argv.includes('--baseline');
const output = path.join(root, '.npm-cache/paragraph-mode', target.kind);
await fs.mkdir(output, { recursive: true });
const calls = [], checks = [];
const server = createServer(async (request, response) => {
  if (request.method === 'POST') {
    let body = ''; for await (const part of request) body += part;
    const payload = JSON.parse(body); calls.push(...payload.texts);
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ translations: payload.texts.map(text =>
      text.includes('⟪WUPAGESEGMENT') ? text.replace(/(⟪WUPAGESEGMENT\d+⟫\n)/g, '$1译文：') : `译文：${text}`) }));
  } else response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html><html lang="en"><meta charset="utf-8">
    <title>Paragraph mode recovery</title><style>body{font:18px/1.6 Arial;padding:24px}iframe{width:600px;height:220px}</style><body><main>
    <p id="paragraph">${request.url === '/child' ? 'Embedded' : 'Main'} paragraph: A useful translation tool should preserve the original text and let readers choose each paragraph.</p>
    ${request.url === '/child' ? '' : '<iframe src="/child"></iframe>'}</main></body></html>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  const moduleName = process.env.PLAYWRIGHT_MODULE || 'playwright';
  const { chromium } = await import(path.isAbsolute(moduleName) ? pathToFileURL(moduleName).href : moduleName);
  browser = await chromium.launchPersistentContext(path.join(output, `profile-${Date.now()}`), {
    ...target.chromiumOptions, headless: true, viewport: { width: 1400, height: 1000 },
    ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging']
  });
  const page = await browser.newPage(); await page.goto(origin);
  const identity = verifyBrowserIdentity(target, await page.evaluate(() => navigator.userAgent));
  const session = await browser.browser().newBrowserCDPSession();
  const { id } = await session.send('Extensions.loadUnpacked', { path: path.join(root, 'dist') }); await session.detach();
  const control = await browser.newPage(); await control.goto(`chrome-extension://${id}/options.html`);
  await control.evaluate(async origin => {
    const loaded = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }); const settings = loaded.data;
    settings.providers.push({ id: 'paragraph-test', type: 'http-template', label: 'Paragraph test', method: 'POST', url: `${origin}/translate`,
      headers: { 'Content-Type': 'application/json' }, bodyTemplate: '{"texts":{{json texts}}}', responsePath: 'translations' });
    Object.assign(settings, { activeProviderId: 'paragraph-test', sourceLang: 'en', targetLang: 'zh-CN', cacheEnabled: false, translationDisplayMode: 'bilingual' });
    const saved = await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings }); if (!saved.ok) throw new Error(saved.error);
  }, origin);
  const sourceTab = await control.evaluate(async origin => (await chrome.tabs.query({})).find(tab => tab.url === origin + '/'), origin);
  assert.ok(sourceTab?.id);
  assert.equal(await page.locator('#wupage-floating-ball').count(), 0, 'the pre-existing tab has no content script');
  const popup = await browser.newPage(); await popup.setViewportSize({ width: 330, height: 1050 });
  // A toolbar popup does not replace the web tab as the active tab. A test tab
  // does, so preserve the real source-tab metadata for active-tab queries only.
  await popup.addInitScript(sourceTab => {
    const query = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = info => info.active ? Promise.resolve([sourceTab]) : query(info);
  }, sourceTab);
  await popup.goto(`chrome-extension://${id}/popup.html`);
  const mode = popup.locator('#translationDisplayMode'), option = mode.locator('option[value="paragraph"]');
  await popup.locator('#translationDisplayMode:not(:disabled)').waitFor();
  console.log('Initial popup:', await popup.evaluate(() => ({ title: document.querySelector('#translationDisplayMode').title,
    disabled: document.querySelector('option[value="paragraph"]').disabled, status: document.querySelector('#status').textContent })));
  await popup.screenshot({ path: path.join(output, baseline ? 'baseline.png' : 'disconnected.png') });
  if (baseline) {
    assert.equal(await option.evaluate(option => option.disabled), true, 'reproduce the locked paragraph option');
    checks.push('reproduced: disconnected page permanently disables the paragraph option');
  } else {
    assert.equal(await option.evaluate(option => option.disabled), false, 'connection failure does not disable the option');
    assert.ok((await popup.locator('#status').textContent()).includes('刷新网页后重试'));
    await mode.selectOption('paragraph');
    await popup.waitForFunction(() => !document.querySelector('#translationDisplayMode').disabled && document.querySelector('#translationDisplayMode').value === 'bilingual');
    assert.ok((await popup.locator('#status').textContent()).includes('刷新网页后重试'));
    assert.equal(await option.evaluate(option => option.disabled), false);
    checks.push('missing content script gives an actionable refresh hint and keeps retry enabled');
    await page.reload(); await page.locator('#wupage-floating-ball').waitFor({ state: 'visible' });
    await mode.selectOption('paragraph');
    await page.waitForFunction(() => document.documentElement.classList.contains('wupage-paragraph-mode'));
    await popup.waitForFunction(() => !document.querySelector('#translationDisplayMode').disabled && document.querySelector('#translationDisplayMode').value === 'paragraph');
    assert.equal(await popup.locator('#status').textContent(), '');
    assert.equal(await mode.getAttribute('title'), null);
    await popup.screenshot({ path: path.join(output, 'enabled.png') });
    checks.push('the same popup successfully retries after page refresh and clears the stale warning');
    const child = page.frames().find(frame => frame.url() === origin + '/child'); assert.ok(child);
    await child.waitForFunction(() => document.documentElement.classList.contains('wupage-paragraph-mode'));
    for (const frame of [page, child]) {
      await page.keyboard.down('Control');
      try { await frame.locator('#paragraph').click(); } finally { await page.keyboard.up('Control'); }
      await frame.locator('#paragraph .wupage-translation').waitFor();
      assert.ok((await frame.locator('#paragraph .wupage-translation').textContent()).includes('译文'));
      await page.keyboard.down('Control');
      try { await frame.locator('#paragraph').click(); } finally { await page.keyboard.up('Control'); }
      await frame.locator('#paragraph .wupage-translation').waitFor({ state: 'detached' });
    }
    assert.equal(calls.length, 2, 'only the two clicked paragraphs are sent');
    await mode.selectOption('bilingual');
    await page.waitForFunction(() => !document.documentElement.classList.contains('wupage-paragraph-mode'));
    await child.waitForFunction(() => !document.documentElement.classList.contains('wupage-paragraph-mode'));
    checks.push('Ctrl-click translates/restores exactly one paragraph in top and embedded documents; exit synchronizes');
  }
  await fs.writeFile(path.join(output, baseline ? 'baseline-report.json' : 'report.json'), JSON.stringify({ ...identity, checks, calls }, null, 2));
  console.log(JSON.stringify({ ...identity, checks, output }, null, 2));
} finally { await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
