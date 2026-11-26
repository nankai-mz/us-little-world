import { WelcomeCover } from "./JournalCover";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { App } from "./App";
import { createHostedService } from "./platform";
import { forgetUnlock } from "./rememberedUnlock";
import { setOfflineAccount } from "./cipherCache";
import { WebInstall, WebInstallControls } from "./WebInstall";
import { PasswordInput } from "./PasswordInput";

interface WebsiteSession {
  account: string | null;
  owner: boolean;
  error?: { message: string };
}
const sessionSignalKey = "us.web.sessionChanged";

function signalSessionChanged() {
  try { localStorage.setItem(sessionSignalKey, crypto.randomUUID()); }
  catch { /* Tabs check the server again when they regain focus. */ }
}

async function sessionRequest(path: string, data?: object) {
  const response = await fetch(path, data && {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  const result: WebsiteSession = await response.json();
  if (!response.ok) throw new Error(result.error?.message || "网站暂时不可用");
  return result;
}

export function HostedWeb() {
  const [session, setSession] = useState<WebsiteSession | null>(null);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const clearSession = useCallback(() => {
    setOfflineAccount(null);
    setSession(null);
    setPassword("");
  }, []);
  const account = session?.account;
  const storageAvailable = useMemo(() => {
    if (!account) return false;
    try {
      localStorage.getItem(`us.web.${account}.vault`);
      return true;
    } catch { return false; }
  }, [account]);
  const service = useMemo(() => account ? createHostedService(account, () => {
    void forgetUnlock(account).catch(() => {});
    clearSession();
  }) : null, [account, clearSession]);
  useEffect(() => {
    let active = true;
    sessionRequest("/api/session").then((value) => {
      if (active) {
        if (!value.account) setOfflineAccount(null);
        setSession(value);
      }
    }).catch(() => {
      if (active) setError("暂时无法连接网站，请刷新后再试。");
    }).finally(() => {
      if (active) setBusy(false);
    });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    let active = true;
    let check = 0;
    const syncSession = (cookieChanged = false) => {
      const request = ++check;
      void sessionRequest("/api/session").then((current) => {
        if (!active || request !== check || (!cookieChanged && current.account === (account ?? null))) return;
        if (!account && !current.account) return;
        service?.lock();
        if (account) void forgetUnlock(account).catch(() => {});
        setPassword("");
        setOfflineAccount(null);
        setSession(current);
      }).catch(() => {});
    };
    const onFocus = () => { if (!document.hidden) syncSession(); };
    const onStorage = (event: StorageEvent) => {
      if (event.key === sessionSignalKey || event.key === null) syncSession(true);
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      active = false;
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [account, service]);
  async function signIn(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const signedIn = await sessionRequest("/api/login", { name, password });
      setOfflineAccount(null);
      setSession(signedIn);
      setPassword("");
      signalSessionChanged();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function signOut() {
    service?.lock();
    setOfflineAccount(null);
    if (account) await forgetUnlock(account).catch(() => {});
    await sessionRequest("/api/logout", {});
    clearSession();
    signalSessionChanged();
  }
  if (account && !storageAvailable) return (
    <main className="welcome">
      <div className="welcome-form">
        <h2>浏览器本机存储不可用</h2>
        <p>请允许这个网站使用本机存储，再刷新页面。密钥库需要保存在当前浏览器。</p>
        {error && <p role="alert" className="error-text">{error}</p>}
        <button className="secondary full" onClick={() =>
          void signOut().catch((failure: Error) => setError(failure.message))
        }>退出网站账号</button>
      </div>
    </main>
  );
  if (account && service) return (
    <WebInstall>
      <App key={account} hosted={{ account, service, owner: !!session?.owner, signOut, installation: <WebInstallControls /> }} />
    </WebInstall>
  );
  return (
    <main className="welcome">
      <WelcomeCover />
      <div className="welcome-form">
        <h2>登录双人空间</h2>
        <form onSubmit={signIn}>
          <label className="field"><span>网站账号</span>
            <input value={name} onChange={(event) => setName(event.target.value)} autoComplete="username" autoCapitalize="none" required />
          </label>
          <label className="field"><span>网站密码</span>
            <PasswordInput value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required />
          </label>
          {error && <p role="alert" className="error-text">{error}</p>}
          <button className="primary full" disabled={busy}>{busy ? "正在连接…" : "登录"}</button>
        </form>
      </div>
    </main>
  );
}
