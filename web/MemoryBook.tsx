import { useCallback, useState } from "react";
import type { UsService } from "../src/core/service";
import type { Entry } from "../src/core/types";
import { SharedMemoryPhoto } from "./SharedMemoryPhoto";
import type { BookDraft } from "./bookDraft";
type Period = BookDraft["period"];

function BookPreview({ entries, draft, service, close }: {
  entries: Entry[];
  draft: BookDraft;
  service: UsService;
  close: () => void;
}) {
  const [settled, setSettled] = useState<Set<string>>(() => new Set());
  const markSettled = useCallback((id: string) => setSettled((previous) =>
    previous.has(id) ? previous : new Set([...previous, id])), []);
  const reading = entries.some(({ data }) => data.photos?.some((photo) =>
    (photo.fileId || photo.sample) && !settled.has(`${photo.id}:${photo.fileId ?? photo.sample}`)));
  return <>
    <div className="book-controls galaxy-buttons">
      <button type="button" className="secondary" onClick={close}>返回编辑纪念册</button>
      <button type="button" className="primary" disabled={reading || !entries.length} onClick={() => window.print()}>
        打印纪念册 / 保存 PDF
      </button>
      {reading && <span role="status">正在准备所选照片</span>}
      <p>打印稿含所选共同回忆的明文，可在浏览器打印对话框中选择保存为 PDF。</p>
    </div>
    <div className="book-print" aria-label="纪念册预览">
      <header className="book-cover">
        <h2>{draft.title.trim() || "我们的回忆纪念册"}</h2>
        {draft.note.trim() && <p>{draft.note.trim()}</p>}
      </header>
      {entries.map(({ id, data }) => <article className="book-page" key={id}>
        <h3>{data.title}</h3>
        <p><time dateTime={data.date}>{data.date}</time>{data.tags?.length ? ` · ${data.tags.join("、")}` : ""}</p>
        {data.body && <p className="book-body">{data.body}</p>}
        {(data.photos ?? []).filter((photo) => photo.fileId || photo.sample).map((photo) => {
          const key = `${photo.id}:${photo.fileId ?? photo.sample}`;
          return <figure key={key}>
            <SharedMemoryPhoto photo={photo} service={service} title={data.title} onSettled={() => markSettled(key)} />
          </figure>;
        })}
      </article>)}
    </div>
  </>;
}

export function MemoryBook({ memories, service, draft, setDraft, openMemory }: {
  memories: Entry[];
  service: UsService;
  draft: BookDraft;
  setDraft: (draft: BookDraft) => void;
  openMemory: (entry: Entry) => void;
}) {
  const [preview, setPreview] = useState(false);
  const valid = draft.period === "month" ? Boolean(draft.month) : draft.period === "year" ? /^\d{4}$/.test(draft.year)
    : Boolean(draft.from && draft.to && draft.from <= draft.to);
  const eligible = valid ? memories.filter((entry) => {
    if (entry.deletedAt || entry.visibility !== "shared" || entry.data.kind !== "memory") return false;
    if (draft.period === "month") return entry.data.date.startsWith(draft.month);
    if (draft.period === "year") return entry.data.date.startsWith(draft.year);
    return draft.from <= entry.data.date && entry.data.date <= draft.to;
  }) : [];
  const byId = new Map(eligible.map((entry) => [entry.id, entry]));
  const selected = draft.selected.flatMap((id) => {
    const entry = byId.get(id);
    return entry ? [entry] : [];
  });
  const selectRange = (change: Partial<BookDraft>) => setDraft({ ...draft, ...change, selected: [] });
  const move = (index: number, offset: number) => {
    const order = selected.map(({ id }) => id);
    [order[index], order[index + offset]] = [order[index + offset], order[index]];
    setDraft({ ...draft, selected: order });
  };
  return <section className="memory-book" aria-label="回忆纪念册">
    {preview ? <BookPreview entries={selected} draft={draft} service={service} close={() => setPreview(false)} /> : <>
      <div className="book-editor card">
        <h2>回忆纪念册</h2>
        <label>日期范围 <select value={draft.period} onChange={(event) => selectRange({ period: event.target.value as Period })}>
          <option value="month">按月</option><option value="year">按年</option><option value="custom">自定义日期</option>
        </select></label>
        {draft.period === "month" && <label>月份 <input type="month" value={draft.month} onChange={(event) => selectRange({ month: event.target.value })} /></label>}
        {draft.period === "year" && <label>年份 <input inputMode="numeric" maxLength={4} value={draft.year} onChange={(event) => selectRange({ year: event.target.value })} /></label>}
        {draft.period === "custom" && <>
          <label>开始日期 <input type="date" value={draft.from} onChange={(event) => selectRange({ from: event.target.value })} /></label>
          <label>结束日期 <input type="date" value={draft.to} onChange={(event) => selectRange({ to: event.target.value })} /></label>
        </>}
        {!valid && <p role="status">请选择有效的日期范围。</p>}
        <label>封面标题 <input value={draft.title} maxLength={100} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label>
        <label>封面寄语 <textarea value={draft.note} maxLength={500} onChange={(event) => setDraft({ ...draft, note: event.target.value })} /></label>
      </div>
      <fieldset className="card book-editor">
        <legend>选择共同回忆</legend>
        {valid && !eligible.length && <p>这段日期内还没有共同回忆。</p>}
        {eligible.map(({ id, data }) => <label key={id} className="book-choice">
          <input type="checkbox" checked={draft.selected.includes(id)} onChange={(event) => setDraft({ ...draft,
            selected: event.target.checked ? [...selected.map((entry) => entry.id), id] : draft.selected.filter((item) => item !== id),
          })} /> {data.date} · {data.title}
        </label>)}
      </fieldset>
      {selected.length > 0 && <div className="card book-editor">
        <h3>页面顺序</h3>
        <ol>{selected.map((entry, index) => <li key={entry.id}>
          <button type="button" className="text-button" onClick={() => openMemory(entry)}>{entry.data.title}</button>
          <div className="galaxy-buttons">
            <button type="button" className="secondary" aria-label={`上移 ${entry.data.title}`} disabled={index === 0} onClick={() => move(index, -1)}>上移</button>
            <button type="button" className="secondary" aria-label={`下移 ${entry.data.title}`} disabled={index === selected.length - 1} onClick={() => move(index, 1)}>下移</button>
          </div>
        </li>)}</ol>
        <button type="button" className="primary" onClick={() => setPreview(true)}>预览纪念册</button>
      </div>}
    </>}
  </section>;
}
