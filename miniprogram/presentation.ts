import type { Entry } from "../src/core/types";

const screenTitles: Record<string, string> = {
  home: "我们的小窝",
  timeline: "时光手账",
  album: "共同相册",
  capsules: "时光胶囊",
  map: "共同足迹",
  report: "回忆报告",
  ai: "回忆整理",
  games: "一起玩耍",
  pet: "糯米的小屋",
  question: "今日小话题",
  truth: "慢慢聊真心话",
  quiz: "默契小测试",
  roulette: "约会转盘",
  wishes: "愿望清单",
  anniversaries: "特别的日子",
  dates: "约会计划",
  profile: "我的空间",
  connection: "连接与同步",
  security: "设备与安全",
  backup: "备份与恢复",
  trash: "回收站",
  privacy: "隐私与空间设置",
  detail: "回忆详情",
  questions: "我们的问题",
  questionBank: "话题小书架",
  customQuestion: "问问对方",
};
export function navigationTitle(
  screen: string,
  kind?: string,
  relationship?: boolean,
) {
  if (screen !== "editor") return screenTitles[screen] || "我们的小世界";
  if (kind === "relationship" || relationship) return "设置恋爱开始日期";
  return (
    (
      {
        memory: "写一篇日记",
        capsule: "写给未来的信",
        anniversary: "记录纪念日",
        wish: "记下一个愿望",
        date: "安排一场约会",
        place: "收藏共同足迹",
      } as Record<string, string>
    )[kind || "memory"] || "编辑这一页"
  );
}
export function entryView(entry: Entry, paths: Record<string, string>) {
  return {
    ...entry,
    coverPhotoUrl: paths[entry.data.photos?.[0]?.id || ""] || "",
    photos: (entry.data.photos || []).map((photo) => ({
      ...photo,
      url: paths[photo.id] || "",
    })),
  };
}
