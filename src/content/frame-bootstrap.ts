import type { RuntimeRequest, RuntimeResponse } from "../shared/types";
import type { FrameSessionSnapshot } from "../shared/frame-session";
import { createDocumentKey, frameExclusion } from "../shared/frame-session";
import { sampleDocumentText } from "./frame-sample";
import { initKeyboardShortcuts } from "./keyboard-shortcuts";
import { sendRuntimeRequest } from "./runtime";
import { installFrameVisibilityBridge } from "./frame-visibility";
import { SETTINGS_KEY } from "../shared/defaults";
import type { ExtensionSettings } from "../shared/types";

const scope = globalThis as typeof globalThis & { __wupageFrameBootstrap?: boolean };
const visibility = installFrameVisibilityBridge();
if (window !== window.top && !scope.__wupageFrameBootstrap) {
  scope.__wupageFrameBootstrap = true;
  const documentKey = createDocumentKey();
  let current: FrameSessionSnapshot | undefined;
  let frameId: number | undefined;
  let worker: Promise<ReturnType<typeof import("./frame-content").activateFrameContent>> | undefined;
  let candidateObserver: MutationObserver | undefined;
  let candidateTimer: ReturnType<typeof setTimeout> | undefined;
  let lastSample = "";
  const domReady = document.readyState === "loading" ? new Promise<void>(resolve => document.addEventListener("DOMContentLoaded", () => resolve(), { once: true })) : Promise.resolve();
  const ready = Promise.all([domReady, visibility.ready]);
  const activate = () => worker ??= ready.then(async () => {
    const module = await import(/* @vite-ignore */ chrome.runtime.getURL("frame-content.js"));
    return module.activateFrameContent(documentKey);
  }).catch(error => { worker = undefined; throw error; });
  const supported = () => ["text/html", "application/xhtml+xml"].includes(document.contentType);
  const allowed = (snapshot: FrameSessionSnapshot) => frameId !== undefined
    ? snapshot.frames.find(frame => frame.frameId === frameId)?.status !== "excluded"
    : !frameExclusion(snapshot.settings, snapshot.frames.find(frame => frame.frameId === 0)?.url ?? "", location.href, 1);
  const register = async () => {
    const value = await sendRuntimeRequest<FrameSessionSnapshot>({ type: "FRAME_REGISTER", documentKey, url: location.href });
    current = value;
    frameId = value.selfFrameId;
    configureCandidates();
    if (supported() && allowed(value) && (value.active || value.paragraphMode)) await (await activate()).apply(value);
  };
  // Automatic language detection must also notice an initially empty SPA frame.
  // This bounded local sample runs only when the user enabled automatic translation.
  const scheduleCandidate = () => {
    if (candidateTimer || !current?.settings.autoTranslation?.enabled || current.active) return;
    candidateTimer = setTimeout(() => {
      candidateTimer = undefined;
      const sample = sampleDocumentText();
      if (sample === lastSample) return;
      lastSample = sample; void register().catch(() => {});
    }, 350);
  };
  const configureCandidates = () => {
    if (current?.settings.autoTranslation?.enabled && !current.active && document.body && supported()) {
      candidateObserver ??= new MutationObserver(scheduleCandidate);
      candidateObserver.observe(document.body, { childList: true, subtree: true, characterData: true,
        attributes: true, attributeFilter: ["class", "style", "hidden", "aria-hidden"] });
    } else { candidateObserver?.disconnect(); clearTimeout(candidateTimer); candidateTimer = undefined; }
  };
  document.addEventListener("wupage:frame-visibility", scheduleCandidate);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[SETTINGS_KEY]?.newValue || !current) return;
    current = { ...current, settings: changes[SETTINGS_KEY].newValue as ExtensionSettings };
    configureCandidates();
  });
  chrome.runtime.onMessage.addListener((request: RuntimeRequest, _sender, respond) => {
    if (request.type === "FRAME_SAMPLE") {
      void visibility.ready.then(() => respond({ ok: true, data: supported() ? sampleDocumentText() : "" })); return true;
    }
    if (request.type !== "FRAME_APPLY" || request.documentKey !== documentKey) return;
    current = request.snapshot;
    configureCandidates();
    if (!supported()) { respond({ ok: false, error: "此文档使用专用查看器" }); return; }
    if (!worker && (!request.allowed || (!request.snapshot.active && !request.snapshot.paragraphMode))) {
      respond({ ok: true, data: { active: false, translated: 0, cached: 0, failed: 0, remaining: 0, pending: 0 } }); return;
    }
    void activate().then(runtime => runtime.apply(request.snapshot, request.allowed, request.reuseResults))
      .then(data => respond({ ok: true, data } satisfies RuntimeResponse), error => respond({ ok: false, error: String(error) }));
    return true;
  });
  initKeyboardShortcuts(async command => {
    if (command === "translate-selection") { if (!current || allowed(current)) await (await activate()).selection(); }
    else await sendRuntimeRequest({ type: "FRAME_FORWARD_SHORTCUT", command });
  });
  document.addEventListener("selectionchange", () => {
    if (worker || current?.settings.selectionTranslation?.enabled === false || !window.getSelection()?.toString().trim() || current && !allowed(current)) return;
    void activate().then(() => document.dispatchEvent(new Event("selectionchange"))).catch(() => {});
  });
  window.addEventListener("pageshow", event => { if (event.persisted) void register().catch(() => {}); });
  window.addEventListener("pagehide", () => { void sendRuntimeRequest({ type: "FRAME_LEAVE", documentKey }).catch(() => {}); });
  void ready.then(register).catch(() => {});
}
