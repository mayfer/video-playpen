import { ApplicationMenu, BrowserWindow, Updater, Utils } from "electrobun/bun";
import { Database } from "bun:sqlite";
import { dlopen, FFIType } from "bun:ffi";
import { existsSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
  APP_DATA_DIR,
  clearCachedVideo,
  clearCacheDirectory,
  downloadVideoToCache,
  ensureYtDlpReady,
  fetchPlaybackUrl,
  findCachedFilePath,
  getYtDlpRuntimeState,
  openCacheDirectory
} from "./downloader";

const DEV_SERVER_PORT = 5173;
const DEV_SERVER_URL = `http://localhost:${DEV_SERVER_PORT}`;
const MAC_TRAFFIC_LIGHTS_X = 14;
const MAC_TRAFFIC_LIGHTS_Y = 12;
const MAC_NATIVE_DRAG_REGION_X = 92;
const MAC_NATIVE_DRAG_REGION_WIDTH = 260;
const MAC_NATIVE_DRAG_REGION_HEIGHT = 52;
const DEBUG_SAFE_WINDOW = process.env.YT_EMBEDS_DEBUG_WINDOW === "1";
const MAX_CACHE_BYTES = 2 * 1024 * 1024 * 1024;
const YT_DLP_UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;
type DownloadState = "missing" | "downloading" | "ready" | "error" | "cancelled";
type PlayerMode = "local" | "youtube";

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

type CacheRecord = {
  video_id: string;
  title: string | null;
  file_path: string | null;
  file_size_bytes: number | null;
  duration_seconds: number | null;
  status: string;
  error_message: string | null;
  last_accessed_at: string | null;
};

type ActiveDownload = {
  promise: Promise<void>;
  title: string | null;
  durationSeconds: number | null;
  downloadedBytes: number | null;
  totalSizeBytes: number | null;
  progressPercent: number | null;
  error: string | null;
  cancelled: boolean;
  cancel: () => void;
};

const DATABASE_PATH = join(APP_DATA_DIR, "app.sqlite");

