import { useState } from "react";
import { secureChoice } from "../src/core/domain";
import {
  archiveMealPlan, emptyMealPlan, mealExclusion, mealMemory, mealNameLimit, mealRecord, meals, preferences, rankMeals, updateMealPlan,
  type Meal, type MealAction, type MealPlan, type MealPreference,
} from "../src/core/meal-plan";
import type { UsService } from "../src/core/service";
import type { Entry } from "../src/core/types";
import { MealSlip } from "./PaperObjects";

const splitTags = (text: string) => text.split(/[,，、\n]/);
const amount = (text: string) => text.trim() ? Number(text) : undefined;

type Act = (action: MealAction, complete?: () => void) => void;

export function MealNotebook({ service, busy, run, open }: {
  service: UsService; busy: boolean;
  run: <T>(work: () => Promise<T>, success?: string) => Promise<T | undefined>;
  open: (entry: Entry) => void;
}) {
  const [dish, setDish] = useState("");
  const [meal, setMeal] = useState<Meal>("晚餐");
  const [day, setDay] = useState(service.day);
  return <section className="card meal-notebook" aria-label="手写餐桌小票">
    <form onSubmit={event => {
      event.preventDefault();
      if (busy || !dish.trim()) return;
      void run(async () => {
        const entry = await service.save({ kind: "memory", title: meal + "吃" + dish.trim(), date: day,
          tags: ["今天吃什么"], mealReceipt: { dish: dish.trim(), meal } }, "shared");
        setDish("");
        open(entry);
      }, "小票已收入收藏册");
    }}>
      <h2>收一张餐桌小票</h2>
      <label className="field"><span>今天吃了什么</span><input value={dish} maxLength={mealNameLimit} required
        placeholder="菜名或餐厅名" onChange={event => setDish(event.target.value)}/></label>
      <div className="editor-meta"><label className="field"><span>用餐日期</span><input type="date" required value={day} onChange={event => setDay(event.target.value)}/></label>
        <label className="field"><span>餐次</span><select value={meal} onChange={event => setMeal(event.target.value as Meal)}>{meals.map(name => <option key={name}>{name}</option>)}</select></label></div>
      <button className="primary" disabled={busy || !dish.trim() || service.space?.status !== "active"}>把小票收入收藏册</button>
    </form>
    <MealSlip date={day} receipt={{ meal, dish: dish.trim() || "留给今天的这道菜" }}/>
  </section>;
}

