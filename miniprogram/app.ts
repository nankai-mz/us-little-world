import "./polyfill";
import { cloudEnv } from "./cloud";
import { clearDecryptedFiles, service } from "./platform";
let hiddenAt = 0;
App({
  onLaunch() {
    try {
      const info = wx.getAccountInfoSync?.();
      if (info?.miniProgram?.envVersion !== "release") {
        wx.setEnableDebug?.({ enableDebug: true });
      }
    } catch {}
    clearDecryptedFiles();
    if (cloudEnv) wx.cloud.init({ env: cloudEnv, traceUser: false });
  },
  onError(err: any) {
    console.error("App.onError:", err);
  },
  onUnhandledRejection(res: any) {
    console.error("App.onUnhandledRejection:", res?.reason || res);
  },
  onHide() {
    hiddenAt = Date.now();
    clearDecryptedFiles();
  },
  onShow() {
    if (hiddenAt && Date.now() - hiddenAt > 300000) {
      try {
        service.lock();
        const pages = typeof getCurrentPages === "function" ? getCurrentPages() : [];
        const lastPage = pages && pages.length ? pages[pages.length - 1] : null;
        if (lastPage && typeof lastPage.onShow === "function") {
          lastPage.onShow();
        }
      } catch {}
    }
  },
});
