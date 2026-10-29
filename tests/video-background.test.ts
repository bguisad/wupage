import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";
import { getSettings } from "../src/shared/settings";
import { translateWithSettings } from "../src/background/translation";
import { cancelVideo, clearVideoTab, openVideoInTab, registerVideoFrame, translateVideo } from "../src/background/video";
vi.mock("../src/shared/settings", () => ({ getSettings: vi.fn() }));
vi.mock("../src/background/translation", () => ({ translateWithSettings: vi.fn() }));
const sender = { tab: { id: 4 }, frameId: 0 } as chrome.runtime.MessageSender;
const request = { type: "TRANSLATE_VIDEO_SUBTITLES", sessionId: "session", requestId: "one", texts: ["Hello"], targetLang: "zh-CN" } as const;
beforeEach(() => { vi.mocked(getSettings).mockResolvedValue(DEFAULT_SETTINGS); vi.stubGlobal("chrome", { tabs: { sendMessage: vi.fn(async () => ({ ok: true, data: { opened: true } })) } }); });
afterEach(() => { clearVideoTab(4); vi.clearAllMocks(); vi.unstubAllGlobals(); });
describe("video frame routing and cancellation", () => {
  it("opens the playing embedded video instead of an unrelated top-frame player", async () => {
    registerVideoFrame({ type: "VIDEO_FRAME_STATUS", videos: 1, area: 1000, playing: false }, sender);
    registerVideoFrame({ type: "VIDEO_FRAME_STATUS", videos: 1, area: 700, playing: true }, { ...sender, frameId: 3 });
    await expect(openVideoInTab(4)).resolves.toEqual({ opened: true });
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(4, { type: "OPEN_VIDEO_SUBTITLES" }, { frameId: 3 });
  });
  it("cancellation is restricted to the originating tab, frame and session", async () => {
    let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
    vi.mocked(translateWithSettings).mockImplementation((_settings, _request, options) => new Promise((_resolve, reject) => {
      options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason)); started();
    }));
    const task = translateVideo({ ...request, texts: ["Hello"] }, sender);
    const result = expect(task).rejects.toMatchObject({ name: "AbortError" }); await ready;
    const signal = vi.mocked(translateWithSettings).mock.calls[0][2]!.signal!;
    cancelVideo({ type: "CANCEL_VIDEO_SUBTITLES", sessionId: "session" }, { ...sender, frameId: 1 }); expect(signal.aborted).toBe(false);
    cancelVideo({ type: "CANCEL_VIDEO_SUBTITLES", sessionId: "another" }, sender); expect(signal.aborted).toBe(false);
    cancelVideo({ type: "CANCEL_VIDEO_SUBTITLES", sessionId: "session" }, sender); await result;
  });
  it("prefers the main paused video over a much smaller autoplay frame", async () => {
    registerVideoFrame({ type: "VIDEO_FRAME_STATUS", videos: 1, area: 360000, playing: false }, sender);
    registerVideoFrame({ type: "VIDEO_FRAME_STATUS", videos: 1, area: 40000, playing: true }, { ...sender, frameId: 3 });
    await openVideoInTab(4);
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(4, { type: "OPEN_VIDEO_SUBTITLES" }, { frameId: 0 });
  });
  it("uses the shared provider limiter with priority and session-only caching", async () => {
    vi.mocked(translateWithSettings).mockResolvedValue({ translations: ["你好"], cached: 0 });
    await translateVideo({ ...request, texts: ["Hello"] }, sender);
    expect(translateWithSettings).toHaveBeenCalledWith(DEFAULT_SETTINGS, expect.objectContaining({ texts: ["Hello"] }),
      expect.objectContaining({ priority: true, persistentCache: false, signal: expect.any(AbortSignal) }));
  });
  it("rejects arbitrary/oversized subtitle jobs and extension-page callers", async () => {
    await expect(translateVideo({ ...request, texts: ["x".repeat(4001)] }, sender)).rejects.toThrow("格式无效");
    await expect(translateVideo({ ...request, texts: ["Hello"] }, { frameId: 0 })).rejects.toThrow("视频页面");
    expect(translateWithSettings).not.toHaveBeenCalled();
  });
});
