import { AppError } from "../src/core/types";
import type { RecordOutbox, OutboxItem } from "../src/core/web-outbox";

const storeName = "writes";
const maxItems = 50;
const maxBytes = 8 * 1024 * 1024;

async function transact<T>(
  mode: IDBTransactionMode, work: (store: IDBObjectStore, setResult: (value: T) => void) => void,
): Promise<T> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open("us-web-outbox", 1);
    open.onupgradeneeded = () => {
      const store = open.result.createObjectStore(storeName, { keyPath: ["scope", "operationId"] });
      store.createIndex("byScope", "scope");
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(storeName, mode);
      let result: T;
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = () => reject(transaction.error ?? new AppError("OUTBOX_STORAGE", "待同步队列保存失败"));
      work(transaction.objectStore(storeName), (value) => { result = value; });
    });
  } finally { database.close(); }
}

export const webOutbox: RecordOutbox = {
  read: (scope) => transact<OutboxItem[]>("readonly", (store, result) => {
    const request = store.index("byScope").getAll(scope);
    request.onsuccess = () => result(request.result.sort((a, b) => a.queuedAt - b.queuedAt));
  }),
  async add(item) {
    const failure = await transact<string | undefined>("readwrite", (store, result) => {
      const request = store.index("byScope").getAll(item.scope);
      request.onsuccess = () => {
        const existing: OutboxItem[] = request.result;
        if (existing.some(({ record }) => record.id === item.record.id)) result("这条记录已有一次待同步编辑");
        else if (existing.length >= maxItems || new Blob([JSON.stringify([...existing, item])]).size > maxBytes)
          result("本机待同步队列已满，请先同步或移除部分项目");
        else store.add(item);
      };
    });
    if (failure) throw new AppError("OUTBOX_FULL", failure);
  },
  set: (item) => transact<void>("readwrite", (store) => { store.put(item); }),
  remove: (scope, operationId) => transact<void>("readwrite", (store) => { store.delete([scope, operationId]); }),
  exclusive: async (scope, work) => {
    if (!navigator.locks) throw new AppError("LOCKS_UNAVAILABLE", "当前浏览器无法安全协调多个标签页，请保留队列并使用支持 Web Locks 的浏览器版本");
    return await navigator.locks.request(`us-outbox:${scope}`, { ifAvailable: true }, (lock) => lock ? work() : undefined);
  },
};
