import { createApp } from "vue";

import App from "./App.vue";
import "./styles.css";
import { router, ROUTER_ENABLED_KEY } from "./router.js";
import { isTauriRuntime, requestAppSnapshot } from "./tauri-rpc.js";

const app = createApp(App).use(router).provide(ROUTER_ENABLED_KEY, true);
void router.isReady().then(() => app.mount("#app"));

if (isTauriRuntime()) {
  void requestAppSnapshot()
    .then((snapshot) => {
      document.documentElement.dataset.qxBackend = snapshot.backend;
      document.documentElement.dataset.qxDataDirectory = snapshot.dataDirectory;
      document.documentElement.dataset.qxDatabasePath = snapshot.databasePath;
    })
    .catch((error: unknown) => {
      document.documentElement.dataset.qxBackend = "error";
      document.documentElement.dataset.qxBackendError = error instanceof Error ? error.message : String(error);
    });
}
