import { useEffect, useRef, useState } from "react";
import { browserRandom, decryptRecord, randomId, unlockVault } from "../src/core/crypto";
import { spaceDay } from "../src/core/date";
import { prepareRecordWrite } from "../src/core/record-write";
import { recordOutboxScope } from "../src/core/web-outbox";
import type { Attachment, Entry, Payload, Secrets, Vault, Visibility } from "../src/core/types";
import type { OutboxItem } from "../src/core/web-outbox";
import { offlineAccountKey, readOfflineSnapshot } from "./cipherCache";
import { unlockGenerationKey } from "./rememberedUnlock";
import { webOutbox } from "./recordOutbox";
import { OfflinePhotos } from "./OfflinePhotos";
import { prepareBrowserPhoto } from "./photos";
import { preparePhotoWrite } from "../src/core/photo-write";
import { PasswordInput } from "./PasswordInput";

type OfflineSession = {
  records: Entry[];
  verifiedAt: number;
  expiresAt: number;
  writeKeyVersion?: number;
  binaryPhotos: boolean;
  canWritePrivate: boolean;
};
type DiaryEditor = {
  title: string;
  body: string;
  date: string;
  visibility: Visibility;
  existing?: Entry;
  existingPhotos: Attachment[];
  attachments: Awaited<ReturnType<typeof preparePhotoWrite>>[];
};
type PendingDiary = { id: string; data: Payload; visibility: Visibility; attachments?: OutboxItem["attachments"] };

function isValidSession(session: OfflineSession) {
  const now = Date.now();
  return now >= session.verifiedAt && now < session.expiresAt;
}

async function readPending(secrets: Secrets) {
  const items = await webOutbox.read(recordOutboxScope(secrets));
  return items.flatMap(({ record, attachments }): PendingDiary[] => {
    if (record.spaceId !== secrets.spaceId || (record.visibility === "private" &&
      (secrets.sharedOnly || record.creatorId !== secrets.userId))) return [];
    try { return [{ id: record.id, data: decryptRecord<Payload>(record, secrets), visibility: record.visibility, attachments }]; }
    catch { return []; }
  });
}

function localAccount() {
  try {
    const account = localStorage.getItem(offlineAccountKey);
    return account && /^[a-z0-9_-]{3,32}$/.test(account) &&
      localStorage.getItem(`us.web.${account}.cipherCache`) === "true" ? account : null;
  } catch { return null; }
}

