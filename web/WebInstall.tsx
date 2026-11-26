import { createContext, useContext, useEffect, useRef, useState, type PropsWithChildren, type ReactNode } from "react";

type InstallPrompt = Event & { prompt(): Promise<{ outcome: "accepted" | "dismissed" }> };
const InstallControls = createContext<ReactNode>(null);

export function WebInstall({ children }: PropsWithChildren) {
  const [install, setInstall] = useState<InstallPrompt>();
  const [update, setUpdate] = useState<ServiceWorker>();
  const [installed, setInstalled] = useState(() => window.matchMedia("(display-mode: standalone)").matches);
  const [supported, setSupported] = useState("serviceWorker" in navigator);
  const applying = useRef(false);
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    let live = true;
    let registration: ServiceWorkerRegistration | undefined;
    let installing: ServiceWorker | null;
    const checkWorker = () => {
      if (live && registration?.waiting && navigator.serviceWorker.controller) setUpdate(registration.waiting);
    };
    const onUpdate = () => {
      installing?.removeEventListener("statechange", checkWorker);
      installing = registration?.installing ?? null;
      installing?.addEventListener("statechange", checkWorker);
      checkWorker();
    };
    const controllerChanged = () => {
      if (applying.current) location.reload();
      else if (live) setUpdate(undefined);
    };
    const installPrompt = (event: Event) => {
      event.preventDefault();
      setInstall(event as InstallPrompt);
    };
    const appInstalled = () => { setInstalled(true); setInstall(undefined); };
    window.addEventListener("beforeinstallprompt", installPrompt);
    window.addEventListener("appinstalled", appInstalled);
    navigator.serviceWorker.addEventListener("controllerchange", controllerChanged);
    void navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }).then((value) => {
      if (!live) return;
      registration = value;
      registration.addEventListener("updatefound", onUpdate);
      onUpdate();
    }).catch(() => { if (live) setSupported(false); });
    return () => {
      live = false;
      registration?.removeEventListener("updatefound", onUpdate);
      installing?.removeEventListener("statechange", checkWorker);
      window.removeEventListener("beforeinstallprompt", installPrompt);
      window.removeEventListener("appinstalled", appInstalled);
      navigator.serviceWorker.removeEventListener("controllerchange", controllerChanged);
    };
  }, []);
  const controls = (
    <section aria-label="安装与更新" className="pwa-controls">
      {update && <button type="button" className="secondary" onClick={() => {
        applying.current = true;
        update.postMessage("activate-public-update");
      }}>有新版本，更新并重新打开</button>}
      {supported && install && !installed && <button className="secondary" onClick={() => {
        const prompt = install;
        setInstall(undefined);
        void prompt.prompt().catch(() => {});
      }}>安装我们的小世界</button>}
      {supported && !install && !installed && <details>
        <summary>如何添加到主屏幕</summary>
        <p>如果浏览器菜单有「安装」或「添加到主屏幕」，可从那里添加。在 iPhone 的 Safari 可从分享菜单添加。</p>
      </details>}
      {!supported && <p>当前浏览器不能启用安装或离线启动，可继续使用网页。</p>}
    </section>
  );
  return <InstallControls.Provider value={controls}>{children}</InstallControls.Provider>;
}

export function WebInstallControls() {
  return useContext(InstallControls);
}
