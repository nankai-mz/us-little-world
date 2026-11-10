export const AI_TASKS = {
  story: "根据选中的回忆整理自然温柔的故事，不评价关系，不捏造经历",
} as const;
export type AiTaskId = keyof typeof AI_TASKS;
export const AI_TEXT_LIMIT = 6000;
export const AI_SPACE_DAILY_LIMIT = 10;
export const AI_GLOBAL_DAILY_LIMIT = 100;
