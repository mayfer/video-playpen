# yt-embeds-electrobun Local Playback Spec

## Goal

Replace the current primary YouTube-embed playback path with a local-file playback path driven by `yt-dlp`, while keeping the existing ElectroBun YouTube webview player component in the codebase for future fallback or comparison work.

The app should behave like a curated local video library:

- choose a hardcoded video or playlist node
- prepare a local playable file for the selected video
- play that local file in the app's own video player
- reuse cached files across launches
- keep cache size bounded automatically

## Non-Goals

- no attempt to preserve YouTube endscreen behavior
- no attempt to preserve embedded ads
- no dependence on user-global or OS-global `yt-dlp`
- no external DB service

## Playback Strategy

### Primary path

1. User opens a video or playlist item.
2. Frontend requests `/api/media/prepare` for the target `videoId`.
3. Backend checks SQLite metadata and the cache directory.
4. If a valid cached file exists, backend returns a local `/media/:videoId` URL.
5. If not, backend starts a background `yt-dlp` download into the app-owned cache directory and returns a `downloading` state.
6. Frontend polls `/api/media/status`.
7. Once ready, frontend switches the HTML5 `<video>` element to the local `/media/:videoId` URL and plays it with native media controls.

### Retained fallback

The existing `SafeYouTubePlayer` component remains in the codebase, but it is not the default playback path anymore.

## App-Owned Runtime Assets

All runtime assets live inside the app data directory, not in user-global package locations.

### App data root

- macOS: `~/Library/Application Support/yt-embeds-electrobun`
- Windows: `%APPDATA%/yt-embeds-electrobun`
- Linux: `~/.local/share/yt-embeds-electrobun`

### Required subpaths

- `bin/yt-dlp` or `bin/yt-dlp.exe`
- `cache/`
- `app.sqlite`

## yt-dlp Management

### Installation

- On first launch, if the app-local binary is missing, download it into `bin/`.
- Do not invoke `yt-dlp` from `PATH`.
- Do not install with Homebrew, pip, npm, or other system/user package managers.

### Updating

- On launch, run an update check.
- While the app stays open, re-check periodically.
- Keep the current resolved version in memory and expose it to the UI.

### UI visibility

Show downloader status in the app footer:

- current `yt-dlp` version if available
- updater state: initializing, updating, ready, or error
- cache usage summary

## Storage Model

SQLite is the source of truth for persistent app metadata.

### Tables

#### `pinned_nodes`

- `node_id TEXT PRIMARY KEY`
- `pinned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP`

#### `media_cache`

- `video_id TEXT PRIMARY KEY`
- `title TEXT`
- `file_path TEXT`
- `file_size_bytes INTEGER`
- `duration_seconds REAL`
- `status TEXT NOT NULL`
- `error_message TEXT`
- `last_accessed_at TEXT`
- `created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP`
- `updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP`

### State meanings

- `missing`: no cached file tracked
- `downloading`: `yt-dlp` job in progress
- `ready`: cached file exists and is playable
- `error`: last prepare attempt failed

## Cache Policy

### File storage

- Cache downloaded files in `cache/`.
- Use predictable names based on YouTube `videoId`.
- One playable file per video ID.

### Size budget

- Set a hard max cache size in bytes.
- Current implementation target: `2 GiB`.

### Eviction

- Evict least recently accessed ready files first.
- Never evict a file currently being downloaded.
- Update `last_accessed_at` whenever a cached file is served or selected for playback.

### Serving

- Serve cached files through the local Bun server.
- Support HTTP byte-range requests so the native video element can seek correctly.

## Frontend Player

### New default player

Use a dedicated local-file player component backed by HTML5 `<video>`.

Required behaviors:

- same high-level interface as the old player component:
  - `loadVideo(videoId)`
  - `togglePlayback()`
  - `replay()`
  - `onStateChange(listener)`
  - `dispose()`
- emits player snapshots for:
  - loading
  - playing
  - paused
  - buffering
  - ended
- displays a local status overlay while preparing or downloading
- displays retry affordance on failure

### Existing page flows

The routed UI remains:

- individual video page
- playlist page with `left`, `top`, and `dropdown` modes
- Home with pinned items
- Discover with hardcoded sample nodes
- node parent/child relationships and collapsed child section

Only the playback engine changes.

## Backend API

### `GET /api/pins`

Returns current pinned node IDs.

### `POST /api/pins/toggle`

Toggles a node pin and returns updated pinned IDs.

### `GET /api/app-status`

Returns:

- `ytDlpVersion`
- `ytDlpStatus`
- `ytDlpError`
- `cacheBytes`
- `cacheFiles`
- `maxCacheBytes`

### `POST /api/media/prepare`

Request body:

- `videoId`

Behavior:

- return `ready` immediately if cache is valid
- otherwise mark/download in background and return current state

### `GET /api/media/status?videoId=...`

Returns latest known persistent state for a video.

### `GET /media/:videoId`

Streams the cached file with byte-range support.

## Verification

Minimum verification for each iteration:

- `bun run typecheck`
- `bun run build`

Runtime smoke checks:

- launch app and open a normal video page
- confirm initial prepare/download overlay appears
- confirm local playback starts once file is ready
- confirm footer shows `yt-dlp` version/status
- confirm pinned items still persist across launches
- confirm cache survives relaunch
- confirm playback seeking works after the file is cached
