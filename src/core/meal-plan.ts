import { hashText } from "./crypto";
import { dayNumber } from "./date";
import { AppError, type Entry } from "./types";
import type { UsService } from "./service";

export const meals = ["早餐", "午餐", "晚餐"] as const;
export type Meal = typeof meals[number];
export const preferences = { want: "想吃", okay: "可以", no: "不想吃" } as const;
export type MealPreference = keyof typeof preferences;
export type MealCandidate = { id: string; creatorId: string; name: string; tags: string[]; price?: number };
type Ballot = { version: number; revision: number; choices?: Record<string, MealPreference> };
export type MealPlan = {
  meal: Meal;
  round: number;
  version: number;
  status: "open" | "confirmed" | "cancelled";
  budget?: number;
  candidates: MealCandidate[];
  restrictions: Record<string, string[]>;
  ballots: Record<string, Ballot>;
  selectedId?: string;
};
export type MealAction = { round: number } & (
  | { type: "add"; name: string; price?: number; tags: string[] }
  | { type: "remove"; id: string }
  | { type: "budget"; value?: number }
  | { type: "restrictions"; tags: string[] }
  | { type: "vote"; version: number; previousVote: number; choices: Record<string, MealPreference> }
  | { type: "withdraw"; version: number; previousVote: number }
  | { type: "choose"; id: string; version: number }
  | { type: "cancel" }
  | { type: "reopen" }
);

const planId = (space: string, date: string, meal: Meal) => hashText(JSON.stringify(["Us/meal", space, date, meal]));
const memoryId = (id: string, round: number) => hashText(JSON.stringify(["Us/meal-memory", id, round]));
const normalize = (value: string) => value.normalize("NFKC").trim().toLocaleLowerCase("zh-CN");
const tags = (values: string[]) => [...new Set(values.map(normalize).filter(Boolean))].sort();

export function mealRecord(service: UsService, date: string, meal: Meal) {
  return service.active.find((entry) => entry.id === planId(service.space?.id ?? "", date, meal) &&
    entry.visibility === "shared" && entry.data.kind === "meal-plan");
}
export function emptyMealPlan(meal: Meal): MealPlan {
  return { meal, round: 1, version: 1, status: "open", candidates: [], restrictions: {}, ballots: {} };
}

export function mealExclusion(plan: MealPlan, candidate: MealCandidate, members: string[]) {
  if (members.some((id) => plan.restrictions[id]?.some((tag) => candidate.tags.includes(tag)))) return "与忌口标签冲突";
  if (plan.budget !== undefined && candidate.price === undefined) return "未填写预计预算";
  if (plan.budget !== undefined && candidate.price! > plan.budget) return "超过本餐预算";
  return "";
}
export function rankMeals(plan: MealPlan, members: string[]) {
  if (members.length !== 2 || members.some((id) =>
    !plan.ballots[id]?.choices || plan.ballots[id].version !== plan.version)) return [];
  return plan.candidates.flatMap((candidate) => {
    if (mealExclusion(plan, candidate, members)) return [];
    const votes = members.map((id) => plan.ballots[id].choices?.[candidate.id]);
    if (votes.some((vote) => vote !== "want" && vote !== "okay")) return [];
    return [{ candidate, score: votes.reduce((total, vote) => total + (vote === "want" ? 2 : 1), 0) }];
  }).sort((a, b) => b.score - a.score || a.candidate.id.localeCompare(b.candidate.id));
}

function validAmount(value?: number) {
  if (value !== undefined && (!Number.isFinite(value) || value < 0 || value > 99999 || Math.round(value * 100) / 100 !== value))
    throw new AppError("MEAL_AMOUNT", "请输入 0 至 99999 元的金额，最多保留两位小数");
}
function invalidate(plan: MealPlan, patch: Partial<MealPlan>): MealPlan {
  return { ...plan, ...patch, version: plan.version + 1, ballots: {} };
}

