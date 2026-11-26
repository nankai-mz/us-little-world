import { useState, type ReactNode } from "react";
import type { UsService } from "../src/core/service";
import { AppError, type Attachment, type Entry, type Visibility } from "../src/core/types";
import {
  addWardrobeItem, privateWardrobe, publishWardrobe, respondToWardrobe, suggestWardrobe,
  visibleItemId, wardrobeNameLimit, wardrobePreviewLimit, wardrobeSelection, wardrobeSlots, wardrobeSuggestion, wardrobeWeatherLimit, type WardrobeSlot,
} from "../src/core/wardrobe";
import { prepareBrowserPhoto } from "./photos";

type Run = <T>(action: () => Promise<T>, success?: string) => Promise<T | undefined>;

function WardrobeShareForm({ service, items, selection, busy, run }: {
  service: UsService; items: Entry[]; selection?: Entry; busy: boolean; run: Run;
}) {
  const published = selection?.data.wardrobeSelection;
  const edition = published?.edition ?? 0;
  const [selected, setSelected] = useState(() => items.filter((item) => selection &&
    published?.items.some(({ id }) => id === visibleItemId(selection.id, item.id))).map(({ id }) => id));
  const [previewIds, setPreviewIds] = useState(() => items.filter((item) => selection &&
    published?.items.some(({ id, photoId }) => photoId && id === visibleItemId(selection.id, item.id))).map(({ id }) => id));
  const [weather, setWeather] = useState(published?.weather ?? "");
  return (
    <form onSubmit={(event) => {
      event.preventDefault();
      void run(() => publishWardrobe(service, selected, weather, edition, previewIds), "共享衣物已更新");
    }}>
      <h3>选择共享衣物</h3>
      <p>默认共享名称、类别和所填天气。可为最多 {wardrobePreviewLimit} 件衣物勾选照片。对方可查看、导出已共享的照片，撤回后，已经保存的副本仍由对方持有。</p>
      {items.map((item) => (
        <div key={item.id}>
          <label className="check-line">
            <input type="checkbox" checked={selected.includes(item.id)} disabled={busy || (!selected.includes(item.id) && selected.length >= 8)}
              onChange={(event) => {
                setSelected(event.target.checked ? [...selected, item.id] : selected.filter((id) => id !== item.id));
                if (!event.target.checked) setPreviewIds(previewIds.filter((id) => id !== item.id));
              }} />
            共享 {item.data.title}
          </label>
          {service.supportsManagedPhotos && selected.includes(item.id) && item.data.photos?.[0]?.fileId && (
            <label className="check-line">
              <input type="checkbox" checked={previewIds.includes(item.id)}
                disabled={busy || (!previewIds.includes(item.id) && previewIds.length >= wardrobePreviewLimit)}
                onChange={(event) => setPreviewIds(event.target.checked ? [...previewIds, item.id] : previewIds.filter((id) => id !== item.id))} />
              同时共享 {item.data.title} 的照片
            </label>
          )}
        </div>
      ))}
      <label className="field"><span>天气备注（可留空）</span><input value={weather} disabled={busy}
        onChange={(e) => setWeather([...e.target.value].slice(0, wardrobeWeatherLimit).join(""))} /></label>
      <button className="primary" disabled={busy || (!selected.length && !published?.items.length)}>更新共享衣物</button>
      {!!published?.items.length && <button type="button" className="text-button" disabled={busy}
        onClick={() => void run(() => publishWardrobe(service, [], "", edition), "衣物共享已撤回")}>撤回全部共享</button>}
    </form>
  );
}

function SuggestionForm({ service, selection, previous, busy, run }: {
  service: UsService; selection: Entry; previous?: Entry; busy: boolean; run: Run;
}) {
  const published = selection.data.wardrobeSelection!;
  const [selected, setSelected] = useState<Partial<Record<WardrobeSlot, string>>>(() => {
    const ids = previous?.data.wardrobeSuggestion?.selected ?? [];
    return Object.fromEntries(published.items.filter(({ id }) => ids.includes(id)).map(({ slot, id }) => [slot, id]));
  });
  const choices = Object.values(selected).filter((value): value is string => !!value);
  return (
    <form onSubmit={(event) => {
      event.preventDefault();
      void run(() => suggestWardrobe(service, selection.creatorId, choices, published.edition, previous?.revision ?? 0), "已发送搭配建议");
    }}>
      <h3>给对方搭配</h3>
      {wardrobeSlots.map((slot) => {
        const candidates = published.items.filter((item) => item.slot === slot);
        return candidates.length > 0 && <label className="field" key={slot}><span>{slot}</span>
          <select value={selected[slot] ?? ""} disabled={busy}
            onChange={(event) => setSelected({ ...selected, [slot]: event.target.value })}>
            <option value="">跳过</option>
            {candidates.map(({ id, name }) => <option value={id} key={id}>{name}</option>)}
          </select>
        </label>;
      })}
      <button className="secondary" disabled={busy || !choices.length}>发送搭配建议</button>
      {previous && published.response?.revision === previous.revision && (
        <p>对方{published.response.accepted ? "已采纳" : "已婉拒"}这次搭配。</p>
      )}
    </form>
  );
}

