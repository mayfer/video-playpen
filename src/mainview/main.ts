import "./index.css";
import {
  type ContentNode,
  type PlaylistDisplayMode,
  type PlaylistNode,
  type VideoNode,
  getChildren,
  getDiscoverNodes,
  getNode,
  getNodeThumbnail,
  getNodeUrl,
  getParents,
  getPlaylistItems
} from "./content";
import { CachedVideoPlayer } from "./local_player";
import { SafeYouTubePlayer, type PlayerSnapshot } from "./player";

type PlayerMode = "local" | "youtube";

type AppStatus = {
  ytDlpVersion: string | null;
  ytDlpStatus: "initializing" | "ready" | "updating" | "error";
  ytDlpError: string | null;
  cacheBytes: number;
  cacheFiles: number;
  maxCacheBytes: number;
};

type AppSettings = {
  playerMode: PlayerMode;
};

type ActivePlayer = {
  dispose: () => void;
  loadVideo: (videoId: string) => void;
  onStateChange: (listener: (snapshot: PlayerSnapshot) => void) => void;
  togglePlayback: () => void;
  replay: () => void;
  element: HTMLElement;
};

let activePlayer: ActivePlayer | null = null;
let pinnedIds = new Set<string>();
let pinsLoaded = false;
let settingsLoaded = false;
let appStatus: AppStatus | null = null;
let appSettings: AppSettings = { playerMode: "local" };
let statusPollTimer: number | null = null;

function getAppServerOrigin(): string {
  const params = new URLSearchParams(window.location.search);
  return params.get("appOrigin") ?? params.get("ytProxyOrigin") ?? window.location.origin;
}

async function loadPinnedIds(): Promise<void> {
  const response = await fetch(`${getAppServerOrigin()}/api/pins`);
  const data = await response.json() as { pinnedIds?: string[] };
  pinnedIds = new Set(data.pinnedIds ?? []);
  pinsLoaded = true;
}

async function loadAppStatus(): Promise<void> {
  const response = await fetch(`${getAppServerOrigin()}/api/app-status`);
  appStatus = await response.json() as AppStatus;
  refreshFooter();
}

async function loadAppSettings(): Promise<void> {
  const response = await fetch(`${getAppServerOrigin()}/api/settings`);
  appSettings = await response.json() as AppSettings;
  settingsLoaded = true;
  refreshFooter();
}

function startStatusPolling(): void {
  if (statusPollTimer !== null) {
    return;
  }

  statusPollTimer = window.setInterval(() => {
    void loadAppStatus()
      .catch((error) => {
        console.error("Failed to refresh app status", error);
      });
  }, 15000);
}

function isPinned(nodeId: string): boolean {
  return pinnedIds.has(nodeId);
}

function getPlayerMode(): PlayerMode {
  return appSettings.playerMode;
}

async function togglePinned(nodeId: string): Promise<void> {
  const response = await fetch(`${getAppServerOrigin()}/api/pins/toggle`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({ nodeId })
  });
  const data = await response.json() as { pinnedIds?: string[] };
  pinnedIds = new Set(data.pinnedIds ?? []);
  renderApp();
}

async function updatePlayerMode(playerMode: PlayerMode): Promise<void> {
  const response = await fetch(`${getAppServerOrigin()}/api/settings`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({ playerMode })
  });
  appSettings = await response.json() as AppSettings;
  settingsLoaded = true;
  renderApp();
}

async function openCacheFolder(): Promise<void> {
  await fetch(`${getAppServerOrigin()}/api/cache/open`, {
    method: "POST"
  });
}

