import { useEffect, useState } from "react";
import { decryptPhoto, unb64 } from "../src/core/crypto";
import { PHOTO_MIMES } from "../src/core/photos";
import type { Attachment, Secrets, Visibility } from "../src/core/types";
import { readOfflinePhoto } from "./cipherCache";

function OfflinePhoto({ account, photo, visibility, secrets }: {
  account: string;
  photo: Attachment;
  visibility: Visibility;
  secrets: Secrets;
}) {
  const [src, setSrc] = useState<string>();
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let current = true;
    let url: string | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clear = () => {
      if (url) URL.revokeObjectURL(url);
      url = undefined;
    };
    void (async () => {
      try {
        if (!photo.fileId || !PHOTO_MIMES.includes(photo.mime)) return;
        const saved = await readOfflinePhoto(account, secrets, photo.fileId);
        if (!current || !saved || saved.expiresAt <= Date.now()) return;
        const bytes = unb64(decryptPhoto(saved.envelope, secrets, photo.id, visibility));
        url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: photo.mime }));
        setSrc(url);
        timer = setTimeout(() => { clear(); setSrc(undefined); }, saved.expiresAt - Date.now());
      } catch { /* A missing or invalid envelope is rendered as unavailable. */ }
      finally { if (current) setLoading(false); }
    })();
    return () => { current = false; clearTimeout(timer); clear(); };
  }, [account, photo, secrets, visibility]);
  return src ? <img src={src} alt={photo.name} onError={() => setSrc(undefined)} />
    : <p>{loading ? "正在读取本机照片" : "这张照片需要联网查看"}</p>;
}

export function OfflinePhotos({ photos, ...context }: {
  account: string;
  photos: Attachment[];
  visibility: Visibility;
  secrets: Secrets;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <details onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary>查看离线照片</summary>
      {expanded && <div className="offline-photos">
        {photos.map((photo) => <OfflinePhoto key={photo.id} photo={photo} {...context} />)}
      </div>}
    </details>
  );
}
