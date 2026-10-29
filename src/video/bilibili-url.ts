// The public web player encodes subtitle CDN paths in web/view metadata.
// Keep this conversion separate from the host/path allowlist used before fetching.
// Reference: https://s1.hdslb.com/bfs/static/player/main/core.9c6ca999.js
const PATH_KEYS = [
  ['nP](wOFRvU.+<fjS{jn-!$D|Dz&",zT`', '=CFxYRn{.y|uVyO$uh&sikph?N.ilF/`'],
  ['Bn"q~|albg@]Go~ACgyDvKnd+)_D}^&J?', "Cu~L!xs~f^&r@'vh=q]q{eeng*sEg^kp#J"]
] as const;

export function bilibiliSubtitleUrl(value: string): string | undefined {
  if (value.length > 8192) return;
  if (!/^(?:https:)?\/\/subtitle\.bilibili\.com\//u.test(value)) return value;
  const match = /^(?:https:)?\/\/subtitle\.bilibili\.com\/([^?#]+)(\?[^#]*)?$/u.exec(value);
  if (!match) return;
  let encoded: string;
  try { encoded = decodeURIComponent(match[1]); } catch { return; }
  for (const [prefix, salt] of PATH_KEYS) {
    const key = `${salt}bilibili`;
    let decoded = '';
    for (let index = 0; index < encoded.length; index++) decoded += String.fromCharCode(encoded.charCodeAt(index) ^ key.charCodeAt(index % key.length));
    if (!decoded.startsWith(prefix)) continue;
    const path = decoded.slice(prefix.length);
    if (!/^\/bfs\/(?:ai_)?subtitle\/[^?#\\\x00-\x20]+\.json$/u.test(path)) return;
    return `https://aisubtitle.hdslb.com${path}${match[2] ?? ''}`;
  }
}
