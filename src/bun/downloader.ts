import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const YT_DLP_UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;

export type DownloadProgress = {
  downloadedBytes: number;
  totalSizeBytes: number | null;
  progressPercent: number | null;
};

export type DownloadSpawnHandle = {
  kill: () => void;
};

type YtDlpRuntimeState = {
  binaryPath: string;
  version: string | null;
  status: "initializing" | "ready" | "updating" | "error";
  lastCheckedAt: number | null;
  error: string | null;
  updatePromise: Promise<void> | null;
};

export function getAppDataDir(): string {
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "yt-embeds-electrobun");
  }

  if (process.platform === "win32") {
    const appData = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
    return join(appData, "yt-embeds-electrobun");
  }

  return join(homedir(), ".local", "share", "yt-embeds-electrobun");
}

export const APP_DATA_DIR = getAppDataDir();
export const BIN_DIR = join(APP_DATA_DIR, "bin");
export const CACHE_DIR = join(APP_DATA_DIR, "cache");

mkdirSync(APP_DATA_DIR, { recursive: true });
mkdirSync(BIN_DIR, { recursive: true });
mkdirSync(CACHE_DIR, { recursive: true });

function getYtDlpBinaryPath(): string {
  if (process.platform === "win32") {
    return join(BIN_DIR, "yt-dlp.exe");
  }

  return join(BIN_DIR, "yt-dlp");
}

function getYtDlpDownloadUrl(): string {
  if (process.platform === "win32") {
    return "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";
  }

  if (process.platform === "darwin") {
    return "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos";
  }

  return "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp";
}

const ytDlpState: YtDlpRuntimeState = {
  binaryPath: getYtDlpBinaryPath(),
  version: null,
  status: "initializing",
  lastCheckedAt: null,
  error: null,
  updatePromise: null
};

async function readProcessOutput(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) {
    return "";
  }

  return await new Response(stream).text();
}

async function runYtDlp(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const process = Bun.spawn({
    cmd: [ytDlpState.binaryPath, ...args],
    stdout: "pipe",
    stderr: "pipe"
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    readProcessOutput(process.stdout),
    readProcessOutput(process.stderr),
    process.exited
  ]);

  return { exitCode, stdout, stderr };
}

async function refreshYtDlpVersion(): Promise<void> {
  const result = await runYtDlp(["--version"]);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || "Failed to read yt-dlp version");
  }

  ytDlpState.version = result.stdout.trim() || null;
}

async function downloadYtDlpBinary(): Promise<void> {
  const response = await fetch(getYtDlpDownloadUrl());
  if (!response.ok) {
    throw new Error(`Failed to download yt-dlp: ${response.status}`);
  }

  const tempPath = `${ytDlpState.binaryPath}.tmp`;
  const bytes = await response.arrayBuffer();
  await Bun.write(tempPath, bytes);
  chmodSync(tempPath, 0o755);
  rmSync(ytDlpState.binaryPath, { force: true });
  renameSync(tempPath, ytDlpState.binaryPath);
  chmodSync(ytDlpState.binaryPath, 0o755);
}

export async function ensureYtDlpReady(forceUpdate = false): Promise<void> {
  if (ytDlpState.updatePromise) {
    return ytDlpState.updatePromise;
  }

  ytDlpState.updatePromise = (async () => {
    try {
      ytDlpState.status = "updating";
      ytDlpState.error = null;

      if (!existsSync(ytDlpState.binaryPath)) {
        await downloadYtDlpBinary();
      }

      const shouldUpdate =
        forceUpdate ||
        ytDlpState.lastCheckedAt === null ||
        Date.now() - ytDlpState.lastCheckedAt > YT_DLP_UPDATE_INTERVAL_MS;

      if (shouldUpdate) {
        await runYtDlp(["-U"]);
        ytDlpState.lastCheckedAt = Date.now();
      }

      await refreshYtDlpVersion();
      ytDlpState.status = "ready";
    } catch (error) {
      ytDlpState.status = "error";
      ytDlpState.error = error instanceof Error ? error.message : String(error);
    } finally {
      ytDlpState.updatePromise = null;
    }
  })();

  return ytDlpState.updatePromise;
}

export function getYtDlpRuntimeState(): Omit<YtDlpRuntimeState, "updatePromise"> {
  return {
    binaryPath: ytDlpState.binaryPath,
    version: ytDlpState.version,
    status: ytDlpState.status,
    lastCheckedAt: ytDlpState.lastCheckedAt,
    error: ytDlpState.error
  };
}

export function findCachedFilePath(videoId: string): string | null {
  const prefix = `${videoId}.`;
  const match = readdirSync(CACHE_DIR).find((fileName) => fileName.startsWith(prefix));
  return match ? join(CACHE_DIR, match) : null;
}

function getLargestCacheArtifactSize(videoId: string): number {
  const prefix = `${videoId}.`;
  let maxSize = 0;

  for (const fileName of readdirSync(CACHE_DIR)) {
    if (!fileName.startsWith(prefix)) {
      continue;
    }

    const filePath = join(CACHE_DIR, fileName);
    if (!existsSync(filePath)) {
      continue;
    }

    const size = statSync(filePath).size;
    if (size > maxSize) {
      maxSize = size;
    }
  }

  return maxSize;
}

export function clearCachedVideo(videoId: string): void {
  const prefix = `${videoId}.`;
  for (const fileName of readdirSync(CACHE_DIR)) {
    if (!fileName.startsWith(prefix)) {
      continue;
    }

    const filePath = join(CACHE_DIR, fileName);
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
  }
}

