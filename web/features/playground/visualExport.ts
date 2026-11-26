import { hashText } from "../../../src/core/crypto";
import type { UsService } from "../../../src/core/service";
import { AppError, type Entry } from "../../../src/core/types";
import type { PhotoReference, Sky } from "../../../src/features/play-core/media-games";
import { download } from "../../platform";
import { acquirePhotoUrl } from "../../photoUrls";

async function png(canvas: HTMLCanvasElement, name: string, service: UsService) {
  const session = service.secrets;
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new AppError("EXPORT_FAILED", "图片导出暂时失败");
  if (session && service.secrets === session) download(name, blob);
}

export async function exportEscapePostcard(service: UsService, name: string, members: [string, string]) {
  const canvas = document.createElement("canvas");
  canvas.width = 960;
  canvas.height = 560;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new AppError("EXPORT_FAILED", "无法生成通关明信片");
  ctx.fillStyle = "#f8edcf";
  ctx.fillRect(0, 0, 960, 560);
  ctx.strokeStyle = "#8d6c48";
  ctx.lineWidth = 3;
  ctx.strokeRect(32, 32, 896, 496);
  ctx.fillStyle = "#3d2f28";
  ctx.font = "500 30px system-ui";
  ctx.fillText("双人密室 · 通关明信片", 75, 122);
  ctx.font = "700 64px system-ui";
  ctx.fillText(name, 75, 258, 810);
  ctx.font = "500 38px system-ui";
  ctx.fillText(members.join(" 和 "), 75, 410, 810);
  await png(canvas, "Us-" + name + "-通关明信片.png", service);
}

function photoFor(service: UsService, ref: PhotoReference) {
  const entry = service.active.find((item) => item.id === ref.recordId && item.visibility === "shared");
  const photo = entry?.data.photos?.find((item) => item.fileId === ref.fileId);
  if (!photo) throw new AppError("REFERENCE_UNAVAILABLE", "一张天空照片已移除或暂不可访问");
  return acquirePhotoUrl(service, photo, "shared");
}

export async function exportSky(service: UsService, sky: Sky, id: string) {
  const session = service.secrets;
  if (!session || !sky.cards.every(Boolean)) return;
  const loaded: ReturnType<typeof photoFor>[] = [];
  try {
    const entries = await Promise.all(sky.cards.map(async (card) => {
      const token = photoFor(service, card!.photo);
      loaded.push(token);
      const image = new Image();
      image.src = await token.loaded;
      await image.decode();
      return { image, caption: [card!.city, card!.note].filter(Boolean).join(" · ") };
    }));
    if (service.secrets !== session) return;
    const canvas = document.createElement("canvas");
    const stacked = sky.layout === "stack";
    canvas.width = stacked ? 640 : 1040;
    canvas.height = stacked ? 920 : 510;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#fffaf0";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#4f544c";
    ctx.font = "24px system-ui";
    ctx.fillText("两扇窗的天空", 32, 45);
    entries.forEach(({ image, caption }, i) => {
      const x = stacked ? 32 : 32 + 500 * i;
      const y = stacked ? 70 + 420 * i : 70;
      const width = stacked ? 576 : 476;
      const height = 324;
      ctx.save();
      ctx.beginPath();
      if (sky.layout === "round") ctx.arc(x + width / 2, y + height / 2, height / 2, 0, 2 * Math.PI);
      else ctx.roundRect(x, y, width, height, 12);
      ctx.clip();
      const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight);
      ctx.drawImage(image, x + (width - image.naturalWidth * scale) / 2, y + (height - image.naturalHeight * scale) / 2,
        image.naturalWidth * scale, image.naturalHeight * scale);
      ctx.restore();
      ctx.font = "18px system-ui";
      ctx.fillText(caption, x, y + height + 34, width);
    });
    await png(canvas, "Us-天空-" + id.slice(0, 8) + ".png", service);
  } finally { for (const item of loaded) item.release(); }
}

export function leafPosition(entry: Entry) {
  const seed = Number.parseInt(hashText(entry.id).slice(0, 7), 16);
  const branch = Math.max(0, Math.min(11, (Number(entry.data.date.slice(5, 7)) || 1) - 1));
  const lane = branch % 2 ? 1 : -1;
  const base = 16 + (branch % 6) * 11;
  return { x: 50 + lane * (13 + (seed % 37) * 0.67), y: base + (Math.floor(seed / 37) % 17) - 5,
    flower: entry.data.kind === "anniversary", fruit: !!entry.data.photos?.length };
}

export async function exportTree(service: UsService, entries: Entry[], year: string) {
  const canvas = document.createElement("canvas");
  canvas.width = 1000; canvas.height = 780;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#f4efde";
  ctx.fillRect(0, 0, 1000, 780);
  ctx.strokeStyle = "#846a4b";
  ctx.lineCap = "round";
  ctx.lineWidth = 22;
  ctx.beginPath(); ctx.moveTo(500, 745); ctx.quadraticCurveTo(545, 520, 500, 255); ctx.stroke();
  for (let i = 0; i < 6; i++) {
    const height = 125 + i * 85;
    for (const direction of [-1, 1]) {
      ctx.lineWidth = 5;
      ctx.beginPath(); ctx.moveTo(506, Math.max(260, height + 134));
      ctx.quadraticCurveTo(506 + direction * 170, height + 50, 506 + direction * 370, height + 68);
      ctx.stroke();
    }
  }
  const leafScale = Math.min(1, Math.sqrt(240 / Math.max(1, entries.length)));
  entries.forEach((entry, index) => {
    const { x, y, flower, fruit } = leafPosition(entry);
    ctx.fillStyle = flower ? "#b45c79" : fruit ? "#b56a42" : ["#536d4b", "#7c8b56", "#a0a16a"][index % 3];
    ctx.beginPath(); ctx.ellipse(x * 10, 26 + y * 7.2, (flower || fruit ? 8 : 11) * leafScale, 6 * leafScale, x > 50 ? -0.4 : 0.4, 0, 2 * Math.PI); ctx.fill();
  });
  ctx.fillStyle = "#463b2e";
  ctx.font = "32px system-ui";
  ctx.fillText(year ? `${year} 年回忆树` : "我们的回忆树", 38, 55);
  ctx.font = "19px system-ui";
  ctx.fillText(entries.length + " 段回忆", 38, 88);
  await png(canvas, "Us-回忆树-" + (year || "全部") + ".png", service);
}
