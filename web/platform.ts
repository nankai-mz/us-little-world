import { createApi } from "../src/server/api";
import { MemoryRepository } from "../src/server/memory-repo";
import {
  AppError,
  type StorageAdapter,
  type Transport,
} from "../src/core/types";
import { browserRandom, hashText, recoverVault } from "../src/core/crypto";
import { UsService } from "../src/core/service";
export function createBrowserService(mode: "demo" | "personal") {
  const prefix = `us.${mode}.`;
  const storage: StorageAdapter = {
    get: (k) => localStorage.getItem(prefix + k),
    set: (k, v) => localStorage.setItem(prefix + k, v),
    remove: (k) => localStorage.removeItem(prefix + k),
  };
  return createLocalService(storage);
}
export function createLocalService(storage: StorageAdapter) {
  let userId = storage.get("userId");
  if (!userId) {
    userId = crypto.randomUUID().replace(/-/g, "");
    storage.set("userId", userId);
  }
  const repo = new MemoryRepository(
    JSON.parse(storage.get("database") || "{}"),
    (data) => storage.set("database", JSON.stringify(data)),
  );
  const api = createApi({
    runtime: { mode: "local" },
    repo,
    now: Date.now,
    id: () => crypto.randomUUID().replace(/-/g, ""),
    hash: hashText,
    filePut: async (path, bytes) => {
      storage.set(`file.${path}`, bytes);
      return path;
    },
    fileGet: async (path) => storage.get(`file.${path}`) || "{}",
    fileDelete: async (path) => storage.remove(`file.${path}`),
  });
  const transport: Transport = {
    async call<T>(action: string, data = {}): Promise<T> {
      const reply = await api(userId!, action, data);
      if (!reply.success)
        throw new AppError(reply.error!.code, reply.error!.message);
      return reply.data as T;
    },
  };
  return new UsService(transport, storage, browserRandom);
}

export async function stageBackup(
  backup: any,
  recoveryKey: string,
  password: string,
): Promise<Record<string, string>> {
  if (
    backup?.format !== "UsBackup" ||
    backup.version !== 1 ||
    typeof backup.database !== "string"
  )
    throw new AppError("INVALID_BACKUP", "请选择有效的 Us 加密备份");
  const recovered = recoverVault(backup.vault, recoveryKey);
  const database = JSON.parse(backup.database);
  if (!database || typeof database !== "object" || Array.isArray(database))
    throw new AppError("INVALID_BACKUP", "备份数据库格式不正确");
  const values: Record<string, string> = {
    userId: recovered.userId,
    database: backup.database,
  };
  for (const [name, value] of Object.entries(backup.files || {})) {
    if (
      !/^file\.encrypted\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+\.enc$/.test(name) ||
      typeof value !== "string"
    )
      throw new AppError("INVALID_BACKUP", "备份中的文件路径不正确");
    values[name] = value;
  }
  const storage: StorageAdapter = {
    get: (k) => values[k] ?? null,
    set: (k, v) => {
      values[k] = v;
    },
    remove: (k) => {
      delete values[k];
    },
  };
  // Validate recovery in isolation. A bad key, identity, or database never touches live storage.
  const staged = createLocalService(storage);
  await staged.recover(backup.vault, recoveryKey, password);
  if (staged.unreadable)
    throw new AppError(
      "INVALID_BACKUP",
      "备份中有无法解密的记录，原空间未被覆盖",
    );
  return values;
}
export function commitBackup(
  mode: "demo" | "personal",
  values: Record<string, string>,
) {
  const previous = new Map<string, string | null>();
  try {
    for (const [key, value] of Object.entries(values)) {
      const name = `us.${mode}.${key}`;
      previous.set(name, localStorage.getItem(name));
      localStorage.setItem(name, value);
    }
    localStorage.setItem("us.mode", mode);
  } catch (error) {
    for (const [key, value] of previous) {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    }
    throw new AppError(
      "STORAGE_FULL",
      "本机存储空间不足，恢复未完成，原数据已保留",
    );
  }
}
export function download(
  name: string,
  data: string,
  mime = "application/json",
) {
  const url = URL.createObjectURL(new Blob([data], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