function MealBallot({ plan, userId, members, act, busy }: {
  plan: MealPlan; userId: string; members: string[]; act: Act; busy: boolean;
}) {
  const mine = plan.ballots[userId];
  const [draft, setDraft] = useState<{ version: number; previousVote: number; choices: Partial<Record<string, MealPreference>> }>();
  const choices = draft?.choices ?? mine?.choices ?? {};
  const identity = { round: plan.round, version: plan.version, previousVote: mine?.revision ?? 0 };
  const voteChanged = draft && (draft.version === plan.version
    ? draft.previousVote !== identity.previousVote : !!mine);
  if (!plan.candidates.length) return null;
  return (
    <form onSubmit={(event) => {
      event.preventDefault();
      if (busy || voteChanged) return;
      const available = Object.fromEntries(plan.candidates.flatMap(({ id }) => choices[id] ? [[id, choices[id]!]] : []));
      act({ type: "vote", ...identity, choices: available }, () => setDraft(undefined));
    }}>
      <h3>我的偏好</h3>
      {draft && draft.version !== plan.version && <p role="status">候选或条件有更新，已保留仍在列表中的选择。请核对本轮偏好后提交。</p>}
      {voteChanged && <p role="status">另一台设备更新了你的投票。<button type="button" className="text-button"
        onClick={() => setDraft(undefined)}>载入最新投票</button></p>}
      {plan.candidates.map((candidate) => (
        <label className="field" key={candidate.id}>
          <span>{candidate.name}{mealExclusion(plan, candidate, members) && ` · ${mealExclusion(plan, candidate, members)}`}</span>
          <select aria-label={`${candidate.name}偏好`} value={choices[candidate.id] ?? ""} required disabled={busy || voteChanged}
            onChange={(event) => setDraft({ ...identity, choices: { ...choices, [candidate.id]: event.target.value as MealPreference } })}>
            <option value="">选择偏好</option>
            {Object.entries(preferences).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select>
        </label>
      ))}
      <button className="primary" disabled={busy || voteChanged}>提交偏好</button>
      {mine?.choices && <button type="button" className="text-button" disabled={busy || voteChanged}
        onClick={() => act({ type: "withdraw", ...identity }, () => setDraft(undefined))}>撤回我的偏好</button>}
    </form>
  );
}

function MealRules({ plan, userId, act, busy }: { plan: MealPlan; userId: string; act: Act; busy: boolean }) {
  const [budget, setBudget] = useState<string>();
  const savedRestrictions = (plan.restrictions[userId] ?? []).join("，");
  const [restrictions, setRestrictions] = useState<string>();
  return (
    <details>
      <summary>预算与忌口</summary>
      <form onSubmit={(event) => {
        event.preventDefault();
        if (!busy) act({ type: "budget", round: plan.round, value: amount(budget ?? plan.budget?.toString() ?? "") }, () => setBudget(undefined));
      }}>
        <label className="field"><span>两人本餐预算（元，可留空）</span>
          <input type="number" min="0" max="99999" step="0.01" disabled={busy} value={budget ?? plan.budget?.toString() ?? ""}
            onChange={(e) => setBudget(e.target.value)} />
        </label>
        <button className="secondary" disabled={busy}>保存预算</button>
      </form>
      <form onSubmit={(event) => {
        event.preventDefault();
        if (!busy) act({ type: "restrictions", round: plan.round, tags: splitTags(restrictions ?? savedRestrictions) }, () => setRestrictions(undefined));
      }}>
        <label className="field"><span>我的忌口标签（用逗号分隔，两人可见）</span>
          <input value={restrictions ?? savedRestrictions} maxLength={210} disabled={busy} onChange={(e) => setRestrictions(e.target.value)} />
        </label>
        <p className="fineprint">忌口按候选填写的标签匹配。</p>
        <button className="secondary" disabled={busy}>保存忌口</button>
      </form>
    </details>
  );
}

function MealCandidates({ plan, userId, act, busy }: { plan: MealPlan; userId: string; act: Act; busy: boolean }) {
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [tags, setTags] = useState("");
  return (
    <section aria-label="选餐候选">
      <h3>候选</h3>
      <ul>
        {plan.candidates.map((candidate) => <li key={candidate.id}>
          <strong>{candidate.name}</strong>
          {candidate.price !== undefined && <span> · {candidate.price} 元</span>}
          {!!candidate.tags.length && <span> · {candidate.tags.join("、")}</span>}
          {candidate.creatorId === userId && <button type="button" className="text-button" disabled={busy}
            aria-label={`撤回候选 ${candidate.name}`}
            onClick={() => act({ type: "remove", round: plan.round, id: candidate.id })}>撤回候选</button>}
        </li>)}
      </ul>
      <form onSubmit={(event) => {
        event.preventDefault();
        act({ type: "add", round: plan.round, name, price: amount(price), tags: splitTags(tags) }, () => {
          setName(""); setPrice(""); setTags("");
        });
      }}>
        <label className="field"><span>菜品或餐厅</span><input required value={name}
          onChange={(e) => setName([...e.target.value].slice(0, mealNameLimit).join(""))} /></label>
        <label className="field"><span>预计价格（元，可留空）</span>
          <input type="number" min="0" max="99999" step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} />
        </label>
        <label className="field"><span>食材标签（用逗号分隔）</span><input maxLength={210} value={tags} onChange={(e) => setTags(e.target.value)} /></label>
        <button className="secondary" disabled={busy || plan.candidates.length >= 12}>添加候选</button>
      </form>
    </section>
  );
}

