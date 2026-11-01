import type { Repository, Tx } from "./api";
export class MemoryRepository implements Repository {
  data: Record<string, Record<string, any>> = {};
  private pending: Promise<unknown> = Promise.resolve();
  constructor(
    initial?: Record<string, Record<string, any>>,
    private persist?: (data: typeof this.data) => void,
  ) {
    if (initial) this.data = initial;
  }
  async get(c: string, id: string) {
    const table = Object.prototype.hasOwnProperty.call(this.data, c)
      ? this.data[c]
      : undefined;
    return structuredClone(
      table && Object.prototype.hasOwnProperty.call(table, id)
        ? table[id]
        : null,
    );
  }
  async put(c: string, id: string, value: any) {
    const table = Object.prototype.hasOwnProperty.call(this.data, c)
      ? this.data[c]
      : {};
    const next = {
      ...this.data,
      [c]: { ...table, [id]: structuredClone(value) },
    };
    this.persist?.(next);
    this.data = next;
  }
  async remove(c: string, id: string) {
    const table = {
      ...(Object.prototype.hasOwnProperty.call(this.data, c)
        ? this.data[c]
        : {}),
    };
    delete table[id];
    const next = { ...this.data, [c]: table };
    this.persist?.(next);
    this.data = next;
  }
  async list(
    c: string,
    where: Record<string, unknown>,
    offset: number,
    limit: number,
  ) {
    return structuredClone(
      Object.values(
        Object.prototype.hasOwnProperty.call(this.data, c) ? this.data[c] : {},
      )
        .filter((r) => Object.entries(where).every(([k, v]) => r[k] === v))
        .sort(
          (a, b) =>
            (a.createdAt || 0) - (b.createdAt || 0) ||
            String(a.id).localeCompare(String(b.id)),
        )
        .slice(offset, offset + limit),
    );
  }
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const run = this.pending.then(async () => {
      const next = new MemoryRepository(structuredClone(this.data));
      const result = await fn(next);
      this.persist?.(next.data);
      this.data = next.data;
      return result;
    });
    this.pending = run.catch(() => {});
    return run;
  }
}
