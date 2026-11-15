import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { App } from "./App";
import { createHostedService } from "./platform";

interface WebsiteSession {
  account: string | null;
  owner: boolean;
  error?: { message: string };
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
    setSession(null);
    setPassword("");
  }, []);
  const account = session?.account;
  const service = useMemo(() => account ? createHostedService(account, clearSession) : null, [account, clearSession]);
  useEffect(() => {
    let active = true;
    sessionRequest("/api/session").then((value) => {
      if (active) setSession(value);
    }).catch(() => {
      if (active) setError("暂时无法连接网站，请刷新后再试。");
    }).finally(() => {
      if (active) setBusy(false);
    });
    return () => { active = false; };
  }, []);
  async function signIn(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      setSession(await sessionRequest("/api/login", { name, password }));
      setPassword("");
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (account && service) return (
    <App key={account} hosted={{
      service,
      owner: !!session?.owner,
      signOut: async () => {
        await sessionRequest("/api/logout", {});
        service.lock();
        clearSession();
      },
    }} />
  );
  return (
    <main className="welcome">
      <div className="welcome-art">
        <div className="brand"><span className="brand-mark">us ✳</span> 我们的小世界</div>
        <div className="welcome-copy">
          <h1>我们的小世界</h1><p>留给两个人的私密手账。</p>
          <img src="/assets/pet-room.svg" alt="" />
        </div>
      </div>
      <div className="welcome-form">
        <h2>登录双人空间</h2>
        <form onSubmit={signIn}>
          <label className="field"><span>网站账号</span>
            <input value={name} onChange={(event) => setName(event.target.value)} autoComplete="username" autoCapitalize="none" required />
          </label>
          <label className="field"><span>网站密码</span>
            <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required />
          </label>
          {error && <p role="alert" className="error-text">{error}</p>}
          <button className="primary full" disabled={busy}>{busy ? "正在连接…" : "登录"}</button>
        </form>
      </div>
    </main>
  );
}
