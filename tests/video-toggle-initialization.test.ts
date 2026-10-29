// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";
import { normalizeVideoTranslation } from "../src/shared/video";
import type { RuntimeRequest, RuntimeResponse } from "../src/shared/types";

afterEach(() => {
  window.dispatchEvent(new Event("pagehide")); vi.unstubAllGlobals(); vi.resetModules(); document.documentElement.replaceChildren();
});

describe("video toggle initialization", () => {
  it.each([true, false])("waits for the saved value %s before displaying a state", async enabled => {
    document.open(); document.write(readFileSync("popup.html", "utf8")); document.close();
    const style = document.createElement("style"); style.textContent = readFileSync("src/popup/styles.css", "utf8"); document.head.append(style);
    let finish!: (value: RuntimeResponse) => void;
    const ready = new Promise<RuntimeResponse>(resolve => { finish = resolve; });
    vi.stubGlobal("chrome", {
      runtime: { sendMessage: async (request: RuntimeRequest) => request.type === "GET_SETTINGS" ? ready
        : request.type === "GET_OCR_STATUS" ? { ok: true, data: { state: "installed", total: 100, downloaded: 100 } } : { ok: true } },
      tabs: { query: async () => [{ id: 1, url: "https://example.com/" }],
        sendMessage: async () => ({ ok: true, data: { enabled: false, translated: false } }) }
    });
    await import("../src/popup/index");
    const toggle = document.querySelector<HTMLButtonElement>("#videoTranslation")!;
    expect(toggle.disabled).toBe(true); expect(getComputedStyle(toggle).visibility).toBe("hidden");
    finish({ ok: true, data: { ...DEFAULT_SETTINGS, videoTranslation: normalizeVideoTranslation({ enabled }) } });
    await vi.waitFor(() => expect(toggle.disabled).toBe(false));
    expect(toggle.getAttribute("aria-pressed")).toBe(String(enabled)); expect(getComputedStyle(toggle).visibility).toBe("visible");
  });
});
