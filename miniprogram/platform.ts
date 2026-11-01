import "./polyfill";
import { AppError, type RandomSource } from "../src/core/types";
import { createTransport } from "../src/core/transport";
import { UsService } from "../src/core/service";
import { config } from "./config";
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
  if (!config.cloudEnv)
    throw new AppError(
      "CLOUD_NOT_CONFIGURED",
      "请先在 miniprogram/config.ts 填写云环境 ID 并部署 usApi",
    );
  const res = await wx.cloud.callFunction({
    name: config.cloudFunction,
    data: { action, data },
  });
  return res.result;
});
export const service = new UsService(
  transport,
  {
    get: (k) => wx.getStorageSync(`us.${k}`) || null,
    set: (k, v) => wx.setStorageSync(`us.${k}`, v),
    remove: (k) => wx.removeStorageSync(`us.${k}`),
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
  const path = `${wx.env.USER_DATA_PATH}/us-${entry.visibility}-${photo.id}.${photo.mime === "image/png" ? "png" : photo.mime === "image/webp" ? "webp" : "jpg"}`;
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
      if (/^us-[a-zA-Z0-9_-]+\.(jpg|png|webp)$/.test(name)) {
        try {
          fs.unlinkSync(`${wx.env.USER_DATA_PATH}/${name}`);
        } catch {}
      }
  } catch {}
}
