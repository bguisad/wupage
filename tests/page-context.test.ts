import { afterEach, expect, it, vi } from "vitest";
import { sendRuntimeRequest } from "../src/content/runtime";
vi.mock("../src/content/runtime", () => ({ sendRuntimeRequest: vi.fn(async () => undefined) }));
afterEach(() => { vi.clearAllMocks(); vi.resetModules(); });

it("reports entering and leaving translation without flooding the worker for progress updates", async () => {
  const { refreshPageContextState } = await import("../src/content/page-context");
  for (const translated of [false, false, true, true, true, false]) refreshPageContextState(translated);
  expect(sendRuntimeRequest).toHaveBeenCalledTimes(3);
  expect(sendRuntimeRequest).toHaveBeenCalledWith({ type: "PAGE_TRANSLATION_STATE_CHANGED" });
});

it("tolerates an invalidated extension context", async () => {
  vi.mocked(sendRuntimeRequest).mockRejectedValueOnce(new Error("Extension context invalidated"));
  const { refreshPageContextState } = await import("../src/content/page-context");
  expect(() => refreshPageContextState(true)).not.toThrow();
  await new Promise(resolve => setTimeout(resolve, 0));
});
