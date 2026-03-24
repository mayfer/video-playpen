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
    this.stage = createElement("div", "player-video-stage");

    this.video = document.createElement("video");
    this.video.className = "cached-video";
    this.video.controls = false;
    this.video.preload = "metadata";
    this.video.playsInline = true;
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
    this.playPauseButton = createElement("button", "pill-button video-control-button", "Play") as HTMLButtonElement;
    this.playPauseButton.addEventListener("click", () => {
      if (!this.playbackUnlocked && (this.snapshot.isReady || this.currentVideoUrl || this.lastDownloadStatus?.state === "downloading")) {
        this.startPlayback();
        return;
      }
      this.togglePlayback();
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

    this.controlsTopRow.append(this.playPauseButton, this.seekInput, this.timeLabel);
    this.controlsBottomRow.append(progressWrap, this.cancelButton);
    this.controls.append(this.controlsTopRow, this.controlsBottomRow);

    this.bindVideoEvents();
    this.stage.append(this.video, this.overlay);
    this.element.append(this.stage, this.controls);
    this.loadVideo(videoId, this.currentTitle);
  }

  dispose(): void {
    this.stopPolling();
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

    this.playPauseButton.disabled = !this.snapshot.isReady && !canQueuePlayback;
    this.seekInput.disabled = !this.snapshot.isReady;
    this.seekInput.max = String(Math.max(duration, 0));
    this.seekInput.style.setProperty("--seek-played-percent", `${playedRatio * 100}%`);
    this.seekInput.style.setProperty("--seek-available-percent", `${Math.max(playedRatio, availableRatio) * 100}%`);

    if (!this.dragSeeking) {
      this.seekInput.value = String(Math.min(this.video.currentTime, duration));
    }

    this.playPauseButton.textContent =
      this.playbackRequested && !this.playbackUnlocked
        ? "Starting..."
        : this.snapshot.playbackState === "playing"
        ? "Pause"
        : this.snapshot.playbackState === "ended"
          ? "Replay"
          : "Play";

    this.timeLabel.textContent = `${formatTime(this.video.currentTime)} / ${formatTime(duration)}`;
    this.controlsBottomRow.hidden = downloadState !== "downloading";
    this.cancelButton.hidden = downloadState !== "downloading";
  }

  private seekToInputValue(): void {
    if (!this.snapshot.isReady) {
      return;
    }

    const desired = Number.parseFloat(this.seekInput.value);
    const seekLimit = this.getSeekLimitSeconds(this.getDurationSeconds());
    this.video.currentTime = Math.min(Math.max(desired, 0), seekLimit);
    this.updateControls();
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
