import type { UsService } from "../src/core/service";
import { AppError, type Attachment, type Secrets, type Visibility } from "../src/core/types";

type PhotoUrl = { references: number; url?: string; loaded: Promise<string> };
const photos = new WeakMap<Secrets, Map<string, PhotoUrl>>();
let available = 4;
const waiting: (() => void)[] = [];

async function withPhotoSlot<T>(load: () => Promise<T>) {
  if (available) available--;
  else await new Promise<void>((resolve) => waiting.push(resolve));
  try {
    return await load();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else available++;
  }
}

export function acquirePhotoUrl(service: UsService, photo: Attachment, visibility: Visibility) {
  const session = service.secrets;
  if (!session) throw new AppError("LOCKED", "请先解锁");
  let cache = photos.get(session);
  if (!cache) photos.set(session, cache = new Map());
  const key = JSON.stringify([photo.id, photo.fileId, photo.mime, visibility]);
  let entry = cache.get(key);
  if (!entry) {
    const current = () => cache.get(key) === entry && service.secrets === session;
    entry = { references: 0, loaded: withPhotoSlot(async () => {
      // Wait for the first reference to exist before starting a request.
      await Promise.resolve();
      if (!current()) throw new AppError("PHOTO_CACHE_EXPIRED", "照片缓存已释放");
      const bytes = await service.readPhotoBytes(photo, visibility, current);
      if (!current()) throw new AppError("PHOTO_CACHE_EXPIRED", "照片缓存已释放");
      return entry!.url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: photo.mime }));
    }) };
    cache.set(key, entry);
  }
  entry.references++;
  const retained = entry;
  return {
    loaded: retained.loaded,
    release() {
      if (--retained.references !== 0) return;
      cache.delete(key);
      if (retained.url) URL.revokeObjectURL(retained.url);
    },
  };
}
