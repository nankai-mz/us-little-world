import { expect, it } from "vitest";
import { applyDrawing, startDrawing } from "../src/features/canvas-core/canvas";
import { strokesUnderEraser } from "../src/features/canvas-core/eraser";
import { activityIds } from "../src/features/play-core/catalog";
import { applyGame, canRebase, rebaseKey, startGame } from "../src/features/play-core/game";
import { flowers, growthStage, officialMusicLink, puzzleFinished, skyCardFingerprint, type Garden, type PhotoPuzzle, type Sky } from "../src/features/play-core/media-games";
import type { Seat } from "../src/features/play-core/protocol";
import { archiveGame, withWorkCover } from "../src/features/play-core/works";
import { connectTiles, linkBoard, pickPair } from "../src/features/puzzle-core/grid";
import { escapeRooms, kitchens, orders, sameCell, shadowLevels, spaceLevels, validateLevel, type Coord } from "../src/features/scene-core/levels";
import { applyExplorer, applyScene, stardust, startScene, type Kitchen, type Explorer } from "../src/features/scene-core/scene";
import { parseCampaign } from "../src/features/scene-core/level-schema";

const firstId = "1".repeat(32);
const secondId = "2".repeat(32);

function openDrawingRound() {
  return applyDrawing(startDrawing("g01"), { type: "drawing.ask", start: 1000, seconds: 60,
    hidden: { deviceId: firstId, deviceOnly: true, envelope: {
      version: 1, algorithm: "XCHACHA20-POLY1305", keyVersion: 1, nonce: "", ciphertext: "",
    } } }, 0);
}

it("橡皮按实际笔迹擦除，单次撤销恢复整次手势，并保护画者与物件版本", () => {
  let state = openDrawingRound();
  for (const [id, y] of [[firstId, 0], [secondId, 30]] as const) {
    state = applyDrawing(state, { type: "canvas.add", panel: 0, item: {
      id, kind: "stroke", color: "#2a2a2a", width: 4, x: 0, y, points: [[0, 0, .5], [60, 0, .5]],
    } }, 0);
  }
  const corner = "3".repeat(32);
  state = applyDrawing(state, { type: "canvas.add", panel: 0, item: {
    id: corner, kind: "stroke", color: "#2a2a2a", width: 2, x: 0, y: 65, points: [[0, 40, .5], [0, 0, .5], [60, 0, .5]],
  } }, 0);
  expect(strokesUnderEraser(state.objects, [[30, 85, .5]], 7)).toEqual([]);
  const items = strokesUnderEraser(state.objects, [[30, -15, .5], [30, 45, .5]], 7);
  expect(items).toEqual([{ id: firstId, version: 1 }, { id: secondId, version: 1 }]);
  const erase = { type: "canvas.erase", round: 1, items } as const;
  expect(() => applyDrawing(state, erase, 1)).toThrow("这一轮由画者绘图");
  expect(() => applyDrawing(state, { ...erase, items: [...items.slice(0, 1), { id: secondId, version: 2 }] }, 0)).toThrow("笔迹已更新");
  const erased = applyDrawing(state, erase, 0);
  expect(erased.objects.map(({ id }) => id)).toEqual([corner]);
  expect(erased.versions[firstId]).toBe(2);
  const undo = applyDrawing(erased, { type: "canvas.undo" }, 0);
  expect(undo.objects.map(({ id }) => id)).toEqual([corner, firstId, secondId]);
  expect(undo.versions[firstId]).toBe(3);
  expect(applyDrawing(undo, { type: "canvas.redo" }, 0).objects.map(({ id }) => id)).toEqual([corner]);
});