const database = new Database(DATABASE_PATH);
database.exec(`
  CREATE TABLE IF NOT EXISTS pinned_nodes (
    node_id TEXT PRIMARY KEY,
    pinned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS media_cache (
    video_id TEXT PRIMARY KEY,
    title TEXT,
    file_path TEXT,
    file_size_bytes INTEGER,
    duration_seconds REAL,
    status TEXT NOT NULL,
    error_message TEXT,
    last_accessed_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

const selectPinnedIdsQuery = database.query("SELECT node_id FROM pinned_nodes ORDER BY pinned_at DESC");
const insertPinnedIdQuery = database.query("INSERT OR REPLACE INTO pinned_nodes (node_id, pinned_at) VALUES (?, CURRENT_TIMESTAMP)");
const deletePinnedIdQuery = database.query("DELETE FROM pinned_nodes WHERE node_id = ?");
const findPinnedIdQuery = database.query("SELECT node_id FROM pinned_nodes WHERE node_id = ? LIMIT 1");
const getSettingValueQuery = database.query("SELECT value FROM app_settings WHERE key = ? LIMIT 1");
const upsertSettingValueQuery = database.query(`
  INSERT INTO app_settings (key, value, updated_at)
  VALUES (?, ?, CURRENT_TIMESTAMP)
  ON CONFLICT(key) DO UPDATE SET
    value = excluded.value,
    updated_at = CURRENT_TIMESTAMP
`);

const getCacheRecordQuery = database.query(`
  SELECT video_id, title, file_path, file_size_bytes, duration_seconds, status, error_message, last_accessed_at
  FROM media_cache
  WHERE video_id = ?
  LIMIT 1
`);
const upsertCacheRecordQuery = database.query(`
  INSERT INTO media_cache (
    video_id, title, file_path, file_size_bytes, duration_seconds, status, error_message, last_accessed_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  ON CONFLICT(video_id) DO UPDATE SET
    title = excluded.title,
    file_path = excluded.file_path,
    file_size_bytes = excluded.file_size_bytes,
    duration_seconds = excluded.duration_seconds,
    status = excluded.status,
    error_message = excluded.error_message,
    last_accessed_at = CURRENT_TIMESTAMP,
    updated_at = CURRENT_TIMESTAMP
`);
const markCacheAccessedQuery = database.query(`
  UPDATE media_cache
  SET last_accessed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
  WHERE video_id = ?
`);
const deleteCacheRecordQuery = database.query("DELETE FROM media_cache WHERE video_id = ?");
const listEvictionCandidatesQuery = database.query(`
  SELECT video_id, file_path, file_size_bytes
  FROM media_cache
  WHERE status = 'ready'
  ORDER BY COALESCE(last_accessed_at, created_at) ASC
`);
const cacheUsageQuery = database.query(`
  SELECT COALESCE(SUM(file_size_bytes), 0) AS total_bytes, COUNT(*) AS file_count
  FROM media_cache
  WHERE status = 'ready'
`);

function listPinnedIds(): string[] {
  return selectPinnedIdsQuery.all().map((row) => String((row as { node_id: string }).node_id));
}

function togglePinnedId(nodeId: string): { pinned: boolean; pinnedIds: string[] } {
  const existing = findPinnedIdQuery.get(nodeId) as { node_id: string } | null;
  if (existing) {
    deletePinnedIdQuery.run(nodeId);
    return { pinned: false, pinnedIds: listPinnedIds() };
  }

  insertPinnedIdQuery.run(nodeId);
  return { pinned: true, pinnedIds: listPinnedIds() };
}

function getPlayerMode(): PlayerMode {
  const row = getSettingValueQuery.get("player_mode") as { value?: string } | null;
  return row?.value === "youtube" ? "youtube" : "local";
}

function setPlayerMode(playerMode: PlayerMode): { playerMode: PlayerMode } {
  upsertSettingValueQuery.run("player_mode", playerMode);
  return { playerMode };
}

function getCacheRecord(videoId: string): CacheRecord | null {
  return (getCacheRecordQuery.get(videoId) as CacheRecord | null) ?? null;
}

function upsertCacheRecord(record: {
  videoId: string;
  title: string | null;
  filePath: string | null;
  fileSizeBytes: number | null;
  durationSeconds: number | null;
  status: DownloadState;
  error: string | null;
}): void {
  upsertCacheRecordQuery.run(
    record.videoId,
    record.title,
    record.filePath,
    record.fileSizeBytes,
    record.durationSeconds,
    record.status,
    record.error
  );
}

function markCacheAccessed(videoId: string): void {
  markCacheAccessedQuery.run(videoId);
}

function deleteCacheRecord(videoId: string): void {
  deleteCacheRecordQuery.run(videoId);
}

function getCacheUsage(): { totalBytes: number; fileCount: number } {
  const row = cacheUsageQuery.get() as { total_bytes: number; file_count: number } | null;
  return {
    totalBytes: row?.total_bytes ?? 0,
    fileCount: row?.file_count ?? 0
  };
}

function clearCacheRecords(): void {
  database.exec("DELETE FROM media_cache");
}

const activeDownloads = new Map<string, ActiveDownload>();
const playbackUrlCache = new Map<string, { url: string; resolvedAt: number }>();

function getCurrentCacheFileInfo(videoId: string): { filePath: string | null; fileSizeBytes: number | null } {
  const filePath = findCachedFilePath(videoId);
  if (!filePath || !existsSync(filePath)) {
    return { filePath: null, fileSizeBytes: null };
  }

  return {
    filePath,
    fileSizeBytes: statSync(filePath).size
  };
}

function buildDownloadStatus(
  videoId: string,
  record: CacheRecord | null,
  origin: string
): DownloadStatus {
  if (!record) {
    return {
      videoId,
      state: "missing",
      mediaUrl: null,
      title: null,
      durationSeconds: null,
      fileSizeBytes: null,
      totalSizeBytes: null,
      progressPercent: null,
      isPartial: false,
      error: null
    };
  }

  const currentFile = getCurrentCacheFileInfo(videoId);
  const activeDownload = activeDownloads.get(videoId) ?? null;
  const hasPartialFile = Boolean(currentFile.filePath);
  const isReady = record.status === "ready" && hasPartialFile;

  return {
    videoId,
    state: (record.status as DownloadState) || "missing",
    mediaUrl:
      record.status === "downloading"
        ? `${origin}/stream/${videoId}`
        : isReady
          ? `${origin}/media/${videoId}`
          : null,
    title: activeDownload?.title ?? record.title,
    durationSeconds: activeDownload?.durationSeconds ?? record.duration_seconds,
    fileSizeBytes: activeDownload?.downloadedBytes ?? (isReady ? record.file_size_bytes : currentFile.fileSizeBytes ?? record.file_size_bytes),
    totalSizeBytes: activeDownload?.totalSizeBytes ?? record.file_size_bytes ?? null,
    progressPercent: activeDownload?.progressPercent ?? null,
    isPartial: record.status === "downloading",
    error: activeDownload?.error ?? record.error_message
  };
}

async function resolvePlaybackUrl(videoId: string): Promise<string> {
  const cached = playbackUrlCache.get(videoId);
  const maxAgeMs = 4 * 60 * 60 * 1000;
  if (cached && Date.now() - cached.resolvedAt < maxAgeMs) {
    return cached.url;
  }

  const url = await fetchPlaybackUrl(videoId);
  playbackUrlCache.set(videoId, { url, resolvedAt: Date.now() });
  return url;
}

function detectMimeType(filePath: string): string {
  if (filePath.endsWith(".mp4")) {
    return "video/mp4";
  }

  if (filePath.endsWith(".webm")) {
    return "video/webm";
  }

  if (filePath.endsWith(".mkv")) {
    return "video/x-matroska";
  }

  return "application/octet-stream";
}

function evictOldestCacheEntries(): void {
  let { totalBytes } = getCacheUsage();
  if (totalBytes <= MAX_CACHE_BYTES) {
    return;
  }

  const candidates = listEvictionCandidatesQuery.all() as Array<{
    video_id: string;
    file_path: string | null;
    file_size_bytes: number | null;
  }>;

  for (const candidate of candidates) {
    if (totalBytes <= MAX_CACHE_BYTES) {
      break;
    }

    if (activeDownloads.has(candidate.video_id)) {
      continue;
    }

    if (candidate.file_path && existsSync(candidate.file_path)) {
      unlinkSync(candidate.file_path);
    }

    deleteCacheRecord(candidate.video_id);
    totalBytes -= candidate.file_size_bytes ?? 0;
  }
}

async function startVideoDownload(videoId: string): Promise<void> {
  const activeDownload = activeDownloads.get(videoId) ?? null;
  upsertCacheRecord({
    videoId,
    title: null,
    filePath: null,
    fileSizeBytes: null,
    durationSeconds: null,
    status: "downloading",
    error: null
  });

  try {
    const result = await downloadVideoToCache(videoId, {
      onMetadata: (metadata) => {
        if (!activeDownload) {
          return;
        }

        activeDownload.title = metadata.title;
        activeDownload.durationSeconds = metadata.durationSeconds;
        activeDownload.totalSizeBytes = metadata.totalSizeBytes;

        upsertCacheRecord({
          videoId,
          title: metadata.title,
          filePath: null,
          fileSizeBytes: null,
          durationSeconds: metadata.durationSeconds,
          status: "downloading",
          error: null
        });
      },
      onProgress: (progress) => {
        if (!activeDownload) {
          return;
        }
        activeDownload.downloadedBytes = progress.downloadedBytes;
        activeDownload.totalSizeBytes = progress.totalSizeBytes;
        activeDownload.progressPercent = progress.progressPercent;
      },
      onSpawn: (handle) => {
        if (!activeDownload) {
          return;
        }
        activeDownload.cancel = () => {
          activeDownload.cancelled = true;
          handle.kill();
        };
      }
    });

    upsertCacheRecord({
      videoId,
      title: result.title,
      filePath: result.filePath,
      fileSizeBytes: result.fileSizeBytes,
      durationSeconds: result.durationSeconds,
      status: "ready",
      error: null
    });
    if (activeDownload) {
      activeDownload.downloadedBytes = result.fileSizeBytes;
      activeDownload.totalSizeBytes = result.totalSizeBytes ?? result.fileSizeBytes;
      activeDownload.progressPercent = 100;
    }
    markCacheAccessed(videoId);
    evictOldestCacheEntries();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (activeDownload?.cancelled) {
      clearCachedVideo(videoId);
      upsertCacheRecord({
        videoId,
        title: null,
        filePath: null,
        fileSizeBytes: null,
        durationSeconds: null,
        status: "cancelled",
        error: null
      });
      return;
    }

    if (activeDownload) {
      activeDownload.error = message;
    }
    upsertCacheRecord({
      videoId,
      title: null,
      filePath: null,
      fileSizeBytes: null,
      durationSeconds: null,
      status: "error",
      error: message
    });
  } finally {
    activeDownloads.delete(videoId);
  }
}

async function ensureVideoPrepared(videoId: string, origin: string): Promise<DownloadStatus> {
  const record = getCacheRecord(videoId);
  if (record?.status === "ready" && record.file_path && existsSync(record.file_path)) {
    markCacheAccessed(videoId);
    return buildDownloadStatus(videoId, getCacheRecord(videoId), origin);
  }

  if (!activeDownloads.has(videoId)) {
    const activeDownload: ActiveDownload = {
      promise: Promise.resolve(),
      title: null,
      durationSeconds: null,
      downloadedBytes: null,
      totalSizeBytes: null,
      progressPercent: null,
      error: null,
      cancelled: false,
      cancel: () => undefined
    };
    activeDownloads.set(videoId, activeDownload);
    activeDownload.promise = startVideoDownload(videoId);
  }

  return buildDownloadStatus(videoId, getCacheRecord(videoId), origin);
}

function parseRangeHeader(rangeHeader: string, fileSize: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match) {
    return null;
  }

  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) {
    return null;
  }

  if (!rawStart) {
    const suffixLength = Number.parseInt(rawEnd, 10);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
      return null;
    }
    const start = Math.max(fileSize - suffixLength, 0);
    return { start, end: fileSize - 1 };
  }

  const start = Number.parseInt(rawStart, 10);
  const end = rawEnd ? Number.parseInt(rawEnd, 10) : fileSize - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start > end || end >= fileSize) {
    return null;
  }

  return { start, end };
}

function createMediaResponse(request: Request, filePath: string): Response {
  const mimeType = detectMimeType(filePath);
  const fileSize = statSync(filePath).size;
  const rangeHeader = request.headers.get("range");
  const baseHeaders = {
    "accept-ranges": "bytes",
    "cache-control": "no-store",
    "content-type": mimeType
  };

  if (!rangeHeader) {
    return new Response(Bun.file(filePath), {
      headers: {
        ...baseHeaders,
        "content-length": String(fileSize)
      }
    });
  }

  const range = parseRangeHeader(rangeHeader, fileSize);
  if (!range) {
    return new Response(null, {
      status: 416,
      headers: {
        ...baseHeaders,
        "content-range": `bytes */${fileSize}`
      }
    });
  }

  const { start, end } = range;
  const chunkSize = end - start + 1;
  return new Response(Bun.file(filePath).slice(start, end + 1), {
    status: 206,
    headers: {
      ...baseHeaders,
      "content-length": String(chunkSize),
      "content-range": `bytes ${start}-${end}/${fileSize}`
    }
  });
}

function getFrontendRoot(): string {
  const bundledFrontendRoot = join(import.meta.dir, "frontend");
  if (existsSync(join(bundledFrontendRoot, "index.html"))) {
    return bundledFrontendRoot;
  }

  return join(process.cwd(), "dist");
}

function createFrontendServer(): Bun.Server<undefined> {
  const frontendRoot = getFrontendRoot();
  let server: Bun.Server<undefined>;
  const apiCorsHeaders = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "cache-control": "no-store"
  };

  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const origin = `http://127.0.0.1:${server.port}`;

      if (url.pathname.startsWith("/api/") && request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: apiCorsHeaders });
      }

      if (url.pathname === "/api/pins" && request.method === "GET") {
        return Response.json({ pinnedIds: listPinnedIds() }, { headers: apiCorsHeaders });
      }

      if (url.pathname === "/api/pins/toggle" && request.method === "POST") {
        const body = await request.json() as { nodeId?: string };
        if (!body.nodeId) {
          return Response.json({ error: "Missing node id" }, { status: 400, headers: apiCorsHeaders });
        }

        return Response.json(togglePinnedId(body.nodeId), { headers: apiCorsHeaders });
      }

      if (url.pathname === "/api/app-status" && request.method === "GET") {
        const cacheUsage = getCacheUsage();
        const ytDlpState = getYtDlpRuntimeState();
        return Response.json({
          ytDlpVersion: ytDlpState.version,
          ytDlpStatus: ytDlpState.status,
          ytDlpError: ytDlpState.error,
          cacheBytes: cacheUsage.totalBytes,
          cacheFiles: cacheUsage.fileCount,
          maxCacheBytes: MAX_CACHE_BYTES
        }, { headers: apiCorsHeaders });
      }

      if (url.pathname === "/api/settings" && request.method === "GET") {
        return Response.json({ playerMode: getPlayerMode() }, { headers: apiCorsHeaders });
      }

      if (url.pathname === "/api/settings" && request.method === "POST") {
        const body = await request.json() as { playerMode?: string };
        if (body.playerMode !== "local" && body.playerMode !== "youtube") {
          return Response.json({ error: "Invalid player mode" }, { status: 400, headers: apiCorsHeaders });
        }

        return Response.json(setPlayerMode(body.playerMode), { headers: apiCorsHeaders });
      }

      if (url.pathname === "/api/cache/open" && request.method === "POST") {
        openCacheDirectory();
        return Response.json({ ok: true }, { headers: apiCorsHeaders });
      }

      if (url.pathname === "/api/cache/clear" && request.method === "POST") {
        if (activeDownloads.size > 0) {
          return Response.json({ error: "Cannot clear cache while downloads are active." }, { status: 409, headers: apiCorsHeaders });
        }

        clearCacheDirectory();
        clearCacheRecords();
        const cacheUsage = getCacheUsage();
        return Response.json({ ok: true, cacheBytes: cacheUsage.totalBytes, cacheFiles: cacheUsage.fileCount }, {
          headers: apiCorsHeaders
        });
      }

      if (url.pathname === "/api/media/prepare" && request.method === "POST") {
        const body = await request.json() as { videoId?: string };
        if (!body.videoId) {
          return Response.json({ error: "Missing video id" }, { status: 400, headers: apiCorsHeaders });
        }

        const status = await ensureVideoPrepared(body.videoId, origin);
        return Response.json(status, { headers: apiCorsHeaders });
      }

      if (url.pathname === "/api/media/cancel" && request.method === "POST") {
        const body = await request.json() as { videoId?: string };
        if (!body.videoId) {
          return Response.json({ error: "Missing video id" }, { status: 400, headers: apiCorsHeaders });
        }

        const activeDownload = activeDownloads.get(body.videoId);
        if (!activeDownload) {
          clearCachedVideo(body.videoId);
          upsertCacheRecord({
            videoId: body.videoId,
            title: null,
            filePath: null,
            fileSizeBytes: null,
            durationSeconds: null,
            status: "cancelled",
            error: null
          });
          return Response.json(buildDownloadStatus(body.videoId, getCacheRecord(body.videoId), origin), {
            headers: apiCorsHeaders
          });
        }

        activeDownload.cancelled = true;
        activeDownload.cancel();
        clearCachedVideo(body.videoId);
        playbackUrlCache.delete(body.videoId);
        return Response.json({
          videoId: body.videoId,
          state: "cancelled",
          mediaUrl: null,
          title: null,
          durationSeconds: null,
          fileSizeBytes: null,
          totalSizeBytes: null,
          progressPercent: null,
          isPartial: false,
          error: null
        } satisfies DownloadStatus, { headers: apiCorsHeaders });
      }

      if (url.pathname === "/api/media/status" && request.method === "GET") {
        const videoId = url.searchParams.get("videoId");
        if (!videoId) {
          return Response.json({ error: "Missing video id" }, { status: 400, headers: apiCorsHeaders });
        }

        return Response.json(buildDownloadStatus(videoId, getCacheRecord(videoId), origin), {
          headers: apiCorsHeaders
        });
      }

      if (url.pathname.startsWith("/media/") && request.method === "GET") {
        const videoId = url.pathname.split("/").pop();
        if (!videoId) {
          return new Response("Missing video id", { status: 400 });
        }

        const record = getCacheRecord(videoId);
        const filePath =
          record?.status === "ready" && record.file_path && existsSync(record.file_path)
            ? record.file_path
            : null;

        if (!filePath || !existsSync(filePath)) {
          return new Response("Media not found", { status: 404 });
        }

        markCacheAccessed(videoId);
        return createMediaResponse(request, filePath);
      }

      if (url.pathname.startsWith("/stream/") && request.method === "GET") {
        const videoId = url.pathname.split("/").pop();
        if (!videoId) {
          return new Response("Missing video id", { status: 400 });
        }

        try {
          const playbackUrl = await resolvePlaybackUrl(videoId);
          const upstreamHeaders = new Headers();
          const rangeHeader = request.headers.get("range");
          if (rangeHeader) {
            upstreamHeaders.set("range", rangeHeader);
          }

          const upstream = await fetch(playbackUrl, {
            headers: upstreamHeaders,
            redirect: "follow"
          });

          const responseHeaders = new Headers();
          const contentType = upstream.headers.get("content-type");
          const contentLength = upstream.headers.get("content-length");
          const contentRange = upstream.headers.get("content-range");
          const acceptRanges = upstream.headers.get("accept-ranges");

          responseHeaders.set("cache-control", "no-store");
          if (contentType) {
            responseHeaders.set("content-type", contentType);
          }
          if (contentLength) {
            responseHeaders.set("content-length", contentLength);
          }
          if (contentRange) {
            responseHeaders.set("content-range", contentRange);
          }
          if (acceptRanges) {
            responseHeaders.set("accept-ranges", acceptRanges);
          }

          return new Response(upstream.body, {
            status: upstream.status,
            headers: responseHeaders
          });
        } catch (error) {
          return new Response(error instanceof Error ? error.message : "Failed to stream video", {
            status: 502
          });
        }
      }

      if (url.pathname.startsWith("/youtube/")) {
        const videoId = url.pathname.split("/").pop();
        if (!videoId) {
          return new Response("Missing video id", { status: 400 });
        }

        const embedUrl = `https://www.youtube.com/embed/${videoId}?controls=1&rel=0&origin=${encodeURIComponent(origin)}`;
        const html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="referrer" content="origin" />
    <title>Loading video…</title>
    <style>
      html, body {
        width: 100%;
        height: 100%;
        margin: 0;
        background: #000;
        color: #fff;
        display: grid;
        place-items: center;
        font: 16px -apple-system, BlinkMacSystemFont, sans-serif;
      }
    </style>
  </head>
  <body>
    <div>Loading video…</div>
    <script>
      window.location.replace(${JSON.stringify(embedUrl)});
    </script>
  </body>
</html>`;

        return new Response(html, {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store"
          }
        });
      }

      const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
      const relativePath = pathname.replace(/^\/+/, "");
      const filePath = join(frontendRoot, relativePath);

      if (!existsSync(filePath)) {
        return new Response("Not found", { status: 404 });
      }

      return new Response(Bun.file(filePath));
    }
  });

  return server;
}

async function getMainViewUrl(): Promise<{ url: string; server: Bun.Server<undefined> | null }> {
  const server = createFrontendServer();
  const appOrigin = encodeURIComponent(`http://127.0.0.1:${server.port}`);
  const channel = await Updater.localInfo.channel();
  if (channel === "dev") {
    try {
      await fetch(DEV_SERVER_URL, { method: "HEAD" });
      console.log(`HMR enabled: using Vite dev server at ${DEV_SERVER_URL}`);
      return { url: `${DEV_SERVER_URL}?appOrigin=${appOrigin}`, server };
    } catch {
      console.log("Vite dev server not running. Run 'bun run dev:hmr' for HMR support.");
    }
  }

  const url = `http://127.0.0.1:${server.port}?appOrigin=${appOrigin}`;
  console.log(`Serving bundled frontend from ${url}`);
  return { url, server };
}