export function OfflineWeb() {
  const [account, setAccount] = useState(localAccount);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [opened, setOpened] = useState<OfflineSession>();
  const [editor, setEditor] = useState<DiaryEditor>();
  const [pending, setPending] = useState<PendingDiary[]>([]);
  const [status, setStatus] = useState("");
  const [reconnected, setReconnected] = useState(false);
  const editingDirty = useRef(false);
  const writing = useRef(false);
  const sessionSecrets = useRef<Secrets | undefined>(undefined);
  const attempt = useRef(0);
  function lock() {
    attempt.current++;
    setPassword("");
    setOpened(undefined);
    sessionSecrets.current = undefined;
    editingDirty.current = false;
    setEditor(undefined);
    setPending([]);
    setStatus("");
    setBusy(false);
  }
  useEffect(() => {
    let live = true;
    let checking = false;
    const online = async () => {
      if (checking) return;
      checking = true;
      try {
        // The browser can report online before the origin is reachable.
        for (let attempt = 0; live && attempt < 3; attempt++) {
          if (editingDirty.current || writing.current) { setReconnected(true); return; }
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 1200);
          const response = await fetch("/healthz", { cache: "no-store", signal: controller.signal }).catch(() => null);
          clearTimeout(timeout);
          if (!live) return;
          if (response?.ok) {
            if (editingDirty.current || writing.current) setReconnected(true);
            else location.reload();
            return;
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 250));
        }
      } finally {
        checking = false;
      }
    };
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (editingDirty.current || writing.current) event.preventDefault();
    };
    const onStorage = ({ key }: StorageEvent) => {
      if (key === null || key === offlineAccountKey ||
        (account && [unlockGenerationKey(account), `us.web.${account}.cipherCache`, `us.web.${account}.vault`].includes(key))) {
        lock();
        setAccount(localAccount());
      }
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener("online", online);
    window.addEventListener("pagehide", lock);
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      live = false;
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("online", online);
      window.removeEventListener("pagehide", lock);
      window.removeEventListener("beforeunload", beforeUnload);
    };
  }, [account]);
  useEffect(() => {
    if (!opened) return;
    const expire = () => {
      if (!isValidSession(opened)) {
        lock();
        setError("离线阅读期限已过，请联网核验。");
      }
    };
    const timer = window.setTimeout(expire, Math.max(0, opened.expiresAt - Date.now()));
    document.addEventListener("visibilitychange", expire);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", expire);
    };
  }, [opened]);
  async function unlock() {
    if (busy || !account || localAccount() !== account) return;
    const sequence = ++attempt.current;
    setBusy(true);
    setError("");
    const phrase = password;
    setPassword("");
    try {
      const raw = localStorage.getItem(`us.web.${account}.vault`);
      if (!raw) throw new Error("此浏览器没有本机密钥库，请联网。");
      let vault: Vault;
      try { vault = JSON.parse(raw) as Vault; }
      catch { throw new Error("本机密钥库无法读取，请联网。"); }
      const secrets = await unlockVault(vault, phrase).catch(() => { throw new Error("本机解锁口令不正确。"); });
      const saved = await readOfflineSnapshot(account, secrets);
      if (!saved) throw new Error("没有仍在有效期内的本机缓存，请联网同步。");
      const pending = await readPending(secrets).catch(() => []);
      if (sequence !== attempt.current || localAccount() !== account) return;
      const records = saved.records.flatMap((record) => {
        if (record.spaceId !== secrets.spaceId || record.deletedAt ||
          (record.visibility === "private" && (secrets.sharedOnly || record.creatorId !== secrets.userId))) return [];
        try {
          const data = decryptRecord<Payload>(record, secrets);
          return data.kind === "memory" ? [{ ...record, data }] : [];
        } catch { return []; }
      }).sort((a, b) => b.data.date.localeCompare(a.data.date));
      sessionSecrets.current = secrets;
      setPending(pending);
      setOpened({
        records, verifiedAt: saved.verifiedAt, expiresAt: saved.expiresAt,
        writeKeyVersion: saved.writeKeyVersion, binaryPhotos: saved.binaryPhotos, canWritePrivate: !secrets.sharedOnly,
      });
    } catch (failure) {
      if (sequence === attempt.current) setError(failure instanceof Error ? failure.message : "无法读取本机缓存，请联网。");
    } finally {
      if (sequence === attempt.current) setBusy(false);
    }
  }
  function startEditing(existing?: Entry) {
    if (!opened?.writeKeyVersion || !isValidSession(opened)) return;
    setError("");
    setStatus("");
    editingDirty.current = false;
    setEditor({
      title: existing?.data.title ?? "",
      body: existing?.data.body ?? "",
      date: existing?.data.date ?? spaceDay(),
      visibility: existing?.visibility ?? "shared",
      existing,
      existingPhotos: existing?.data.photos ?? [],
      attachments: [],
    });
  }
  function changeEditor(patch: Partial<DiaryEditor>) {
    editingDirty.current = true;
    setEditor((value) => value && { ...value, ...patch });
  }
  function confirmLeaving() {
    if (writing.current) return false;
    if (editingDirty.current && !window.confirm("还有未保存的日记，确定离开吗？")) return false;
    editingDirty.current = false;
    return true;
  }
  async function addPhotos(files: File[]) {
    const secrets = sessionSecrets.current;
    if (!editor || !opened?.writeKeyVersion || !secrets || writing.current || !files.length) return;
    const remaining = 6 - editor.existingPhotos.length - editor.attachments.length;
    const selected = files.slice(0, remaining);
    const sequence = attempt.current;
    const current = () => sequence === attempt.current && sessionSecrets.current === secrets &&
      localAccount() === account && isValidSession(opened);
    const failures: string[] = [];
    if (selected.length !== files.length) failures.push("每条日记最多添加六张照片。");
    writing.current = true;
    setBusy(true);
    setError("");
    for (const file of selected) {
      if (!current()) break;
      try {
        const image = await prepareBrowserPhoto(file);
        const prepared = await preparePhotoWrite(new Uint8Array(await image.arrayBuffer()),
          image.type, file.name, editor.visibility, secrets, opened.writeKeyVersion, browserRandom, opened.binaryPhotos);
        if (current()) {
          editingDirty.current = true;
          setEditor((value) => value && { ...value, attachments: [...value.attachments, prepared] });
        }
      } catch (error) {
        failures.push(`${file.name}：${error instanceof Error ? error.message : "无法添加照片"}`);
      }
    }
    writing.current = false;
    if (current()) {
      setBusy(false);
      setError(failures.join(" "));
    }
  }
  async function saveEditor() {
    const secrets = sessionSecrets.current;
    if (!opened?.writeKeyVersion || !editor || !secrets || writing.current) return;
    const sequence = attempt.current;
    const canSave = () => sequence === attempt.current && sessionSecrets.current === secrets &&
      localAccount() === account && isValidSession(opened);
    if (!canSave()) { lock(); return; }
    setError("");
    writing.current = true;
    setBusy(true);
    try {
      const { existing, title, body, date, visibility, attachments, existingPhotos } = editor;
      const photos = [...existingPhotos, ...attachments.map(({ photo }) => photo)];
      const data: Payload = {
        ...existing?.data, kind: "memory", title: title.trim(), body, date, photos,
      };
      const { record, expectedRevision, photoRefs } = await prepareRecordWrite(data, visibility, secrets, opened.writeKeyVersion, browserRandom, existing);
      const operationId = await randomId(browserRandom);
      if (!canSave()) return;
      const pendingAttachments = attachments.map(({ photo, envelope }) => ({ fileId: photo.fileId, envelope }));
      await webOutbox.add({
        scope: recordOutboxScope(secrets), operationId, queuedAt: Date.now(), record,
        expectedRevision, photoRefs, state: "queued",
        attachments: pendingAttachments,
      });
      if (canSave()) {
        setPending((items) => [...items, { id: record.id, data, visibility, attachments: pendingAttachments }]);
        editingDirty.current = false;
        setEditor(undefined);
        setStatus("已保存在本机。联网验证后可从待同步队列发送。");
      }
    } catch (failure) {
      if (canSave()) setError(failure instanceof Error ? failure.message : "无法保存本机待同步日记。");
    } finally {
      writing.current = false;
      if (sequence === attempt.current) setBusy(false);
    }
  }
  return (
    <main className="offline-library">
      <section className="card offline-header">
        <h1>离线日记</h1>
        <p>联网后会重新核验账号与设备。此处可阅读最近 24 小时内缓存的日记和照片。</p>
        <button type="button" className="secondary" onClick={() => { if (confirmLeaving()) location.reload(); }}>重新连接</button>
        {opened && <button type="button" className="text-button" onClick={() => { if (confirmLeaving()) lock(); }}>锁定离线日记</button>}
        {reconnected && <p>网络已恢复。可以先保存编辑，再选择「重新连接」。</p>}
        {!opened && account && (
          <form onSubmit={(event) => { event.preventDefault(); void unlock(); }}>
            <label className="field"><span>本机解锁口令</span>
              <PasswordInput value={password} autoComplete="current-password" required
                onChange={(event) => setPassword(event.target.value)} />
            </label>
            <button className="primary" disabled={busy}>解锁离线日记</button>
          </form>
        )}
        {!opened && !account && <p>请先联网登录，在「我的」开启本机密文缓存。</p>}
        {error && <p role="alert" className="error-text">{error}</p>}
        {status && <p role="status">{status}</p>}
      </section>
      {opened?.writeKeyVersion && !editor && (
        <button type="button" className="primary" onClick={() => startEditing()}>写离线日记</button>
      )}
      {editor && opened && (
        <form className="card offline-entry" aria-label="离线日记编辑"
          onSubmit={(event) => { event.preventDefault(); void saveEditor(); }}>
          <h2>{editor.existing ? "编辑离线日记" : "写离线日记"}</h2>
          <label className="field"><span>日记标题</span>
            <input required maxLength={80} disabled={busy} value={editor.title} onChange={(event) => changeEditor({ title: event.target.value })} />
          </label>
          <label className="field"><span>日记日期</span>
            <input type="date" required disabled={busy} value={editor.date} onChange={(event) => changeEditor({ date: event.target.value })} />
          </label>
          <label className="field"><span>日记正文</span>
            <textarea rows={7} maxLength={12000} disabled={busy} value={editor.body} onChange={(event) => changeEditor({ body: event.target.value })} />
          </label>
          {!editor.existing && opened.canWritePrivate && <label className="field"><span>谁可以看见</span>
            <select value={editor.visibility} disabled={busy || editor.attachments.length > 0} onChange={(event) => changeEditor({ visibility: event.target.value as Visibility })}>
              <option value="shared">我们两人</option>
              <option value="private">仅自己</option>
            </select>
          </label>}
          <label className="field"><span>添加离线照片</span>
            <input type="file" multiple accept="image/jpeg,image/png,image/webp"
              disabled={busy || editor.existingPhotos.length + editor.attachments.length >= 6}
              onChange={(event) => {
                const files = Array.from(event.target.files ?? []);
                event.target.value = "";
                void addPhotos(files);
              }} />
          </label>
          {!!editor.existingPhotos.length && account && sessionSecrets.current && <>
            <OfflinePhotos photos={editor.existingPhotos} account={account} secrets={sessionSecrets.current} visibility={editor.visibility} />
            <ul>{editor.existingPhotos.map((photo) => <li key={photo.id}>{photo.name}
              <button type="button" className="text-button" disabled={busy} onClick={() =>
                changeEditor({ existingPhotos: editor.existingPhotos.filter(({ id }) => id !== photo.id) })}>移除已有照片</button>
            </li>)}</ul>
          </>}
          {editor.attachments.length > 0 && <ul>
            {editor.attachments.map(({ photo }) => <li key={photo.id}>{photo.name}
              <button type="button" className="text-button" disabled={busy} onClick={() =>
                changeEditor({ attachments: editor.attachments.filter((item) => item.photo.id !== photo.id) })}>
                移除照片
              </button>
            </li>)}
          </ul>}
          <button className="primary" disabled={busy}>保存到待同步队列</button>
          <button type="button" className="text-button" disabled={busy} onClick={() => {
            if (confirmLeaving()) setEditor(undefined);
          }}>取消编辑</button>
        </form>
      )}
      {!!pending.length && <section className="card offline-entry" aria-label="本机待同步日记">
        <h2>待同步日记（{pending.length}）</h2>
        {pending.map(({ id, data, visibility, attachments }) => <details key={id}>
          <summary>{data.title}</summary>
          <p>{data.date} · {visibility === "private" ? "私人" : "共同"}</p>
          {data.body && <p className="detail-body">{data.body}</p>}
          {!!data.photos?.length && sessionSecrets.current && <OfflinePhotos photos={data.photos}
            account={account ?? undefined} visibility={visibility} secrets={sessionSecrets.current} attachments={attachments} />}
        </details>)}
      </section>}
      {opened && (
        <section aria-label="本机缓存日记">
          <p>最近确认时间 {new Date(opened.verifiedAt).toLocaleString("zh-CN")}</p>
          {opened.records.length === 0 && <p>本机缓存中没有可读日记。</p>}
          {opened.records.map((record) => (
            <article key={record.id} className="card offline-entry">
              <h2>{record.data.title}</h2>
              <p>{record.data.date} · {record.visibility === "private" ? "私人" : "共同"}</p>
              {record.data.body && <p className="detail-body">{record.data.body}</p>}
              {!!record.data.photos?.length && account && sessionSecrets.current &&
                <OfflinePhotos photos={record.data.photos} account={account}
                  visibility={record.visibility} secrets={sessionSecrets.current} />}
              {opened.writeKeyVersion && <button type="button" className="text-button"
                disabled={!!editor || pending.some(({ id }) => id === record.id)}
                onClick={() => startEditing(record)}>编辑这条日记</button>}
            </article>
          ))}
        </section>
      )}
    </main>
  );
}
