import { installFrameRuntime } from "./frame-runtime";
import { injectContentStyles } from "./styles";
import { initSelectionTranslation } from "./selection-translation";
import { translateShortcutParagraphs } from "./paragraph-shortcut";
import { findTranslatableParagraph } from "./dom";
import { translateParagraph } from "./paragraph-translation";
import { sendRuntimeRequest } from "./runtime";
import type { ExtensionSettings } from "../shared/types";
import { setupAppearance } from "../shared/appearance-runtime";
import { SETTINGS_KEY } from "../shared/defaults";

export function activateFrameContent(documentKey: string) {
  injectContentStyles();
  initSelectionTranslation();
  const appearance = setupAppearance(undefined, { extensionPage: false });
  void sendRuntimeRequest<ExtensionSettings>({ type: "GET_SETTINGS" }).then(settings => appearance.update(settings.appearance)).catch(() => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[SETTINGS_KEY]?.newValue) appearance.update((changes[SETTINGS_KEY].newValue as ExtensionSettings).appearance);
  });
  let paragraph = false;
  let pending = false;
  document.addEventListener("click", event => {
    if (!paragraph || !event.ctrlKey || event.button !== 0 || event.defaultPrevented || pending) return;
    const element = event.composedPath().find(node => node instanceof Element) as Element | undefined;
    if (element?.closest("input,textarea,select,[contenteditable]:not([contenteditable='false'])")) return;
    const target = findTranslatableParagraph(element ?? null);
    if (!target) return;
    event.preventDefault(); event.stopPropagation(); pending = true;
    void translateParagraph(target)
      .catch(() => {}).finally(() => { pending = false; });
  }, true);
  const setParagraph = (enabled: boolean) => {
    paragraph = enabled; document.documentElement.classList.toggle("wupage-paragraph-mode", enabled);
  };
  const runtime = installFrameRuntime(documentKey, { top: false });
  return { ...runtime, paragraph: setParagraph, selection: translateShortcutParagraphs };
}
