import { expect, it } from "vitest";
import { b64, browserRandom, newSecrets, publicKeys, toHex } from "../src/core/crypto";
import { QUESTION_BANK } from "../src/core/questions";
import { applyAsync, startAsync, storyTurn, type Bond, type Story } from "../src/features/play-core/async-games";
import { decryptPlay, deriveActivityKey, draftContext, encryptPlay, opContext } from "../src/features/play-core/crypto";
import { moveGomoku, newGomoku, requestGomokuUndo, respondGomokuUndo } from "../src/features/play-core/gomoku";
import { type OpHeader } from "../src/features/play-core/protocol";
import { signPlaySocket, verifyPlaySocket } from "../src/features/play-core/realtime";
import { textWork } from "../src/features/play-core/works";
import { parseWebRoute, playRoute } from "../web/routes";

const roomId = "0123456789abcdef0123456789abcdef";

it("游乐园深链可直接解析，旧互动与银河入口仍可访问", () => {
  for (const path of ["games", "create", "world", "gallery", "games/g05", "create/c19", "rooms/" + roomId, "works/" + roomId]) {
    const parsed = parseWebRoute("/app/play/" + path);
    expect(parsed?.play).toBeDefined();
    expect(playRoute(parsed!.play!).pathname).toBe("/app/play/" + path);
  }
  expect(parseWebRoute("/app/play/quiz")?.section).toBe("quiz");
  expect(parseWebRoute("/app/play/food")?.section).toBe("food");
  expect(parseWebRoute("/app/memories/galaxy")?.section).toBe("galaxy");
  expect(parseWebRoute("/app/play/create/g05")).toBeUndefined();
  expect(parseWebRoute("/app/play/rooms/borrowed")).toBeUndefined();
});

it("HKDF 与独立向量一致，操作密文绑定房间、设备、操作 ID 与版本", async () => {
  expect(toHex(deriveActivityKey(new Uint8Array(32).fill(7), roomId)))
    .toBe("49b08cd2aaf5c1a0a3f7840aba0d5ee01d6fa41208f2b62c58bda41546b3ca54");
  const a = await newSecrets(browserRandom, "first", "space");
  const b = await newSecrets(browserRandom, "second", a.spaceId);
  a.spaceKeys[1] = b.spaceKeys[1] = b64(new Uint8Array(32).fill(7));
  const header: OpHeader = { spaceId: a.spaceId, roomId, opId: roomId, deviceId: a.deviceId, actor: 0,
    keyVersion: 1, protocolVersion: 1, expectedRevision: 0, turn: 0, nextTurn: 1 };
  const move = { type: "chess.move", x: 7, y: 8 };
  const first = await encryptPlay(move, a, opContext(header), browserRandom);
  const second = await encryptPlay(move, a, opContext(header), browserRandom);
  expect(first.nonce).not.toBe(second.nonce);
  expect(decryptPlay(second, b, opContext(header))).toEqual(move);
  for (const changed of [{ actor: 1 as const }, { opId: a.deviceId }, { deviceId: b.deviceId },
    { keyVersion: 2 }, { expectedRevision: 1 }, { roomId: b.deviceId }, { nextTurn: null }])
    expect(() => decryptPlay(first, b, opContext({ ...header, ...changed }))).toThrow();
  const draft = draftContext({ id: roomId, spaceId: a.spaceId, keyVersion: 1 }, a.userId, a.deviceId, "answer/1", false);
  const answer = await encryptPlay("谜底", a, draft, browserRandom);
  expect(decryptPlay(answer, a, draft)).toBe("谜底");
  expect(() => decryptPlay(answer, b, draft)).toThrow();
  const proof = { roomId, spaceId: a.spaceId, deviceId: a.deviceId, nonce: "a".repeat(64) };
  const signature = signPlaySocket(proof, a.signingSecret);
  expect(verifyPlaySocket(proof, signature, publicKeys(a).signingPublicKey)).toBe(true);
  expect(verifyPlaySocket({ ...proof, nonce: "b".repeat(64) }, signature, publicKeys(a).signingPublicKey)).toBe(false);
});

it("横、竖、两条对角线均可获胜，悔棋由另一位成员确认", () => {
  for (const direction of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
    let board = newGomoku();
    for (let n = 0; n < 5; n++) {
      board = moveGomoku(board, 0, 4 + direction[0] * n, 5 + direction[1] * n);
      if (n < 4) board = moveGomoku(board, 1, n, 13);
    }
    expect(board.winner).toBe(0);
    const undo = requestGomokuUndo(board, 0);
    expect(() => respondGomokuUndo(undo, 0, true)).toThrow();
    board = respondGomokuUndo(undo, 1, true);
    expect(board.winner).toBeNull();
    expect(board.stones).toHaveLength(8);
    expect(() => moveGomoku(board, 0, 4, 5)).toThrow();
    expect(() => moveGomoku(board, 0, 15, 2)).toThrow();
    expect(() => moveGomoku(board, 1, 0, 0)).toThrow();
  }
});

it("答题撤回、跳过和小说待确认章节的归档互不混淆", () => {
  let bond = startAsync("g03", QUESTION_BANK[0].text) as Bond;
  bond = applyAsync(bond, { type: "bond.answer", text: "秘密回答" }, 0) as Bond;
  expect(textWork(bond, "", roomId).markdown).toBe("");
  bond = applyAsync(bond, { type: "bond.withdraw" }, 0) as Bond;
  bond = applyAsync(bond, { type: "bond.answer", text: null }, 0) as Bond;
  bond = applyAsync(bond, { type: "bond.answer", text: "a".repeat(20) }, 1) as Bond;
  expect(textWork(bond, "", roomId).markdown).toContain("跳过");
  expect(() => applyAsync(bond, { type: "bond.withdraw" }, 1)).toThrow();
  let story = startAsync("c19", "雨巷") as Story;
  const text = "晴".repeat(101) + "🫶";
  expect(() => applyAsync(story, { type: "story.write", title: "续章", text }, 1)).toThrow();
  story = applyAsync(story, { type: "story.write", title: "开场", text }, 0) as Story;
  expect(storyTurn(story)).toBe(1);
  expect(textWork(story, "雨巷", roomId).markdown).toBe("");
  story = applyAsync(story, { type: "story.accept" }, 1) as Story;
  story = applyAsync(story, { type: "story.write", title: "续章", text }, 1) as Story;
  expect(() => applyAsync(story, { type: "story.withdraw" }, 0)).toThrow();
  story = applyAsync(story, { type: "story.withdraw" }, 1) as Story;
  expect(story.chapters).toHaveLength(1);
  expect(textWork(story, "雨巷", roomId).markdown).toContain("## 开场");
});
