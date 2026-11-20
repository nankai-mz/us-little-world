import { strToU8, Zip, ZipPassThrough } from "fflate";
import { unb64 } from "../src/core/crypto";
import type { UsService } from "../src/core/service";
import { AppError, type Entry, type Visibility } from "../src/core/types";

export interface ArchiveScope {
  visibility: Visibility | "all";
  from: string;
  to: string;
}

const extensions = new Map([["image/jpeg", "jpg"], ["image/png", "png"], ["image/webp", "webp"]]);
const entities: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escape = (value: string) => value.replace(/[&<>"']/g, (character) => entities[character]);

function archiveRecord(entry: Entry, userId: string) {
  const { id, creatorId, visibility, createdAt, updatedAt, data } = entry;
  const { photos: _photos, ...content } = data;
  if (content.answers && Object.keys(content.answers).length < 2)
    content.answers = Object.fromEntries(Object.entries(content.answers).filter(([id]) => id === userId));
  return { id, creatorId, visibility, createdAt, updatedAt, content };
}

export async function createArchive(
  service: UsService,
  scope: ArchiveScope,
  password: string,
  signal: AbortSignal,
  progress: (done: number, total: number) => void,
) {
  if (scope.from && scope.to && scope.from > scope.to)
    throw new AppError("INVALID_DATE", "起始日期不能晚于结束日期");
  const session = service.secrets;
  if (!session || !service.ready) throw new AppError("LOCKED", "请先解锁空间");
  const active = () => service.secrets === session && !signal.aborted;
  const checkActive = () => {
    if (!active()) throw new AppError("EXPORT_STOPPED", "导出已停止，请重新打开导出窗口");
  };
  await service.confirmUnlockPassword(password);
  checkActive();
  await service.refresh();
  checkActive();
  const scoped = service.active.filter(({ visibility, data }) =>
    (scope.visibility === "all" || visibility === scope.visibility) &&
    (visibility === "shared" || service.hasPrivateAccess) &&
    (!scope.from || data.date >= scope.from) && (!scope.to || data.date <= scope.to),
  );
  const entries = scoped.filter(({ data }) => data.kind !== "capsule" || !!data.openedAt);
  if (!entries.length) throw new AppError("ARCHIVE_EMPTY", "所选范围没有可导出的记录");

  const chunks: BlobPart[] = [];
  const zip = new Zip((error, bytes) => {
    if (error) throw error;
    chunks.push(bytes.slice());
  });
  function add(path: string, bytes: Uint8Array) {
    const file = new ZipPassThrough(path);
    zip.add(file);
    file.push(bytes, true);
  }
  const records = [];
  const failed: { recordId: string; photoId: string; name: string; code: string }[] = [];
  const sections: string[] = [];
  const total = entries.reduce((count, entry) => count + (entry.data.photos?.length ?? 0), 0);
  let done = 0;
  progress(0, total);
  for (const [index, entry] of entries.entries()) {
    checkActive();
    const attachments = [];
    const images = [];
    for (const [offset, photo] of (entry.data.photos ?? []).entries()) {
      checkActive();
      try {
        const extension = photo.sample ? "svg" : extensions.get(photo.mime);
        if (!extension) throw new AppError("UNSUPPORTED_PHOTO", "无法识别照片格式");
        const raw = await service.readPhoto(photo, entry.visibility, active);
        let bytes: Uint8Array;
        if (photo.sample) {
          if (!/^\/assets\/[a-z0-9-]+\.svg$/.test(raw)) throw new AppError("INVALID_PHOTO", "无效示例照片");
          const response = await fetch(raw, { signal });
          if (!response.ok) throw new AppError("PHOTO_MISSING", "示例图片暂不可用");
          bytes = new Uint8Array(await response.arrayBuffer());
        } else bytes = unb64(raw);
        checkActive();
        const path = `photos/${index + 1}-${offset + 1}.${extension}`;
        add(path, bytes);
        attachments.push({ id: photo.id, name: photo.name, mime: photo.sample ? "image/svg+xml" : photo.mime, path, bytes: bytes.length });
        images.push(`<figure><img src="${path}" alt="${escape(photo.name)}"><figcaption>${escape(photo.name)}</figcaption></figure>`);
      } catch (error) {
        checkActive();
        if (error instanceof AppError && ["DEVICE_REVOKED", "AUTH_REQUIRED", "PRIVATE_KEY_REQUIRED"].includes(error.code)) throw error;
        failed.push({ recordId: entry.id, photoId: photo.id, name: photo.name, code: error instanceof AppError ? error.code : "READ_FAILED" });
        images.push(`<p>照片未导出：${escape(photo.name)}</p>`);
      }
      progress(++done, total);
    }
    records.push({ ...archiveRecord(entry, session.userId), attachments });
    sections.push(`<article><h2>${escape(entry.data.title)}</h2><small>${escape(entry.data.date)} · ${entry.visibility === "private" ? "私人" : "共同"}</small><p>${escape(entry.data.body ?? "")}</p>${images.join("")}</article>`);
  }
  await service.call("getSpace");
  checkActive();
  const manifest = {
    format: "UsReadableArchive", version: 1, generatedAt: new Date().toISOString(), scope,
    records: records.length, photos: total - failed.length, failedPhotos: failed,
    unopenedCapsulesExcluded: scoped.length - entries.length,
    unreadableRecordsInSpace: service.unreadable,
  };
  add("manifest.json", strToU8(JSON.stringify(manifest, null, 2)));
  add("records.json", strToU8(JSON.stringify(records, null, 2)));
  add("index.html", strToU8(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src file: 'self'; style-src 'unsafe-inline'"><title>Us · 回忆归档</title><style>body{max-width:55rem;margin:auto;padding:1.5rem;color:#2f2927;background:#faf7ef;font:16px/1.6 system-ui,sans-serif}article{border-top:1px solid #cbbfaf;padding:1rem 0}p{white-space:pre-wrap;overflow-wrap:anywhere}figure{margin:1rem 0}img{max-width:100%;height:auto}</style></head><body><h1>Us · 回忆归档</h1><p>${records.length} 条记录，${manifest.photos} 张照片。${failed.length ? `${failed.length} 张照片未导出，详见 manifest.json。` : ""}${service.unreadable ? `当前空间有 ${service.unreadable} 条记录无法解密。` : ""}</p>${sections.join("")}</body></html>`));
  zip.end();
  return { blob: new Blob(chunks, { type: "application/zip" }), manifest };
}