it("自动揭晓保护当前轮次，旧版揭晓仍按原有密文回放基础校验", () => {
  const initial = openDrawingRound();
  expect(() => applyDrawing(initial, { type: "drawing.guess", value: "Moon", at: 2000 }, 0)).toThrow("无法猜词");
  const guess = { type: "drawing.guess", value: " ＭＯＯＮ ", at: 2000 } as const;
  expect(rebaseKey(initial, guess)).toBeNull();
  expect(rebaseKey(initial, { ...guess, round: 1 })).toBe("drawing/1");
  expect(() => applyDrawing(initial, { ...guess, round: 2 }, 1)).toThrow("无法猜词");
  const guessed = applyDrawing(initial, { ...guess, round: 1 }, 1);
  const legacy = { type: "drawing.reveal", answer: "Moon", at: 2001 } as const;
  const automatic = { ...legacy, round: 1 };
  expect(rebaseKey(guessed, legacy)).toBeNull();
  expect(rebaseKey(guessed, automatic)).toBe("drawing/1");
  expect(() => applyDrawing(guessed, automatic, 1)).toThrow("由画者揭晓");
  expect(() => applyDrawing(guessed, { ...automatic, round: 2 }, 0)).toThrow("由画者揭晓");
  expect(applyDrawing(guessed, automatic, 0)).toEqual(applyDrawing(guessed, legacy, 0));
  expect(applyDrawing(guessed, automatic, 0).rounds[0].result).toEqual({ answer: "Moon", correct: true });
  expect(applyDrawing(initial, { ...automatic, at: 61000 }, 0).rounds[0].result).toEqual({ answer: "Moon", correct: false });
});

it("关卡配置校验拒绝错误的角色、重复的星尘坐标和缺失的影门", () => {
  const campaign = { version: 1, g11: escapeRooms, g12: spaceLevels, g13: shadowLevels };
  expect(parseCampaign(campaign)).toEqual(campaign);

  const wrongSeat = structuredClone(campaign);
  Object.assign(wrongSeat.g11[0].locks[0], { role: 2 });
  expect(() => parseCampaign(wrongSeat)).toThrow("g11 第 1 关");

  const duplicateStar = structuredClone(campaign);
  duplicateStar.g12[1].stars.push(duplicateStar.g12[1].stars[0]);
  expect(() => parseCampaign(duplicateStar)).toThrow("g12 第 2 关");

  const noShadowDoor = structuredClone(campaign);
  noShadowDoor.g13[0].rows = noShadowDoor.g13[0].rows.map((row) => row.replaceAll("D", "#"));
  expect(() => parseCampaign(noShadowDoor)).toThrow("g13 第 1 关缺少影门");
});

it("封面从作品已有引用或实际画格生成，过滤失效引用后不保留其照片封面", () => {
  const legacy = archiveGame(startGame("c21"), "天空", firstId);
  expect(withWorkCover(legacy).cover).toEqual({ kind: "title" });
  const withPhoto = withWorkCover({ ...legacy, references: [{ recordId: firstId, fileId: secondId }] });
  expect(withPhoto.cover).toEqual({ kind: "photo", recordId: firstId, fileId: secondId });
  expect(withWorkCover({ ...withPhoto, references: [] }).cover).toEqual({ kind: "title" });

  const art = applyDrawing(startDrawing("c15"), { type: "canvas.add", panel: 0,
    item: { id: secondId, kind: "sticky", text: "小记", color: "#a65449", x: 0, y: 0 } }, 0);
  expect(withWorkCover(archiveGame(art, "画布", firstId)).cover).toEqual({ kind: "canvas", panel: 0 });
});

it("星际纪念碑保留原照片引用和旧日记引用，进入下一关继续可读", () => {
  const first = startScene("g12") as Explorer;
  const old = applyExplorer(first, { type: "scene.tribute", id: firstId }, 0);
  expect(archiveGame(old, "星际照片", secondId).references).toEqual([{ recordId: firstId }]);
  const marked = applyExplorer(old, { type: "scene.tribute", id: firstId, photo: secondId }, 1);
  const next = applyExplorer({ ...marked, solved: [0] }, { type: "scene.next" }, 0);
  expect(archiveGame(next, "星际照片", secondId).references).toEqual([{ recordId: firstId, fileId: secondId }]);
  expect(() => applyExplorer(next, { type: "scene.tribute", id: firstId, photo: "invalid-id" }, 1)).toThrow();
});

