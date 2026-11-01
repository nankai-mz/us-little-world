import {
  fitPhoto,
  MAX_SOURCE_PHOTO_BYTES,
  PHOTO_MIMES,
} from "../src/core/photos";
import { AppError } from "../src/core/types";

export async function prepareBrowserPhoto(file: File): Promise<Blob> {
  if (
    !PHOTO_MIMES.includes(file.type) ||
    !file.size ||
    file.size > MAX_SOURCE_PHOTO_BYTES
  )
    throw new AppError(
      "INVALID_IMAGE",
      "请选择 25 MB 以内的 JPG、PNG 或 WebP 照片",
    );
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement("canvas");
    const result = await fitPhoto(
      {
        value: file as Blob,
        size: file.size,
        mime: file.type,
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
        context.fillStyle = "#fff";
        context.fillRect(0, 0, width, height);
        context.drawImage(bitmap, 0, 0, width, height);
        const blob = await new Promise<Blob>((resolve, reject) =>
          canvas.toBlob(
            (value) =>
              value
                ? resolve(value)
                : reject(new AppError("INVALID_IMAGE", "照片压缩暂时失败")),
            "image/jpeg",
            quality / 100,
          ),
        );
        return { value: blob, size: blob.size, mime: blob.type, width, height };
      },
    );
    return result.value;
  } finally {
    bitmap.close();
  }
}
