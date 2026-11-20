import { describe, expect, it } from "vitest";
import { applyMealAction, emptyMealPlan, rankMeals, type MealAction, type MealPlan } from "../src/core/meal-plan";

const members = ["alice", "bob"];
const add = (plan: MealPlan, userId: string, name: string, price: number, tags: string[] = []) =>
  applyMealAction(plan, userId, members, { type: "add", round: plan.round, name, price, tags });
type BallotInput = Extract<MealAction, { type: "vote" }>;
const vote = (plan: MealPlan, choices: BallotInput["choices"], previousVote = 0): BallotInput =>
  ({ type: "vote", round: plan.round, version: plan.version, choices, previousVote });

describe("异步选餐", () => {
  it("按双方偏好排名，排除忌口、超预算和任一方拒绝的候选", () => {
    let plan = add(emptyMealPlan("晚餐"), "alice", "米饭", 20);
    plan = add(plan, "bob", "花生酱面", 18, ["花生"]);
    plan = add(plan, "bob", "套餐", 120);
    plan = add(plan, "alice", "蘑菇饭", 25);
    const [rice, noodles, expensive, mushrooms] = plan.candidates;
    plan = applyMealAction(plan, "bob", members, { type: "restrictions", round: 1, tags: [" 花生 "] });
    plan = applyMealAction(plan, "alice", members, { type: "budget", round: 1, value: 50 });
    const want = { [rice.id]: "want", [noodles.id]: "want", [expensive.id]: "want", [mushrooms.id]: "want" } as const;
    plan = applyMealAction(plan, "alice", members, vote(plan, want));
    expect(rankMeals(plan, members)).toEqual([]);
    const noMatch = applyMealAction(plan, "bob", members, vote(plan, { ...want, [rice.id]: "no", [mushrooms.id]: "no" }));
    expect(rankMeals(noMatch, members)).toEqual([]);
    plan = applyMealAction(plan, "bob", members, vote(plan, { ...want, [rice.id]: "okay", [mushrooms.id]: "no" }));
    expect(rankMeals(plan, members)).toEqual([{ candidate: rice, score: 3 }]);
    expect(() => applyMealAction(plan, "alice", members, { type: "choose", round: 1, version: plan.version, id: noodles.id })).toThrow("共同接受");
    expect(applyMealAction(plan, "alice", members, { type: "choose", round: 1, version: plan.version, id: rice.id }))
      .toMatchObject({ status: "confirmed", selectedId: rice.id });
  });

  it("重复投票幂等，拒绝乱序与旧候选投票，撤回、取消和重开隔离轮次", () => {
    let plan = add(emptyMealPlan("午餐"), "alice", "米饭", 10);
    const [rice] = plan.candidates;
    const first = vote(plan, { [rice.id]: "want" });
    plan = applyMealAction(plan, "alice", members, first);
    expect(applyMealAction(plan, "alice", members, first)).toBe(plan);
    const update = vote(plan, { [rice.id]: "okay" }, 1);
    plan = applyMealAction(plan, "alice", members, update);
    expect(() => applyMealAction(plan, "alice", members, first)).toThrow("另一台设备");
    plan = applyMealAction(plan, "alice", members, { type: "withdraw", round: 1, version: plan.version, previousVote: 2 });
    expect(plan.ballots.alice.choices).toBeUndefined();
    plan = add(plan, "bob", "烤饼", 12);
    expect(() => applyMealAction(plan, "alice", members, update)).toThrow("候选或条件已更新");
    expect(() => applyMealAction(plan, "bob", members, { type: "remove", round: 1, id: rice.id })).toThrow("只能撤回");
    plan = applyMealAction(plan, "bob", members, { type: "cancel", round: 1 });
    expect(plan.status).toBe("cancelled");
    plan = applyMealAction(plan, "alice", members, { type: "reopen", round: 1 });
    expect(plan).toMatchObject({ round: 2, status: "open", ballots: {} });
    expect(() => applyMealAction(plan, "alice", members, { type: "cancel", round: 1 })).toThrow("本轮已更新");
  });
});
