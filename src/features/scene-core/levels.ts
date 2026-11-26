import levelData from "./level-campaign.json";
import { parseCampaign, type Coord } from "./level-schema";

export { sameCell, validateLevel, type Coord, type MazeLevel } from "./level-schema";

const campaign = parseCampaign(levelData);
export const escapeRooms = campaign.g11;
export const spaceLevels = campaign.g12;
export const shadowLevels = campaign.g13;

export const flightBadges = [
  { id: "orbit", name: "浅雾星环", dust: 3 },
  { id: "halo", name: "盐湖流光", dust: 9 },
  { id: "beacon", name: "灯塔徽光", dust: 18 },
] as const;
export type FlightBadge = typeof flightBadges[number]["id"];

export const ingredients = ["番茄", "鸡蛋", "蘑菇", "胡萝卜", "青菜"] as const;
export const orders = [
  { name: "番茄炒蛋", items: [0, 1] }, { name: "清炒蘑菇", items: [2] },
  { name: "胡萝卜滑蛋", items: [3, 1] }, { name: "青菜小炒", items: [4] },
  { name: "番茄蘑菇煲", items: [0, 2] }, { name: "炒三色蔬菜", items: [0, 3, 4] },
  { name: "蘑菇蛋饼", items: [2, 1] }, { name: "胡萝卜青菜汤", items: [3, 4] },
];
export const kitchens = [
  { name: "长桌厨房", rows: ["#########", "#F.W.#C.#", "#....T..#", "#.K..#D.#", "#########"],
    start: [[2, 2], [6, 2]] as [Coord, Coord] },
  { name: "窗边厨房", rows: ["#########", "#W...#D.#", "#..F.T..#", "#K...#C.#", "#########"],
    start: [[2, 2], [6, 2]] as [Coord, Coord] },
];

export const planetTiles = [
  ["grass", "草地", "🌱"], ["lake", "湖泊", "💧"], ["mountain", "山丘", "⛰️"], ["tree", "树木", "🌲"],
  ["home", "房屋", "🏠"], ["monument", "纪念碑", "🗿"], ["light", "路灯", "🕯️"], ["path", "小径", "▤"],
  ["flower", "花坛", "🌷"], ["bridge", "石桥", "🌉"], ["rock", "岩石", "🪨"], ["observatory", "观星台", "🔭"],
] as const;
export const stargazingTiles = [["star-light", "星灯", "✦"], ["moon-garden", "月牙花坛", "☾"]] as const;
export const flowers = [
  { key: "cornflower", name: "矢车菊", symbol: "💠", unlock: 0 },
  { key: "daisy", name: "雏菊", symbol: "🌼", unlock: 6 },
  { key: "sunflower", name: "向日葵", symbol: "🌻", unlock: 12 },
  { key: "tulip", name: "郁金香", symbol: "🌷", unlock: 20 },
  { key: "camellia", name: "山茶", symbol: "🌺", unlock: 30 },
] as const;
export const furniture = [
  ["fridge", "冰箱", "▣"], ["wardrobe", "衣柜", "🚪"], ["shelf", "书架", "📚"], ["window", "窗户", "🪟"],
  ["record", "留声机", "♫"], ["easel", "画架", "🎨"], ["bed", "床", "🛏️"], ["lamp", "台灯", "💡"],
  ["table", "餐桌", "🍽️"], ["chair", "椅子", "🪑"], ["rug", "地毯", "▧"], ["sofa", "沙发", "🛋️"],
  ["cushion", "靠垫", "◇"], ["plant", "盆栽", "🪴"], ["clock", "挂钟", "🕰️"], ["tea", "茶具", "🫖"],
  ["box", "收纳箱", "📦"], ["pantry", "餐边柜", "▤"], ["portrait", "相框", "🖼️"], ["basket", "糯米的窝", "🧺"],
  ["ball", "宠物玩具", "🧶"], ["blind", "窗帘", "▥"], ["radio", "收音机", "📻"], ["mat", "门垫", "▩"],
  ...flowers.map(({ key, name, symbol }) => [`potted-${key}`, `${name}盆栽`, symbol] as const),
] as const;
