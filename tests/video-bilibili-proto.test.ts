import { describe, expect, it } from "vitest";
import { bilibiliProtoTracks } from "../src/video/bilibili-proto";

const varint = (value: number): number[] => { const bytes = []; do { bytes.push((value & 127) | (value > 127 ? 128 : 0)); value = Math.floor(value / 128); } while (value); return bytes; };
const field = (id: number, content: number[] | string): number[] => { const bytes = typeof content === "string" ? [...new TextEncoder().encode(content)] : content; return [...varint(id * 8 + 2), ...varint(bytes.length), ...bytes]; };
describe("current Bilibili subtitle track protocol", () => {
  it("extracts bounded subtitle metadata without forwarding unrelated user/author fields", () => {
    const track = [...field(2, "42"), ...field(3, "en-US"), ...field(4, "English"), ...field(5, "//subtitle.bilibili.com/example"), ...field(6, "Unrelated author metadata")];
    const payload = new Uint8Array(field(1, field(3, track)));
    expect(bilibiliProtoTracks(payload)).toEqual([{ id_str: "42", lan: "en-US", lan_doc: "English", subtitle_url: "//subtitle.bilibili.com/example" }]);
  });
  it("rejects truncated buffers and ignores malformed track records", () => {
    expect(() => bilibiliProtoTracks(new Uint8Array([10, 120, 1]))).toThrow();
    expect(bilibiliProtoTracks(new Uint8Array(field(1, field(3, field(5, "file:///private")))))).toEqual([]);
  });
});
