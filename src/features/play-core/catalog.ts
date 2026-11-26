import type { ActivityMode, PlayStage } from "./protocol";

export type PlaySection = "games" | "create" | "world";

export const activities = {
  g01: { title: "你画我猜", summary: "给同一个词画张画，猜完再换人。", icon: "✍",
    section: "games", stage: "shared_canvas", modes: ["realtime"], minutes: 8 },
  g02: { title: "双人拼图", summary: "把一张共同照片拼回来，看看那天的故事。", icon: "▦",
    section: "games", stage: "creative_worlds", modes: ["asynchronous", "realtime"], minutes: 10 },
  g03: { title: "心有灵犀", summary: "同一道题，各自写下答案，等两个人都答完再翻开。", icon: "✦",
    section: "games", stage: "async_games", modes: ["asynchronous"], minutes: 3 },
  g04: { title: "双人厨房大作战", summary: "一边洗切，一边开火，把订单一起端上桌。", icon: "♨",
    section: "games", stage: "realtime_games", modes: ["realtime"], minutes: 5 },
  g05: { title: "双人五子棋", summary: "在十五路棋盘上接着下，随时回来走下一步。", icon: "◉",
    section: "games", stage: "async_games", modes: ["asynchronous", "realtime"], minutes: 12 },
  g06: { title: "谁更了解谁", summary: "出一道关于自己的题，听听对方会怎么猜。", icon: "?",
    section: "games", stage: "async_games", modes: ["asynchronous"], minutes: 5 },
  g07: { title: "Emoji 猜故事", summary: "用几个表情藏起一段只有你们知道的故事。", icon: "☺",
    section: "games", stage: "async_games", modes: ["asynchronous"], minutes: 5 },
  g08: { title: "双人连连看", summary: "找两张相同图案，把整盘一起清空。", icon: "❖",
    section: "games", stage: "realtime_games", modes: ["realtime"], minutes: 5 },
  g09: { title: "幸运盲盒", summary: "各放进去一件小惊喜，等对方来拆。", icon: "✧",
    section: "games", stage: "async_games", modes: ["asynchronous"], minutes: 3 },
  g10: { title: "回忆猜日期", summary: "看一张旧照片，猜猜你们是在哪天拍的。", icon: "◷",
    section: "games", stage: "shared_canvas", modes: ["asynchronous", "realtime"], minutes: 4 },
  g11: { title: "非对称双人密室", summary: "各看一间房，交换线索解开六道机关。", icon: "⚿",
    section: "games", stage: "realtime_games", modes: ["realtime", "asynchronous"], minutes: 12 },
  g12: { title: "两人的迷你星际探险", summary: "踩开压力板，收集星尘，和搭档一起到达出口。", icon: "✶",
    section: "games", stage: "realtime_games", modes: ["realtime"], minutes: 15 },
  g13: { title: "双人光影迷宫", summary: "一个点亮路，一个穿过影门，十关一起走完。", icon: "◐",
    section: "games", stage: "realtime_games", modes: ["realtime"], minutes: 12 },
  g14: { title: "双人养花", summary: "挑一颗种子，慢慢种出一朵属于两个人的花。", icon: "✿",
    section: "world", stage: "creative_worlds", modes: ["asynchronous"], minutes: 3 },
  c15: { title: "双人无限画布", summary: "用笔迹、图片和便签一起拼一张大画。", icon: "✐",
    section: "create", stage: "shared_canvas", modes: ["realtime", "asynchronous"], minutes: 12 },
  c16: { title: "双人漫画工作室", summary: "各认领几个分镜，把一个瞬间画成漫画。", icon: "▣",
    section: "create", stage: "creative_worlds", modes: ["asynchronous", "realtime"], minutes: 20 },
  c17: { title: "共同创造小星球", summary: "在地图上铺一片湖、种树，再给旧回忆立个纪念碑。", icon: "⊙",
    section: "world", stage: "creative_worlds", modes: ["asynchronous", "realtime"], minutes: 12 },
  c18: { title: "共创星座编辑器", summary: "从回忆银河里摘几颗星，为它们连线和写故事。", icon: "⁂",
    section: "create", stage: "creative_worlds", modes: ["asynchronous", "realtime"], minutes: 8 },
  c19: { title: "双人小说接龙", summary: "轮流写下一个片段，让故事从两个人手里长出来。", icon: "✎",
    section: "create", stage: "async_games", modes: ["asynchronous"], minutes: 10 },
  c20: { title: "音乐明信片", summary: "各选一首歌，把想推荐的理由写进卡片。", icon: "♫",
    section: "create", stage: "shared_canvas", modes: ["asynchronous"], minutes: 5 },
  c21: { title: "双城天空拼图", summary: "两个人各拍一张天空，在一张卡片上见面。", icon: "☁",
    section: "create", stage: "shared_canvas", modes: ["asynchronous"], minutes: 5 },
  c22: { title: "共同梦想地图", summary: "把两个人的愿望便签贴到一张地图上。", icon: "⊹",
    section: "create", stage: "creative_worlds", modes: ["asynchronous", "realtime"], minutes: 12 },
  w23: { title: "两个人的小屋 2.0", summary: "摆家具、陪陪糯米，从小屋去听歌、看星星。", icon: "⌂",
    section: "world", stage: "creative_worlds", modes: ["asynchronous", "realtime"], minutes: 12 },
  w24: { title: "两个人的回忆树", summary: "挑喜欢的回忆，让它们成为树叶和果实。", icon: "♧",
    section: "world", stage: "creative_worlds", modes: ["asynchronous"], minutes: 5 },
} as const satisfies Record<string, {
  title: string; summary: string; icon: string; section: PlaySection; stage: PlayStage; modes: readonly ActivityMode[]; minutes: number;
}>;

export type ActivityId = keyof typeof activities;
export const activityIds = Object.keys(activities) as ActivityId[];
export function isActivityId(value: unknown): value is ActivityId {
  return typeof value === "string" && Object.hasOwn(activities, value);
}