async function clearCache(): Promise<void> {
  const response = await fetch(`${getAppServerOrigin()}/api/cache/clear`, {
    method: "POST"
  });

  if (!response.ok) {
    const payload = await response.json() as { error?: string };
    throw new Error(payload.error ?? "Failed to clear cache.");
  }

  await loadAppStatus();
  renderApp();
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

function formatNodeKind(node: ContentNode): string {
  return node.kind === "video" ? "Video" : "Playlist";
}

function getRoute(): { page: "home" | "discover" | "settings" | "video" | "playlist"; nodeId?: string; mode?: PlaylistDisplayMode; index?: number } {
  const hash = window.location.hash || "#/";
  const [rawPath, rawQuery] = hash.slice(1).split("?");
  const segments = rawPath.split("/").filter(Boolean);
  const query = new URLSearchParams(rawQuery ?? "");

  if (segments[0] === "settings") {
    return { page: "settings" };
  }

  if (segments[0] === "discover") {
    return { page: "discover" };
  }

  if (segments[0] === "video" && segments[1]) {
    return { page: "video", nodeId: segments[1] };
  }

  if (segments[0] === "playlist" && segments[1]) {
    const modeParam = query.get("mode");
    const mode = modeParam === "top" || modeParam === "dropdown" ? modeParam : "left";
    const rawIndex = Number.parseInt(query.get("index") ?? "0", 10);
    return {
      page: "playlist",
      nodeId: segments[1],
      mode,
      index: Number.isFinite(rawIndex) ? Math.max(0, rawIndex) : 0
    };
  }

  return { page: "home" };
}

function disposeActivePlayer(): void {
  activePlayer?.dispose();
  activePlayer = null;
}

function createNavLink(label: string, href: string, active = false): HTMLAnchorElement {
  const link = createElement("a", active ? "nav-link nav-link-active" : "nav-link", label);
  link.href = href;
  return link;
}

function createPinButton(node: ContentNode): HTMLButtonElement {
  const pinned = isPinned(node.id);
  const button = createElement(
    "button",
    pinned ? "pill-button pill-button-active" : "pill-button",
    pinned ? "Unpin" : "Pin"
  );
  button.addEventListener("click", () => {
    void togglePinned(node.id);
  });
  return button;
}

function createNodeCard(node: ContentNode, compact = false): HTMLElement {
  const card = createElement("article", compact ? "node-card node-card-compact" : "node-card");
  const link = createElement("a", "node-card-link") as HTMLAnchorElement;
  link.href = getNodeUrl(node);

  const thumb = createElement("div", `node-thumb node-thumb-${node.accent}`);
  const image = document.createElement("img");
  image.src = getNodeThumbnail(node);
  image.alt = node.title;
  image.loading = "lazy";
  thumb.appendChild(image);

  const body = createElement("div", "node-card-body");
  const meta = createElement("div", "node-meta");
  meta.append(
    createElement("span", "node-kind", formatNodeKind(node)),
    createElement("span", "node-channel", node.channel)
  );

  const title = createElement("h3", "node-card-title", node.title);
  const description = createElement("p", "muted node-description", node.description);

  body.append(meta, title);
  if (!compact) {
    body.append(description);
  }

  link.append(thumb, body);

  const footer = createElement("div", "node-card-footer");
  footer.append(createPinButton(node));

  card.append(link, footer);
  return card;
}

function createParentLinks(node: ContentNode): HTMLElement | null {
  const parents = getParents(node);
  if (parents.length === 0) {
    return null;
  }

  const section = createElement("div", "parent-links");
  section.appendChild(createElement("span", "detail-label", "Parents"));

  const row = createElement("div", "chip-row");
  for (const parent of parents) {
    const link = createElement("a", "chip-link", parent.title) as HTMLAnchorElement;
    link.href = getNodeUrl(parent);
    row.appendChild(link);
  }

  section.appendChild(row);
  return section;
}

function createChildrenDisclosure(node: ContentNode): HTMLElement | null {
  const children = getChildren(node);
  if (children.length === 0) {
    return null;
  }

  const disclosure = createElement("details", "children-disclosure");
  const summary = createElement("summary", "children-summary", `${children.length} children`);
  const grid = createElement("div", "children-grid");

  for (const child of children) {
    grid.appendChild(createNodeCard(child, true));
  }

  disclosure.append(summary, grid);
  return disclosure;
}

function mountPlayer(
  host: HTMLElement,
  videoId: string,
  title: string,
  onStateChange: (snapshot: PlayerSnapshot) => void
): ActivePlayer {
  disposeActivePlayer();
  activePlayer =
    getPlayerMode() === "youtube"
      ? new SafeYouTubePlayer(videoId, getAppServerOrigin())
      : new CachedVideoPlayer(videoId, getAppServerOrigin(), title);
  activePlayer.onStateChange(onStateChange);
  host.replaceChildren(activePlayer.element);
  return activePlayer;
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

function createFooterStatus(): HTMLElement {
  const footer = createElement("footer", "app-footer");
  const versionText =
    appStatus?.ytDlpVersion
      ? `yt-dlp ${appStatus.ytDlpVersion}`
      : appStatus?.ytDlpStatus === "error"
        ? "yt-dlp unavailable"
        : "yt-dlp checking local install";
  const cacheText = appStatus
    ? `${formatBytes(appStatus.cacheBytes)} / ${formatBytes(appStatus.maxCacheBytes)} cache`
    : "cache loading";
  const statusText =
    appStatus?.ytDlpStatus === "error"
      ? appStatus.ytDlpError ?? "download service error"
      : appStatus?.ytDlpStatus === "updating"
        ? "updating local downloader"
        : appStatus?.ytDlpStatus === "ready"
          ? `${appStatus.cacheFiles} cached file${appStatus.cacheFiles === 1 ? "" : "s"}`
          : "starting local downloader";

  footer.append(
    createElement("span", "footer-pill", versionText),
    createElement("span", "footer-pill", cacheText),
    createElement("span", "footer-pill", statusText),
    createElement("span", "footer-pill", `player: ${getPlayerMode()}`)
  );
  return footer;
}

function refreshFooter(): void {
  const existingFooter = document.querySelector(".app-footer");
  if (!existingFooter) {
    return;
  }

  existingFooter.replaceWith(createFooterStatus());
}

function renderHomePage(main: HTMLElement): void {
  const allNodes = getDiscoverNodes();
  const homePinnedNodes = allNodes.filter((node) => pinnedIds.has(node.id));

  const intro = createElement("section", "page-head");
  intro.append(
    createElement("h1", "page-title", "Pinned Library"),
    createElement("p", "muted page-copy", "Pin videos and playlists from Discover, then keep Home focused on your curated set.")
  );

  const section = createElement("section", "content-block");
  section.appendChild(createElement("div", "section-label", "Pinned Nodes"));

  if (homePinnedNodes.length === 0) {
    const empty = createElement("div", "empty-state");
    empty.append(
      createElement("h2", "empty-title", "No pinned content yet"),
      createElement("p", "muted", "Use the Discover page to pin videos or playlists. Home only shows your saved nodes.")
    );
    const discoverLink = createElement("a", "button-link", "Open Discover") as HTMLAnchorElement;
    discoverLink.href = "#/discover";
    empty.appendChild(discoverLink);
    section.appendChild(empty);
  } else {
    const grid = createElement("div", "node-grid");
    for (const node of homePinnedNodes) {
      grid.appendChild(createNodeCard(node));
    }
    section.appendChild(grid);
  }

  main.append(intro, section);
}

function renderDiscoverPage(main: HTMLElement): void {
  const nodes = getDiscoverNodes();
  const videos = nodes.filter((node): node is VideoNode => node.kind === "video");
  const playlists = nodes.filter((node): node is PlaylistNode => node.kind === "playlist");

  const intro = createElement("section", "page-head");
  intro.append(
    createElement("h1", "page-title", "Discover"),
    createElement("p", "muted page-copy", "Hardcoded examples for now. Both individual videos and playlists can be pinned or organized into hierarchies.")
  );

  const videoSection = createElement("section", "content-block");
  videoSection.appendChild(createElement("div", "section-label", "Videos"));
  const videoGrid = createElement("div", "node-grid");
  videos.forEach((node) => videoGrid.appendChild(createNodeCard(node)));
  videoSection.appendChild(videoGrid);

  const playlistSection = createElement("section", "content-block");
  playlistSection.appendChild(createElement("div", "section-label", "Playlists"));
  const playlistGrid = createElement("div", "node-grid");
  playlists.forEach((node) => playlistGrid.appendChild(createNodeCard(node)));
  playlistSection.appendChild(playlistGrid);

  main.append(intro, videoSection, playlistSection);
}

function createSettingsChoice(
  title: string,
  description: string,
  playerMode: PlayerMode
): HTMLElement {
  const card = createElement("section", "settings-option");
  const titleRow = createElement("div", "settings-option-head");
  titleRow.append(
    createElement("h2", "detail-title detail-title-small", title),
    createElement(
      "span",
      playerMode === getPlayerMode() ? "info-chip settings-chip-active" : "info-chip",
      playerMode === getPlayerMode() ? "Selected" : "Available"
    )
  );

  const copy = createElement("p", "muted", description);
  const button = createElement(
    "button",
    playerMode === getPlayerMode() ? "pill-button pill-button-active" : "pill-button",
    playerMode === getPlayerMode() ? "Current Player" : "Use This Player"
  ) as HTMLButtonElement;
  button.disabled = playerMode === getPlayerMode();
  button.addEventListener("click", () => {
    void updatePlayerMode(playerMode);
  });

  card.append(titleRow, copy, button);
  return card;
}

function renderSettingsPage(main: HTMLElement): void {
  const intro = createElement("section", "page-head");
  intro.append(
    createElement("h1", "page-title", "Settings"),
    createElement("p", "muted page-copy", "Choose the global playback engine for every video page and playlist view.")
  );

  const playerSection = createElement("section", "content-block settings-grid");
  playerSection.appendChild(createElement("div", "section-label", "Player Mode"));
  playerSection.append(
    createSettingsChoice(
      "Local Downloader",
      "Downloads through the app-local yt-dlp binary, caches files, and plays them in the native HTML5 video element.",
      "local"
    ),
    createSettingsChoice(
      "YouTube Webview",
      "Uses the older ElectroBun webview player with recommendation-hiding injection. Useful for embed behavior comparisons.",
      "youtube"
    )
  );

  const noteSection = createElement("section", "content-block");
  noteSection.appendChild(createElement("div", "section-label", "Current Notes"));
  const notes = createElement("div", "settings-notes");
  notes.append(
    createElement("p", "muted", "The setting is global and persisted in the local SQLite app database."),
    createElement("p", "muted", "Discover includes an embed-disabled test node for video ID yvr9TXXc9Hw so both player paths can be compared.")
  );
  noteSection.appendChild(notes);

  const cacheSection = createElement("section", "content-block settings-grid");
  cacheSection.appendChild(createElement("div", "section-label", "Cache"));
  const cacheActions = createElement("div", "settings-actions");
  const openCacheButton = createElement("button", "pill-button", "Open Cache Folder") as HTMLButtonElement;
  openCacheButton.addEventListener("click", () => {
    void openCacheFolder();
  });
  const clearCacheButton = createElement("button", "pill-button", "Clear Cache") as HTMLButtonElement;
  clearCacheButton.addEventListener("click", () => {
    void clearCache().catch((error) => {
      console.error("Failed to clear cache", error);
      window.alert(error instanceof Error ? error.message : "Failed to clear cache.");
    });
  });
  cacheActions.append(openCacheButton, clearCacheButton);
  const cacheCopy = createElement(
    "p",
    "muted",
    "Clear removes downloaded media files and cache metadata. It does not affect pinned content or player settings."
  );
  cacheSection.append(cacheActions, cacheCopy);

  main.append(intro, playerSection, cacheSection, noteSection);
}

function renderVideoPage(main: HTMLElement, node: VideoNode): void {
  const page = createElement("section", "detail-page detail-page-video");
  const backRow = createElement("div", "detail-top-row");
  const backLink = createElement("a", "back-link", "Home") as HTMLAnchorElement;
  backLink.href = "#/";
  const discoverLink = createElement("a", "back-link back-link-secondary", "Discover") as HTMLAnchorElement;
  discoverLink.href = "#/discover";
  backRow.append(backLink, discoverLink, createPinButton(node));

  const playerCard = createElement("section", "player-card");
  const title = createElement("h1", "detail-title", node.title);
  const subtitle = createElement("p", "muted detail-copy", node.description);
  const playerFrame = createElement("div", "video-frame video-frame-detail");
  const actionButton = createElement("button", "hero-button", "Loading…") as HTMLButtonElement;
  actionButton.disabled = true;

  let latestSnapshot: PlayerSnapshot | null = null;

  mountPlayer(playerFrame, node.videoId, node.title, (snapshot) => {
    latestSnapshot = snapshot;
    actionButton.disabled = !snapshot.isReady;

    if (snapshot.playbackState === "ended") {
      actionButton.textContent = "Play Again";
    } else if (snapshot.playbackState === "playing") {
      actionButton.textContent = "Pause";
    } else {
      actionButton.textContent = "Play";
    }
  });

  actionButton.addEventListener("click", () => {
    if (!activePlayer || !latestSnapshot) {
      return;
    }

    if (latestSnapshot.playbackState === "ended") {
      activePlayer.replay();
      return;
    }

    activePlayer.togglePlayback();
  });

  playerCard.append(title, subtitle, playerFrame, actionButton);

  const metadata = createElement("section", "detail-metadata");
  metadata.appendChild(createElement("div", "section-label", "Node Info"));
  const info = createElement("div", "detail-info-grid");
  info.append(
    createElement("div", "info-chip", `Channel: ${node.channel}`),
    createElement("div", "info-chip", `Duration: ${node.durationLabel}`),
    createElement("div", "info-chip", `Type: ${formatNodeKind(node)}`)
  );
  metadata.appendChild(info);

  const parentLinks = createParentLinks(node);
  const childDisclosure = createChildrenDisclosure(node);

  page.append(backRow, playerCard, metadata);
  if (parentLinks) {
    page.appendChild(parentLinks);
  }
  if (childDisclosure) {
    page.appendChild(childDisclosure);
  }

  main.appendChild(page);
}

function buildPlaylistModeUrl(playlist: PlaylistNode, mode: PlaylistDisplayMode, index: number): string {
  return `#/playlist/${playlist.id}?mode=${mode}&index=${index}`;
}

function createPlaylistRail(
  playlist: PlaylistNode,
  items: VideoNode[],
  currentIndex: number,
  mode: PlaylistDisplayMode
): HTMLElement {
  if (mode === "dropdown") {
    const shell = createElement("div", "playlist-dropdown-shell");
    const label = createElement("label", "detail-label", "Playlist");
    const select = createElement("select", "playlist-select") as HTMLSelectElement;

    items.forEach((item, index) => {
      const option = document.createElement("option");
      option.value = String(index);
      option.textContent = item.title;
      option.selected = index === currentIndex;
      select.appendChild(option);
    });

    select.addEventListener("change", () => {
      window.location.hash = buildPlaylistModeUrl(playlist, mode, Number(select.value));
    });

    shell.append(label, select);
    return shell;
  }

  const list = createElement(
    "div",
    mode === "top" ? "playlist-strip playlist-strip-top" : "playlist-strip playlist-strip-left"
  );

  items.forEach((item, index) => {
    const entry = createElement(
      "a",
      index === currentIndex ? "playlist-entry playlist-entry-active" : "playlist-entry"
    ) as HTMLAnchorElement;
    entry.href = buildPlaylistModeUrl(playlist, mode, index);

    const thumb = createElement("div", "playlist-entry-thumb");
    const image = document.createElement("img");
    image.src = getNodeThumbnail(item);
    image.alt = item.title;
    image.loading = "lazy";
    thumb.appendChild(image);

    const body = createElement("div", "playlist-entry-body");
    body.append(
      createElement("span", "playlist-entry-title", item.title),
      createElement("span", "playlist-entry-meta", item.durationLabel)
    );

    entry.append(thumb, body);
    list.appendChild(entry);
  });

  if (mode === "top") {
    const shell = createElement("div", "playlist-top-shell");
    const fadeLeft = createElement("div", "scroll-fade scroll-fade-left");
    const fadeRight = createElement("div", "scroll-fade scroll-fade-right");
    shell.append(list, fadeLeft, fadeRight);
    return shell;
  }

  return list;
}

function renderPlaylistPage(
  main: HTMLElement,
  playlist: PlaylistNode,
  mode: PlaylistDisplayMode,
  index: number
): void {
  const items = getPlaylistItems(playlist);
  const currentIndex = Math.min(Math.max(index, 0), Math.max(items.length - 1, 0));
  const currentVideo = items[currentIndex];

  const backRow = createElement("div", "detail-top-row");
  const homeLink = createElement("a", "back-link", "Home") as HTMLAnchorElement;
  homeLink.href = "#/";
  const discoverLink = createElement("a", "back-link back-link-secondary", "Discover") as HTMLAnchorElement;
  discoverLink.href = "#/discover";
  backRow.append(homeLink, discoverLink, createPinButton(playlist));

  const page = createElement(
    "section",
    mode === "left" ? "detail-page playlist-layout-left" : "detail-page"
  );

  const header = createElement("section", "page-head page-head-compact");
  header.append(
    createElement("h1", "page-title", playlist.title),
    createElement("p", "muted page-copy", playlist.description)
  );

  const modes = createElement("div", "mode-switcher");
  (["left", "top", "dropdown"] as PlaylistDisplayMode[]).forEach((entryMode) => {
    const button = createElement(
      "a",
      entryMode === mode ? "mode-pill mode-pill-active" : "mode-pill",
      entryMode
    ) as HTMLAnchorElement;
    button.href = buildPlaylistModeUrl(playlist, entryMode, currentIndex);
    modes.appendChild(button);
  });

  const playerPanel = createElement("section", "player-card");
  const nowPlayingMeta = createElement("div", "detail-info-grid");
  nowPlayingMeta.append(
    createElement("div", "info-chip", `Current: ${currentIndex + 1} / ${items.length}`),
    createElement("div", "info-chip", `Channel: ${currentVideo.channel}`),
    createElement("div", "info-chip", `Duration: ${currentVideo.durationLabel}`)
  );

  const title = createElement("h2", "detail-title detail-title-small", currentVideo.title);
  const frame = createElement("div", "video-frame video-frame-detail");
  mountPlayer(frame, currentVideo.videoId, currentVideo.title, () => undefined);

  const navRow = createElement("div", "playlist-nav-row");
  const previousLink = createElement(
    "a",
    currentIndex === 0 ? "button-link button-link-disabled" : "button-link",
    "Previous"
  ) as HTMLAnchorElement;
  previousLink.href = buildPlaylistModeUrl(playlist, mode, Math.max(0, currentIndex - 1));
  if (currentIndex === 0) {
    previousLink.setAttribute("aria-disabled", "true");
  }

  const nextLink = createElement(
    "a",
    currentIndex >= items.length - 1 ? "button-link button-link-disabled" : "button-link",
    "Next"
  ) as HTMLAnchorElement;
  nextLink.href = buildPlaylistModeUrl(playlist, mode, Math.min(items.length - 1, currentIndex + 1));
  if (currentIndex >= items.length - 1) {
    nextLink.setAttribute("aria-disabled", "true");
  }

  navRow.append(previousLink, nextLink);
  playerPanel.append(title, nowPlayingMeta, frame, navRow);

  const rail = createPlaylistRail(playlist, items, currentIndex, mode);
  const parentLinks = createParentLinks(playlist);
  const childDisclosure = createChildrenDisclosure(playlist);

  if (mode === "left") {
    const layout = createElement("div", "playlist-grid");
    const aside = createElement("aside", "playlist-sidebar");
    aside.append(createElement("div", "section-label", "Playlist Items"), rail);
    layout.append(aside, playerPanel);
    page.append(backRow, header, modes, layout);
  } else {
    page.append(backRow, header, modes, rail, playerPanel);
  }

  if (parentLinks) {
    page.appendChild(parentLinks);
  }
  if (childDisclosure) {
    page.appendChild(childDisclosure);
  }

  main.appendChild(page);
}

function renderMissingPage(main: HTMLElement): void {
  const page = createElement("section", "empty-state");
  page.append(
    createElement("h1", "empty-title", "Node not found"),
    createElement("p", "muted", "The requested video or playlist does not exist in the current hardcoded graph.")
  );
  const homeLink = createElement("a", "button-link", "Back Home") as HTMLAnchorElement;
  homeLink.href = "#/";
  page.appendChild(homeLink);
  main.appendChild(page);
}

function renderPage(main: HTMLElement): void {
  if (!pinsLoaded || !settingsLoaded) {
    const loading = createElement("section", "empty-state");
    loading.append(
      createElement("h1", "empty-title", "Loading App"),
      createElement("p", "muted", "Fetching local pins, player settings, and app status.")
    );
    main.appendChild(loading);
    return;
  }

  const route = getRoute();

  if (route.page === "settings") {
    renderSettingsPage(main);
    return;
  }

  if (route.page === "discover") {
    renderDiscoverPage(main);
    return;
  }

  if (route.page === "video" && route.nodeId) {
    const node = getNode(route.nodeId);
    if (node?.kind === "video") {
      renderVideoPage(main, node);
      return;
    }
    renderMissingPage(main);
    return;
  }

  if (route.page === "playlist" && route.nodeId) {
    const node = getNode(route.nodeId);
    if (node?.kind === "playlist") {
      renderPlaylistPage(main, node, route.mode ?? "left", route.index ?? 0);
      return;
    }
    renderMissingPage(main);
    return;
  }

  renderHomePage(main);
}

function renderApp(): void {
  const root = document.getElementById("app");
  if (!root) {
    return;
  }

  disposeActivePlayer();

  const shell = createElement("div", "app-shell");
  const topBar = createElement("header", "top-bar");
  const brand = createElement("div", "top-bar-title", "Video Playpen");
  const nav = createElement("nav", "top-nav");
  const route = getRoute();

  nav.append(
    createNavLink("Home", "#/", route.page === "home"),
    createNavLink("Discover", "#/discover", route.page === "discover"),
    createNavLink("Settings", "#/settings", route.page === "settings")
  );
  topBar.append(brand, nav);

  const main = createElement("main", "content");
  renderPage(main);

  shell.append(topBar, main, createFooterStatus());
  root.replaceChildren(shell);
}

window.addEventListener("hashchange", () => {
  renderApp();
});

window.addEventListener("DOMContentLoaded", () => {
  startStatusPolling();
  void Promise.allSettled([
    loadPinnedIds().catch((error) => {
      console.error("Failed to load pinned ids", error);
      pinsLoaded = true;
    }),
    loadAppSettings().catch((error) => {
      console.error("Failed to load app settings", error);
      settingsLoaded = true;
    }),
    loadAppStatus().catch((error) => {
      console.error("Failed to load app status", error);
    })
  ]).finally(() => {
    renderApp();
  });
});