export function applyMealAction(plan: MealPlan, userId: string, members: string[], action: MealAction): MealPlan {
  if (!members.includes(userId) || members.length !== 2)
    throw new AppError("MEAL_MEMBERS", "双方加入空间后可以参与选餐");
  if (action.round !== plan.round) throw new AppError("MEAL_CHANGED", "本轮已更新，请刷新后继续");
  if (action.type === "reopen") {
    if (plan.status === "open") return plan;
    return invalidate(plan, { status: "open", round: plan.round + 1, selectedId: undefined });
  }
  if (action.type === "cancel") {
    if (plan.status === "cancelled") return plan;
    if (plan.status === "open") return invalidate(plan, { status: "cancelled" });
  }
  if (plan.status !== "open") throw new AppError("MEAL_CLOSED", "本轮已结束，可重新开一轮");
  if ("version" in action && action.version !== plan.version)
    throw new AppError("MEAL_CHANGED", "候选或条件已更新，请重新确认偏好");
  switch (action.type) {
    case "add": {
      const name = action.name.trim();
      const candidateTags = tags(action.tags);
      validAmount(action.price);
      if (!name || [...name].length > 40 || candidateTags.length > 10 || candidateTags.some((tag) => [...tag].length > 20))
        throw new AppError("MEAL_CANDIDATE", "填写 1 至 40 字的候选，最多 10 个标签，每个最多 20 字");
      const id = hashText(normalize(name));
      if (plan.candidates.some((item) => item.id === id)) return plan;
      if (plan.candidates.length >= 12) throw new AppError("MEAL_LIMIT", "本轮最多 12 个候选");
      return invalidate(plan, { candidates: [...plan.candidates, { id, name, creatorId: userId, price: action.price, tags: candidateTags }] });
    }
    case "remove": {
      const candidate = plan.candidates.find(({ id }) => id === action.id);
      if (!candidate) return plan;
      if (candidate.creatorId !== userId) throw new AppError("MEAL_CANDIDATE", "只能撤回自己添加的候选");
      return invalidate(plan, { candidates: plan.candidates.filter(({ id }) => id !== action.id) });
    }
    case "budget":
      validAmount(action.value);
      return plan.budget === action.value ? plan : invalidate(plan, { budget: action.value });
    case "restrictions": {
      const next = tags(action.tags);
      if (next.length > 10 || next.some((tag) => [...tag].length > 20))
        throw new AppError("MEAL_RESTRICTIONS", "最多填写 10 个忌口标签，每个最多 20 字");
      return JSON.stringify(next) === JSON.stringify(plan.restrictions[userId] ?? []) ? plan :
        invalidate(plan, { restrictions: { ...plan.restrictions, [userId]: next } });
    }
    case "vote": {
      const choices: Record<string, MealPreference> = {};
      if (!plan.candidates.length) throw new AppError("MEAL_VOTE", "请先添加候选");
      for (const { id } of plan.candidates) {
        const choice = action.choices[id];
        if (choice !== "want" && choice !== "okay" && choice !== "no")
          throw new AppError("MEAL_VOTE", "请为每个候选选择偏好");
        choices[id] = choice;
      }
      const current = plan.ballots[userId];
      if (JSON.stringify(choices) === JSON.stringify(current?.choices)) return plan;
      const previous = current?.revision ?? 0;
      if (previous !== action.previousVote) throw new AppError("MEAL_CHANGED", "你的另一台设备已更新投票");
      return { ...plan, ballots: { ...plan.ballots, [userId]: { version: plan.version, revision: previous + 1, choices } } };
    }
    case "withdraw": {
      const current = plan.ballots[userId];
      if (!current?.choices) return plan;
      if (current.revision !== action.previousVote) throw new AppError("MEAL_CHANGED", "你的另一台设备已更新投票");
      return { ...plan, ballots: { ...plan.ballots, [userId]: { version: plan.version, revision: current.revision + 1 } } };
    }
    case "choose":
      if (!rankMeals(plan, members).some(({ candidate }) => candidate.id === action.id))
        throw new AppError("MEAL_CHOICE", "请选择双方共同接受并满足条件的候选");
      return { ...plan, status: "confirmed", selectedId: action.id };
    // Cancellation and reopening are resolved above.
    default: return plan;
  }
}

export async function updateMealPlan(service: UsService, date: string, meal: Meal, action: MealAction) {
  dayNumber(date);
  const session = service.secrets;
  if (!session || !service.space) throw new AppError("LOCKED", "请先解锁");
  const id = planId(service.space.id, date, meal);
  for (let retries = 0; retries < 3; retries++) {
    await service.refresh();
    if (service.secrets !== session || !service.space) throw new AppError("LOCKED", "请先解锁");
    const existing = mealRecord(service, date, meal);
    const plan = existing?.data.mealPlan ?? emptyMealPlan(meal);
    const next = applyMealAction(plan, service.userId, service.space.members, action);
    if (next === plan) return;
    try {
      await service.save({ kind: "meal-plan", title: `${meal}选餐`, date, mealPlan: next }, "shared", existing, id);
      return;
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== "REVISION_CONFLICT" || retries === 2) throw error;
    }
  }
}

export function mealMemory(service: UsService, entry: Entry) {
  const plan = entry.data.mealPlan;
  return plan && service.entries.find(({ id }) => id === memoryId(entry.id, plan.round));
}

export async function archiveMealPlan(service: UsService, date: string, meal: Meal, round: number) {
  const session = service.secrets;
  await service.refresh();
  if (!session || service.secrets !== session) throw new AppError("LOCKED", "请先解锁");
  const entry = mealRecord(service, date, meal);
  const plan = entry?.data.mealPlan;
  const choice = plan?.candidates.find(({ id }) => id === plan.selectedId);
  if (!entry || !plan || plan.round !== round || plan.status !== "confirmed" || !choice)
    throw new AppError("MEAL_CHANGED", "本轮尚无可保存的决定，请刷新后查看");
  const id = memoryId(entry.id, round);
  if (mealMemory(service, entry)) return;
  try {
    await service.save({
      kind: "memory", title: `${meal}吃${choice.name}`, date, tags: ["今天吃什么"],
      ...(choice.price !== undefined ? { body: `预计预算 ${choice.price} 元` } : {}),
    }, "shared", undefined, id);
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== "REVISION_CONFLICT") throw error;
    await service.refresh();
    if (!mealMemory(service, entry)) throw error;
  }
}
