// Keep this preference separate from settings forms and per-tab page sessions.
// Saving an older settings form must not undo a mode change in another tab.
export const PARAGRAPH_MODE_KEY = "wupage.paragraph-mode";

export async function readParagraphMode(storage = chrome.storage): Promise<boolean> {
  const stored = await storage?.local?.get(PARAGRAPH_MODE_KEY);
  return stored?.[PARAGRAPH_MODE_KEY] === true;
}

export function observeParagraphMode(update: (enabled: boolean) => void): () => void {
  const storage = chrome.storage;
  let revision = 0;
  let disposed = false;
  const refresh = () => {
    const started = ++revision;
    void readParagraphMode(storage).then(enabled => {
      if (!disposed && started === revision) update(enabled);
    }).catch(() => {});
  };
  const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (disposed || area !== "local" || !(PARAGRAPH_MODE_KEY in changes)) return;
    revision++;
    update(changes[PARAGRAPH_MODE_KEY].newValue === true);
  };
  storage?.onChanged?.addListener(changed);
  if (typeof window !== "undefined") window.addEventListener("pageshow", refresh);
  refresh();
  return () => {
    disposed = true;
    storage?.onChanged?.removeListener?.(changed);
    if (typeof window !== "undefined") window.removeEventListener("pageshow", refresh);
  };
}