function applyMacOSWindowEffects(mainWindow: BrowserWindow) {
  const dylibPath = join(import.meta.dir, "libMacWindowEffects.dylib");

  if (!existsSync(dylibPath)) {
    console.warn(`Native macOS effects lib not found at ${dylibPath}.`);
    return;
  }

  try {
    const lib = dlopen(dylibPath, {
      enableWindowVibrancy: {
        args: [FFIType.ptr],
        returns: FFIType.bool
      },
      ensureWindowShadow: {
        args: [FFIType.ptr],
        returns: FFIType.bool
      },
      setWindowTrafficLightsPosition: {
        args: [FFIType.ptr, FFIType.f64, FFIType.f64],
        returns: FFIType.bool
      },
      setNativeWindowDragRegion: {
        args: [FFIType.ptr, FFIType.f64, FFIType.f64, FFIType.f64],
        returns: FFIType.bool
      }
    });

    const alignButtons = () =>
      lib.symbols.setWindowTrafficLightsPosition(mainWindow.ptr, MAC_TRAFFIC_LIGHTS_X, MAC_TRAFFIC_LIGHTS_Y);
    const alignNativeDragRegion = () =>
      lib.symbols.setNativeWindowDragRegion(
        mainWindow.ptr,
        MAC_NATIVE_DRAG_REGION_X,
        MAC_NATIVE_DRAG_REGION_WIDTH,
        MAC_NATIVE_DRAG_REGION_HEIGHT
      );

    lib.symbols.enableWindowVibrancy(mainWindow.ptr);
    lib.symbols.ensureWindowShadow(mainWindow.ptr);
    alignButtons();
    alignNativeDragRegion();

    setTimeout(() => {
      alignButtons();
      alignNativeDragRegion();
    }, 120);

    mainWindow.on("resize", () => {
      alignButtons();
      alignNativeDragRegion();
    });
  } catch (error) {
    console.warn("Failed to apply native macOS effects:", error);
  }
}

