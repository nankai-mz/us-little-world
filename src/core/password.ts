import { AppError } from "./types";

// Explicit ranges keep this check compatible with older WeChat JS engines that
// reject Unicode property escapes such as /\p{L}/u at parse time.
const LETTER = /[A-Za-z\u00c0-\u024f\u0400-\u04ff\u4e00-\u9fff]/;
// Digits, punctuation, symbols and whitespace all count as the "other" class.
const OTHER = /[^A-Za-z\u00c0-\u024f\u0400-\u04ff\u4e00-\u9fff]/;

function reject(message: string): never {
  throw new AppError("WEAK_PASSWORD", message);
}

// Applies only to new passwords. Existing vaults remain unlockable with their original password.
export function validateNewPassword(password: string) {
  const value = password.trim();
  if (!value) reject("请先输入本机解锁口令");
  if (value.length < 10) reject("口令至少需要 10 位");
  if (password.length > 256) reject("口令太长了，请控制在 256 位以内");
  if (/^[\d\s./_-]+$/.test(value))
    reject("不要只使用数字、日期或符号，请加入字母或汉字");
  if (/^(.{1,3})\1{2,}$/.test(value)) reject("不要使用重复的短模式");
  if (/^(?:password|qwerty|123456|abcdef)(?:[\d\W_]*)$/i.test(value))
    reject("不要使用 password、qwerty 等常见词");
  const cjkCount = (value.match(/[\u4e00-\u9fff]/g) || []).length;
  if (
    value.length < 16 &&
    cjkCount < 8 &&
    !(LETTER.test(value) && OTHER.test(value))
  )
    reject(
      "10–15 位请混合字母和数字/符号，或用 16 位以上；中文建议至少 8 个字",
    );
}
