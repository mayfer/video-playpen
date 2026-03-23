import type { PlayerPlaybackState, PlayerSnapshot } from "./player";

type DownloadState = "missing" | "downloading" | "ready" | "error";

type DownloadStatus = {
  videoId: string;
  state: DownloadState;
  mediaUrl: string | null;
  title: string | null;
  durationSeconds: number | null;
  fileSizeBytes: number | null;
  totalSizeBytes: number | null;
  progressPercent: number | null;
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

export class CachedVideoPlayer {
  readonly element: HTMLElement;

  private readonly appOrigin: string;
  private readonly video: HTMLVideoElement;
  private readonly overlay: HTMLElement;
  private readonly overlayTitle: HTMLElement;
  private readonly overlayCopy: HTMLElement;
  private readonly progressTrack: HTMLElement;
  private readonly progressBar: HTMLElement;
  private readonly progressLabel: HTMLElement;
  private readonly retryButton: HTMLButtonElement;
  private readonly listeners = new Set<PlayerStateListener>();
  private pollTimer: number | null = null;
  private requestToken = 0;
  private snapshot: PlayerSnapshot;
  private currentVideoUrl: string | null = null;
  private currentVideoId: string;
  private currentTitle: string;
  private hadPlaybackError = false;
  private lastDownloadStatus: DownloadStatus | null = null;

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

    this.video = document.createElement("video");
    this.video.className = "cached-video";
    this.video.controls = true;
    this.video.preload = "metadata";
    this.video.playsInline = true;
    this.applyPresentation(videoId, this.currentTitle);

    this.overlay = createElement("div", "player-overlay");
    const status = createElement("div", "player-overlay-card");
    this.overlayTitle = createElement("h3", "player-overlay-title");
    this.overlayCopy = createElement("p", "player-overlay-copy");
    this.progressBar = createElement("div", "download-progress-fill");
    this.progressTrack = createElement("div", "download-progress-track");
    this.progressTrack.appendChild(this.progressBar);
    this.progressLabel = createElement("p", "download-progress-label");
    this.retryButton = createElement("button", "pill-button", "Retry") as HTMLButtonElement;
    this.retryButton.hidden = true;
    this.retryButton.addEventListener("click", () => {
      this.loadVideo(this.currentVideoId);
    });
    status.append(this.overlayTitle, this.overlayCopy, this.progressTrack, this.progressLabel, this.retryButton);
    this.overlay.appendChild(status);

    this.bindVideoEvents();
    this.element.append(this.video, this.overlay);
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

  togglePlayback(): void {
    if (!this.snapshot.isReady) {
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

    this.video.currentTime = 0;
    void this.video.play().catch(() => undefined);
  }

  loadVideo(videoId: string, title?: string): void {
    this.currentVideoId = videoId;
    this.currentTitle = title ?? videoId;
    this.requestToken += 1;
    const token = this.requestToken;

    this.stopPolling();
    this.currentVideoUrl = null;
    this.hadPlaybackError = false;
    this.lastDownloadStatus = null;
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
    this.setOverlay("Preparing download", "Checking the local cache and starting yt-dlp if needed.");
    this.emitSnapshot();

    void this.prepareVideo(token, videoId);
  }

  private bindVideoEvents(): void {
    this.video.addEventListener("loadedmetadata", () => {
      this.snapshot.duration = Number.isFinite(this.video.duration) ? this.video.duration : 0;
      this.snapshot.isReady = true;
      this.snapshot.playbackState = this.video.paused ? "paused" : "playing";
      this.hideOverlay();
      this.emitSnapshot();
    });

    this.video.addEventListener("timeupdate", () => {
      this.updateSnapshot(this.video.ended ? "ended" : this.video.paused ? "paused" : "playing");
    });

    this.video.addEventListener("play", () => {
      this.updateSnapshot("playing");
    });

    this.video.addEventListener("pause", () => {
      this.updateSnapshot(this.video.ended ? "ended" : "paused");
    });

    this.video.addEventListener("ended", () => {
      this.updateSnapshot("ended");
    });

    this.video.addEventListener("waiting", () => {
      this.updateSnapshot("buffering");
    });

    this.video.addEventListener("stalled", () => {
      this.updateSnapshot("buffering");
    });

    this.video.addEventListener("error", () => {
      this.snapshot.isReady = false;
      this.snapshot.playbackState = "loading";
      this.hadPlaybackError = true;

      if (this.lastDownloadStatus?.state === "error") {
        this.setOverlay("Playback failed", "The cached file could not be loaded. Try downloading it again.", true);
      } else if (this.lastDownloadStatus?.state === "downloading") {
        this.setProgress(
          this.lastDownloadStatus.progressPercent,
          this.lastDownloadStatus.fileSizeBytes,
          this.lastDownloadStatus.totalSizeBytes
        );
        this.setOverlay("Downloading video", this.buildDownloadedCopy(this.lastDownloadStatus), false);
      } else {
        this.setOverlay("Preparing video", "Waiting for enough downloaded data to start playback.", false);
      }
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
      if (status.state !== "ready" && status.state !== "error") {
        this.startPolling(token, videoId);
      }
    } catch (error) {
      if (token !== this.requestToken) {
        return;
      }
      this.setOverlay(
        "Preparing failed",
        error instanceof Error ? error.message : "The app could not contact the local download service.",
        true
      );
    }
  }

  private startPolling(token: number, videoId: string): void {
    this.stopPolling();
    this.pollTimer = window.setInterval(() => {
      void this.refreshStatus(token, videoId);
    }, 1200);
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
      if (status.state === "ready" || status.state === "error") {
        this.stopPolling();
      }
    } catch (error) {
      if (token !== this.requestToken) {
        return;
      }
      this.setOverlay(
        "Status check failed",
        error instanceof Error ? error.message : "The app could not read the current download state.",
        true
      );
      this.stopPolling();
    }
  }

  private applyDownloadStatus(status: DownloadStatus): void {
    this.lastDownloadStatus = status;
    if (status.mediaUrl) {
      const shouldReloadSource =
        this.currentVideoUrl !== status.mediaUrl ||
        this.hadPlaybackError;

      if (shouldReloadSource) {
        this.currentVideoUrl = status.mediaUrl;
        this.hadPlaybackError = false;
        this.video.src = `${status.mediaUrl}?t=${Date.now()}`;
        this.video.load();
      }

      if (this.video.readyState >= HTMLMediaElement.HAVE_METADATA || this.snapshot.isReady) {
        this.hideOverlay();
        this.snapshot.isReady = true;
        if (this.snapshot.playbackState === "loading") {
          this.snapshot.playbackState = this.video.paused ? "paused" : "playing";
        }
        this.emitSnapshot();
      } else {
        this.setProgress(status.progressPercent, status.fileSizeBytes, status.totalSizeBytes);
        this.setOverlay("Preparing video", "Finalizing download and loading the local file.", false);
      }
      return;
    }

    this.snapshot.isReady = false;
    this.snapshot.playbackState = "loading";
    this.emitSnapshot();

    if (status.state === "error") {
      this.setOverlay("Download failed", status.error ?? "yt-dlp could not download this video.", true);
      return;
    }

    this.setProgress(status.progressPercent, status.fileSizeBytes, status.totalSizeBytes);
    this.setOverlay(
      status.state === "missing" ? "Queued for download" : "Downloading video",
      this.buildDownloadedCopy(status)
    );
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

  private setOverlay(title: string, copy: string, showRetry = false): void {
    this.overlay.hidden = false;
    this.overlayTitle.textContent = title;
    this.overlayCopy.textContent = copy;
    this.retryButton.hidden = !showRetry;
  }

  private hideOverlay(): void {
    this.overlay.hidden = true;
    this.retryButton.hidden = true;
  }

  private setProgress(progressPercent: number | null, downloadedBytes: number | null, totalSizeBytes: number | null): void {
    const hasKnownProgress = typeof progressPercent === "number" && Number.isFinite(progressPercent);
    this.progressTrack.hidden = !hasKnownProgress;
    this.progressBar.style.width = `${Math.max(0, Math.min(100, hasKnownProgress ? progressPercent : 0))}%`;

    if (hasKnownProgress) {
      this.progressLabel.textContent =
        typeof downloadedBytes === "number" && typeof totalSizeBytes === "number" && totalSizeBytes > 0
          ? `${progressPercent.toFixed(1)}% complete`
          : `${progressPercent.toFixed(1)}%`;
      return;
    }

    if (typeof downloadedBytes === "number" && downloadedBytes > 0) {
      this.progressLabel.textContent = `${(downloadedBytes / (1024 * 1024)).toFixed(1)} MB downloaded`;
      return;
    }

    this.progressLabel.textContent = "Waiting for progress information";
  }

  private buildDownloadedCopy(status: DownloadStatus): string {
    if (typeof status.fileSizeBytes === "number" && status.fileSizeBytes > 0) {
      const downloadedMb = (status.fileSizeBytes / (1024 * 1024)).toFixed(1);
      if (typeof status.totalSizeBytes === "number" && status.totalSizeBytes > 0) {
        const totalMb = (status.totalSizeBytes / (1024 * 1024)).toFixed(1);
        return `Downloaded ${downloadedMb} MB of ${totalMb} MB so far.`;
      }

      return `Downloaded ${downloadedMb} MB so far.`;
    }

    return "The app is downloading a local playable file.";
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
