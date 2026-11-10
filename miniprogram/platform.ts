import "./polyfill";
import { AppError, type RandomSource } from "../src/core/types";
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
  if (action === "filePut" || action.startsWith("fileUpload")) {
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
export async function photoPath(
  entry: import("../src/core/types").Entry,
  photo: import("../src/core/types").Attachment,
): Promise<string> {
  if (photo.sample) {
    if (!["coffee", "sea", "sunset"].includes(photo.sample))
      throw new AppError("INVALID_IMAGE", "未知的示例照片");
    return `/assets/${photo.sample}.png`;
  }
  const session = service.secrets;
  if (!session || !/^[A-Za-z0-9_-]{1,80}$/.test(photo.id))
    throw new AppError("INVALID_IMAGE", "照片标识不正确或空间已锁定");
  const extension = photo.mime === "image/png" ? "png" : photo.mime === "image/webp" ? "webp" : "jpg";
  const path = `${wx.env.USER_DATA_PATH}/${photoPrefix}${entry.visibility}-${photo.id}.${extension}`;
  try {
    wx.getFileSystemManager().accessSync(path);
    return path;
  } catch {}
  const value = await service.readPhoto(photo, entry.visibility);
  if (session !== service.secrets || !session)
    throw new AppError("LOCKED", "请先解锁");
  wx.getFileSystemManager().writeFileSync(path, value, "base64");
  return path;
}
export function clearDecryptedFiles() {
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
