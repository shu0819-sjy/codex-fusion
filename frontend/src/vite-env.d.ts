/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 设为 'native' 时使用 NativeWorkspaceBridge（生产接入点），缺省使用 mock */
  readonly VITE_BRIDGE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
