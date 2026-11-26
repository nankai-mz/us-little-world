import { useEffect, useState } from "react";
import type { UsService } from "../src/core/service";
import type { Payload } from "../src/core/types";
import { OfflinePhotos } from "./OfflinePhotos";
import { SharedMemoryPhoto } from "./SharedMemoryPhoto";

const labels = {
  queued: "待同步",
  retry: "等待重试",
  conflict: "服务端已有更新，可查看并复制本机版本",
  blocked: "当前设备、密钥或附件无法提交",
  expired: "回执核对期限已过，请先检查云端记录",
};

function CopyForm({ data, busy, save, cancel }: {
  data: Payload;
  busy: boolean;
  save: (edits: { title: string; body: string; photoIds: string[] }) => void;
  cancel: () => void;
}) {
  const [title, setTitle] = useState(data.title);
  const [body, setBody] = useState(data.body ?? "");
  const [photoIds, setPhotoIds] = useState(() => data.photos?.map(({ id }) => id) ?? []);
  return (
    <form aria-label="另存为新日记" onSubmit={(event) => { event.preventDefault(); save({ title, body, photoIds }); }}>
      <p>新日记会保留原来的日期和可见范围，先保存到待同步队列。原项仍会保留。</p>
      <label className="field"><span>新日记标题</span><input required value={title} disabled={busy}
        onChange={(event) => setTitle(event.target.value)} /></label>
      <label className="field"><span>新日记正文</span><textarea value={body} disabled={busy}
        onChange={(event) => setBody(event.target.value)} /></label>
      {data.photos?.map(({ id, name }) => <label key={id} className="check-line">
        <input type="checkbox" checked={photoIds.includes(id)} disabled={busy}
          onChange={(event) => setPhotoIds(event.target.checked ? [...photoIds, id] : photoIds.filter((value) => value !== id))} />
        保留照片 {name}
      </label>)}
      <button className="secondary" disabled={busy || !title.trim()}>保存新日记到待同步队列</button>
      <button type="button" className="text-button" onClick={cancel}>取消另存</button>
    </form>
  );
}

export function OutboxPanel({ service, busy, revision, run }: {
  service: UsService;
  busy: boolean;
  revision: number;
  run: <T>(action: () => Promise<T>, success?: string) => Promise<T | undefined>;
}) {
  const [items, setItems] = useState<Awaited<ReturnType<UsService["listOutbox"]>>>([]);
  const [failed, setFailed] = useState(false);
  const [copying, setCopying] = useState<string>();
  const canWrite = !busy && service.space?.status === "active";
  useEffect(() => {
    let active = true;
    void service.listOutbox().then((value) => {
      if (active) { setItems(value); setFailed(false); }
    }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [service, revision]);
  return (
    <section aria-label="待同步队列" className="notice">
      <h3>待同步队列（{items.length}）</h3>
      {failed && <p role="alert">无法读取本机待同步队列，请检查浏览器存储。</p>}
      {items.length > 0 && <button type="button" className="secondary" disabled={!canWrite}
        onClick={() => void run(() => service.flushOutbox())}>同步待发送日记</button>}
      {items.map(({ operationId, data, queuedAt, state, attachments, visibility }) => (
        <details key={operationId}>
          <summary>{data?.title || new Date(queuedAt).toLocaleString("zh-CN")}</summary>
          <p>{labels[state]}</p>
          {data?.body && <p className="detail-body">{data.body}</p>}
          {!!attachments?.length && !!data?.photos?.length && service.secrets && (
            <OfflinePhotos photos={data.photos.filter((photo) => attachments.some(({ fileId }) => photo.fileId === fileId))}
              visibility={visibility} attachments={attachments} secrets={service.secrets} />
          )}
          {copying === operationId && data?.kind === "memory" ? <>
            {data.photos?.filter((photo) => !attachments?.some(({ fileId }) => photo.fileId === fileId)).map((photo) => (
              <SharedMemoryPhoto key={photo.id} photo={photo} service={service} title={photo.name} visibility={visibility} />
            ))}
            <CopyForm data={data} busy={!canWrite} cancel={() => setCopying(undefined)} save={(edits) => {
              void run(async () => {
                await service.copyOutboxAsNew(operationId, edits);
                setCopying(undefined);
              }, "已另存为新的待同步日记，原项仍保留");
            }} />
          </> : ["conflict", "blocked", "expired"].includes(state) && data?.kind === "memory" && (
            <button type="button" className="text-button" disabled={!canWrite} onClick={() => {
              if (state !== "expired" || window.confirm("原提交可能已保存。请先核对云端记录，仍要复制为新日记吗？"))
                setCopying(operationId);
            }}>另存为新日记</button>
          )}
          {state !== "conflict" && state !== "expired" && (
            <button type="button" className="text-button" disabled={!canWrite}
              onClick={() => void run(() => service.flushOutbox(operationId))}>重试此项</button>
          )}
          <button type="button" className="text-button" disabled={busy} onClick={() => {
            if (window.confirm("移除此项会删除本机待同步副本。确定移除吗？")) void run(async () => {
              await service.discardOutbox(operationId);
              if (copying === operationId) setCopying(undefined);
            });
          }}>移除此项</button>
        </details>
      ))}
    </section>
  );
}
