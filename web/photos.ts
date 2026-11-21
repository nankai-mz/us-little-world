import {
  fitPhoto,
  MAX_PHOTO_BYTES,
  MAX_SOURCE_PHOTO_BYTES,
} from "../src/core/photos";
import { AppError } from "../src/core/types";

export async function prepareBrowserPhoto(file: File): Promise<Blob> {
  const invalidImage = () => new AppError("INVALID_IMAGE", "请选择 25 MB 以内可读取的 JPG、PNG 或 WebP 照片");
  if (!file.size || file.size > MAX_SOURCE_PHOTO_BYTES) throw invalidImage();
  const header = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const matches = (at: number, signature: number[]) => signature.every((byte, offset) => header[at + offset] === byte);
  const mime = matches(0, [0xff, 0xd8, 0xff]) ? "image/jpeg"
    : matches(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) ? "image/png"
    : matches(0, [0x52, 0x49, 0x46, 0x46]) && matches(8, [0x57, 0x45, 0x42, 0x50]) ? "image/webp"
    : null;
  if (!mime) throw invalidImage();
  if (typeof createImageBitmap !== "function")
    throw new AppError("IMAGE_UNSUPPORTED", "当前浏览器无法处理照片，请更新浏览器后重试");
  const bitmap = await createImageBitmap(file.slice(0, file.size, mime), { imageOrientation: "from-image" })
    .catch(() => { throw invalidImage(); });
  const canvas = document.createElement("canvas");
  try {
    const result = await fitPhoto(
      {
        value: file as Blob,
        size: file.size,
        mime,
        width: bitmap.width,
        height: bitmap.height,
      },
      async (width, height, quality) => {
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");
        if (!context)
          throw new AppError(
            "IMAGE_UNSUPPORTED",
            "当前浏览器无法处理照片，请更新浏览器后重试",
          );
        context.drawImage(bitmap, 0, 0, width, height);
        const encode = (type: string) => new Promise<Blob>((resolve, reject) =>
          canvas.toBlob(
            (value) =>
              value
                ? resolve(value)
                : reject(new AppError("INVALID_IMAGE", "照片压缩暂时失败")),
            type,
            quality / 100,
          ),
        );
        let blob: Blob;
        if (mime === "image/png" && quality === 82) {
          blob = await encode("image/png");
          if (blob.size > MAX_PHOTO_BYTES) blob = await encode("image/webp");
        } else {
          blob = await encode(mime === "image/png" ? "image/webp" : mime);
        }
        return { value: blob, size: blob.size, mime: blob.type, width, height };
      },
      { alwaysEncode: true },
    );
    return result.value;
  } finally {
    bitmap.close();
    canvas.width = canvas.height = 0;
  }
}