export function MealDecision({ service, busy, run, open }: {
  service: UsService;
  busy: boolean;
  run: <T>(action: () => Promise<T>, success?: string) => Promise<T | undefined>;
  open: (entry: Entry) => void;
}) {
  const [date, setDate] = useState(() => service.day);
  const [meal, setMeal] = useState<Meal>("晚餐");
  const entry = mealRecord(service, date, meal);
  const plan = entry?.data.mealPlan ?? emptyMealPlan(meal);
  const members = service.space?.members ?? [];
  const writable = !busy && members.length === 2 && service.space?.status === "active";
  const bothVoted = members.length === 2 && members.every((id) =>
    plan.ballots[id]?.version === plan.version && !!plan.ballots[id]?.choices);
  const submitted = (id: string) => plan.ballots[id]?.version === plan.version && !!plan.ballots[id]?.choices;
  const partnerVoted = members.some((id) => id !== service.userId && submitted(id));
  const ranked = rankMeals(plan, members);
  const selected = plan.candidates.find((candidate) => candidate.id === plan.selectedId);
  const saved = entry && mealMemory(service, entry);
  const action: Act = (action, complete) => void run(async () => {
    await updateMealPlan(service, date, meal, action);
    complete?.();
  });
  const identity = { round: plan.round, version: plan.version };
  const key = `${date}:${meal}:${plan.round}`;
  return (
    <section className="card meal-decision" aria-label="今天吃什么">
      <h2>今天吃什么</h2>
      <div className="editor-meta">
        <label className="field"><span>选餐日期</span><input type="date" value={date} disabled={busy}
          onChange={(event) => { if (event.target.value) setDate(event.target.value); }} /></label>
        <label className="field"><span>餐次</span><select value={meal} disabled={busy}
          onChange={(event) => setMeal(event.target.value as Meal)}>{meals.map((value) => <option key={value}>{value}</option>)}</select></label>
      </div>
      <p>{meal}第 {plan.round} 轮 · {plan.status === "confirmed" ? "已决定" : plan.status === "cancelled" ? "已取消" : "收集偏好"}</p>
      {members.length < 2 && <p>双方加入空间后可以一起选餐。</p>}
      {plan.status === "open" && <>
        <MealRules key={key}
          plan={plan} userId={service.userId} act={action} busy={!writable} />
        <MealCandidates key={key} plan={plan} userId={service.userId} act={action} busy={!writable} />
        <MealBallot key={key} plan={plan} userId={service.userId} members={members} act={action} busy={!writable} />
        {plan.candidates.length > 0 && !bothVoted && <p>{submitted(service.userId)
          ? "你已提交偏好，等待对方。"
          : partnerVoted ? "对方已提交，轮到你选择偏好。" : "双方提交偏好后，可查看共同选择。"} 候选或条件变化后需要重新投票。</p>}
        {bothVoted && (ranked.length ? (
          <section aria-label="共同接受的候选">
            <h3>共同接受的候选</h3>
            <ol>{ranked.map(({ candidate }) => <li key={candidate.id}>
              {candidate.name} <button type="button" className="text-button" disabled={!writable}
                onClick={() => action({ ...identity, type: "choose", id: candidate.id })}>采纳 {candidate.name}</button>
            </li>)}</ol>
            {ranked.length > 1 && <button className="secondary" disabled={!writable} onClick={() => void run(async () => {
              const chosen = secureChoice(ranked, await service.rng(64));
              await updateMealPlan(service, date, meal, { ...identity, type: "choose", id: chosen.candidate.id });
            })}>从共同候选抽签</button>}
          </section>
        ) : <p role="status">本轮没有同时满足两人偏好和条件的候选，可以调整偏好或添加新候选。</p>)}
        {entry && <button className="text-button" disabled={!writable}
          onClick={() => action({ type: "cancel", round: plan.round })}>取消本轮</button>}
      </>}
      {plan.status !== "open" && <div>
        {selected && <MealSlip receipt={saved?.data.mealReceipt ?? { meal, dish: selected.name }} date={date} names={service.displayNames} userId={service.userId}/>}
        {selected && !saved && <button className="primary" disabled={!writable}
          onClick={() => void run(() => archiveMealPlan(service, date, meal, plan.round), "已保存为共同回忆")}>保存为共同回忆</button>}
        {saved && !saved.deletedAt && <button className="text-button" onClick={() => open(saved)}>查看共同回忆</button>}
        {saved?.deletedAt && <p>已保存的回忆在回收站。</p>}
        <button className="secondary" disabled={!writable}
          onClick={() => action({ type: "reopen", round: plan.round })}>重新开一轮</button>
      </div>}
    </section>
  );
}
