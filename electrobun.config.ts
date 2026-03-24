import type { ElectrobunConfig } from "electrobun";

export default {
  app: {
    name: "Video Playpen",
    identifier: "net.ayfer.video-playpen",
    version: "1.0.0"
  },
  build: {
    copy: {
      "dist/index.html": "bun/frontend/index.html",
      "dist/assets": "bun/frontend/assets",
      "src/bun/libMacWindowEffects.dylib": "bun/libMacWindowEffects.dylib"
    },
    mac: {
      bundleCEF: false
    },
    linux: {
      bundleCEF: false
    },
    win: {
      bundleCEF: false
    }
  }
} satisfies ElectrobunConfig;
