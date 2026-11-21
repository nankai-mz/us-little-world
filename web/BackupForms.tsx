import { useEffect, useRef, useState } from "react";
import { today } from "../src/core/date";
import type { UsService } from "../src/core/service";
import { Field } from "./Field";
import { PasswordInput } from "./PasswordInput";
import { commitBackup, download, stageBackup } from "./platform";
import type { ArchiveScope } from "./archive";

export function ArchiveExport({ service, busy, run, complete }: {
  service: UsService;
  busy: boolean;
  run: <T>(fn: () => Promise<T>) => Promise<T | undefined>;
  complete: (partial: boolean) => void;
}) {
  const [scope, setScope] = useState<ArchiveScope>({ visibility: "shared", from: "", to: "" });
  const [password, setPassword] = useState("");
  const [progress, setProgress] = useState("");
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);
  return <form aria-label="导出可读图文归档" onSubmit={(event) => {
    event.preventDefault();
    if (busy || active.current) return;
    const controller = new AbortController();
    active.current = controller;
    const pass = password;
    setPassword("");
    setProgress("正在核对权限和记录…");
    void run(async () => {
      try {
        const { createArchive } = await import("./archive");
        const { blob, manifest } = await createArchive(service, scope, pass, controller.signal, (count, total) => {
          setProgress(total ? `已处理 ${count} / ${total} 张照片` : "正在生成归档…");
        });
        if (!controller.signal.aborted) {
          download(`Us-图文回忆-${today()}.zip`, blob);
          complete(manifest.failedPhotos.length > 0 || manifest.unreadableRecordsInSpace > 0);
        }
      } catch (error) {
        if (!controller.signal.aborted) throw error;
      } finally {
        active.current = null;
        if (!controller.signal.aborted) setProgress("");
      }
    });
  }}>
    <p className="muted">ZIP 保存的是可直接阅读的明文。解压后打开 index.html 查看照片和记录。未开启的胶囊按原规则保留在空间中。</p>
    <Field label="导出范围"><select value={scope.visibility} disabled={busy} onChange={(event) => setScope({ ...scope, visibility: event.target.value as ArchiveScope["visibility"] })}>
      <option value="shared">共同记录</option>
      {service.hasPrivateAccess && <><option value="private">我的私人记录</option><option value="all">共同和我的私人记录</option></>}
    </select></Field>
    <div className="editor-meta">
      <Field label="起始日期（可选）"><input type="date" value={scope.from} disabled={busy} onChange={(event) => setScope({ ...scope, from: event.target.value })} /></Field>
      <Field label="结束日期（可选）"><input type="date" value={scope.to} disabled={busy} onChange={(event) => setScope({ ...scope, to: event.target.value })} /></Field>
    </div>
    <Field label="确认本机解锁口令"><input type="password" value={password} autoComplete="current-password" disabled={busy} onChange={(event) => setPassword(event.target.value)} required /></Field>
    {progress && <p role="status">{progress}</p>}
    <button className="primary full" disabled={busy}>确认并下载 ZIP</button>
  </form>;
}

export function RestoreForm({
  service,
  hosted,
  openSpace,
  mode,
  run,
  done,
}: {
  service: UsService | null;
  hosted?: boolean;
  openSpace: (action: () => Promise<void>) => Promise<void>;
  mode: "demo" | "personal";
  run: <T>(fn: () => Promise<T>, success?: string) => Promise<T | undefined>;
  done: () => void;
}) {
  const [backup, setBackup] = useState<any>(null);
  const [backupError, setBackupError] = useState("");
  const fileSelection = useRef(0);
  const [key, setKey] = useState("");
  const [password, setPassword] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        run(async () => {
          if (hosted) {
            if (!service || backup?.format !== "UsBackup" || backup.version !== 2 || !backup.vault)
              throw new Error("请选择此网站导出的加密密钥备份");
            await openSpace(() => service.recover(backup.vault, key, password));
            done();
          } else {
            const values = await stageBackup(backup, key, password);
            commitBackup(mode, values);
            sessionStorage.removeItem("us.demo.password");
            done();
            window.location.reload();
          }
        }, hosted ? "备份已恢复，此设备已解锁" : "备份已恢复，请用新口令解锁");
      }}
    >
      <p className="fineprint">
        {hosted ? "使用属于当前网站账号和空间的加密备份，恢复这台设备的解锁密钥。"
          : "导入会替换当前模式的本机数据库。请先保存当前备份；本机备份恢复不能迁移到不同微信账号。"}
      </p>
      <Field label="加密备份 JSON">
        <input
          type="file"
          accept="application/json,.json"
          required
          onChange={async (e) => {
            const selection = ++fileSelection.current;
            const file = e.target.files?.[0];
            setBackup(null);
            setBackupError("");
            if (file) {
              try {
                const parsed = JSON.parse(await file.text());
                if (hosted && (parsed?.format !== "UsBackup" || parsed.version !== 2 || !parsed.vault))
                  throw new Error("INVALID_BACKUP");
                if (selection === fileSelection.current) setBackup(parsed);
              } catch {
                if (selection === fileSelection.current) setBackupError("无法读取此备份，请选择从当前入口导出的加密 JSON 文件。");
              }
            }
          }}
        />
      </Field>
      {backupError && <p className="error-text" role="alert">{backupError}</p>}
      <Field label="64 位恢复密钥">
        <textarea
          rows={3}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          required
        />
      </Field>
      <Field label="新的本机解锁口令">
        <PasswordInput
          minLength={10}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </Field>
      <button className="primary full" disabled={!backup}>验证并恢复备份</button>
    </form>
  );
}
