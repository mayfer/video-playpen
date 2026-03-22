import { ApplicationMenu, BrowserWindow, Updater, Utils } from "electrobun/bun";
import { dlopen, FFIType } from "bun:ffi";
import { existsSync } from "node:fs";
import { join } from "node:path";

const DEV_SERVER_PORT = 5173;
const DEV_SERVER_URL = `http://localhost:${DEV_SERVER_PORT}`;
const MAC_TRAFFIC_LIGHTS_X = 14;
const MAC_TRAFFIC_LIGHTS_Y = 12;
const MAC_NATIVE_DRAG_REGION_X = 92;
const MAC_NATIVE_DRAG_REGION_HEIGHT = 52;
const DEBUG_SAFE_WINDOW = process.env.YT_EMBEDS_DEBUG_WINDOW === "1";

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

  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/youtube/")) {
        const videoId = url.pathname.split("/").pop();
        if (!videoId) {
          return new Response("Missing video id", { status: 400 });
        }

        const origin = `http://127.0.0.1:${server.port}`;
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
  const proxyOrigin = encodeURIComponent(`http://127.0.0.1:${server.port}`);
  const channel = await Updater.localInfo.channel();
  if (channel === "dev") {
    try {
      await fetch(DEV_SERVER_URL, { method: "HEAD" });
      console.log(`HMR enabled: using Vite dev server at ${DEV_SERVER_URL}`);
      return { url: `${DEV_SERVER_URL}?ytProxyOrigin=${proxyOrigin}`, server };
    } catch {
      console.log("Vite dev server not running. Run 'bun run dev:hmr' for HMR support.");
    }
  }

  const url = `http://127.0.0.1:${server.port}?ytProxyOrigin=${proxyOrigin}`;
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
        args: [FFIType.ptr, FFIType.f64, FFIType.f64],
        returns: FFIType.bool
      }
    });

    const alignButtons = () =>
      lib.symbols.setWindowTrafficLightsPosition(
        mainWindow.ptr,
        MAC_TRAFFIC_LIGHTS_X,
        MAC_TRAFFIC_LIGHTS_Y
      );
    const alignNativeDragRegion = () =>
      lib.symbols.setNativeWindowDragRegion(
        mainWindow.ptr,
        MAC_NATIVE_DRAG_REGION_X,
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
