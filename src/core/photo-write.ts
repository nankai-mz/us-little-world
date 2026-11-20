import { hashText, randomId, seal, unb64 } from "./crypto";
import { base64ByteLength, MAX_PHOTO_BYTES, PHOTO_MIMES } from "./photos";
import { AppError, type Envelope, type RandomSource, type Secrets, type Visibility } from "./types";

export function photoReceiptFor(visibility: Visibility, envelope: Envelope) {
  return hashText(JSON.stringify([visibility, envelope]));
}

export function photoFileId(spaceId: string, userId: string, receipt: string, hash = hashText) {
  return hash(JSON.stringify([spaceId, userId, receipt])).slice(0, 32);
}

export async function preparePhotoWrite(
  bytes: string, mime: string, name: string, visibility: Visibility,
  secrets: Secrets, keyVersion: number, rng: RandomSource,
) {
  if (!PHOTO_MIMES.includes(mime)) throw new AppError("INVALID_IMAGE", "支持 JPG、PNG 和 WebP 图片");
  const size = base64ByteLength(bytes);
  if (size > MAX_PHOTO_BYTES) throw new AppError("FILE_TOO_LARGE", "请使用小于 500 KB 的照片");
  const key = visibility === "private" ? (!secrets.sharedOnly && secrets.personalKey) : secrets.spaceKeys[keyVersion];
  if (!key) throw new AppError("KEY_NOT_FOUND", "缺少照片密钥，请先联机核验");
  const id = await randomId(rng);
  const envelope = await seal({ base64: bytes }, unb64(key),
    `Us/file/1/${secrets.spaceId}/${id}/${visibility}`, rng, keyVersion);
  const fileId = photoFileId(secrets.spaceId, secrets.userId, photoReceiptFor(visibility, envelope));
  return { photo: { id, fileId, name, mime, bytes: size }, envelope };
}
