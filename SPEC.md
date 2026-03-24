# yt-embeds-electrobun Spec

## Goal

Build an ElectroBun version of the playlist/video browser that keeps the curated node-based app flow, uses native macOS blur for the shell, and supports two playback modes:

- a local downloader-backed player that streams immediately and caches to disk
- a retained YouTube webview player for comparison and fallback

The app should feel like a small curated media library rather than a generic YouTube client.

## Current Product Shape

### Navigation

The app has four primary surfaces:

- `Home`: pinned nodes
- `Discover`: hardcoded videos and playlists
- `Video`: single video page
- `Playlist`: playlist page with multiple layout modes
- `Settings`: global player mode and cache actions

### Content graph

Content is currently hardcoded in `src/mainview/content.ts`.

Each node has:

- `video` or `playlist` kind
- title, description, channel, accent
- parent relationships
- child relationships

Playlist pages support:

- `left` mode
- `top` mode
- `dropdown` mode

## Player Modes

### Local player

The default mode is the local downloader-backed player.

Behavior:

1. Opening a video calls `POST /api/media/prepare`.
2. The backend checks cache state in SQLite plus the cache directory.
3. If a full cached file exists, playback can use the local `/media/:videoId` route.
4. If not, the backend starts a background `yt-dlp` download into the app-owned cache.
5. During download, the player can start immediately through a proxied stream route while the cache fill continues in parallel.
6. When the download finishes, the cache is preserved for future launches.

### YouTube player

The previous YouTube webview player is still present and selectable in Settings.

Behavior:

- uses the existing ElectroBun webview path
- keeps the recommendation-hiding logic already built for the project
- remains useful for comparison and edge-case testing

## Local Player UX

The local player is a custom HTML5 video player, not the browser's default control set.

### Core controls

- single Play/Pause button
- custom seek bar
- current time and full duration
- inline download progress row under the video while a cache download is active
- inline `Cancel Download` button during active download only

### Streaming while downloading

The player does not wait for the full cache file to finish.

Instead:

- the playback button can start immediately
- playback uses a proxied streaming source during active download
- the cache download continues in the background until complete
- pausing playback does not stop the download
- `Cancel Download` stops the background downloader and deletes partial cache artifacts

### Stable duration timeline

The player should use the real video duration from `yt-dlp` metadata as soon as it is known.

The seek bar should:

- keep a stable full-length timeline instead of rescaling as more bytes arrive
- show played portion
- show downloaded/available portion
- show unavailable remainder
- prevent seeking past the currently available portion

### Overlay policy

The centered overlay should be reserved for exceptional states such as:

- download failure
- playback failure
- cancelled state with explicit restart action

Normal download progress belongs in the inline control area, not in a blocking modal overlay.

## App-Owned Runtime Assets

All downloader runtime assets must remain app-local, not user-global.

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

- download `yt-dlp` into the app-local `bin/` directory on first run
- do not depend on `PATH`
- do not use Homebrew, pip, npm, or any system/user install

### Updating

- check/update on launch
- re-check periodically while the app stays open
- expose the current resolved version and updater state to the UI footer

### Footer visibility

The footer should show:

- current `yt-dlp` version if known
- updater state: `initializing`, `updating`, `ready`, or `error`
- cache usage summary
- active global player mode

## Persistence

SQLite is the source of truth for persistent app state.

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

#### `app_settings`

- `key TEXT PRIMARY KEY`
- `value TEXT NOT NULL`
- `updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP`

### Persisted behaviors

- pinned nodes persist across launches
- global player mode persists across launches
- cache metadata persists across launches
- cached video files persist across launches until explicitly cleared or evicted

## Cache Policy

### File storage

- cached files live in `cache/`
- filenames are based on YouTube `videoId`
- one canonical cached playable file per video ID

### Size budget

- hard max cache size: `2 GiB`

### Eviction

- evict least recently accessed `ready` files first
- never evict an active download
- update `last_accessed_at` whenever cached media is served

### User actions

Settings should provide:

- `Open Cache Folder`
- `Clear Cache`

`Clear Cache` should refuse to run while downloads are active.

## Backend API

### Pins

- `GET /api/pins`
- `POST /api/pins/toggle`

### Settings

- `GET /api/settings`
- `POST /api/settings`

Currently persisted settings include:

- `player_mode`: `local` or `youtube`

### App status

- `GET /api/app-status`

Returns:

- `ytDlpVersion`
- `ytDlpStatus`
- `ytDlpError`
- `cacheBytes`
- `cacheFiles`
- `maxCacheBytes`

### Media lifecycle

- `POST /api/media/prepare`
- `GET /api/media/status?videoId=...`
- `POST /api/media/cancel`
- `GET /media/:videoId`
- `GET /stream/:videoId`

Behavior:

- `/api/media/prepare` starts or reuses download preparation
- `/api/media/status` returns current title, duration, size, progress, state, and media URL
- `/api/media/cancel` stops the downloader and removes partial cache artifacts
- `/media/:videoId` serves completed cached files with byte-range support
- `/stream/:videoId` proxies an active playback stream for immediate start while downloading

## Current Sample Content

Discover currently includes, among others:

- `BeamNG Drive - Realistic Car Crashes | Dangerous Driving #9`
- `YouTube API Demo Clip`
- `Sample Embedded Video`
- `Embed Disabled Test Video` for `yvr9TXXc9Hw`

These nodes exist mainly to exercise:

- single-video flow
- playlist flow
- pinned content
- local playback vs YouTube playback comparison
- embed-disabled behavior

## Non-Goals

- no dependence on global `yt-dlp`
- no external DB service
- no requirement to preserve normal YouTube endscreen behavior in local mode
- no requirement to preserve YouTube ads in local mode

## Verification

### Required

- `bun run typecheck`
- `bun run build`

### Useful smoke checks

- open a video in local mode and confirm immediate playback can start while download continues
- confirm inline download progress and cancel control are visible during active download
- confirm completed video reopens from cache after relaunch
- confirm pinned content persists across relaunch
- confirm player mode persists across relaunch
- confirm footer shows `yt-dlp` status/version
- confirm cache clear/open actions work
- confirm YouTube mode still launches the retained webview player