it("累计星尘从既有关卡状态派生，双方的装饰独立合并且过关后保留", () => {
  const before = startScene("g12") as Explorer;
  const equip = { type: "scene.badge", badge: "orbit", previous: null } as const;
  expect(stardust(before)).toBe(0);
  expect(() => applyExplorer(before, equip, 0)).toThrow("先收集足够的星尘");
  const collecting = { ...before, stars: [0, 1, 2] };
  const solved = { ...collecting, solved: [0] };
  expect(stardust(collecting)).toBe(stardust(solved));
  const first = applyExplorer(solved, equip, 0);
  expect(canRebase(first, equip)).toBe(true);
  const both = applyExplorer(first, equip, 1);
  expect(() => applyExplorer(both, { ...equip, badge: null }, 0)).toThrow("已更新");
  const next = applyExplorer(both, { type: "scene.next" }, 1);
  expect(next.badges).toEqual(["orbit", "orbit"]);
  expect(stardust(next)).toBe(3);
  const changed = applyExplorer(next, { type: "scene.badge", badge: null, previous: "orbit" }, 0);
  expect(changed.badges).toEqual([null, "orbit"]);
  expect(changed.avatars).toEqual(next.avatars);
  expect(stardust(changed)).toBe(3);
  expect(() => applyExplorer(next, { ...equip, previous: "orbit", badge: "beacon" }, 0)).toThrow("先收集足够的星尘");
  expect(() => applyExplorer(startScene("g13") as Explorer, equip, 1)).toThrow("没有宇航服装饰");
});

it("24 项活动均可初始化且导出空档案不会泄露未揭晓内容", () => {
  expect(activityIds).toHaveLength(24);
  for (const id of activityIds) {
    const game = startGame(id);
    expect(game.id).toBe(id);
    expect(archiveGame(game, "合成活动", firstId)).toMatchObject({ activityId: id, version: 1, roomId: firstId });
  }
});

it("共同画布按物件版本合并，撤销只影响自己的物件，分镜要求认领", () => {
  const item = { id: firstId, kind: "sticky", text: "一起画画", color: "#a65449", x: 0, y: 0 } as const;
  const one = applyDrawing(startDrawing("c15"), { type: "canvas.add", item, panel: 0 }, 0);
  const both = applyDrawing(one, { type: "canvas.add", item: { ...item, id: secondId }, panel: 0 }, 1);
  expect(() => applyDrawing(both, { type: "canvas.delete", id: firstId, version: 1 }, 1)).toThrow();
  const undone = applyDrawing(both, { type: "canvas.undo" }, 0);
  expect(undone.objects.map(({ id }) => id)).toEqual([secondId]);
  const restored = applyDrawing(undone, { type: "canvas.redo" }, 0);
  expect(restored.objects.find(({ id }) => id === firstId)?.version).toBeGreaterThan(1);
  expect(() => applyDrawing(restored, { type: "canvas.change", id: firstId, version: 1, x: 30 }, 0)).toThrow();
  const comic = startDrawing("c16", "6");
  expect(comic.frames).toHaveLength(6);
  expect(() => applyDrawing(comic, { type: "canvas.add", item, panel: 0 }, 0)).toThrow();
  const claimed = applyDrawing(comic, { type: "comic.claim", panel: 0 }, 0);
  expect(() => applyDrawing(claimed, { type: "comic.claim", panel: 0 }, 1)).toThrow();
  expect(applyDrawing(claimed, { type: "canvas.add", item, panel: 0 }, 0).objects).toHaveLength(1);
  const backdrop = applyDrawing(claimed, { type: "comic.background", panel: 0, background: "night" }, 0);
  const cast = applyDrawing(backdrop, { type: "canvas.add", panel: 0, item: { ...item, kind: "character", avatar: 2, expression: 9 } }, 0);
  expect(archiveGame(cast, "合成漫画", firstId).canvas?.backgrounds?.[0]).toBe("night");
});

