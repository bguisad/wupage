import { expect, it } from 'vitest';
import { bilibiliSubtitleUrl } from '../src/video/bilibili-url';

// Public web/view response captured without its temporary authorization query.
const encoded = '//subtitle.bilibili.com/%01%1B%5C=_%04%12%12%049f%2F%07H%08%29~%16$5%0D.%0B%0AL%03%2C%01%1A%00M:%1Ce%00%0F%1FF%11%1C%0E%1D%2A%01%12%29%0E%1E%10%1A%5E%3C%10%11%25F%10Q%5CAkB%1EPW%5B_%1CFrPk_D%17x%07%0D%09%5BW%5E%09%0CqL%18bK%0B%1C%10';
const decoded = 'https://aisubtitle.hdslb.com/bfs/subtitle/fcd8b6ceaf9a063e5258657754442ede257ee29f.json';

it('converts the current player metadata path before URL normalization and preserves the signed query', () => {
  expect(bilibiliSubtitleUrl(encoded + '?auth_key=fixture%2Bvalue&x=1')).toBe(decoded + '?auth_key=fixture%2Bvalue&x=1');
  expect(bilibiliSubtitleUrl('https:' + encoded)).toBe(decoded);
});

it('leaves direct CDN paths unchanged and rejects unknown or malformed encoded paths', () => {
  expect(bilibiliSubtitleUrl(decoded + '?auth_key=fixture')).toBe(decoded + '?auth_key=fixture');
  expect(bilibiliSubtitleUrl('//subtitle.bilibili.com/%ZZ')).toBeUndefined();
  expect(bilibiliSubtitleUrl('//subtitle.bilibili.com/unrecognized')).toBeUndefined();
  expect(bilibiliSubtitleUrl(encoded + '#fragment')).toBeUndefined();
  expect(bilibiliSubtitleUrl('x'.repeat(8193))).toBeUndefined();
});
