import { sendRuntimeRequest } from "./runtime";

let lastTranslated: boolean | undefined;

/** Keep the browser menu in sync without sending a message for each batch. */
export function refreshPageContextState(translated: boolean): void {
  if (translated === lastTranslated) return;
  lastTranslated = translated;
  void sendRuntimeRequest({ type: "PAGE_TRANSLATION_STATE_CHANGED" }).catch(() => undefined);
}
