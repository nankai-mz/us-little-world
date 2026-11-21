import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowRight, ImagePlus, LockKeyhole, X } from "lucide-react";
import { addDays } from "../src/core/date";
import type { UsService } from "../src/core/service";
import { AppError, type Entry, type Payload, type Visibility } from "../src/core/types";
import { Field } from "./Field";
import { prepareBrowserPhoto } from "./photos";
import { SharedMemoryPhoto } from "./SharedMemoryPhoto";

export const moodOptions = [
  "很开心",
  "被治愈",
  "想你了",
  "有点累",
  "想聊聊天",
  "需要独处",
];

export function RecordEditor({
  kind,
  initialTitle,
  service,
  existing,
  busy,
  run,
  done,
  dirty,
}: {
  kind: string;
  initialTitle: string;
  service: UsService;
  existing?: Entry;
  busy: boolean;
  run: <T>(fn: () => Promise<T>, success?: string) => Promise<T | undefined>;
  done: () => void;
  dirty: { current: boolean };
}) {
  const isRelationship =
    kind === "relationship" || existing?.data.category === "relationship";
  const draftSlot = existing ? `draft:edit:${existing.id}` : "draft";
  const isMemory = kind === "memory";
  const [{ draft, draftUnavailable }] = useState(() => {
    try {
      const saved = isMemory
        ? service.loadDraft<{ form: Payload; visibility: Visibility; base?: Entry }>(draftSlot) : null;
      if (saved?.visibility === "private" && !service.hasPrivateAccess)
        return { draft: null, draftUnavailable: true };
      return { draft: saved, draftUnavailable: false };
    } catch {
      return { draft: null, draftUnavailable: true };
    }
  });
  const [base, setBase] = useState(draft?.base ?? existing);
  const changedSinceDraft = !!existing && !!draft?.base && existing.revision !== draft.base.revision;
  const [conflict, setConflict] = useState(changedSinceDraft);
  const [latest, setLatest] = useState<Entry | null>(changedSinceDraft ? existing : null);
  const [form, setForm] = useState<Payload>(
    draft?.form ||
      existing?.data || {
        kind: isRelationship ? "anniversary" : (kind as Payload["kind"]),
        ...(isRelationship ? { category: "relationship" } : {}),
        title: isRelationship ? "我们的小世界" : initialTitle,
        body: "",
        date: service.day,
        tags: [],
        photos: [],
        unlockDate: addDays(service.day, 30),
        yearly: true,
      },
  );
  const [tagInput, setTagInput] = useState(() => form.tags?.join("，") ?? "");
  const [visibility, setVisibility] = useState<Visibility>(
    existing?.visibility || (service.hasPrivateAccess ? draft?.visibility : undefined) || "shared",
  );
  const [photosBusy, setPhotosBusy] = useState(false);
  const [photoError, setPhotoError] = useState("");
  const [failedPhotos, setFailedPhotos] = useState<{ file: File; message: string }[]>([]);
  const [queuedPhotos, setQueuedPhotos] = useState<Awaited<ReturnType<UsService["prepareQueuedPhoto"]>>[]>([]);
  const photoCount = (form.photos?.length ?? 0) + queuedPhotos.length;
  const [saved, setSaved] = useState("");
  const generation = useRef(0);
  const saving = useRef<Promise<void>>(Promise.resolve());
  const initial = useRef({ form, visibility, base });
  const [persisted, setPersisted] = useState(initial.current);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const set = (patch: Partial<Payload>) => setForm((f) => ({ ...f, ...patch }));
  useLayoutEffect(() => {
    dirty.current = persisted.form !== form || persisted.visibility !== visibility || persisted.base !== base ||
      photosBusy || failedPhotos.length > 0 || queuedPhotos.length > 0;
    return () => { dirty.current = false; };
  }, [dirty, persisted, form, visibility, base, photosBusy, failedPhotos.length, queuedPhotos.length]);
  useEffect(() => {
    if (!isMemory || (initial.current.form === form && initial.current.visibility === visibility && initial.current.base === base)) return;
    const id = draftTimer.current = setTimeout(() => {
      const value = ++generation.current;
      saving.current = saving.current
        .then(() => service.saveDraft({ form, visibility, base }, draftSlot))
        .then(() => {
          if (value === generation.current) {
            setPersisted({ form, visibility, base });
            setSaved("已在本机加密保存草稿");
          }
        }).catch(() => {
          if (value === generation.current) setSaved("草稿保存失败，请保留当前编辑内容");
        });
    }, 600);
    return () => clearTimeout(id);
  }, [form, visibility, service, isMemory, draftSlot, base]);
  const upload = async (files: File[]) => {
    if (!files.length || photosBusy) return;
    const remaining = Math.max(0, 6 - photoCount);
    const selected = files.slice(0, remaining);
    const session = service.secrets;
    if (!selected.length || !session) return;
    setPhotosBusy(true);
    setPhotoError(files.length > remaining ? `本次只处理了能加入的 ${remaining} 张照片，记录最多六张。` : "");
    setFailedPhotos((current) => current.filter(({ file }) => !selected.includes(file)));
    try {
      for (const file of selected) {
        if (service.secrets !== session) break;
        try {
          const prepared = await prepareBrowserPhoto(file);
          const bytes = new Uint8Array(await prepared.arrayBuffer());
          if (service.secrets !== session) break;
          if (isMemory && service.supportsOutbox && !navigator.onLine) {
            const queued = await service.prepareQueuedPhoto(bytes, prepared.type, file.name, visibility);
            if (service.secrets !== session) break;
            setQueuedPhotos((photos) => [...photos, queued]);
            continue;
          }
          const photo = await service.addPhoto(bytes, prepared.type, file.name, visibility);
          if (service.secrets !== session) break;
          setForm((value) => ({ ...value, photos: [...(value.photos ?? []), photo] }));
        } catch (error) {
          if (service.secrets !== session) break;
          setFailedPhotos((current) => [...current, {
            file, message: error instanceof Error ? error.message : "照片暂时未能添加",
          }]);
        }
      }
    } finally {
      setPhotosBusy(false);
    }
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (busy || photosBusy || conflict || service.hasPendingSave || queuedPhotos.length > 0) return;
        run(
          async () => {
            if (form.kind === "capsule" && form.unlockDate! < service.day && form.unlockDate !== existing?.data.unlockDate)
              throw new AppError("INVALID_DATE", "请选择今天或之后的开启日期");
            clearTimeout(draftTimer.current);
            await saving.current;
            if (isMemory) {
              await service.saveDraft({ form, visibility, base }, draftSlot);
              setPersisted({ form, visibility, base });
            }
            try {
              await service.save(form, visibility, base, undefined, true);
            } catch (error) {
              if (error instanceof AppError && error.code === "REVISION_CONFLICT") {
                setLatest(null);
                setConflict(true);
              }
              throw error;
            }
            if (isMemory) service.storage.remove(draftSlot);
            done();
          },
          isRelationship
            ? "恋爱开始日期已更新，首页天数已重新计算"
            : "这份温柔，已经好好收藏",
        );
      }}
    >
      {service.hasPendingSave && <div className="notice" role="status">
        上一次保存尚未确认。先核对该次保存，再提交新的内容。
        <button type="button" className="text-button" disabled={busy} onClick={() => run(async () => {
          const confirmed = await service.resumePendingSave();
          if (confirmed && isMemory && (existing?.id === confirmed.id || !existing && confirmed.expectedRevision === 0)) {
            const remote = service.entries.find((entry) => entry.id === confirmed.id);
            if (remote && JSON.stringify(remote.data) === JSON.stringify(form)) service.storage.remove(draftSlot);
          }
          done();
        }, "已核对上一次保存")}>核对并继续原保存</button>
      </div>}
      {conflict && <div className="notice" role="status">
        另一台设备已更新这条记录，你的编辑仍保留。
        <button type="button" className="text-button" disabled={busy} onClick={() => run(async () => {
          await service.refresh();
          const current = service.active.find((entry) => entry.id === existing?.id);
          if (!current) throw new AppError("RECORD_UNAVAILABLE", "这条记录已移出时间线，请先核对回收站");
          setLatest(current);
        })}>查看最新版本</button>
        {latest && <div>
          <strong>{latest.data.title}</strong><p>{latest.data.body}</p>
          <button type="button" className="text-button" onClick={() => {
            const previous = base?.data;
            if (previous) setForm({ ...latest.data, ...Object.fromEntries(Object.entries(form).filter(([key, value]) =>
              JSON.stringify(value) !== JSON.stringify(previous[key as keyof Payload]),
            )) });
            setBase(latest);
            setConflict(false);
          }}>保留我的编辑，以此版本为基础</button>
        </div>}
      </div>}
      <div className="editor-meta">
        <Field
          label={
            isRelationship
              ? "恋爱开始日期"
              : kind === "anniversary"
                ? "纪念日日期"
                : "记录日期"
          }
        >
          <input
            type="date"
            value={form.date}
            max={isRelationship ? service.day : undefined}
            onChange={(e) => set({ date: e.target.value })}
            required
          />
        </Field>
        {kind === "memory" && (
          <Field label="谁可以看见">
            <select
              value={visibility}
              disabled={
                photosBusy || !!existing || !!form.photos?.some((p) => p.fileId) || queuedPhotos.length > 0
              }
              onChange={(e) => setVisibility(e.target.value as Visibility)}
            >
              <option value="shared">我们两个人</option>
              <option value="private" disabled={!service.hasPrivateAccess}>只有我自己</option>
            </select>
          </Field>
        )}
      </div>
      {draftUnavailable && <p className="fineprint">旧草稿无法用当前设备密钥打开。</p>}
      {isRelationship && (
        <p className="muted">
          恋爱开始当天记为第 1
          天。保存后，首页天数和恋爱纪念日倒计时都会自动更新。
        </p>
      )}
      {!isRelationship && (
        <>
          <Field label="这一页的小标题">
            <input
              placeholder={
                kind === "capsule"
                  ? "写给未来的我们…"
                  : "今天，有什么值得记住？"
              }
              value={form.title}
              maxLength={80}
              onChange={(e) => set({ title: e.target.value })}
              required
            />
          </Field>
          <Field
            label={kind === "capsule" ? "想留给未来的话" : "慢慢写，不用着急"}
          >
            <textarea
              placeholder="或许只是一起喝了一杯咖啡，也很值得。"
              rows={kind === "memory" || kind === "capsule" ? 6 : 3}
              value={form.body || ""}
              maxLength={12000}
              onChange={(e) => set({ body: e.target.value })}
            />
          </Field>
        </>
      )}
      {kind === "memory" && (
        <>
          <div className="editor-meta">
            <Field label="今天的心情">
              <select
                value={form.mood || ""}
                onChange={(e) => set({ mood: e.target.value })}
              >
                <option value="">留白也很好</option>
                {moodOptions.map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
            </Field>
            <Field label="小标签（用逗号分开）">
              <input
                value={tagInput}
                placeholder="日常，约会，小幸福"
                onChange={(event) => {
                  const text = event.target.value;
                  setTagInput(text);
                  set({ tags: [...new Set(text.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean))].slice(0, 8) });
                }}
              />
            </Field>
          </div>
          <div className="photo-upload">
            <label className="upload-button">
              <ImagePlus size={20} />
              <span>{photosBusy ? "正在整理并加密照片…" : "添加照片"}</span>
              <small>JPG / PNG / WebP，自动压缩至 ≤500 KB，最多 6 张</small>
              <input
                aria-label="添加照片"
                type="file"
                multiple
                accept="image/jpeg,image/png,image/webp"
                disabled={photosBusy || photoCount >= 6}
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? []);
                  e.target.value = "";
                  void upload(files);
                }}
              />
            </label>
            {failedPhotos.map(({ file, message }, index) => <div className="notice" key={`${file.name}-${index}`}>
              <strong>{file.name}</strong><p>{message}</p>
              <button type="button" className="text-button" disabled={photosBusy || photoCount >= 6} onClick={() => void upload([file])}>重试此照片</button>
              <button type="button" className="text-button" onClick={() => setFailedPhotos((current) => current.filter((failure) => failure.file !== file))}>移除失败照片</button>
            </div>)}
            <div className="editor-photos">
              {form.photos?.map((p) => (
                <div key={p.id}>
                  <SharedMemoryPhoto title="照片" photo={p} visibility={visibility} service={service} />
                  <button
                    type="button"
                    aria-label="移除照片"
                    onClick={() =>
                      set({ photos: form.photos?.filter((x) => x.id !== p.id) })
                    }
                  >
                    <X size={13} />
                  </button>
                </div>
              ))}
            </div>
            {queuedPhotos.length > 0 && <div className="notice">
              <p>这些照片将随日记保存在待同步队列。</p>
              <ul>{queuedPhotos.map(({ photo }) => <li key={photo.id}>{photo.name}
                <button type="button" className="text-button" disabled={photosBusy}
                  onClick={() => setQueuedPhotos((items) => items.filter((item) => item.photo.id !== photo.id))}>
                  移除待同步照片
                </button>
              </li>)}</ul>
            </div>}
            {photoError && <p className="error-text">{photoError}</p>}
          </div>
        </>
      )}
      {kind === "capsule" && (
        <>
          <Field label="约定开启的日子">
            <input
              type="date"
              min={existing?.data.unlockDate && existing.data.unlockDate < service.day ? existing.data.unlockDate : service.day}
              disabled={!!existing?.data.openedAt}
              value={form.unlockDate}
              onChange={(e) => set({ unlockDate: e.target.value })}
              required
            />
          </Field>
          <label className="check-line">
            <input
              type="checkbox"
              checked={!!form.needsBoth}
              disabled={!!existing?.data.openedAt}
              onChange={(e) => set({ needsBoth: e.target.checked })}
            />{" "}
            到期后，还需要我们两个人都确认
          </label>
        </>
      )}
      {kind === "place" && (
        <>
          <div className="editor-meta">
            <Field label="在哪个城市">
              <input
                value={form.city || ""}
                onChange={(e) => set({ city: e.target.value })}
                placeholder="文字地点也可以"
              />
            </Field>
            <Field label="足迹分类">
              <select
                value={form.category || "城市"}
                onChange={(e) => set({ category: e.target.value })}
              >
                {["城市", "旅行", "餐厅", "特别纪念", "未来想去"].map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            </Field>
          </div>
          <details>
            <summary>可选：主动填写地图坐标（不会自动定位）</summary>
            <div className="editor-meta">
              <Field label="纬度">
                <input
                  type="number"
                  step="any"
                  min="-90"
                  max="90"
                  value={form.latitude ?? ""}
                  onChange={(e) =>
                    set({
                      latitude: e.target.value
                        ? Number(e.target.value)
                        : undefined,
                    })
                  }
                />
              </Field>
              <Field label="经度">
                <input
                  type="number"
                  step="any"
                  min="-180"
                  max="180"
                  value={form.longitude ?? ""}
                  onChange={(e) =>
                    set({
                      longitude: e.target.value
                        ? Number(e.target.value)
                        : undefined,
                    })
                  }
                />
              </Field>
            </div>
          </details>
        </>
      )}
      {kind === "wish" && (
        <Field label="这份期待有多特别">
          <select
            value={form.priority || "小小期待"}
            onChange={(e) => set({ priority: e.target.value })}
          >
            <option>小小期待</option>
            <option>很想实现</option>
            <option>慢慢来就好</option>
          </select>
        </Field>
      )}
      {kind === "anniversary" && !isRelationship && (
        <label className="check-line">
          <input
            type="checkbox"
            checked={!!form.yearly}
            onChange={(e) => set({ yearly: e.target.checked })}
          />{" "}
          每一年，都想好好记住
        </label>
      )}
      {kind === "date" && (
        <div className="editor-meta">
          <Field label="约会地点">
            <input
              value={form.location || ""}
              onChange={(e) => set({ location: e.target.value })}
            />
          </Field>
          <Field label="大概预算（元）">
            <input
              type="number"
              min="0"
              value={form.budget || ""}
              onChange={(e) => set({ budget: e.target.value })}
            />
          </Field>
        </div>
      )}
      <div className="editor-footer">
        <span className="fineprint">
          <LockKeyhole size={12} />
          {saved || "保存前在本机加密"}
        </span>
        {isMemory && service.supportsOutbox && (
          <button type="button" className="secondary"
            disabled={busy || photosBusy || conflict || service.hasPendingSave || failedPhotos.length > 0}
            onClick={() => void run(async () => {
              clearTimeout(draftTimer.current);
              await saving.current;
              const photos = [...(form.photos ?? []), ...queuedPhotos.map(({ photo }) => photo)];
              await service.queueSave({ ...form, photos }, visibility, base,
                queuedPhotos.map(({ photo, envelope }) => ({ fileId: photo.fileId, envelope })));
              try { service.storage.remove(draftSlot); } catch { /* The queued copy is already durable. */ }
              done();
            }, "已保存在本机，等待同步")}>
            先存本机，稍后同步
          </button>
        )}
        <button className="primary" disabled={busy || photosBusy || conflict || service.hasPendingSave || queuedPhotos.length > 0}>
          {busy
            ? "正在收藏…"
            : isRelationship
              ? "保存恋爱开始日期"
              : kind === "capsule"
                ? "封存这份期待"
                : "收藏到我们的小世界"}
          <ArrowRight size={15} />
        </button>
      </div>
    </form>
  );
}
