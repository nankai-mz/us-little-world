import { useRef, useState, type ReactNode } from "react";

const pageSize = 30;

export function MemoryPages<T>({ items, label, render }: {
  items: T[];
  label: string;
  render: (items: T[]) => ReactNode;
}) {
  const [selectedPage, setSelectedPage] = useState(0);
  const start = useRef<HTMLElement>(null);
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const page = Math.min(selectedPage, pageCount - 1);
  const offset = page * pageSize;
  const end = Math.min(offset + pageSize, items.length);
  const turnPage = (next: number) => {
    setSelectedPage(next);
    start.current?.focus({ preventScroll: true });
    start.current?.scrollIntoView({ block: "start" });
  };
  return <section className="memory-pages" ref={start} tabIndex={-1} aria-label={label}>
    {render(items.slice(offset, end))}
    {pageCount > 1 && <nav className="memory-pagination" aria-label={`${label}分页`}>
      <button type="button" className="secondary" disabled={page === 0} onClick={() => turnPage(page - 1)}>上一页</button>
      <span role="status">第 {offset + 1}–{end} 项，共 {items.length} 项</span>
      <button type="button" className="secondary" disabled={page >= pageCount - 1} onClick={() => turnPage(page + 1)}>下一页</button>
    </nav>}
  </section>;
}
