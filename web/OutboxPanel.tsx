import { useEffect, useState } from "react";
import type { UsService } from "../src/core/service";
import { OfflinePhotos } from "./OfflinePhotos";

const labels = {
  queued: "待同步",
  retry: "等待重试",
  conflict: "服务端已有更新，可查看并复制本机版本",
  blocked: "当前设备、密钥或附件无法提交",
  expired: "回执核对期限已过，请先检查云端记录",
};

export function OutboxPanel({ service, busy, revision, run }: {
  service: UsService;
  busy: boolean;
  revision: number;
  run: <T>(action: () => Promise<T>, success?: string) => Promise<T | undefined>;
}) {
  const [items, setItems] = useState<Awaited<ReturnType<UsService["listOutbox"]>>>([]);
  const [failed, setFailed] = useState(false);
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
      {items.length > 0 && <button type="button" className="secondary" disabled={busy || service.space?.status !== "active"}
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
          {["conflict", "blocked", "expired"].includes(state) && data && (
            <button type="button" className="text-button" disabled={busy || service.space?.status !== "active"} onClick={() => {
              if (state !== "expired" || window.confirm("原提交可能已保存。请先核对云端记录，仍要复制为新日记吗？"))
                void run(() => service.copyOutboxAsNew(operationId), "已另存为新的待同步日记，原项仍保留");
            }}>另存为新日记</button>
          )}
          {state !== "conflict" && state !== "expired" && (
            <button type="button" className="text-button" disabled={busy || service.space?.status !== "active"}
              onClick={() => void run(() => service.flushOutbox(operationId))}>重试此项</button>
          )}
          <button type="button" className="text-button" disabled={busy} onClick={() => {
            if (window.confirm("移除此项会删除本机待同步副本。确定移除吗？")) void run(() => service.discardOutbox(operationId));
          }}>移除此项</button>
        </details>
      ))}
    </section>
  );
}
