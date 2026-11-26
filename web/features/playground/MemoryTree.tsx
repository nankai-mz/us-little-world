import { useMemo, useState } from "react";
import type { UsService } from "../../../src/core/service";
import type { Entry } from "../../../src/core/types";
import type { MemoryReference } from "../../../src/features/play-core/async-games";
import type { MediaCommand, Tree } from "../../../src/features/play-core/media-games";
import { MemoryPages } from "../../MemoryPages";
import { exportTree, leafPosition } from "./visualExport";

type TreeContext = { service: UsService; openMemory: (entry: Entry) => void; report: (error: unknown) => void; reduceMotion?: boolean };

function TreeYear({ entries, year, onChange }: { entries: Entry[]; year: string; onChange: (value: string) => void }) {
  const years = [...new Set([year, ...entries.map(({ data }) => data.date.slice(0, 4))])].filter(Boolean).sort().reverse();
  return <label>年份<select aria-label="年份" value={year} onChange={(event) => onChange(event.target.value)}>
    <option value="">所有年份</option>{years.map((value) => <option key={value}>{value}</option>)}
  </select></label>;
}

const symbol = (entry: Entry) => entry.data.kind === "anniversary" ? "🌸" : entry.data.photos?.length ? "🍎" : "🍃";

function TreeLeaves({ service, openMemory, report, reduceMotion, entries, year }: TreeContext & { entries: Entry[]; year: string }) {
  const [view, setView] = useState<"tree" | "list">();
  const showTree = view ? view === "tree" : !reduceMotion;
  const privateCount = entries.filter(({ visibility }) => visibility === "private").length;
  return <>
    <div className="play-garden"><span aria-hidden="true">🌳</span><h3>{year ? `${year} 年回忆树` : "所有年份的回忆树"}</h3>
      <p>{entries.length} 片叶子 · {entries.filter((leaf) => leaf.data.photos?.length).length} 颗照片果实</p></div>
    <div className="play-actions">
      <button disabled={!entries.length} onClick={() => {
        if (entries.length) openMemory(entries[crypto.getRandomValues(new Uint32Array(1))[0] % entries.length]);
      }}>随机一片叶子</button>
      <button aria-pressed={!showTree} onClick={() => setView(showTree ? "list" : "tree")}>{showTree ? "只显示列表" : "显示树形图"}</button>
      <button disabled={!entries.length} onClick={() => {
        const included = privateCount ? `，其中有 ${privateCount} 片自己的私人叶子` : "";
        if (window.confirm(`树图将包含所选年份的 ${entries.length} 片叶子${included}。导出的图片可直接查看。继续导出？`))
          void exportTree(service, entries, year).catch(report);
      }}>导出树图 PNG</button>
    </div>
    {!entries.length ? <p>当前范围内没有回忆叶子。</p> : <MemoryPages key={year} items={entries} label="回忆树叶子" render={(page) => <>
      {showTree && <div className="play-tree-plot" aria-label="回忆树枝叶" role="group">
        <div className="play-tree-trunk" aria-hidden="true" />
        {Array.from({ length: 6 }, (_, index) => <i aria-hidden="true" key={index} style={{ top: 22 + index * 10 + "%" }} />)}
        {page.map((entry) => {
          const leaf = leafPosition(entry);
          return <button key={entry.id} aria-label={entry.data.title} style={{ left: leaf.x + "%", top: leaf.y + "%" }}
            onClick={() => openMemory(entry)}>{symbol(entry)}</button>;
        })}
      </div>}
      <ul className="play-leaves">{page.map((entry) => <li key={entry.id}>
        <button onClick={() => openMemory(entry)}>{symbol(entry)}　{entry.data.date}　{entry.data.title}
          {entry.visibility === "private" ? "　私人" : ""}</button>
      </li>)}</ul>
    </>} />}
  </>;
}

function isTreeEntry(entry: Entry) { return !entry.deletedAt && (entry.data.kind === "memory" || entry.data.kind === "anniversary"); }

export function MemoryTreeEditor({ game, disabled, submit, ...context }: TreeContext & {
  game: Tree; disabled: boolean; submit: (command: MediaCommand) => Promise<boolean>;
}) {
  const { service } = context;
  const [year, setYear] = useState("");
  const [showPrivate, setShowPrivate] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState("");
  const own = showPrivate && service.hasPrivateAccess;
  const active = service.active, owner = service.userId;
  const entries = useMemo(() => active.filter((entry) => isTreeEntry(entry) &&
    (entry.visibility === "shared" || (own && entry.creatorId === owner))), [active, own, owner]);
  const selectedIds = useMemo(() => new Set(game.selected), [game.selected]);
  const inYear = entries.filter(({ data }) => !year || data.date.startsWith(year));
  const leaves = inYear.filter((entry) => entry.visibility === "private" || selectedIds.has(entry.id));
  const needle = query.trim().normalize("NFKC").toLowerCase();
  const candidates = inYear.filter(({ visibility, data }) => visibility === "shared" &&
    `${data.date} ${data.title} ${data.tags?.join(" ") ?? ""}`.normalize("NFKC").toLowerCase().includes(needle));
  return <>
    <div className="play-fields play-split">
      <TreeYear entries={entries} year={year} onChange={setYear} />
      {service.hasPrivateAccess && <label className="play-check"><input type="checkbox" checked={own}
        onChange={(event) => setShowPrivate(event.target.checked)} />在这台设备上显示自己的私人叶子</label>}
    </div>
    {!disabled && <div className="play-fields">
      <label>搜索共同回忆<input type="search" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
      <MemoryPages key={`${year}:${needle}`} items={candidates} label="共同回忆候选" render={(page) => {
        const picked = page.find(({ id }) => id === selected);
        return <div className="play-fields">
          <label>挑一条共同回忆<select value={picked?.id ?? ""} onChange={(event) => setSelected(event.target.value)}>
            <option value="">选择回忆</option>{page.map(({ id, data }) => <option key={id} value={id}>
              {data.date} · {data.title}{selectedIds.has(id) ? " · 已在树上" : ""}
            </option>)}
          </select></label>
          <button disabled={!picked} onClick={() => {
            if (picked) void submit({ type: "tree.select", id: picked.id, include: !selectedIds.has(picked.id) });
          }}>{picked && selectedIds.has(picked.id) ? "取下这片叶子" : "把回忆挂到树上"}</button>
        </div>;
      }} />
    </div>}
    <TreeLeaves {...context} entries={leaves} year={year} />
  </>;
}

export function ArchivedMemoryTree({ references, ...context }: TreeContext & { references: MemoryReference[] }) {
  const [year, setYear] = useState("");
  const active = context.service.active;
  const entries = useMemo(() => {
    const ids = new Set(references.map(({ recordId }) => recordId));
    return active.filter((entry) => entry.visibility === "shared" && ids.has(entry.id) && isTreeEntry(entry));
  }, [active, references]);
  return <div className="play-tree-archive play-fields">
    <TreeYear entries={entries} year={year} onChange={setYear} />
    <TreeLeaves {...context} entries={entries.filter(({ data }) => !year || data.date.startsWith(year))} year={year} />
    {references.length > entries.length && <p>{references.length - entries.length} 段关联回忆已移除或暂不可访问。</p>}
  </div>;
}
