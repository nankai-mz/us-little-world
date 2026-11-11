import "./polyfill";
import { AppError, type Attachment, type RandomSource, type Visibility } from "../src/core/types";
import { createTransport } from "../src/core/transport";
import { UsService } from "../src/core/service";
import { cloudTarget } from "./cloud";

const { env, functionName, localScope } = cloudTarget;
export const isTestSpace = !!localScope;
// Keep the existing production vault keys and file names.
const storagePrefix = localScope ? `us.${localScope}.` : "us.";
const photoPrefix = localScope ? `us-${localScope}.` : "us-";

export function localExportPath(fileName: string) {
  const prefix = localScope ? `us-${localScope}.` : "";
  return `${wx.env.USER_DATA_PATH}/${prefix}${fileName}`;
}

const rng: RandomSource = (n) =>
  new Promise((resolve, reject) => {
    if (typeof wx.getRandomValues !== "function")
      return reject(
        new AppError(
          "UNSUPPORTED_RANDOM",
          "当前微信不支持安全随机数，请更新微信或基础库",
        ),
      );
    wx.getRandomValues({
      length: n,
      success: (res) => resolve(new Uint8Array(res.randomValues)),
      fail: reject,
    });
  });
const transport = createTransport(async (action, data) => {
  if (!env)
    throw new AppError(
      "CLOUD_NOT_CONFIGURED",
      "请先在 miniprogram/config.ts 填写云环境 ID 并部署 usApi",
    );
  const request = {
    name: functionName,
    config: { env },
    data: { action, data },
  };
  if (action === "fileGet" || action === "filePut" || action.startsWith("fileUpload")) {
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      if (isTestSpace) console.info("[photo]", action, "sent");
      wx.cloud.callFunction({
        ...request,
        success: (result) => {
          if (isTestSpace) console.info("[photo]", action, "reply", Date.now() - startedAt);
          resolve(result.result);
        },
        fail: (error) => {
          if (isTestSpace) {
            const code = /\berrCode:\s*(-?\d{1,8})\b/.exec(error.errMsg)?.[1] || "unknown";
            console.info("[photo]", action, "fail", Date.now() - startedAt, code);
          }
          reject(error);
        },
      });
    });
  }
  const res = await wx.cloud.callFunction(request);
  return res.result;
});
export const service = new UsService(
  transport,
  {
    get: (k) => wx.getStorageSync(storagePrefix + k) || null,
    set: (k, v) => wx.setStorageSync(storagePrefix + k, v),
    remove: (k) => wx.removeStorageSync(storagePrefix + k),
  },
  rng,
);
let photoGeneration = 0;
let photoFileSequence = 0;
const cachedPhotos = new Map<string, string>();
const pendingPhotos = new Map<string, Promise<string>>();
let photoSession = service.secrets;

function photoCacheKey(visibility: Visibility, photo: Attachment) {
  return JSON.stringify([visibility, photo.id, photo.fileId, photo.mime]);
}

export function cachedPhotoPath(visibility: Visibility, photo: Attachment) {
  if (photo.sample) {
    return ["coffee", "sea", "sunset"].includes(photo.sample)
      ? `/assets/${photo.sample}.png`
      : "";
  }
  if (photoSession !== service.secrets) clearDecryptedFiles();
  return service.secrets ? cachedPhotos.get(photoCacheKey(visibility, photo)) || "" : "";
}

export function forgetPhotoPath(visibility: Visibility, photo: Attachment, url: string) {
  const key = photoCacheKey(visibility, photo);
  if (cachedPhotos.get(key) !== url) return;
  cachedPhotos.delete(key);
  try { wx.getFileSystemManager().unlinkSync(url); } catch {}
}

export async function photoPath(
  visibility: Visibility,
  photo: Attachment,
  localBytes?: string,
): Promise<string> {
  const cached = cachedPhotoPath(visibility, photo);
  if (cached) return cached;
  const session = service.secrets;
  if (!session || photo.sample || !/^[A-Za-z0-9_-]{1,80}$/.test(photo.id))
    throw new AppError("INVALID_IMAGE", "照片标识不正确或空间已锁定");
  const key = photoCacheKey(visibility, photo);
  const pending = pendingPhotos.get(key);
  if (pending) return pending;
  const generation = photoGeneration;
  const active = () => generation === photoGeneration && session === service.secrets;
  const extension = photo.mime === "image/png" ? "png" : photo.mime === "image/webp" ? "webp" : "jpg";
  const path = `${wx.env.USER_DATA_PATH}/${photoPrefix}${visibility}-${photo.id}-${++photoFileSequence}.${extension}`;
  const load = (async () => {
    const value = localBytes ?? await service.readPhoto(photo, visibility, active);
    if (!active()) throw new AppError("PHOTO_CACHE_EXPIRED", "照片缓存已过期");
    const fs = wx.getFileSystemManager();
    await new Promise<void>((resolve, reject) => fs.writeFile({
      filePath: path, data: value, encoding: "base64", success: () => resolve(), fail: reject,
    }));
    if (!active()) {
      try { fs.unlinkSync(path); } catch {}
      throw new AppError("PHOTO_CACHE_EXPIRED", "照片缓存已过期");
    }
    cachedPhotos.set(key, path);
    return path;
  })();
  pendingPhotos.set(key, load);
  try {
    return await load;
  } finally {
    if (pendingPhotos.get(key) === load) pendingPhotos.delete(key);
  }
}
export function clearDecryptedFiles() {
  photoGeneration++;
  photoSession = service.secrets;
  cachedPhotos.clear();
  pendingPhotos.clear();
  const fs = wx.getFileSystemManager();
  try {
    for (const name of fs.readdirSync(wx.env.USER_DATA_PATH))
      if (name.startsWith(photoPrefix) && /^[a-zA-Z0-9_-]+\.(jpg|png|webp)$/.test(name.slice(photoPrefix.length))) {
        try {
          fs.unlinkSync(`${wx.env.USER_DATA_PATH}/${name}`);
        } catch {}
      }
  } catch {}
}
