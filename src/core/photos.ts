import { AppError } from "./types";

export const MAX_PHOTO_BYTES = 500 * 1024;
export const MAX_SOURCE_PHOTO_BYTES = 25 * 1024 * 1024;
export const PHOTO_MIMES = ["image/jpeg", "image/png", "image/webp"];

export interface PreparedPhoto<T> {
  value: T;
  size: number;
  mime: string;
  width: number;
  height: number;
}

export function fittedSize(width: number, height: number, maxEdge: number) {
  if (![width, height].every((value) => Number.isFinite(value) && value > 0))
    throw new AppError("INVALID_IMAGE", "这张图片无法读取，请换一张试试");
  const ratio = Math.min(1, maxEdge / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
  };
}

/** The encoder always starts from the original image; results are checked by actual bytes. */
export async function fitPhoto<T>(
  source: PreparedPhoto<T>,
  encode: (
    width: number,
    height: number,
    quality: number,
  ) => Promise<PreparedPhoto<T>>,
): Promise<PreparedPhoto<T>> {
  if (
    !Number.isFinite(source.size) ||
    source.size <= 0 ||
    source.size > MAX_SOURCE_PHOTO_BYTES
  )
    throw new AppError("INVALID_IMAGE", "请选择 25 MB 以内的照片");
  if (source.size <= MAX_PHOTO_BYTES && PHOTO_MIMES.includes(source.mime))
    return source;
  const steps = [
    [1920, 82],
    [1600, 72],
    [1280, 62],
    [1024, 55],
    [800, 48],
    [640, 42],
    [480, 36],
    [320, 32],
  ];
  for (const [edge, quality] of steps) {
    const dimensions = fittedSize(source.width, source.height, edge);
    const result = await encode(dimensions.width, dimensions.height, quality);
    if (
      result.size > 0 &&
      result.size <= MAX_PHOTO_BYTES &&
      PHOTO_MIMES.includes(result.mime)
    )
      return result;
  }
  throw new AppError(
    "PHOTO_COMPRESSION_FAILED",
    "这张照片暂时无法压缩到合适大小，请换一张或裁剪后重试",
  );
}

export function base64ByteLength(value: string) {
  return (
    Math.floor((value.length * 3) / 4) -
    (value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0)
  );
}
