# Video Playpen

Video Playpen is an ElectroBun app for a YouTube viewer that hides video recommendations (the ones that show up at the end of a video) to make it compatible with toddlers who easily get obsessed with new videos if they see the thumbnail.

## Commands

```bash
bun install
bun run dev
bun run dev:hmr
bun run build
```

## Pi desktop control

This repo now includes a project-local pi extension at `.pi/extensions/macos-desktop-control/`.

When you run `pi` from this repo on macOS, pi auto-loads tools that let the model:

- list visible app windows
- capture a screenshot of a specific window
- focus a window
- click, scroll, type, and send shortcuts

See `.pi/extensions/macos-desktop-control/README.md` for setup and permissions.

## Notes

- The window uses `transparent: true` plus a native `NSVisualEffectView` bridge on macOS for the blur background.
- The renderer remains a local Vite page that embeds YouTube videos through `https://www.youtube.com/embed/...`.
- Non-macOS builds fall back to a normal transparent-window configuration without the native blur dylib.
