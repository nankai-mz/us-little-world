import "./polyfill";
import { config } from "./config";
import { clearDecryptedFiles, service } from "./platform";
let hiddenAt = 0;
App({
  onLaunch() {
    clearDecryptedFiles();
    if (config.cloudEnv)
      wx.cloud.init({ env: config.cloudEnv, traceUser: false });
  },
  onHide() {
    hiddenAt = Date.now();
    clearDecryptedFiles();
  },
  onShow() {
    if (hiddenAt && Date.now() - hiddenAt > 300000) {
      service.lock();
      const pages = getCurrentPages();
      pages[pages.length - 1]?.onShow?.();
    }
  },
});
