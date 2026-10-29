// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { observeParagraphMode, PARAGRAPH_MODE_KEY, readParagraphMode } from "../src/shared/paragraph-mode";

const disposals: Array<() => void> = [];
afterEach(() => { disposals.splice(0).forEach(dispose => dispose()); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.resetModules(); });

function fixture(initial = false) {
  const stored: Record<string, unknown> = { [PARAGRAPH_MODE_KEY]: initial, "wupage.settings": { targetLang: "zh-CN" } };
  const listeners = new Set<(changes: Record<string, chrome.storage.StorageChange>, area: string) => void>();
  const emit = (changes: Record<string, chrome.storage.StorageChange>, area = "local") => {
    for (const listener of listeners) listener(changes, area);
  };
  const write = async (values: Record<string, unknown>) => {
    const changes = Object.fromEntries(Object.entries(values).map(([key, newValue]) => [key, { oldValue: stored[key], newValue }]));
    Object.assign(stored, values); emit(changes);
  };
  const local = { get: vi.fn(async (key: string) => ({ [key]: stored[key] })), set: vi.fn(write) };
  vi.stubGlobal("chrome", { storage: { local, onChanged: {
    addListener: (listener: Parameters<typeof listeners.add>[0]) => listeners.add(listener),
    removeListener: (listener: Parameters<typeof listeners.add>[0]) => listeners.delete(listener)
  } } });
  const observe = () => {
    const update = vi.fn(); disposals.push(observeParagraphMode(update)); return update;
  };
  return { stored, local, emit, write, observe, listeners };
}

describe("global paragraph mode", () => {
  it("updates existing subscribers and restores the shared mode for a new document", async () => {
    const f = fixture(), first = f.observe(), second = f.observe();
    await vi.waitFor(() => expect(first).toHaveBeenLastCalledWith(false));
    const { saveParagraphMode } = await import("../src/background/paragraph-mode");
    await saveParagraphMode(true);
    expect(first).toHaveBeenLastCalledWith(true); expect(second).toHaveBeenLastCalledWith(true);
    const newlyOpened = f.observe();
    await vi.waitFor(() => expect(newlyOpened).toHaveBeenLastCalledWith(true));
    expect(await readParagraphMode()).toBe(true);
    await saveParagraphMode(false);
    for (const update of [first, second, newlyOpened]) expect(update).toHaveBeenLastCalledWith(false);
    expect(f.stored["wupage.settings"]).toEqual({ targetLang: "zh-CN" });
  });

  it("does not overwrite a storage change with a delayed initial read", async () => {
    const f = fixture(); let finish!: (value: Record<string, unknown>) => void;
    f.local.get.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const update = f.observe();
    await f.write({ [PARAGRAPH_MODE_KEY]: true });
    finish({ [PARAGRAPH_MODE_KEY]: false }); await Promise.resolve(); await Promise.resolve();
    expect(update.mock.calls).toEqual([[true]]);
  });

  it("ignores settings saves and other storage areas, and handles clearing the preference", async () => {
    const f = fixture(true), update = f.observe();
    await vi.waitFor(() => expect(update).toHaveBeenLastCalledWith(true));
    update.mockClear();
    f.emit({ "wupage.settings": { newValue: {} } });
    f.emit({ [PARAGRAPH_MODE_KEY]: { newValue: false } }, "session");
    expect(update).not.toHaveBeenCalled();
    f.emit({ [PARAGRAPH_MODE_KEY]: { oldValue: true } });
    expect(update).toHaveBeenLastCalledWith(false);
  });

  it("keeps the latest refresh when a document is restored before its first read finishes", async () => {
    const f = fixture(); let finish!: (value: Record<string, unknown>) => void;
    f.local.get.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const update = f.observe();
    f.stored[PARAGRAPH_MODE_KEY] = true;
    window.dispatchEvent(new Event("pageshow"));
    await vi.waitFor(() => expect(update).toHaveBeenLastCalledWith(true));
    finish({ [PARAGRAPH_MODE_KEY]: false }); await Promise.resolve(); await Promise.resolve();
    expect(update.mock.calls).toEqual([[true]]);
  });

  it("serializes changes from different tabs instead of completing an older write last", async () => {
    const f = fixture(); let release!: () => void;
    f.local.set.mockImplementationOnce(async values => {
      await new Promise<void>(resolve => { release = resolve; }); await f.write(values);
    });
    const { saveParagraphMode } = await import("../src/background/paragraph-mode");
    const first = saveParagraphMode(true), second = saveParagraphMode(false);
    await vi.waitFor(() => expect(f.local.set).toHaveBeenCalledTimes(1));
    release(); await Promise.all([first, second]);
    expect(await readParagraphMode()).toBe(false);
    expect(f.local.set.mock.calls.map(([value]) => value[PARAGRAPH_MODE_KEY])).toEqual([true, false]);
  });

  it("reports a failed save without changing other tabs and allows a later retry", async () => {
    const f = fixture(), update = f.observe();
    await vi.waitFor(() => expect(update).toHaveBeenLastCalledWith(false)); update.mockClear();
    f.local.set.mockRejectedValueOnce(new Error("storage unavailable"));
    const { saveParagraphMode } = await import("../src/background/paragraph-mode");
    await expect(saveParagraphMode(true)).rejects.toThrow("storage unavailable");
    expect(await readParagraphMode()).toBe(false); expect(update).not.toHaveBeenCalled();
    await saveParagraphMode(true); expect(update).toHaveBeenLastCalledWith(true);
  });

  it("refreshes a restored document and stops listening after disposal", async () => {
    const f = fixture(), update = f.observe();
    await vi.waitFor(() => expect(update).toHaveBeenLastCalledWith(false));
    f.stored[PARAGRAPH_MODE_KEY] = true;
    window.dispatchEvent(new Event("pageshow"));
    await vi.waitFor(() => expect(update).toHaveBeenLastCalledWith(true));
    disposals.pop()!(); update.mockClear();
    await f.write({ [PARAGRAPH_MODE_KEY]: false }); window.dispatchEvent(new Event("pageshow"));
    await Promise.resolve(); expect(update).not.toHaveBeenCalled(); expect(f.listeners.size).toBe(0);
  });
});
