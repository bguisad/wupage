import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installPdfFont, PDF_FONT_CACHE, readPdfFont, removePdfFont } from "../src/pdf/font-store";

vi.mock("../public/pdf-fonts/font-metadata.json", () => ({ default: { font: {
  source: "https://fonts.example/font.otf", bytes: 3,
  sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
} } }));
let entries: Map<string, Response>;
beforeEach(() => {
  entries = new Map();
  vi.stubGlobal("caches", {
    has: async () => entries.size > 0,
    delete: async () => { entries.clear(); return true; },
    open: async () => ({
      match: async (key: string) => entries.get(key)?.clone(),
      put: async (key: string, value: Response) => { entries.set(key, value.clone()); },
      delete: async (key: string) => entries.delete(key)
    })
  });
  vi.stubGlobal("navigator", { locks: { request: async (_name: string, options: unknown, task?: () => unknown) => {
    return task ? task() : (options as () => unknown)();
  } } });
  vi.stubGlobal("fetch", vi.fn(async () => new Response("abc")));
});
afterEach(() => vi.unstubAllGlobals());

describe("optional PDF export font storage", () => {
  it("does not download on lookup, and reuses verified cached data offline", async () => {
    expect(await readPdfFont()).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
    const progress = vi.fn();
    await installPdfFont(new AbortController().signal, progress);
    expect(progress).toHaveBeenLastCalledWith(3);
    expect(fetch).toHaveBeenCalledWith("https://fonts.example/font.otf", expect.objectContaining({ credentials: "omit", cache: "no-store" }));
    vi.mocked(fetch).mockRejectedValue(new Error("offline"));
    expect(new TextDecoder().decode(await readPdfFont())).toBe("abc");
    expect(new TextDecoder().decode(await installPdfFont(new AbortController().signal, vi.fn()))).toBe("abc");
    expect(fetch).toHaveBeenCalledTimes(1);
    await removePdfFont();
    expect(await readPdfFont()).toBeUndefined();
    expect(entries.size).toBe(0);
  });
  it.each(["ab", "abd", "abcdef"])("rejects incomplete, corrupted or oversized data: %s", async (body) => {
    vi.mocked(fetch).mockResolvedValue(new Response(body));
    await expect(installPdfFont(new AbortController().signal, vi.fn())).rejects.toThrow();
    expect(entries.size).toBe(0);
  });
  it("discards corrupted cached data instead of passing it to the PDF renderer", async () => {
    await installPdfFont(new AbortController().signal, vi.fn());
    entries.set([...entries.keys()][0], new Response("abd"));
    expect(await readPdfFont()).toBeUndefined();
    expect(entries.size).toBe(0);
  });
  it("leaves no installed font after cancellation or HTTP failure", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(installPdfFont(controller.signal, vi.fn())).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    vi.mocked(fetch).mockResolvedValue(new Response("", { status: 503 }));
    await expect(installPdfFont(new AbortController().signal, vi.fn())).rejects.toThrow("503");
    expect(await readPdfFont()).toBeUndefined();
    expect(PDF_FONT_CACHE).toContain("pdf-export-fonts");
  });
});
