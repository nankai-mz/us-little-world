import { AppError, type Space } from "../core/types";
import type { ServerDeps, Tx } from "./api";

export const CLOSING_GRACE_MS = 7 * 86400000;
export const TRANSFER_TTL_MS = 7 * 86400000;
export function readableSpace(space: Space | null, at: number) {
  return (
    !!space &&
    (space.status === "active" ||
      (space.status === "closing" && (space.purgeAfter || 0) > at))
  );
}
export async function availableBinding(tx: Tx, userId: string) {
  const user = await tx.get("users", userId);
  const bound = user?.spaceId ? await tx.get("spaces", user.spaceId) : null;
  if (bound?.status === "active")
    throw new AppError("ALREADY_BOUND", "当前账号已有空间");
  return user || {};
}

// Server-only worker. Callers must be authenticated by the cloud entry, never by a client action.
// Tombstones retain only a space ID and timing metadata after a successful purge.
export async function runMaintenance(
  deps: ServerDeps,
  options: { budget?: number; pageSize?: number } = {},
) {
  const { repo, now } = deps;
  const token = deps.id();
  const lease = await repo.transaction(async (tx) => {
    const state = await tx.get("maintenance_state", "lease");
    if (state?.until > now()) return false;
    await tx.put("maintenance_state", "lease", {
      token,
      until: now() + 120000,
    });
    return true;
  });
  if (!lease) return { busy: true, removed: 0, completedSpaces: 0 };
  let remaining = Math.max(1, Math.min(options.budget || 100, 500));
  const pageSize = Math.max(1, Math.min(options.pageSize || 25, 100));
  let removed = 0,
    completedSpaces = 0;
  async function purgeSpace(space: Space) {
    const current = await repo.transaction(async (tx) => {
      const value = await tx.get("spaces", space.id);
      if (
        !value ||
        value.purgedAt ||
        !["closing", "purging", "closed"].includes(value.status)
      )
        return null;
      if (
        !value.members?.length ||
        !value.members.every((member: string) =>
          value.closeConfirmations?.includes(member),
        )
      ) {
        // Old versions did not collect consent to erase each member's private records.
        await tx.put("spaces", space.id, {
          ...value,
          cleanupBlocked: "member-consent-required",
        });
        return null;
      }
      if (!value.purgeAfter) {
        // Legacy closed spaces keep their access disabled and receive an explicit retention deadline.
        await tx.put("spaces", space.id, {
          ...value,
          purgeAfter: now() + CLOSING_GRACE_MS,
        });
        return null;
      }
      if (value.purgeAfter > now()) return null;
      if (value.status !== "purging")
        await tx.put("spaces", space.id, { ...value, status: "purging" });
      for (const member of value.members || []) {
        const user = await tx.get("users", member);
        if (!user) continue;
        await tx.put("users", member, {
          ...user,
          ...(user.spaceId === space.id ? { spaceId: null } : {}),
          ...(user.closingSpaceId === space.id ? { closingSpaceId: null } : {}),
        });
      }
      return value as Space;
    });
    if (!current) return true;
    for (const collection of [
      "encrypted_files",
      "encrypted_records",
      "key_envelopes",
      "devices",
      "invitations",
      "ai_limits",
    ]) {
      while (remaining > 0) {
        const rows = await repo.list(
          collection,
          { spaceId: space.id },
          0,
          Math.min(remaining, 25),
        );
        if (!rows.length) break;
        for (const row of rows) {
          if (collection === "encrypted_files" && !row.staging) {
            if (!deps.fileDelete)
              throw new AppError(
                "NOT_CONFIGURED",
                "文件删除服务未配置，清理保留待重试",
              );
            await deps.fileDelete(row.storageId);
          }
          await repo.remove(collection, row.id);
          remaining--;
          removed++;
        }
      }
      // Recheck without advancing an offset after deletions; a later invocation resumes safely.
      if ((await repo.list(collection, { spaceId: space.id }, 0, 1)).length)
        return false;
    }
    await repo.put("spaces", space.id, {
      id: space.id,
      status: "closed",
      members: [],
      keyVersion: current.keyVersion,
      createdAt: current.createdAt,
      purgeAfter: current.purgeAfter,
      purgedAt: now(),
    });
    completedSpaces++;
    return true;
  }
  async function scan(
    collection: string,
    visit: (row: any) => Promise<boolean | "retry">,
    size = pageSize,
  ) {
    if (remaining <= 0) return;
    const state = await repo.get("maintenance_state", collection);
    const offset = Math.max(0, Number(state?.offset) || 0);
    const rows = await repo.list(collection, {}, offset, size);
    let seen = 0,
      deleted = 0;
    for (const row of rows) {
      if (remaining <= 0) break;
      const result = await visit(row);
      if (result === "retry") break;
      if (result) deleted++;
      seen++;
    }
    await repo.put("maintenance_state", collection, {
      offset:
        seen === rows.length && rows.length < size
          ? 0
          : Math.max(0, offset + seen - deleted),
    });
  }
  try {
    await scan("spaces", async (space) =>
      (await purgeSpace(space)) ? false : "retry",
    );
    for (const collection of ["key_envelopes", "invitations", "ai_limits"]) {
      await scan(collection, async (row) => {
        if (!row.expiresAt && collection === "key_envelopes") {
          await repo.put(collection, row.id, {
            ...row,
            createdAt: row.createdAt || now(),
            expiresAt: now() + TRANSFER_TTL_MS,
          });
          return false;
        }
        const expiresAt =
          row.expiresAt ||
          (collection === "ai_limits" && Number.isFinite(row.at)
            ? row.at + 3 * 86400000
            : 0);
        if (expiresAt && expiresAt <= now()) {
          await repo.remove(collection, row.id);
          remaining--;
          removed++;
          return true;
        }
        if (expiresAt && !row.expiresAt)
          await repo.put(collection, row.id, { ...row, expiresAt });
        return false;
      });
    }
    // A stage may contain almost 1 MB of ciphertext, so use a small page.
    await scan("encrypted_files", async (row) => {
      if (!row.staging || row.expiresAt > now()) return false;
      const expired = await repo.transaction(async (tx) => {
        const current = await tx.get("encrypted_files", row.id);
        if (!current?.staging || current.expiresAt > now()) return false;
        await tx.remove("encrypted_files", row.id);
        return true;
      });
      if (expired) {
        remaining--;
        removed++;
      }
      return expired;
    }, Math.min(pageSize, 8));
    return { busy: false, removed, completedSpaces };
  } finally {
    await repo.transaction(async (tx) => {
      if ((await tx.get("maintenance_state", "lease"))?.token === token)
        await tx.remove("maintenance_state", "lease");
    });
  }
}