it("拼图的三档都能还原，冲突拼块不会被重放，连线可从外侧转弯", () => {
  for (const size of [3, 4, 6]) {
    let game = applyGame(startGame("g02"), { type: "puzzle.pick", size, photo: { recordId: firstId, fileId: secondId } }, 0) as PhotoPuzzle;
    expect(puzzleFinished(game)).toBe(false);
    for (const [index, tile] of game.tiles.entries()) {
      if (game.tiles[index] === index) continue;
      const b = game.tiles.indexOf(index);
      const action = { type: "puzzle.swap", a: index, b, values: [game.tiles[index], game.tiles[b]] } as const;
      game = applyGame(game, { ...action, values: [...action.values] }, index % 2 as Seat) as PhotoPuzzle;
      expect(() => applyGame(game, { ...action, values: [...action.values] }, 1)).toThrow();
      expect(tile).toBeGreaterThanOrEqual(0);
    }
    expect(puzzleFinished(game)).toBe(true);
  }
  expect(linkBoard("same-board")).toEqual(linkBoard("same-board"));
  const board = Array<number | null>(48).fill(null);
  board[0] = board[2] = 0; board[1] = 2; board[8] = 3;
  expect(connectTiles(board, 0, 2)).toContainEqual([0, -1]);
  expect(connectTiles(board, 0, 1)).toBeNull();
  expect(pickPair(board)).toEqual([0, 2]);
});

it("花园照料只增加进度，音乐明信片拒绝伪装的外链", () => {
  let game = applyGame(startGame("g14"), { type: "garden.plant", seed: 0 }, 0) as Garden;
  for (let index = 0; index < flowers.at(-1)!.unlock; index++)
    game = applyGame(game, { type: "garden.tend", action: index % 2 ? "日照" : "水" }, index % 2 as Seat) as Garden;
  expect(growthStage(game)).toBe("开花");
  game = applyGame(game, { type: "garden.reset" }, 1) as Garden;
  expect(applyGame(game, { type: "garden.plant", seed: 4 }, 1)).toMatchObject({ seed: 4, growth: 0, experience: 30 });
  expect(officialMusicLink("https://music.163.com/song?id=3")).toBe("https://music.163.com/song?id=3");
  expect(() => officialMusicLink("https://music.163.com.evil.example/song")).toThrow();
  expect(() => officialMusicLink("https://secret@music.163.com/song")).toThrow();
});

it("双方的天空照片可并发保存，同一张卡的旧编辑不可覆盖新版本", () => {
  const start = startGame("c21") as Sky;
  const first = { type: "sky.put", previous: null, value: { photo: { recordId: firstId, fileId: firstId }, note: "小雨", city: "" } } as const;
  const second = { ...first, value: { photo: { recordId: secondId, fileId: secondId }, note: "晴天", city: "" } };
  const withFirst = applyGame(start, first, 0) as Sky;
  expect(canRebase(withFirst, second)).toBe(true);
  expect(applyGame(withFirst, second, 1)).toMatchObject({ cards: [first.value, second.value] });
  expect(() => applyGame(withFirst, second, 0)).toThrow("这张天空卡已在另一台设备更新");
  const changed = { ...first, previous: skyCardFingerprint(withFirst.cards[0]), value: { ...first.value, note: "雨停了" } };
  expect(applyGame(withFirst, changed, 0)).toMatchObject({ cards: [changed.value, null] });
  const legacy = { type: "sky.put", value: second.value } as const;
  expect(applyGame(withFirst, legacy, 1)).toMatchObject({ cards: [first.value, second.value] });
  expect(canRebase(withFirst, legacy)).toBe(false);
});

function walk(game: Explorer, seat: Seat, target: Coord) {
  const map = (game.id === "g12" ? spaceLevels : shadowLevels)[game.level];
  const start = game.avatars[seat];
  const queue: Coord[][] = [[start]];
  const visited = new Set([start.join(",")]);
  for (let i = 0; i < queue.length; i++) {
    const path = queue[i];
    const current = path.at(-1)!;
    if (sameCell(current, target)) {
      return path.slice(1).reduce((state, to) =>
        applyExplorer(state, { type: "scene.move", from: state.avatars[seat], to }, seat), game);
    }
    for (const [dx, dy] of [[0, 1], [1, 0], [0, -1], [-1, 0]]) {
      const to: Coord = [current[0] + dx, current[1] + dy];
      const cell = map.rows[to[1]]?.[to[0]];
      if (visited.has(to.join(",")) || (game.box && sameCell(game.box, to))) continue;
      if (cell !== "." && !(cell === "G" && game.lit.every(Boolean)) && !(cell === "D" && seat === 1)) continue;
      visited.add(to.join(","));
      queue.push([...path, to]);
    }
  }
  throw new Error("Unreachable synthetic target " + map.name + ": " + target.join(","));
}

