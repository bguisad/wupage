import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startFirefox } from './firefox.mjs';
import { browserTarget } from './browser-target.mjs';

// Both adapters use new profiles and never attach to the user's open browsers.
export async function openExtensionBrowser(root, output, firefox = false) {
  await fs.mkdir(output, { recursive: true });
  if (firefox) {
    const browser = await startFirefox(output, path.join(root, 'dist-firefox'), {
      'browser.download.folderList': 2, 'browser.download.dir': path.resolve(output),
      'browser.download.useDownloadDir': true, 'browser.helperApps.neverAsk.saveToDisk': 'application/pdf',
      'pdfjs.disabled': true
    });
    try {
      const result = await browser.command('WebDriver:GetWindowHandle');
      const control = result.value ?? result;
      const select = handle => browser.command('WebDriver:SwitchToWindow', { handle });
      await browser.command('WebDriver:Navigate', { url: `${browser.base}options.html` });
      const created = await browser.command('WebDriver:NewWindow', { type: 'tab' });
      const page = (created.value ?? created).handle;
      return {
        api: async (source, input = []) => {
          await select(control);
          const result = await browser.executeAsync(`const done=arguments[arguments.length-1],input=JSON.parse(arguments[0]),chrome=window.wrappedJSObject.chrome;
            (async()=>{${source}})().then(value=>done(JSON.stringify({value})),error=>done(JSON.stringify({error:String(error)})));`, [JSON.stringify(input)]);
          const parsed = JSON.parse(result); if (parsed.error) throw new Error(parsed.error); return parsed.value;
        },
        evaluate: async source => { await select(page); return browser.execute(source); },
        navigate: async url => { await select(page); await browser.command('WebDriver:Navigate', { url }); },
        capture: async name => {
          await select(page); const value = await browser.command('WebDriver:TakeScreenshot', { id: null, highlights: [], full: false });
          await fs.writeFile(path.join(output, name), Buffer.from(value.value, 'base64'));
        },
        resize: async (width, height) => {
          await select(page); await browser.command('WebDriver:SetWindowRect', { width, height });
        },
        download: async (source, destination) => {
          const before = new Set(await fs.readdir(output));
          await select(page); await browser.execute(source);
          for (let attempt = 0; attempt < 600; attempt++) {
            const files = await fs.readdir(output);
            const file = files.find(name => !before.has(name) && name.endsWith('.pdf') && !files.includes(name + '.part'));
            if (file) { await fs.copyFile(path.join(output, file), destination); return destination; }
            await new Promise(resolve => setTimeout(resolve, 200));
          }
          throw new Error('Firefox PDF download timed out');
        },
        close: () => browser.close()
      };
    } catch (error) { await browser.close(); throw error; }
  }
  const moduleName = process.env.PLAYWRIGHT_MODULE || 'playwright';
  const { chromium } = await import(path.isAbsolute(moduleName) ? pathToFileURL(moduleName).href : moduleName);
  const browser = await chromium.launchPersistentContext(path.join(output, `profile-${Date.now()}`), {
    ...browserTarget().chromiumOptions,
    headless: true, viewport: { width: 1400, height: 1000 }, ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging']
  });
  try {
    const session = await browser.browser().newBrowserCDPSession();
    await session.send('Extensions.loadUnpacked', { path: path.join(root, 'dist') }); await session.detach();
    const worker = browser.serviceWorkers()[0] || await browser.waitForEvent('serviceworker');
    const control = await browser.newPage(); await control.goto(`chrome-extension://${new URL(worker.url()).host}/options.html`);
    const page = await browser.newPage();
    return {
      api: (source, input = []) => control.evaluate(`(async()=>{const input=${JSON.stringify(input)};${source}})()`),
      evaluate: source => page.evaluate(`(()=>{${source}})()`),
      navigate: url => page.goto(url),
      capture: name => page.screenshot({ path: path.join(output, name) }),
      resize: (width, height) => page.setViewportSize({ width, height }),
      download: async (source, destination) => {
        const pending = page.waitForEvent('download', { timeout: 120000 });
        await page.evaluate(`(()=>{${source}})()`);
        const download = await pending; await download.saveAs(destination); return destination;
      },
      close: () => browser.close()
    };
  } catch (error) { await browser.close(); throw error; }
}
