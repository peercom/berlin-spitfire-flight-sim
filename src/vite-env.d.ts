/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CESIUM_ION_ACCESS_TOKEN?: string;
  readonly VITE_USE_GOOGLE_PHOTOREALISTIC_TILES?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
