import "./index.css";

interface ElectrobunWebviewElement extends HTMLElement {
  executeJavascript: (js: string) => void;
  on: (event: string, listener: (event: CustomEvent) => void) => void;
}

declare global {
  interface HTMLElementTagNameMap {
    "electrobun-webview": ElectrobunWebviewElement;
  }
}

const playlist = [
  "C6ZNrzvaci0"
];

const YOUTUBE_HIDE_RECOMMENDATIONS_SCRIPT = `
(() => {
  const STYLE_ID = "yt-embeds-hide-recommendations";
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

  ensureStyle();

  if (!(window).__ytEmbedsHideRecommendationsObserverInstalled) {
    const observer = new MutationObserver(() => {
      ensureStyle();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    (window).__ytEmbedsHideRecommendationsObserverInstalled = true;
  }
})();
`;

let currentVideoIndex = 0;
let recommendationHideInterval: number | null = null;

function clearRecommendationHideInterval(): void {
  if (recommendationHideInterval !== null) {
    window.clearInterval(recommendationHideInterval);
    recommendationHideInterval = null;
  }
}

function getYouTubeProxyOrigin(): string {
  const params = new URLSearchParams(window.location.search);
  return params.get("ytProxyOrigin") ?? window.location.origin;
}

function extractVideoId(url: string): string | null {
  const regex = /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\n?#]+)/;
  const match = url.match(regex);
  return match ? match[1] : null;
}

function createEmbedProxyUrl(videoId: string): string {
  return `${getYouTubeProxyOrigin()}/youtube/${videoId}`;
}

function updateVideoCounter(): void {
  const counter = document.getElementById("video-counter");
  if (counter) {
    counter.textContent = `Video ${currentVideoIndex + 1} of ${playlist.length}`;
  }

  const prevButton = document.getElementById("prev-button") as HTMLButtonElement | null;
  const nextButton = document.getElementById("next-button") as HTMLButtonElement | null;

  if (prevButton) {
    prevButton.disabled = currentVideoIndex === 0;
  }

  if (nextButton) {
    nextButton.disabled = currentVideoIndex >= playlist.length - 1;
  }
}

function createVideoPlayer(videoId: string): ElectrobunWebviewElement {
  clearRecommendationHideInterval();

  const webview = document.createElement("electrobun-webview");
  webview.className = "video-webview";
  webview.setAttribute("src", createEmbedProxyUrl(videoId));

  const injectHideScript = () => {
    webview.executeJavascript(YOUTUBE_HIDE_RECOMMENDATIONS_SCRIPT);
  };

  webview.on("dom-ready", injectHideScript);
  webview.on("did-navigate", injectHideScript);
  webview.on("load-finished", injectHideScript);

  recommendationHideInterval = window.setInterval(() => {
    injectHideScript();
  }, 750);

  return webview;
}

function loadVideo(videoId: string): void {
  const container = document.getElementById("video-container");
  if (!container) {
    return;
  }

  container.replaceChildren(createVideoPlayer(videoId));
  updateVideoCounter();
}

function createPlaylistControls(): HTMLElement {
  const controls = document.createElement("section");
  controls.className = "card controls-card";

  const previousButton = document.createElement("button");
  previousButton.id = "prev-button";
  previousButton.className = "button button-secondary";
  previousButton.textContent = "Previous";
  previousButton.addEventListener("click", () => {
    if (currentVideoIndex > 0) {
      currentVideoIndex -= 1;
      loadVideo(playlist[currentVideoIndex]);
    }
  });

  const counter = document.createElement("span");
  counter.id = "video-counter";
  counter.className = "video-counter";

  const nextButton = document.createElement("button");
  nextButton.id = "next-button";
  nextButton.className = "button button-primary";
  nextButton.textContent = "Next";
  nextButton.addEventListener("click", () => {
    if (currentVideoIndex < playlist.length - 1) {
      currentVideoIndex += 1;
      loadVideo(playlist[currentVideoIndex]);
    }
  });

  controls.append(previousButton, counter, nextButton);
  return controls;
}

function createAddVideoForm(): HTMLElement {
  const form = document.createElement("section");
  form.className = "card form-card";

  const title = document.createElement("h2");
  title.textContent = "Add Video to Playlist";

  const description = document.createElement("p");
  description.className = "muted";
  description.textContent = "Paste a YouTube URL or an 11-character video ID.";

  const row = document.createElement("div");
  row.className = "input-row";

  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "Enter YouTube URL or video ID";
  input.autocomplete = "off";
  input.spellcheck = false;

  const addButton = document.createElement("button");
  addButton.className = "button button-accent";
  addButton.textContent = "Add Video";

  const addVideo = () => {
    const value = input.value.trim();
    if (!value) {
      return;
    }

    let videoId = extractVideoId(value);
    if (!videoId && value.length === 11) {
      videoId = value;
    }

    if (!videoId) {
      window.alert("Invalid YouTube URL or video ID");
      return;
    }

    playlist.push(videoId);
    input.value = "";
    updateVideoCounter();
  };

  addButton.addEventListener("click", addVideo);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      addVideo();
    }
  });

  row.append(input, addButton);
  form.append(title, description, row);
  return form;
}

function createVideoSection(): HTMLElement {
  const section = document.createElement("section");
  section.className = "card video-card";

  const label = document.createElement("div");
  label.className = "section-label";
  label.textContent = "Now Playing";

  const container = document.createElement("div");
  container.id = "video-container";
  container.className = "video-frame";

  section.append(label, container);
  return section;
}

function renderApp(): void {
  const app = document.getElementById("app");
  if (!app) {
    return;
  }

  const shell = document.createElement("div");
  shell.className = "app-shell";

  const topBar = document.createElement("header");
  topBar.className = "top-bar";

  const topBarTitle = document.createElement("span");
  topBarTitle.className = "top-bar-title";
  topBarTitle.textContent = "Kids Video Playlist";
  topBar.appendChild(topBarTitle);

  const main = document.createElement("main");
  main.className = "content";

  const hero = document.createElement("section");
  hero.className = "hero";

  const heading = document.createElement("h1");
  heading.textContent = "YouTube embeds in an ElectroBun shell";

  const intro = document.createElement("p");
  intro.className = "muted hero-copy";
  intro.textContent =
    "This keeps the same playlist flow as the Electron app, but runs in ElectroBun and uses native macOS vibrancy for the window background.";

  hero.append(heading, intro);

  main.append(hero, createVideoSection(), createPlaylistControls(), createAddVideoForm());
  shell.append(topBar, main);
  app.replaceChildren(shell);

  if (playlist.length > 0) {
    loadVideo(playlist[currentVideoIndex]);
  } else {
    updateVideoCounter();
  }
}

document.addEventListener("DOMContentLoaded", renderApp);
