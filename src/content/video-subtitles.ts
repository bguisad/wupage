import { PlayerSubtitleController } from "./video-player";
import { playerContainer, queryVideoRoots, videoPlatform } from "../video/platforms";
import { sendRuntimeRequest } from "./runtime";
import { videoPriority } from "../shared/video";

let current: VideoSubtitleManager | undefined;

export function initVideoSubtitles(): void {
  if (current || typeof location === "undefined" || typeof document === "undefined" || !/^https?:$/u.test(location.protocol) || !document.documentElement) return;
  current = new VideoSubtitleManager();
}

export function openVideoSubtitles(): { opened: boolean } {
  initVideoSubtitles(); return { opened: current?.open() ?? false };
}

export class VideoSubtitleManager {
  private players = new Map<HTMLVideoElement, PlayerSubtitleController>();
  private readonly observer: MutationObserver;
  private readonly timer: ReturnType<typeof setInterval>;
  private pending?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private registered = false;
  private resumePlayback = false;
  private readonly pagehide = (event: PageTransitionEvent) => {
    const enabled = [...this.players.values()].filter(player => player.wantsTranslation).map(player => player.video);
    this.dispose();
    if (event.persisted) window.addEventListener("pageshow", () => {
      initVideoSubtitles();
      for (const video of enabled) void current?.players.get(video)?.start();
    }, { once: true });
  };
  private readonly navigate = () => this.schedule();
  private readonly scrolled = () => { if (this.players.size >= 12) this.schedule(); };

  constructor() {
    this.observer = new MutationObserver(records => {
      if (records.some(record => [...record.addedNodes, ...record.removedNodes].some(node => node instanceof Element
        && !node.matches("[data-wupage-video],[data-wupage-video-style]")
        && (node.matches("video,disney-web-player") || !!node.querySelector("video") || !!node.shadowRoot)))) this.schedule();
    });
    this.observer.observe(document.documentElement, { childList: true, subtree: true });
    this.timer = setInterval(() => {
      if (!this.players.size || [...this.players.values()].some(player => !player.connected)) this.refresh();
      this.announce();
    }, 6000);
    window.addEventListener("pagehide", this.pagehide);
    window.addEventListener("pageshow", this.navigate);
    window.addEventListener("popstate", this.navigate);
    window.addEventListener("scroll", this.scrolled, { passive: true });
    window.addEventListener("resize", this.navigate);
    document.addEventListener("yt-navigate-finish", this.navigate);
    document.addEventListener("loadedmetadata", this.navigate, true);
    document.addEventListener("playing", this.navigate, true);
    this.refresh();
  }

  private schedule(): void {
    clearTimeout(this.pending); this.pending = setTimeout(() => this.refresh(), 160);
  }

  refresh(): void {
    if (this.disposed) return;
    this.observer.disconnect();
    const candidates = queryVideoRoots(document, root => this.observer.observe(root, { childList: true, subtree: true }))
      .map(video => ({ video, rect: video.getBoundingClientRect() }))
      .filter(({ video, rect }) => video.title !== "Advertisement" && rect.width >= 160 && rect.height >= 90)
      .map(({ video, rect }) => ({ video, score: this.rank(video, rect) }))
      .sort((a, b) => Number(!!this.players.get(b.video)?.enabled) - Number(!!this.players.get(a.video)?.enabled) || b.score - a.score)
      .slice(0, 12);
    const selected = new Set(candidates.map(({ video }) => video));
    for (const [video, player] of this.players) if (!selected.has(video) || !player.connected) {
      if (player.wantsTranslation) this.resumePlayback = true;
      player.dispose(); this.players.delete(video);
    }
    for (const { video } of candidates) {
      if (this.players.has(video)) continue;
      const platform = videoPlatform();
      const player = new PlayerSubtitleController(video, playerContainer(video, platform), platform, video === candidates[0].video);
      this.players.set(video, player);
      if (this.resumePlayback) { this.resumePlayback = false; void player.start(); }
    }
    this.announce();
  }

  private rank(video: HTMLVideoElement, rect = video.getBoundingClientRect()): number {
    const visible = rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
    return videoPriority(rect.width * rect.height, !video.paused) * (visible ? 1 : .5);
  }

  private primary(): PlayerSubtitleController | undefined {
    return [...this.players.values()].filter(player => player.connected).sort((a, b) =>
      Number(b.enabled) - Number(a.enabled) || this.rank(b.video) - this.rank(a.video))[0];
  }

  private announce(): void {
    const players = [...this.players.values()].filter(player => player.connected);
    if (!players.length && !this.registered) return;
    this.registered = players.length > 0;
    const primary = this.primary();
    const rect = primary?.video.getBoundingClientRect();
    const area = rect ? rect.width * rect.height : 0;
    void sendRuntimeRequest({ type: "VIDEO_FRAME_STATUS", videos: players.length, area: Math.min(area, 1e8), playing: !!primary && !primary.video.paused }).catch(() => undefined);
  }

  open(): boolean {
    this.refresh();
    const player = this.primary(); if (!player) return false;
    player.video.scrollIntoView?.({ block: "nearest", inline: "nearest" }); player.open(); return true;
  }

  dispose(): void {
    if (this.disposed) return; this.disposed = true;
    clearTimeout(this.pending); clearInterval(this.timer); this.observer.disconnect();
    window.removeEventListener("pagehide", this.pagehide); window.removeEventListener("pageshow", this.navigate); window.removeEventListener("popstate", this.navigate);
    window.removeEventListener("scroll", this.scrolled); window.removeEventListener("resize", this.navigate);
    document.removeEventListener("yt-navigate-finish", this.navigate);
    document.removeEventListener("loadedmetadata", this.navigate, true);
    document.removeEventListener("playing", this.navigate, true);
    for (const player of this.players.values()) player.dispose(); this.players.clear();
    this.announce(); if (current === this) current = undefined;
  }
}
