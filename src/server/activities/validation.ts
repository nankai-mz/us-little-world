import { AppError } from "../../core/types";
import { playIdPattern, type Seat } from "../../features/play-core/protocol";
import { validateEnvelope } from "../api";

export function check(ok: unknown, code: string, message: string): asserts ok {
  if (!ok) throw new AppError(code, message);
}

export function object(value: unknown): Record<string, unknown> {
  check(value && typeof value === "object" && !Array.isArray(value), "INVALID_REQUEST", "请求格式不正确");
  return value as Record<string, unknown>;
}

export function playId(value: unknown): string {
  check(typeof value === "string" && playIdPattern.test(value), "INVALID_REQUEST", "资源标识不正确");
  return value;
}

export function counter(value: unknown): number {
  check(typeof value === "number" && Number.isSafeInteger(value) && value >= 0,
    "INVALID_REQUEST", "版本或游标不正确");
  return value;
}

export function seat(value: unknown): Seat | null {
  check(value === 0 || value === 1 || value === null, "INVALID_REQUEST", "回合标识不正确");
  return value;
}

export function cipher(value: unknown, keyVersion: number, limit: number) {
  const envelope = validateEnvelope(object(value));
  check(envelope.keyVersion === keyVersion, "KEY_VERSION_CHANGED", "空间密钥已更新，请刷新后继续");
  check(envelope.ciphertext.length <= limit, "PAYLOAD_LIMIT", "活动内容超过大小限制");
  return envelope;
}
