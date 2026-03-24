interface ElectrobunWebviewElement extends HTMLElement {
  executeJavascript: (js: string) => void;
  loadURL?: (url: string) => void;
  on: (event: string, listener: (event: CustomEvent) => void) => void;
}

declare global {
  interface HTMLElementTagNameMap {
    "electrobun-webview": ElectrobunWebviewElement;
  }

  interface Window {
    __appHideRecommendationsObserverInstalled?: boolean;
    __appStateEmitterInstalled?: boolean;
    __appStateEmitterInterval?: number;
  }
}

export type PlayerPlaybackState = "loading" | "playing" | "paused" | "ended" | "buffering";

export type PlayerSnapshot = {
  playbackState: PlayerPlaybackState;
  currentTime: number;
  duration: number;
  videoId: string;
  isReady: boolean;
};

type PlayerStateListener = (snapshot: PlayerSnapshot) => void;

const HIDE_AND_STATE_SCRIPT = `
(() => {
  const STYLE_ID = "app-hide-recommendations";
  const CSS = \`
    .ytmCreatorEndscreenHost,
    .ytmCreatorEndscreenScrim,
    .ytmCreatorEndscreenElement,
    .ytmExpandingEndscreenElementHost,
    .ytmExpandingEndscreenElementOverlay,
    .ytmThumbnailEndscreenElementHost,
    .ytp-endscreen-content,
    .ytp-ce-element,
    .ytp-pause-overlay,
    .html5-endscreen,
    .ytp-show-tiles,
    .ytp-videowall-still,
    .ytp-suggestion-set,
    .fullscreen-action-menu,
    .fullscreen-recommendations-wrapper,
    .fullscreen-recommendation,
    .fullscreen-watch-next-entrypoint-wrapper,
    .watch-on-youtube-button-wrapper,
    .ytmFullscreenRelatedVideosEntryPointViewModelHost,
    .ytmFullscreenRelatedVideosEntryPointViewModelButton {
      display: none !important;
      opacity: 0 !important;
      visibility: hidden !important;
      pointer-events: none !important;
    }
  \`;

  const ensureStyle = () => {
    let style = document.getElementById(STYLE_ID);
    if (!style) {
      style = document.createElement("style");
      style.id = STYLE_ID;
      document.documentElement.appendChild(style);
    }
    if (style.textContent !== CSS) {
      style.textContent = CSS;
    }
  };

  const getPlaybackState = (player) => {
    const raw = player?.getPlayerState?.();
    switch (raw) {
      case 0: return "ended";
      case 1: return "playing";
      case 2: return "paused";
      case 3: return "buffering";
      default: return "loading";
    }
  };

  const emitSnapshot = () => {
    ensureStyle();
    const player = window.movie_player;
    if (!player || typeof player.getPlayerState !== "function") {
      window.__electrobunSendToHost?.({
        type: "player-snapshot",
        playbackState: "loading",
        currentTime: 0,
        duration: 0,
        isReady: false,
        videoId: ""
      });
      return;
    }

    const data = typeof player.getVideoData === "function" ? player.getVideoData() : null;
    window.__electrobunSendToHost?.({
      type: "player-snapshot",
      playbackState: getPlaybackState(player),
      currentTime: typeof player.getCurrentTime === "function" ? player.getCurrentTime() : 0,
      duration: typeof player.getDuration === "function" ? player.getDuration() : 0,
      isReady: true,
      videoId: data?.video_id || ""
    });
  };

  ensureStyle();

  if (!window.__appHideRecommendationsObserverInstalled) {
    const observer = new MutationObserver(() => ensureStyle());
    observer.observe(document.documentElement, { childList: true, subtree: true });
    window.__appHideRecommendationsObserverInstalled = true;
  }

  if (window.__appStateEmitterInterval) {
    window.clearInterval(window.__appStateEmitterInterval);
  }

  window.__appStateEmitterInterval = window.setInterval(emitSnapshot, 400);
  emitSnapshot();
})();
`;

function parseHostMessage(detail: unknown): Partial<PlayerSnapshot> & { type?: string } | null {
  if (typeof detail === "string") {
    try {
      return JSON.parse(detail) as Partial<PlayerSnapshot> & { type?: string };
    } catch {
      return null;
    }
  }

  if (typeof detail === "object" && detail !== null) {
    return detail as Partial<PlayerSnapshot> & { type?: string };
  }

  return null;
}

export class SafeYouTubePlayer {
  readonly element: HTMLElement;

  private readonly webview: ElectrobunWebviewElement;
  private readonly listeners = new Set<PlayerStateListener>();
  private injectTimer: number | null = null;
  private snapshot: PlayerSnapshot;
  private videoId: string;
  private readonly proxyOrigin: string;

  constructor(videoId: string, proxyOrigin: string) {
    this.videoId = videoId;
    this.proxyOrigin = proxyOrigin;
    this.snapshot = {
      playbackState: "loading",
      currentTime: 0,
      duration: 0,
      videoId,
      isReady: false
    };

    this.element = document.createElement("div");
    this.element.className = "player-surface";

    this.webview = document.createElement("electrobun-webview");
    this.webview.className = "video-webview";
    this.element.appendChild(this.webview);

    const inject = () => {
      this.webview.executeJavascript(HIDE_AND_STATE_SCRIPT);
    };

    this.webview.on("dom-ready", inject);
    this.webview.on("did-navigate", inject);
    this.webview.on("load-finished", inject);
    this.webview.on("host-message", (event) => {
      const payload = parseHostMessage(event.detail);
      if (!payload || payload.type !== "player-snapshot") {
        return;
      }

      this.snapshot = {
        playbackState: (payload.playbackState as PlayerPlaybackState | undefined) ?? "loading",
        currentTime: typeof payload.currentTime === "number" ? payload.currentTime : 0,
        duration: typeof payload.duration === "number" ? payload.duration : 0,
        videoId: typeof payload.videoId === "string" && payload.videoId ? payload.videoId : this.videoId,
        isReady: Boolean(payload.isReady)
      };

      this.emitSnapshot();
    });

    this.injectTimer = window.setInterval(inject, 750);
    this.loadVideo(videoId);
  }

  dispose(): void {
    if (this.injectTimer !== null) {
      window.clearInterval(this.injectTimer);
      this.injectTimer = null;
    }
    this.element.remove();
  }

  loadVideo(videoId: string): void {
    this.videoId = videoId;
    this.snapshot = {
      playbackState: "loading",
      currentTime: 0,
      duration: 0,
      videoId,
      isReady: false
    };

    const url = `${this.proxyOrigin}/youtube/${videoId}`;
    this.webview.setAttribute("src", url);
    this.webview.loadURL?.(url);
    this.emitSnapshot();
  }

  onStateChange(listener: PlayerStateListener): void {
    this.listeners.add(listener);
    listener(this.snapshot);
  }

  getSnapshot(): PlayerSnapshot {
    return this.snapshot;
  }

  togglePlayback(): void {
    this.webview.executeJavascript(`
      (() => {
        const player = window.movie_player;
        if (!player || typeof player.getPlayerState !== "function") return;
        const state = player.getPlayerState();
        if (state === 1 || state === 3) {
          player.pauseVideo?.();
        } else {
          player.playVideo?.();
        }
      })();
    `);
  }

  replay(): void {
    this.webview.executeJavascript(`
      (() => {
        const player = window.movie_player;
        if (!player) return;
        player.seekTo?.(0, true);
        player.playVideo?.();
      })();
    `);
  }

  private emitSnapshot(): void {
    for (const listener of this.listeners) {
      listener(this.snapshot);
    }
  }
}