it("十关光影迷宫和九关星际探险逐关都有可执行的双人路线", () => {
  for (const id of ["g12", "g13"] as const) {
    const levels = id === "g12" ? spaceLevels : shadowLevels;
    let game = startScene(id) as Explorer;
    for (const [index, map] of levels.entries()) {
      expect(validateLevel(map)).toBe(true);
      for (const seat of [0, 1] as const) {
        game = walk(game, seat, map.controls[seat]);
        if (id === "g13") game = applyExplorer(game, { type: "scene.use" }, seat);
      }
      expect(game.lit).toEqual([true, true]);
      for (const star of map.stars) game = walk(game, 0, star);
      game = walk(game, 0, map.exit);
      game = walk(game, 1, map.exit);
      expect(game.solved.at(-1)).toBe(index);
      if (index + 1 < levels.length) game = applyExplorer(game, { type: "scene.next" }, 0);
    }
  }
});

it("同关的反光镜和影之按钮可顺序补发，玩家移开后拒绝旧机关操作", () => {
  const initial = startScene("g13") as Explorer;
  const controls = shadowLevels[0].controls;
  const atControls = { ...initial, avatars: controls };
  const reflect = { type: "scene.use", from: controls[0] } as const;
  const shadow = { type: "scene.use", from: controls[1] } as const;
  expect(rebaseKey(initial, { type: "scene.use" })).toBeNull();
  expect(rebaseKey(atControls, reflect)).toBe("maze/0");
  expect(() => applyExplorer(initial, shadow, 1)).toThrow("位置已更新");
  const illuminated = applyExplorer(atControls, reflect, 0);
  expect(illuminated.lit).toEqual([true, false]);
  expect(applyExplorer(illuminated, shadow, 1).lit).toEqual([true, true]);
});

it("三间密室各六道机关，只有持有机关的角色能输入对应的答案", () => {
  let game = startScene("g11");
  for (const [themeIndex, theme] of escapeRooms.entries()) {
    for (const [stage, lock] of theme.locks.entries()) {
      const command = { type: "escape.solve", stage, value: lock.code } as const;
      expect(() => applyScene(game, command, lock.role === 0 ? 1 : 0)).toThrow();
      game = applyScene(game, command, lock.role);
    }
    expect(game).toMatchObject({ solved: 6 });
    if (themeIndex < 2) game = applyScene(game, { type: "scene.next" }, 1);
  }
  expect(game).toMatchObject({ finished: [0, 1, 2] });
});

it("两张厨房图的八种订单都能完成，备菜和烹饪均依赖对方", () => {
  let game = startScene("g04") as Kitchen;
  const at = 1460000000000;
  for (const [mapId, map] of kitchens.entries()) {
    const station = (tile: string): Coord => {
      const y = map.rows.findIndex((row) => row.includes(tile));
      return [map.rows[y].indexOf(tile), y];
    };
    const to = (actor: Seat, target: Coord) => {
      const path = [game.avatars[actor], [game.avatars[actor][0], 2] as Coord, [target[0], 2] as Coord, target];
      for (const goal of path.slice(1)) {
        while (!sameCell(game.avatars[actor], goal)) {
          const from = game.avatars[actor];
          const axis = from[0] !== goal[0] ? 0 : 1;
          const next: Coord = [...from];
          next[axis] += Math.sign(goal[axis] - from[axis]);
          game = applyScene(game, { type: "scene.move", from, to: next }, actor) as Kitchen;
        }
      }
    };
    for (const [index, order] of orders.entries()) {
      game = applyScene(game, { type: "kitchen.start", map: mapId, order: index, at }, 0) as Kitchen;
      for (const id of order.items) {
        for (const [actor, target] of [
          [0, station("F")], [0, station("W")], [0, station("K")], [0, [4, 2]],
          [1, [6, 2]], [1, station("C")], [1, station("D")],
        ] as [Seat, Coord][]) {
          to(actor, target);
          game = applyScene(game, { type: "kitchen.use", ingredient: id, at: at + 100 }, actor) as Kitchen;
        }
      }
      expect(game.plated).toEqual(order.items);
      expect(game.carrying).toEqual([null, null]);
      expect(game.table).toBeNull();
    }
  }
});

