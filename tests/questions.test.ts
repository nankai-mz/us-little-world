import { describe, it, expect } from "vitest";
import { addDays, today } from "../src/core/date";
import {
  QUESTION_BANK,
  QUESTION_CATEGORIES,
  QUIZ_BANK,
  dailyQuestion,
  dailyQuiz,
} from "../src/core/questions";
import { createLocalService } from "../web/platform";
import { createApi } from "../src/server/api";
import { MemoryRepository } from "../src/server/memory-repo";
import { UsService } from "../src/core/service";
import { b64, hashText, newSecrets } from "../src/core/crypto";
import { randomBytes } from "node:crypto";
import { AppError, type Transport } from "../src/core/types";

describe("分类话题和每日轮换", () => {
  it("120 个不重复话题覆盖 8 类，24 道默契题各有四个不重复选项", () => {
    expect(QUESTION_BANK).toHaveLength(120);
    expect(QUESTION_CATEGORIES).toHaveLength(8);
    expect(new Set(QUESTION_BANK.map((item) => item.id)).size).toBe(120);
    expect(new Set(QUESTION_BANK.map((item) => item.text)).size).toBe(120);
    expect(QUIZ_BANK).toHaveLength(24);
    for (const quiz of QUIZ_BANK) expect(new Set(quiz.options).size).toBe(4);
  });
  it("以连续日历日选择，不在月初重新回到同一题，两端结果一致", () => {
    const questions = Array.from(
      { length: 120 },
      (_, index) => dailyQuestion(addDays("2026-10-31", index)).id,
    );
    expect(new Set(questions).size).toBe(120);
    expect(dailyQuestion("2026-10-31")).toEqual(dailyQuestion("2026-10-31"));
    expect(
      new Set(
        Array.from(
          { length: 24 },
          (_, index) => dailyQuiz(addDays("2026-10-31", index)).id,
        ),
      ).size,
    ).toBe(24);
  });
  it("旧版的问题文本仍可找到，不改写已保存答案的标题", () => {
    expect(
      QUESTION_BANK.some(
        (item) => item.text === "你还记得我们第一次见面时的天气吗？",
      ),
    ).toBe(true);
    expect(QUIZ_BANK[0].title).toBe("突然拥有一天假期，你最想和我…");
  });
});
describe("自定义问题与历史答案", () => {
  async function session() {
    const data: Record<string, string> = { userId: "question-fixture" };
    const service = createLocalService({
      get: (key) => data[key] || null,
      set: (key, value) => {
        data[key] = value;
      },
      remove: (key) => {
        delete data[key];
      },
    });
    await service.create(
      "question fixture password",
      "保留原记录",
      "2025-08-29",
    );
    return { service, data };
  }
  it("自定义问题加密保存，重复提问不会抹掉已提交答案", async () => {
    const { service, data } = await session();
    const title = "周末想一起做哪一件小事？";
    const question = await service.askQuestion(title);
    expect(question.data.answers).toEqual({});
    expect(JSON.stringify(data)).not.toContain(title);
    await service.answer(title, "一起去看晚霞");
    const repeated = await service.askQuestion(title);
    expect(repeated.id).toBe(question.id);
    expect(repeated.data.answers?.[service.userId]).toBe("一起去看晚霞");
    expect(
      service.active.filter((entry) => entry.data.title === title),
    ).toHaveLength(1);
    await expect(service.askQuestion("  ")).rejects.toMatchObject({
      code: "INVALID_QUESTION",
    });
  });
  it("历史问题继续回答时沿用原日期和 ID，不在今天创建重复问题", async () => {
    const { service } = await session();
    const title = "过去留下的小问题";
    const date = addDays(today(), -7);
    const first = await service.answer(title, "第一版答案", "question", date);
    const second = await service.answer(
      title,
      "后来想说的话",
      "question",
      date,
    );
    expect(second.id).toBe(first.id);
    expect(second.data.date).toBe(date);
    expect(second.data.answers?.[service.userId]).toBe("后来想说的话");
    expect(
      service.active.filter((entry) => entry.data.title === title),
    ).toHaveLength(1);
    expect(
      service.active.find((entry) => entry.data.category === "relationship")!
        .data.date,
    ).toBe("2025-08-29");
  });
  it("双方同时回答同一题时，只在已知版本冲突后重读合并，不丢掉另一方答案", async () => {
    const repo = new MemoryRepository();
    const rng = async (n: number) => new Uint8Array(randomBytes(n));
    const api = createApi({
      repo,
      now: Date.now,
      id: () => randomBytes(16).toString("hex"),
      hash: hashText,
    });
    const space = {
      id: "question-space",
      members: ["alice", "bob"],
      status: "active" as const,
      keyVersion: 1,
      createdAt: 1,
    };
    await repo.put("spaces", space.id, space);
    const key = b64(await rng(32));
    async function member(id: string) {
      await repo.put("users", id, { spaceId: space.id });
      const transport: Transport = {
        async call<T>(action: string, data: Record<string, unknown> = {}) {
          const result = await api(id, action, data);
          if (!result.success)
            throw new AppError(result.error!.code, result.error!.message);
          return result.data as T;
        },
      };
      const service = new UsService(
        transport,
        { get: () => null, set() {}, remove() {} },
        rng,
      );
      service.secrets = await newSecrets(rng, id, space.id);
      service.secrets.spaceKeys["1"] = key;
      service.space = { ...space };
      await service.registerDevice();
      return service;
    }
    const alice = await member("alice");
    const bob = await member("bob");
    await Promise.all([
      alice.answer("一起想做的事", "看晚霞"),
      bob.answer("一起想做的事", "散步"),
    ]);
    await alice.refresh();
    expect(
      alice.active.find((entry) => entry.data.title === "一起想做的事")!.data
        .answers,
    ).toEqual({ alice: "看晚霞", bob: "散步" });
  });
  it("网络结果不确定时不会自动重发答案", async () => {
    const { service } = await session();
    const original = service.transport;
    let writes = 0;
    service.transport = {
      async call<T>(action: string, data: Record<string, unknown> = {}) {
        if (action === "putRecord") {
          writes++;
          throw new AppError("NETWORK_ERROR", "fixture lost response");
        }
        return original.call<T>(action, data);
      },
    };
    await expect(
      service.answer("不重复发送的问题", "我的答案"),
    ).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    expect(writes).toBe(1);
  });
});
