import { clearCachedVideo, downloadVideoToCache, ensureYtDlpReady, findCachedFilePath, getYtDlpRuntimeState } from "../src/bun/downloader";

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

const args = Bun.argv.slice(2);
const videoId = args.find((arg) => !arg.startsWith("--")) ?? "M7lc1UVf-VE";
const fresh = args.includes("--fresh");

if (fresh) {
  clearCachedVideo(videoId);
}

console.log(`Testing downloader for video ${videoId}`);
console.log(`Cached file before run: ${findCachedFilePath(videoId) ?? "none"}`);

await ensureYtDlpReady();
const ytDlp = getYtDlpRuntimeState();
console.log(`Using yt-dlp ${ytDlp.version ?? "unknown"} from ${ytDlp.binaryPath}`);

let lastLine = "";
const startedAt = Date.now();

const result = await downloadVideoToCache(videoId, {
  onProgress: (progress) => {
    const progressText =
      progress.totalSizeBytes && progress.totalSizeBytes > 0
        ? `${formatBytes(progress.downloadedBytes)} / ${formatBytes(progress.totalSizeBytes)}${typeof progress.progressPercent === "number" ? ` (${progress.progressPercent.toFixed(1)}%)` : ""}`
        : `${formatBytes(progress.downloadedBytes)} downloaded`;

    if (progressText === lastLine) {
      return;
    }

    lastLine = progressText;
    console.log(progressText);
  }
});

console.log(`Completed in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
console.log(`Title: ${result.title ?? "unknown"}`);
console.log(`Duration: ${result.durationSeconds ?? "unknown"}s`);
console.log(`File: ${result.filePath}`);
console.log(`Size: ${formatBytes(result.fileSizeBytes)}`);
