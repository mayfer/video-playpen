import type { PlayerPlaybackState, PlayerSnapshot } from "./player";

type DownloadState = "missing" | "downloading" | "ready" | "error" | "cancelled";

type DownloadStatus = {
  videoId: string;
  state: DownloadState;
  mediaUrl: string | null;
  title: string | null;
  durationSeconds: number | null;
  fileSizeBytes: number | null;
  totalSizeBytes: number | null;
  progressPercent: number | null;
  isPartial: boolean;
  error: string | null;
};

type PlayerStateListener = (snapshot: PlayerSnapshot) => void;

type VideoControlIcon =
  | "play"
  | "pause"
  | "replay"
  | "skip-back-10"
  | "skip-forward-10"
  | "fullscreen-enter"
  | "fullscreen-exit";

type FullscreenDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
};

type FullscreenElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
};

const SEEK_STEP_SECONDS = 10;
const SVG_NS = "http://www.w3.org/2000/svg";

function getVideoThumbnail(videoId: string): string {
  return `https://i.ytimg.com/vi_webp/${videoId}/hqdefault.webp`;
}

function createElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) {
    element.className = className;
  }
  if (text !== undefined) {
    element.textContent = text;
  }
  return element;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }

  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${bytes} B`;
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "0:00";
  }

  const totalSeconds = Math.floor(seconds);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }

  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

function getIconMarkup(icon: VideoControlIcon): string {
  switch (icon) {
    case "play":
      return `<path d="M9 6.2 18 12 9 17.8Z" fill="currentColor" />`;
    case "pause":
      return `
        <rect x="8.15" y="6.35" width="3.1" height="11.3" rx="0.85" fill="currentColor" />
        <rect x="12.75" y="6.35" width="3.1" height="11.3" rx="0.85" fill="currentColor" />
      `;
    case "replay":
      return `
        <path d="M8.15 6.75H5.25V3.85" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.85" />
        <path d="M5.65 6.75a7 7 0 1 1-1.05 6.35" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.85" />
        <path d="M10.15 8.7 15.35 12l-5.2 3.3Z" fill="currentColor" />
      `;
    case "skip-back-10":
      return `
        <path d="M9.1 5.25 5.85 8.5l3.25 3.25" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.75" />
        <path d="M6.15 8.5a6.9 6.9 0 1 1-1.04 5.95" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.75" />
        <text x="12" y="14.25" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="5.65" font-weight="700" fill="currentColor">10</text>
      `;
    case "skip-forward-10":
      return `
        <path d="M14.9 5.25 18.15 8.5l-3.25 3.25" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.75" />
        <path d="M17.85 8.5a6.9 6.9 0 1 0 1.04 5.95" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.75" />
        <text x="12" y="14.25" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="5.65" font-weight="700" fill="currentColor">10</text>
      `;
    case "fullscreen-enter":
      return `
        <path d="M8.2 4.9h-3.3v3.3M15.8 4.9h3.3v3.3M19.1 15.8v3.3h-3.3M8.2 19.1h-3.3v-3.3" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.85" />
      `;
    case "fullscreen-exit":
      return `
        <path d="M9.05 5.2v3.85H5.2M14.95 5.2v3.85h3.85M18.8 14.95h-3.85v3.85M5.2 14.95h3.85v3.85" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.85" />
      `;
  }
}

function createVideoIcon(icon: VideoControlIcon): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "video-control-icon");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.innerHTML = getIconMarkup(icon);
  return svg;
}

function setIconButton(button: HTMLButtonElement, label: string, icon: VideoControlIcon): void {
  button.replaceChildren(createVideoIcon(icon));
  button.setAttribute("aria-label", label);
  button.title = label;
}

function createIconButton(className: string, label: string, icon: VideoControlIcon): HTMLButtonElement {
  const button = createElement("button", className) as HTMLButtonElement;
  button.type = "button";
  setIconButton(button, label, icon);
  return button;
}

export class CachedVideoPlayer {
  readonly element: HTMLElement;

  private readonly appOrigin: string;
  private readonly stage: HTMLElement;
  private readonly video: HTMLVideoElement;
  private readonly overlay: HTMLElement;
  private readonly overlayTitle: HTMLElement;
  private readonly overlayCopy: HTMLElement;
  private readonly primaryButton: HTMLButtonElement;
  private readonly controls: HTMLElement;
  private readonly controlsTopRow: HTMLElement;
  private readonly controlsBottomRow: HTMLElement;
  private readonly playPauseButton: HTMLButtonElement;
  private readonly hoverControls: HTMLElement;
  private readonly skipBackButton: HTMLButtonElement;
  private readonly skipForwardButton: HTMLButtonElement;
  private readonly centerPlayPauseButton: HTMLButtonElement;
  private readonly fullscreenButton: HTMLButtonElement;
  private readonly seekInput: HTMLInputElement;
  private readonly timeLabel: HTMLElement;
  private readonly progressTrack: HTMLElement;
  private readonly progressBar: HTMLElement;
  private readonly progressLabel: HTMLElement;
  private readonly cancelButton: HTMLButtonElement;
  private readonly listeners = new Set<PlayerStateListener>();
  private pollTimer: number | null = null;
  private requestToken = 0;
  private snapshot: PlayerSnapshot;
  private currentVideoUrl: string | null = null;
  private currentVideoId: string;
  private currentTitle: string;
  private lastDownloadStatus: DownloadStatus | null = null;
  private primaryAction: (() => void) | null = null;
  private dragSeeking = false;
  private playbackUnlocked = false;
  private playbackRequested = false;
  private readonly handleFullscreenChange = (): void => {
    this.updateControls();
  };

  constructor(videoId: string, appOrigin: string, title?: string) {
    this.appOrigin = appOrigin;
    this.currentVideoId = videoId;
    this.currentTitle = title ?? videoId;
    this.snapshot = {
      playbackState: "loading",
      currentTime: 0,
      duration: 0,
      videoId,
      isReady: false
    };

    this.element = createElement("div", "player-surface player-surface-local");
    this.element.tabIndex = 0;
    this.element.setAttribute("aria-label", "Video player");
    this.element.addEventListener("keydown", (event) => {
      this.handleKeyDown(event);
    });
    this.stage = createElement("div", "player-video-stage");
    this.stage.addEventListener("pointerenter", () => {
      this.focusPlayer();
    });
    this.stage.addEventListener("pointerleave", () => {
      if (document.activeElement === this.element) {
        this.element.blur();
      }
    });

    this.video = document.createElement("video");
    this.video.className = "cached-video";
    this.video.controls = false;
    this.video.preload = "metadata";
    this.video.playsInline = true;
    this.video.addEventListener("click", () => {
      this.togglePlayback();
    });
    this.applyPresentation(videoId, this.currentTitle);

    this.overlay = createElement("div", "player-overlay");
    const overlayCard = createElement("div", "player-overlay-card");
    this.overlayTitle = createElement("h3", "player-overlay-title");
    this.overlayCopy = createElement("p", "player-overlay-copy");

    const actions = createElement("div", "overlay-actions");
    this.primaryButton = createElement("button", "pill-button", "Play") as HTMLButtonElement;
    this.primaryButton.hidden = true;
    this.primaryButton.addEventListener("click", () => {
      this.primaryAction?.();
    });
    actions.append(this.primaryButton);
    overlayCard.append(this.overlayTitle, this.overlayCopy, actions);
    this.overlay.appendChild(overlayCard);

    this.controls = createElement("div", "video-controls");
    this.controlsTopRow = createElement("div", "video-controls-row video-controls-row-top");
    this.controlsBottomRow = createElement("div", "video-controls-row video-controls-row-bottom");
    this.playPauseButton = createIconButton("video-icon-button video-control-button", "Play", "play");
    this.playPauseButton.addEventListener("click", () => this.handlePlayPauseControl());

    this.hoverControls = createElement("div", "video-hover-controls");
    const transportCluster = createElement("div", "video-transport-cluster");
    this.skipBackButton = createIconButton("video-icon-button video-skip-button", "Back 10 seconds", "skip-back-10");
    this.centerPlayPauseButton = createIconButton("video-icon-button video-center-button", "Play", "play");
    this.skipForwardButton = createIconButton(
      "video-icon-button video-skip-button",
      "Forward 10 seconds",
      "skip-forward-10"
    );
    this.skipBackButton.addEventListener("click", () => this.seekBySeconds(-SEEK_STEP_SECONDS));
    this.centerPlayPauseButton.addEventListener("click", () => this.handlePlayPauseControl());
    this.skipForwardButton.addEventListener("click", () => this.seekBySeconds(SEEK_STEP_SECONDS));
    transportCluster.append(this.skipBackButton, this.centerPlayPauseButton, this.skipForwardButton);
    this.hoverControls.appendChild(transportCluster);

    this.fullscreenButton = createIconButton("video-icon-button video-fullscreen-button", "Enter Full Screen", "fullscreen-enter");
    this.fullscreenButton.addEventListener("click", () => {
      void this.toggleFullscreen();
    });

    this.seekInput = document.createElement("input");
    this.seekInput.className = "video-seek";
    this.seekInput.type = "range";
    this.seekInput.min = "0";
    this.seekInput.max = "0";
    this.seekInput.step = "0.1";
    this.seekInput.value = "0";
    this.seekInput.disabled = true;
    this.seekInput.addEventListener("pointerdown", () => {
      this.dragSeeking = true;
    });
    this.seekInput.addEventListener("pointerup", () => {
      this.dragSeeking = false;
      this.seekToInputValue();
    });
    this.seekInput.addEventListener("input", () => {
      if (!this.dragSeeking) {
        this.seekToInputValue();
      }
      this.updateControls();
    });
    this.seekInput.addEventListener("change", () => {
      this.seekToInputValue();
    });

    this.timeLabel = createElement("div", "video-time-label", "0:00 / 0:00");
    this.progressBar = createElement("div", "download-progress-fill");
    this.progressTrack = createElement("div", "download-progress-track");
    this.progressTrack.appendChild(this.progressBar);
    this.progressLabel = createElement("p", "download-progress-label");
    this.cancelButton = createElement("button", "pill-button overlay-cancel-button", "Cancel Download") as HTMLButtonElement;
    this.cancelButton.hidden = true;
    this.cancelButton.addEventListener("click", () => {
      void this.cancelDownload();
    });

    const progressWrap = createElement("div", "download-progress-inline");
    progressWrap.append(this.progressTrack, this.progressLabel);

    this.controlsTopRow.append(this.playPauseButton, this.seekInput, this.timeLabel, this.fullscreenButton);
    this.controlsBottomRow.append(progressWrap, this.cancelButton);
    this.controls.append(this.controlsTopRow, this.controlsBottomRow);

    document.addEventListener("fullscreenchange", this.handleFullscreenChange);
    document.addEventListener("webkitfullscreenchange", this.handleFullscreenChange);
    this.bindVideoEvents();
    this.stage.append(this.video, this.hoverControls, this.overlay);
    this.element.append(this.stage, this.controls);
    this.loadVideo(videoId, this.currentTitle);
  }

  dispose(): void {
    this.stopPolling();
    document.removeEventListener("fullscreenchange", this.handleFullscreenChange);
    document.removeEventListener("webkitfullscreenchange", this.handleFullscreenChange);
    this.video.pause();
    this.video.removeAttribute("src");
    this.video.load();
    this.element.remove();
  }

  onStateChange(listener: PlayerStateListener): void {
    this.listeners.add(listener);
    listener(this.snapshot);
  }

  getSnapshot(): PlayerSnapshot {
    return this.snapshot;
  }

  loadVideo(videoId: string, title?: string): void {
    this.currentVideoId = videoId;
    this.currentTitle = title ?? videoId;
    this.requestToken += 1;
    const token = this.requestToken;

    this.stopPolling();
    this.currentVideoUrl = null;
    this.lastDownloadStatus = null;
    this.primaryAction = null;
    this.playbackUnlocked = false;
    this.playbackRequested = false;
    this.dragSeeking = false;

    this.video.pause();
    this.video.removeAttribute("src");
    this.applyPresentation(videoId, this.currentTitle);
    this.video.load();

    this.snapshot = {
      playbackState: "loading",
      currentTime: 0,
      duration: 0,
      videoId,
      isReady: false
    };
    this.setProgress(0, null, 0);
    this.hideOverlay();
    this.updateControls();
    this.emitSnapshot();

    void this.prepareVideo(token, videoId);
  }

  private handlePlayPauseControl(): void {
    if (
      !this.playbackUnlocked &&
      (this.snapshot.isReady || this.currentVideoUrl || this.lastDownloadStatus?.state === "downloading")
    ) {
      this.startPlayback();
      return;
    }

    this.togglePlayback();
  }

  togglePlayback(): void {
    if (!this.snapshot.isReady) {
      return;
    }

    if (!this.playbackUnlocked) {
      this.startPlayback();
      return;
    }

    if (this.video.ended) {
      this.replay();
      return;
    }

    if (this.video.paused) {
      void this.video.play().catch(() => undefined);
      return;
    }

    this.video.pause();
  }

  private focusPlayer(): void {
    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement && !this.element.contains(activeElement)) {
      const tagName = activeElement.tagName.toLowerCase();
      if (tagName === "input" || tagName === "select" || tagName === "textarea" || activeElement.isContentEditable) {
        return;
      }
    }

    this.element.focus({ preventScroll: true });
  }

  private handleKeyDown(event: KeyboardEvent): void {
    if (event.altKey || event.ctrlKey || event.metaKey) {
      return;
    }

    if (event.key === "ArrowLeft") {
      event.preventDefault();
      this.seekBySeconds(-SEEK_STEP_SECONDS);
      return;
    }

    if (event.key === "ArrowRight") {
      event.preventDefault();
      this.seekBySeconds(SEEK_STEP_SECONDS);
    }
  }

  replay(): void {
    if (!this.snapshot.isReady) {
      return;
    }

    this.playbackUnlocked = true;
    this.video.currentTime = 0;
    void this.video.play().catch(() => undefined);
    this.hideOverlay();
    this.updateControls();
  }

  private seekBySeconds(deltaSeconds: number): void {
    if (!this.snapshot.isReady) {
      return;
    }

    this.seekToSeconds(this.video.currentTime + deltaSeconds);
  }

  private seekToSeconds(seconds: number): void {
    if (!this.snapshot.isReady || !Number.isFinite(seconds)) {
      return;
    }

    const duration = this.getDurationSeconds();
    const seekLimit = this.getSeekLimitSeconds(duration);
    const target = Math.min(Math.max(seconds, 0), seekLimit);
    this.video.currentTime = target;
    this.updateSnapshot(this.video.ended ? "ended" : this.video.paused ? "paused" : "playing");
    this.updateControls();
  }

  private isFullscreen(): boolean {
    const fullscreenDocument = document as FullscreenDocument;
    return document.fullscreenElement === this.element || fullscreenDocument.webkitFullscreenElement === this.element;
  }

  private canUseFullscreen(): boolean {
    const fullscreenElement = this.element as FullscreenElement;
    return Boolean(this.element.requestFullscreen || fullscreenElement.webkitRequestFullscreen);
  }

  private async toggleFullscreen(): Promise<void> {
    const fullscreenDocument = document as FullscreenDocument;
    const fullscreenElement = this.element as FullscreenElement;

    try {
      if (this.isFullscreen()) {
        if (document.exitFullscreen) {
          await document.exitFullscreen();
        } else {
          await fullscreenDocument.webkitExitFullscreen?.();
        }
      } else if (this.element.requestFullscreen) {
        await this.element.requestFullscreen();
      } else {
        await fullscreenElement.webkitRequestFullscreen?.();
      }
    } catch {
      // Some hosts reject fullscreen without surfacing a useful reason.
    }

    this.updateControls();
  }

  private bindVideoEvents(): void {
    this.video.addEventListener("loadedmetadata", () => {
      this.snapshot.duration = Number.isFinite(this.video.duration) ? this.video.duration : 0;
      this.snapshot.isReady = true;
      this.snapshot.playbackState = this.video.paused ? "paused" : "playing";
      this.renderOverlayForStatus();
      this.updateControls();
      this.emitSnapshot();

      if (this.playbackRequested) {
        this.startPlayback();
      }
    });

    this.video.addEventListener("timeupdate", () => {
      this.updateSnapshot(this.video.ended ? "ended" : this.video.paused ? "paused" : "playing");
      this.updateControls();
    });

    this.video.addEventListener("play", () => {
      this.playbackUnlocked = true;
      this.playbackRequested = false;
      this.hideOverlay();
      this.updateSnapshot("playing");
      this.updateControls();
    });

    this.video.addEventListener("pause", () => {
      this.updateSnapshot(this.video.ended ? "ended" : "paused");
      this.updateControls();
    });

    this.video.addEventListener("ended", () => {
      this.playbackRequested = false;
      this.updateSnapshot("ended");
      this.updateControls();
    });

    this.video.addEventListener("waiting", () => {
      this.updateSnapshot("buffering");
      this.updateControls();
    });

    this.video.addEventListener("stalled", () => {
      this.updateSnapshot("buffering");
      this.updateControls();
    });

    this.video.addEventListener("error", () => {
      this.snapshot.isReady = false;
      this.snapshot.playbackState = "loading";

      if (this.lastDownloadStatus?.state === "downloading") {
        this.updateControls();
      } else {
        this.showOverlay("Playback failed", "The local file could not be played.", {
          primaryLabel: "Download Again",
          onPrimary: () => this.loadVideo(this.currentVideoId, this.currentTitle),
          showCancel: false
        });
      }

      this.updateControls();
      this.emitSnapshot();
    });
  }

  private async prepareVideo(token: number, videoId: string): Promise<void> {
    try {
      const response = await fetch(`${this.appOrigin}/api/media/prepare`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({ videoId })
      });
      const status = await response.json() as DownloadStatus;
      if (token !== this.requestToken) {
        return;
      }

      this.applyDownloadStatus(status);
      if (status.state === "downloading") {
        this.startPolling(token, videoId);
      }
    } catch (error) {
      if (token !== this.requestToken) {
        return;
      }
      this.showOverlay("Download failed", error instanceof Error ? error.message : "The local downloader could not be reached.", {
        primaryLabel: "Download Again",
        onPrimary: () => this.loadVideo(this.currentVideoId, this.currentTitle),
        showCancel: false
      });
    }
  }

  private startPolling(token: number, videoId: string): void {
    this.stopPolling();
    this.pollTimer = window.setInterval(() => {
      void this.refreshStatus(token, videoId);
    }, 900);
  }

  private stopPolling(): void {
    if (this.pollTimer !== null) {
      window.clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async refreshStatus(token: number, videoId: string): Promise<void> {
    try {
      const response = await fetch(`${this.appOrigin}/api/media/status?videoId=${encodeURIComponent(videoId)}`);
      const status = await response.json() as DownloadStatus;
      if (token !== this.requestToken) {
        return;
      }

      this.applyDownloadStatus(status);
      if (status.state !== "downloading") {
        this.stopPolling();
      }
    } catch (error) {
      if (token !== this.requestToken) {
        return;
      }
      this.showOverlay("Status check failed", error instanceof Error ? error.message : "The app could not read download status.", {
        primaryLabel: null,
        onPrimary: null,
        showCancel: false
      });
      this.stopPolling();
    }
  }

  private async cancelDownload(): Promise<void> {
    const response = await fetch(`${this.appOrigin}/api/media/cancel`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({ videoId: this.currentVideoId })
    });

    const status = await response.json() as DownloadStatus;
    this.stopPolling();
    this.video.pause();
    this.video.removeAttribute("src");
    this.video.load();
    this.currentVideoUrl = null;
    this.playbackUnlocked = false;
    this.playbackRequested = false;
    this.snapshot = {
      playbackState: "loading",
      currentTime: 0,
      duration: 0,
      videoId: this.currentVideoId,
      isReady: false
    };
    this.resetProgress();
    this.applyDownloadStatus(status);
    this.updateControls();
    this.emitSnapshot();
  }

  private applyDownloadStatus(status: DownloadStatus): void {
    this.lastDownloadStatus = status;

    if (
      status.mediaUrl &&
      this.currentVideoUrl !== status.mediaUrl &&
      (!this.currentVideoUrl || (!this.playbackUnlocked && !this.playbackRequested))
    ) {
      this.currentVideoUrl = status.mediaUrl;
      this.video.src = `${status.mediaUrl}?t=${Date.now()}`;
      this.video.load();
    }

    if (status.state === "ready" || status.state === "downloading") {
      this.setProgress(status.progressPercent, status.totalSizeBytes, status.fileSizeBytes ?? 0);
    } else if (status.state === "cancelled") {
      this.resetProgress();
    }

    this.renderOverlayForStatus();
    this.updateControls();
  }

  private renderOverlayForStatus(): void {
    const status = this.lastDownloadStatus;
    if (!status) {
      return;
    }

    if (
      status.state === "downloading" ||
      status.state === "ready" ||
      status.state === "missing" ||
      (this.playbackUnlocked && this.snapshot.isReady)
    ) {
      this.hideOverlay();
      return;
    }

    if (status.state === "error") {
      this.showOverlay("Download failed", status.error ?? "yt-dlp could not download this video.", {
        primaryLabel: "Download Again",
        onPrimary: () => this.loadVideo(this.currentVideoId, this.currentTitle),
        showCancel: false
      });
      return;
    }

    if (status.state === "cancelled") {
      this.showOverlay("Download cancelled", "", {
        primaryLabel: "Download Again",
        onPrimary: () => this.loadVideo(this.currentVideoId, this.currentTitle),
        showCancel: false
      });
      return;
    }

    if (status.mediaUrl && this.snapshot.isReady) {
      return;
    }
  }

  private startPlayback(): void {
    this.playbackRequested = true;

    if (!this.currentVideoUrl || !this.snapshot.isReady) {
      this.renderOverlayForStatus();
      return;
    }

    this.playbackUnlocked = true;
    this.hideOverlay();
    void this.video.play().catch(() => undefined);
    this.updateControls();
  }

  private updateSnapshot(playbackState: PlayerPlaybackState): void {
    this.snapshot = {
      playbackState,
      currentTime: this.video.currentTime,
      duration: Number.isFinite(this.video.duration) ? this.video.duration : this.snapshot.duration,
      videoId: this.currentVideoId,
      isReady: this.video.readyState >= HTMLMediaElement.HAVE_METADATA
    };
    this.emitSnapshot();
  }

  private updateControls(): void {
    const duration = this.getDurationSeconds();
    const seekLimit = this.getSeekLimitSeconds(duration);
    const downloadState = this.lastDownloadStatus?.state ?? "missing";
    const canQueuePlayback =
      Boolean(this.currentVideoUrl) || downloadState === "downloading" || downloadState === "ready";
    const playedRatio = duration > 0 ? Math.min(this.video.currentTime / duration, 1) : 0;
    const availableRatio = duration > 0 ? Math.min(seekLimit / duration, 1) : 0;
    const canSeek = this.snapshot.isReady && duration > 0;
    const canSeekBackward = canSeek && this.video.currentTime > 0.05;
    const canSeekForward = canSeek && seekLimit - this.video.currentTime > 0.05;
    const isStarting = this.playbackRequested && !this.playbackUnlocked;
    const playbackIcon =
      this.snapshot.playbackState === "playing" || this.snapshot.playbackState === "buffering"
        ? "pause"
        : this.snapshot.playbackState === "ended"
          ? "replay"
          : "play";
    const playbackLabel = isStarting
      ? "Starting playback"
      : this.snapshot.playbackState === "playing" || this.snapshot.playbackState === "buffering"
        ? "Pause"
        : this.snapshot.playbackState === "ended"
          ? "Replay"
          : "Play";

    this.playPauseButton.disabled = !this.snapshot.isReady && !canQueuePlayback;
    this.centerPlayPauseButton.disabled = this.playPauseButton.disabled;
    this.skipBackButton.disabled = !canSeekBackward;
    this.skipForwardButton.disabled = !canSeekForward;
    this.fullscreenButton.disabled = !this.canUseFullscreen();
    this.seekInput.disabled = !this.snapshot.isReady;
    this.seekInput.max = String(Math.max(duration, 0));
    this.seekInput.style.setProperty("--seek-played-percent", `${playedRatio * 100}%`);
    this.seekInput.style.setProperty("--seek-available-percent", `${Math.max(playedRatio, availableRatio) * 100}%`);

    if (!this.dragSeeking) {
      this.seekInput.value = String(Math.min(this.video.currentTime, duration));
    }

    setIconButton(this.playPauseButton, playbackLabel, playbackIcon);
    setIconButton(this.centerPlayPauseButton, playbackLabel, playbackIcon);
    setIconButton(
      this.fullscreenButton,
      this.isFullscreen() ? "Exit Full Screen" : "Enter Full Screen",
      this.isFullscreen() ? "fullscreen-exit" : "fullscreen-enter"
    );
    this.centerPlayPauseButton.classList.toggle("video-control-button-loading", isStarting);
    this.playPauseButton.classList.toggle("video-control-button-loading", isStarting);
    this.element.classList.toggle("player-controls-pinned", this.snapshot.playbackState !== "playing" || !this.playbackUnlocked);
    this.element.classList.toggle("player-download-active", downloadState === "downloading");

    this.timeLabel.textContent = `${formatTime(this.video.currentTime)} / ${formatTime(duration)}`;
    this.controlsBottomRow.hidden = downloadState !== "downloading";
    this.cancelButton.hidden = downloadState !== "downloading";
  }

  private seekToInputValue(): void {
    if (!this.snapshot.isReady) {
      return;
    }

    const desired = Number.parseFloat(this.seekInput.value);
    this.seekToSeconds(desired);
  }

  private getDurationSeconds(): number {
    if (Number.isFinite(this.video.duration) && this.video.duration > 0) {
      return this.video.duration;
    }

    return this.lastDownloadStatus?.durationSeconds ?? this.snapshot.duration ?? 0;
  }

  private getSeekLimitSeconds(duration: number): number {
    if (!Number.isFinite(duration) || duration <= 0) {
      return 0;
    }

    if (this.lastDownloadStatus?.state === "ready") {
      return duration;
    }

    let available = this.video.currentTime;
    if (this.video.buffered.length > 0) {
      available = Math.max(available, this.video.buffered.end(this.video.buffered.length - 1));
    }

    if (
      this.lastDownloadStatus?.fileSizeBytes &&
      this.lastDownloadStatus.totalSizeBytes &&
      this.lastDownloadStatus.totalSizeBytes > 0
    ) {
      const byBytes = duration * Math.min(this.lastDownloadStatus.fileSizeBytes / this.lastDownloadStatus.totalSizeBytes, 1);
      available = Math.max(available, byBytes);
    }

    return Math.min(duration, available);
  }

  private setProgress(progressPercent: number | null, totalBytes: number | null, downloadedBytes: number): void {
    const percent = Math.max(0, Math.min(100, progressPercent ?? 0));
    this.progressTrack.hidden = false;
    this.progressLabel.hidden = false;
    this.progressBar.style.width = `${percent}%`;

    const bytesLabel =
      totalBytes && totalBytes > 0
        ? `${formatBytes(downloadedBytes)} / ${formatBytes(totalBytes)}`
        : `${formatBytes(downloadedBytes)}`;
    const percentLabel = progressPercent !== null ? `${progressPercent.toFixed(1)}%` : null;
    this.progressLabel.textContent = percentLabel ? `${bytesLabel} · ${percentLabel}` : bytesLabel;
  }

  private resetProgress(): void {
    this.progressTrack.hidden = true;
    this.progressLabel.hidden = true;
    this.progressBar.style.width = "0%";
    this.progressLabel.textContent = "";
  }

  private showOverlay(
    title: string,
    copy: string,
    actions: {
      primaryLabel: string | null;
      onPrimary: (() => void) | null;
      showCancel: boolean;
    }
  ): void {
    this.overlay.hidden = false;
    this.overlayTitle.textContent = title;
    this.overlayCopy.textContent = copy;
    this.overlayCopy.hidden = copy.length === 0;
    this.primaryButton.hidden = actions.primaryLabel === null;
    this.cancelButton.hidden = !actions.showCancel;
    this.primaryButton.textContent = actions.primaryLabel ?? "";
    this.primaryAction = actions.onPrimary;
  }

  private hideOverlay(): void {
    this.overlay.hidden = true;
  }

  private applyPresentation(videoId: string, title: string): void {
    const thumbnailUrl = getVideoThumbnail(videoId);
    this.video.poster = thumbnailUrl;
    this.video.title = title;
    this.element.title = title;
    this.element.style.setProperty("--player-thumbnail-url", `url("${thumbnailUrl}")`);
  }

  private emitSnapshot(): void {
    for (const listener of this.listeners) {
      listener(this.snapshot);
    }
  }
}