function setupMacOSMenu(mainWindow: BrowserWindow) {
  ApplicationMenu.setApplicationMenu([
    {
      submenu: [{ role: "quit" }]
    },
    {
      label: "File",
      submenu: [
        {
          label: "Close Window",
          action: "close-main-window",
          accelerator: "w"
        },
        { type: "separator" },
        { role: "quit" }
      ]
    },
    {
      label: "Window",
      submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "bringAllToFront" }]
    }
  ]);

  ApplicationMenu.on("application-menu-clicked", (event: unknown) => {
    const action = (event as { data?: { action?: string } })?.data?.action;
    if (action === "close-main-window") {
      mainWindow.close();
    }
  });
}

void ensureYtDlpReady(true);
setInterval(() => {
  void ensureYtDlpReady(false);
}, YT_DLP_UPDATE_INTERVAL_MS);

const { url, server } = await getMainViewUrl();
const isMacOS = process.platform === "darwin";

const mainWindow = new BrowserWindow({
  title: "Kids Video Playlist",
  url,
  frame: {
    width: 1200,
    height: 800,
    x: 160,
    y: 120
  },
  ...(isMacOS && !DEBUG_SAFE_WINDOW
    ? {
        titleBarStyle: "hiddenInset" as const,
        transparent: true
      }
    : {})
});

if (isMacOS && !DEBUG_SAFE_WINDOW) {
  applyMacOSWindowEffects(mainWindow);
  setupMacOSMenu(mainWindow);
}

mainWindow.on("close", () => {
  server?.stop(true);
  Utils.quit();
});

console.log("yt-embeds-electrobun started");
