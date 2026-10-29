// Keep browser identity and artifacts explicit when running the same MV3
// regression against Chrome and Edge. Every run still gets its own profile.
export function browserTarget() {
  const firefox = process.argv.includes('--firefox');
  const edge = process.argv.includes('--edge');
  if (firefox && edge) throw new Error('Choose either --firefox or --edge.');
  const kind = firefox ? 'firefox' : edge ? 'edge' : 'chrome';
  const executablePath = edge ? process.env.EDGE_TEST_BROWSER : process.env.CHROME_TEST_BROWSER;
  return {
    kind,
    label: { firefox: 'Firefox', edge: 'Edge', chrome: 'Chrome' }[kind],
    chromiumOptions: executablePath ? { executablePath } : { channel: edge ? 'msedge' : 'chromium' }
  };
}

export function verifyBrowserIdentity(target, userAgent) {
  if (target.kind === 'edge' && !/\bEdg\//u.test(userAgent)) {
    throw new Error(`Expected Microsoft Edge; got ${userAgent}`);
  }
  return { browser: target.label, userAgent };
}