it("场景可保存 200 个物件，同位置并发及过期布局版本会拒绝", () => {
  let game = startScene("c17");
  for (let i = 0; i < 200; i++) game = applyScene(game, { type: "world.put",
    item: { key: i.toString(16).padStart(32, "0"), kind: "tree", x: i % 20, y: Math.floor(i / 20), angle: 0 } }, i % 2 as Seat);
  expect(game).toMatchObject({ decorations: expect.arrayContaining([{ key: "0".repeat(32), kind: "tree", x: 0, y: 0, angle: 0, revision: 1 }]) });
  expect(() => applyScene(game, { type: "world.put", item: { key: "a".repeat(32), kind: "tree", x: 0, y: 10, angle: 0 } }, 1))
    .toThrow("布局超出限制");
  const one = applyScene(startScene("w23"), { type: "world.put", item: { key: firstId, kind: "chair", x: 0, y: 0, angle: 0 } }, 0);
  expect(() => applyScene(one, { type: "world.put", item: { key: secondId, kind: "table", x: 0, y: 0, angle: 0 } }, 1)).toThrow();
  const moved = applyScene(one, { type: "world.edit", key: firstId, version: 1, x: 2, y: 1, angle: 90 }, 1);
  expect(() => applyScene(moved, { type: "world.remove", key: firstId, version: 1 }, 0)).toThrow();
});

it("星球装饰共同领取，照片引用保留在移动与归档中，旧物件版本不可覆盖", () => {
  const original = startScene("c17");
  const photo = "3".repeat(32);
  const item = { key: firstId, kind: "star-light", x: 4, y: 6, angle: 0, memory: secondId, photo };
  expect(() => applyScene(original, { type: "world.put", item }, 0)).toThrow();
  const claimed = applyScene(original, { type: "world.claimStargazingDecorations" }, 1);
  expect(applyScene(claimed, { type: "world.claimStargazingDecorations" }, 0)).toBe(claimed);
  expect(() => applyScene(claimed, { type: "world.put", item: { ...item, memory: undefined } }, 0)).toThrow();
  const placed = applyScene(claimed, { type: "world.put", item }, 0);
  const move = { type: "world.edit", key: firstId, version: 1, x: 5, y: 6, angle: 90, memory: secondId } as const;
  expect(canRebase(placed, move)).toBe(true);
  const moved = applyScene(placed, move, 1);
  expect(moved).toMatchObject({ decorations: [{ ...item, x: 5, angle: 90, revision: 2 }] });
  expect(() => applyScene(moved, move, 0)).toThrow("物件已更新");
  expect(archiveGame(moved, "星球", firstId).references).toEqual([{ recordId: secondId, fileId: photo }]);
  const detached = applyScene(moved, { ...move, version: 2, photo: null }, 0);
  expect(archiveGame(detached, "星球", firstId).references).toEqual([{ recordId: secondId }]);
});

it("星图移动核对原坐标，换一颗星时可独立合并，旧协议仍能回放", () => {
  const photo = { recordId: firstId, fileId: secondId };
  const base = applyGame(startGame("c18"), { type: "stars.add", star: { x: 10, y: 20, photo } }, 0);
  const move = { type: "stars.move", id: secondId, x: 42, y: 60, from: { x: 10, y: 20 } } as const;
  const peer = applyGame(base, { type: "stars.add", star: { x: 10, y: 20, photo: { ...photo, fileId: firstId } } }, 1);
  expect(canRebase(peer, move)).toBe(true);
  const moved = applyGame(peer, move, 0);
  expect(moved).toMatchObject({ stars: [{ x: 42, y: 60 }, { x: 10, y: 20 }] });
  expect(() => applyGame(moved, { ...move, x: 65 }, 1)).toThrow("这颗星已被移动");
  expect(applyGame(moved, { type: "stars.move", id: secondId, x: 10, y: 20 }, 0)).toMatchObject({ stars: [{ x: 10, y: 20 }, { x: 10, y: 20 }] });
});
