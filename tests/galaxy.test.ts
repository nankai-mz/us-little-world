import { describe, expect, it } from "vitest";
import { buildGalaxy, drawGalaxyStar } from "../src/core/galaxy";
import type { Attachment, Entry } from "../src/core/types";

function photo(id: string): Attachment {
  return { id, name: `${id}.png`, fileId: `file-${id}`, mime: "image/png", bytes: 12 };
}

function memory(id: string, photos: Attachment[], overrides: Partial<Entry> = {}): Entry {
  return { id, creatorId: "test-user", spaceId: "test-space", visibility: "shared", revision: 1,
    createdAt: 1, updatedAt: 1, data: { kind: "memory", date: "2026-10-01", title: id, photos }, ...overrides };
}

describe("回忆银河星表", () => {
  it("每张有效共同照片对应一颗星，位置不受筛选和其他记录影响", () => {
    const shared = memory("shared", [photo("one"), photo("two"), { ...photo("missing"), fileId: undefined }]);
    const duplicate = memory("duplicate", [photo("one")]);
    const privateMemory = memory("private", [photo("private")], { visibility: "private" });
    const trashed = memory("trashed", [photo("trashed")], { deletedAt: 2 });
    const stars = buildGalaxy([privateMemory, shared, duplicate, trashed]);
    expect(stars.map(({ id, memory }) => [id, memory.id])).toEqual([["one", "shared"], ["two", "shared"]]);
    expect(buildGalaxy([shared])).toEqual(stars);
    expect(buildGalaxy([memory("new", [photo("three")]), shared]).slice(1)).toEqual(stars);
  });

  it.each([20, 50, 300, 1000])("为 %i 张照片生成可定位的星点", (count) => {
    const photos = Array.from({ length: count }, (_, index) => photo(String(index)));
    const stars = buildGalaxy([memory("sample", photos)]);
    expect(new Set(stars.map(({ id }) => id)).size).toBe(count);
    expect(stars.every(({ x, y, year }) => x >= 4 && x <= 96 && y >= 5 && y <= 95 && year === "2026")).toBe(true);
  });

  it("空结果和单张无需抽样，千张相册能抽中最后一张", () => {
    const stars = buildGalaxy([memory("sample", Array.from({ length: 1000 }, (_, index) => photo(String(index))))]);
    const unexpected = () => { throw new Error("A selection of zero or one does not need randomness"); };
    expect(drawGalaxyStar([], unexpected)).toBeUndefined();
    expect(drawGalaxyStar(stars.slice(0, 1), unexpected)).toBe(stars[0]);
    const draws = [0xffff_ffff, 999];
    expect(drawGalaxyStar(stars, () => draws.shift()!)).toBe(stars[999]);
    expect(draws).toEqual([]);
  });
});
