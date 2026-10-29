import { queryVideoRoots } from "../video/platforms";

// Video controls remain independent of whole-page/paragraph translation. A
// video-only module keeps text-only iframes on the lightweight bootstrap.
export function initEmbeddedVideoSubtitles(): void {
  let loading: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const observer = new MutationObserver(() => schedule());
  const discover = () => {
    if (loading) return;
    observer.disconnect();
    if (!queryVideoRoots(document, root => observer.observe(root, { childList: true, subtree: true })).length) return;
    loading = import(/* @vite-ignore */ chrome.runtime.getURL("video-content.js")).then(module => {
      module.initVideoSubtitles();
      chrome.runtime.onMessage.addListener((request, _sender, respond) => {
        if (request.type !== "OPEN_VIDEO_SUBTITLES") return;
        void module.openVideoSubtitles().then((data: { opened: boolean }) => respond({ ok: true, data }),
          (error: unknown) => respond({ ok: false, error: String(error) }));
        return true;
      });
      observer.disconnect(); clearInterval(interval); clearTimeout(timer);
      document.removeEventListener("loadedmetadata", schedule, true);
      document.removeEventListener("playing", schedule, true);
    }).catch(() => { loading = undefined; });
  };
  const schedule = () => {
    if (loading || timer) return;
    timer = setTimeout(() => { timer = undefined; discover(); }, 160);
  };
  // Attaching a shadow root to an existing host does not mutate the light DOM.
  const interval = setInterval(discover, 1000);
  document.addEventListener("loadedmetadata", schedule, true);
  document.addEventListener("playing", schedule, true);
  window.addEventListener("pagehide", event => {
    observer.disconnect(); clearInterval(interval); clearTimeout(timer);
    document.removeEventListener("loadedmetadata", schedule, true);
    document.removeEventListener("playing", schedule, true);
    if (event.persisted && !loading) window.addEventListener("pageshow", () => initEmbeddedVideoSubtitles(), { once: true });
  }, { once: true });
  discover();
}
