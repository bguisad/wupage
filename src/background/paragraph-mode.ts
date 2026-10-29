import { PARAGRAPH_MODE_KEY } from "../shared/paragraph-mode";

let writes: Promise<unknown> = Promise.resolve();

/** Serialize changes from different tabs so the last accepted action wins. */
export function saveParagraphMode(enabled: boolean): Promise<{ enabled: boolean }> {
  const write = writes.catch(() => {}).then(async () => {
    await chrome.storage.local.set({ [PARAGRAPH_MODE_KEY]: enabled });
    return { enabled };
  });
  writes = write;
  return write;
}
