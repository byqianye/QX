/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_QX_TEST_PRESET_URL?: string;
  readonly VITE_QX_TEST_PRESET_AUTO_LOAD?: string;
  readonly VITE_QX_TEST_PRESET_AUTO_CONFIRM?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