export function clearCacheDirectory(): void {
  for (const fileName of readdirSync(CACHE_DIR)) {
    unlinkSync(join(CACHE_DIR, fileName));
  }
}

export function openCacheDirectory(): void {
  const command =
    process.platform === "darwin"
      ? ["open", CACHE_DIR]
      : process.platform === "win32"
        ? ["explorer", CACHE_DIR]
        : ["xdg-open", CACHE_DIR];

  Bun.spawn({
    cmd: command,
    stdout: "ignore",
    stderr: "ignore"
  });
}

export async function fetchVideoMetadata(videoId: string): Promise<{
  title: string | null;
  durationSeconds: number | null;
  totalSizeBytes: number | null;
}> {
  await ensureYtDlpReady();

  const sourceUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const result = await runYtDlp(["-J", "--no-warnings", "--no-playlist", sourceUrl]);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || "Failed to fetch video metadata");
  }

  try {
    const metadata = JSON.parse(result.stdout) as {
      title?: string;
      duration?: number;
      filesize?: number;
      filesize_approx?: number;
    };

    return {
      title: metadata.title ?? null,
      durationSeconds: typeof metadata.duration === "number" ? metadata.duration : null,
      totalSizeBytes:
        typeof metadata.filesize === "number"
          ? metadata.filesize
          : typeof metadata.filesize_approx === "number"
            ? metadata.filesize_approx
            : null
    };
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : "Failed to parse video metadata");
  }
}

export async function fetchPlaybackUrl(videoId: string): Promise<string> {
  await ensureYtDlpReady();

  const sourceUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const result = await runYtDlp([
    "-g",
    "--no-warnings",
    "--no-playlist",
    "-f",
    "best[ext=mp4]/best",
    sourceUrl
  ]);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || "Failed to resolve playback URL");
  }

  const playbackUrl = result.stdout.trim().split(/\r?\n/).find(Boolean) ?? "";
  if (!playbackUrl) {
    throw new Error("yt-dlp did not return a playback URL");
  }

  return playbackUrl;
}

export async function downloadVideoToCache(
  videoId: string,
  options?: {
    onMetadata?: (metadata: {
      title: string | null;
      durationSeconds: number | null;
      totalSizeBytes: number | null;
    }) => void;
    onProgress?: (progress: DownloadProgress) => void;
    onSpawn?: (handle: DownloadSpawnHandle) => void;
  }
): Promise<{
  title: string | null;
  durationSeconds: number | null;
  totalSizeBytes: number | null;
  filePath: string;
  fileSizeBytes: number;
}> {
  const metadata = await fetchVideoMetadata(videoId);
  options?.onMetadata?.(metadata);
  clearCachedVideo(videoId);

  const outputTemplate = join(CACHE_DIR, `${videoId}.%(ext)s`);
  const sourceUrl = `https://www.youtube.com/watch?v=${videoId}`;

  let maxDownloadedBytes = 0;
  let maxPercent = 0;
  const emitProgress = (downloadedBytes: number, progressPercent: number | null) => {
    if (downloadedBytes > maxDownloadedBytes) {
      maxDownloadedBytes = downloadedBytes;
    }
    if (typeof progressPercent === "number" && Number.isFinite(progressPercent) && progressPercent > maxPercent) {
      maxPercent = progressPercent;
    }

    const normalizedPercent =
      metadata.totalSizeBytes && metadata.totalSizeBytes > 0
        ? maxDownloadedBytes >= metadata.totalSizeBytes
          ? 99.9
          : (maxDownloadedBytes / metadata.totalSizeBytes) * 100
        : maxPercent > 0
          ? Math.min(maxPercent, 99.9)
          : null;

    options?.onProgress?.({
      downloadedBytes: maxDownloadedBytes,
      totalSizeBytes: metadata.totalSizeBytes,
      progressPercent: normalizedPercent
    });
  };

  emitProgress(0, 0);

  const process = Bun.spawn({
    cmd: [
      ytDlpState.binaryPath,
      "--no-warnings",
      "--no-playlist",
      "--no-part",
      "--format",
      "best[ext=mp4]/best",
      "--output",
      outputTemplate,
      sourceUrl
    ],
    stdout: "pipe",
    stderr: "pipe"
  });
  options?.onSpawn?.({
    kill: () => {
      (process as { kill?: (signal?: string | number) => void }).kill?.("SIGTERM");
    }
  });

  const progressTimer = setInterval(() => {
    emitProgress(getLargestCacheArtifactSize(videoId), null);
  }, 500);

  const [stdout, stderr, exitCode] = await Promise.all([
    readProcessOutput(process.stdout),
    readProcessOutput(process.stderr),
    process.exited
  ]);
  clearInterval(progressTimer);

  if (exitCode !== 0) {
    throw new Error(stderr || stdout || "yt-dlp download failed");
  }

  const filePath = findCachedFilePath(videoId);
  if (!filePath || !existsSync(filePath)) {
    throw new Error("yt-dlp completed without producing a cached file");
  }

  const fileSizeBytes = statSync(filePath).size;
  options?.onProgress?.({
    downloadedBytes: Math.max(maxDownloadedBytes, fileSizeBytes),
    totalSizeBytes: metadata.totalSizeBytes ?? fileSizeBytes,
    progressPercent: 100
  });

  return {
    title: metadata.title,
    durationSeconds: metadata.durationSeconds,
    totalSizeBytes: metadata.totalSizeBytes,
    filePath,
    fileSizeBytes
  };
}