export function Wardrobe({ service, busy, run, photo }: {
  service: UsService; busy: boolean; run: Run; photo: (attachment: Attachment, visibility: Visibility) => ReactNode;
}) {
  const [name, setName] = useState("");
  const [slot, setSlot] = useState<WardrobeSlot>("上装");
  const [file, setFile] = useState<File>();
  const [inputVersion, setInputVersion] = useState(0);
  const me = service.userId;
  const partner = service.space?.members.find((member) => member !== me);
  const mine = wardrobeSelection(service, me);
  const theirs = partner ? wardrobeSelection(service, partner) : undefined;
  const incoming = partner ? wardrobeSuggestion(service, partner, me) : undefined;
  const outgoing = partner ? wardrobeSuggestion(service, me, partner) : undefined;
  const shared = mine?.data.wardrobeSelection;
  const items = privateWardrobe(service);
  const canWrite = !busy && service.space?.status === "active";
  const preview = (incoming?.data.wardrobeSuggestion?.selected ?? []).flatMap((id) =>
    shared?.items.find((item) => item.id === id) ?? []);
  const sharedPhotos = (theirs?.data.wardrobeSelection?.items ?? []).flatMap(({ id, name, slot, photoId }) => {
    const attachment = theirs?.data.photos?.find(({ id }) => id === photoId);
    return attachment ? [{ id, name, slot, attachment }] : [];
  });
  return (
    <div className="card wardrobe-panel">
      <h2>今天穿什么</h2>
      {service.hasPrivateAccess ? <section aria-label="私人衣橱">
        <h3>私人衣橱</h3>
        <form onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            const session = service.secrets;
            await addWardrobeItem(service, name, slot, file ? async () => {
              const image = await prepareBrowserPhoto(file);
              const bytes = new Uint8Array(await image.arrayBuffer());
              if (!session || service.secrets !== session) throw new AppError("LOCKED", "请先解锁");
              return service.addPhoto(bytes, image.type, file.name, "private");
            } : undefined);
            setName(""); setFile(undefined); setInputVersion((value) => value + 1);
          }, "衣物已保存到私人衣橱");
        }}>
          <label className="field"><span>衣物名称</span><input value={name} required disabled={!canWrite}
            onChange={(e) => setName([...e.target.value].slice(0, wardrobeNameLimit).join(""))} /></label>
          <label className="field"><span>衣物类别</span><select value={slot} disabled={!canWrite}
            onChange={(e) => setSlot(e.target.value as WardrobeSlot)}>{wardrobeSlots.map((value) => <option key={value}>{value}</option>)}</select></label>
          <label className="field"><span>私人衣物照片（可选）</span><input key={inputVersion} type="file" disabled={!canWrite}
            accept="image/jpeg,image/png,image/webp" onChange={(e) => setFile(e.target.files?.[0])} /></label>
          <button className="secondary" disabled={!canWrite || items.length >= 24}>添加私人衣物</button>
        </form>
        <ul>{items.map((item) => {
          const publicItem = mine && shared?.items.find(({ id }) => id === visibleItemId(mine.id, item.id));
          return <li key={item.id}>
            {item.data.title} · {item.data.category}{publicItem && (publicItem.photoId ? " · 已共享名称和照片" : " · 已共享名称")}
            {item.data.photos?.[0] && photo(item.data.photos[0], "private")}
            {!publicItem && <button type="button" className="text-button" disabled={!canWrite}
              onClick={() => void run(() => service.trash(item), "已移至回收站")}>移除衣物</button>}
          </li>;
        })}</ul>
        {partner && <WardrobeShareForm key={shared?.edition ?? 0} service={service} items={items} selection={mine} busy={!canWrite} run={run} />}
      </section> : <p>当前设备可参与共享搭配。使用自己的加密备份恢复后可访问私人衣橱。</p>}
      {!!preview.length && shared && incoming && (
        <section aria-label="收到的搭配">
          <h3>收到的搭配</h3>
          <ul>{preview.map(({ id, slot, name }) => <li key={id}>{slot} · {name}</li>)}</ul>
          {shared.response?.revision === incoming.revision ? <p>{shared.response.accepted ? "已采纳" : "已婉拒"}</p> : <>
            <button className="primary" disabled={!canWrite}
              onClick={() => void run(() => respondToWardrobe(service, shared.edition, incoming.revision, true))}>采纳搭配</button>
            <button className="text-button" disabled={!canWrite}
              onClick={() => void run(() => respondToWardrobe(service, shared.edition, incoming.revision, false))}>婉拒搭配</button>
          </>}
        </section>
      )}
      <section aria-label="对方共享的衣物">
        <h3>对方共享的衣物</h3>
        {theirs?.data.wardrobeSelection?.items.length ? <>
          {theirs.data.wardrobeSelection.weather && <p>天气备注：{theirs.data.wardrobeSelection.weather}</p>}
          {!!sharedPhotos.length && <ul aria-label="已共享的衣物照片">
            {sharedPhotos.map(({ id, name, slot, attachment }) => <li key={id}>
              {slot} · {name}
              {photo(attachment, "shared")}
            </li>)}
          </ul>}
          <SuggestionForm key={`${theirs.id}:${theirs.data.wardrobeSelection.edition}:${outgoing?.revision ?? 0}`}
            service={service} selection={theirs} previous={outgoing} busy={!canWrite} run={run} />
        </> : <p>{partner ? "对方还没有共享衣物。" : "双方加入后即可共享搭配。"}</p>}
      </section>
    </div>
  );
}
