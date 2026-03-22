# yt-embeds-electrobun

ElectroBun version of the `yt-embeds-electron` app, keeping the same simple playlist workflow while using native macOS vibrancy from the `electrobun-macos-native-blur` example.

## Commands

```bash
bun install
bun run dev
bun run dev:hmr
bun run build
```

## Notes

- The window uses `transparent: true` plus a native `NSVisualEffectView` bridge on macOS for the blur background.
- The renderer remains a local Vite page that embeds YouTube videos through `https://www.youtube.com/embed/...`.
- Non-macOS builds fall back to a normal transparent-window configuration without the native blur dylib.
