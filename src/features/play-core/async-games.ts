import { QUESTION_BANK } from "../../core/questions";
import { AppError, type Envelope } from "../../core/types";
import { gomokuTurn, moveGomoku, newGomoku, rematchGomoku, requestGomokuUndo, respondGomokuUndo, type Gomoku } from "./gomoku";
import { otherSeat, type Seat } from "./protocol";

type Pair<T> = [T | null, T | null];
type Comment = { by: Seat; text: string };
export type MemoryReference = { recordId: string; fileId?: string };
export type HiddenAnswer = { envelope: Envelope; deviceId: string; deviceOnly: boolean };
export type RevealAnswer = { text: string; memoryId?: string };
type BondRound = { question: string; answers: Pair<{ text: string | null }>; comments: Comment[] };
export type Bond = { id: "g03"; rounds: BondRound[] };
export type Chess = { id: "g05"; game: Gomoku };
export type QuizRound = {
  author: Seat;
  prompt: string;
  symbols?: string[];
  hidden: HiddenAnswer | null;
  guess: string | null;
  answer: RevealAnswer | null;
  comments: Comment[];
};
export type Quiz = { id: "g06" | "g07"; rounds: QuizRound[] };
type Box = { kind: "surprise" | "date" | "task"; text: string; instant: boolean; memory?: MemoryReference;
  opened: boolean; reply?: "accept" | "decline" };
export type Boxes = { id: "g09"; boxes: Pair<Box> };
type Chapter = { author: Seat; title: string; text: string; accepted: boolean; comments: Comment[] };
export type Story = { id: "c19"; title: string; chapters: Chapter[] };
export type AsyncActivity = Bond | Chess | Quiz | Boxes | Story;

export type AsyncCommand =
  | { type: "bond.answer"; text: string | null }
  | { type: "bond.withdraw" }
  | { type: "bond.next"; question: string }
  | { type: "chess.move"; x: number; y: number }
  | { type: "chess.undo" }
  | { type: "chess.respond"; accept: boolean }
  | { type: "chess.rematch" }
  | { type: "quiz.ask"; prompt: string; symbols?: string[]; hidden: HiddenAnswer }
  | { type: "quiz.guess"; guess: string }
  | { type: "quiz.reveal"; answer: RevealAnswer }
  | { type: "quiz.next" }
  | { type: "box.put"; kind: Box["kind"]; text: string; instant: boolean; memory?: MemoryReference }
  | { type: "box.remove" }
  | { type: "box.open" }
  | { type: "box.respond"; reply: "accept" | "decline" }
  | { type: "story.write"; title: string; text: string }
  | { type: "story.accept" }
  | { type: "story.withdraw" }
  | { type: "comment"; text: string; chapter?: number };

export const emojiChoices = ["🌈", "☔", "🚲", "🚆", "🌊", "🏔️", "⛺", "🌙", "⭐", "📷", "🌸", "🍰", "☕", "🍜", "🍓", "🐈", "🐇",
  "🧳", "🎠", "🎬", "🎵", "🎁", "❤️", "😂", "🫶", "👩‍❤️‍👨", "🏡", "🌆", "🗺️", "📚"] as const;
const symbolSet = new Set<string>(emojiChoices);
const questions = new Set(QUESTION_BANK.map(({ text }) => text));
const maxRounds = 24;

function requireCondition(ok: unknown, message: string): asserts ok {
  if (!ok) throw new AppError("INVALID_MOVE", message);
}

function content(value: unknown, maximum: number, minimum = 1) {
  requireCondition(typeof value === "string", "请输入文字");
  const normalized = value.trim();
  const length = Array.from(normalized).length;
  requireCondition(length >= minimum && length <= maximum, `请输入 ${minimum}–${maximum} 字`);
  return normalized;
}

function withSeat<T>(pair: Pair<T>, actor: Seat, value: T | null): Pair<T> {
  return actor === 0 ? [value, pair[1]] : [pair[0], value];
}

function replaceRound<T>(rounds: T[], next: T) {
  return [...rounds.slice(0, -1), next];
}

function bondRound(question: string): BondRound {
  requireCondition(questions.has(question), "请从题库选择问题");
  return { question, answers: [null, null], comments: [] };
}

function quizRound(author: Seat): QuizRound {
  return { author, prompt: "", hidden: null, guess: null, answer: null, comments: [] };
}

export function startAsync(id: AsyncActivity["id"], choice?: string): AsyncActivity {
  switch (id) {
    case "g03": return { id, rounds: [bondRound(choice ?? QUESTION_BANK[0].text)] };
    case "g05": return { id, game: newGomoku() };
    case "g06":
    case "g07": return { id, rounds: [quizRound(0)] };
    case "g09": return { id, boxes: [null, null] };
    case "c19": return { id, title: choice?.trim() ? content(choice, 60) : "未命名故事", chapters: [] };
  }
}

function applyBond(state: Bond, command: AsyncCommand, actor: Seat): Bond {
  const round = state.rounds.at(-1)!;
  const revealed = round.answers.every(Boolean);
  if (command.type === "bond.answer") {
    requireCondition(!round.answers[actor], "你已经提交过这一题");
    return { ...state, rounds: replaceRound(state.rounds, {
      ...round, answers: withSeat(round.answers, actor, { text: command.text === null ? null : content(command.text, 500) }),
    }) };
  }
  if (command.type === "bond.withdraw") {
    requireCondition(!revealed && round.answers[actor], "揭晓前可撤回自己的答案");
    return { ...state, rounds: replaceRound(state.rounds, { ...round, answers: withSeat(round.answers, actor, null) }) };
  }
  requireCondition(revealed, "等两个人都提交后再继续");
  if (command.type === "bond.next") {
    requireCondition(state.rounds.length < maxRounds, "当前活动已达到 24 轮上限");
    return { ...state, rounds: [...state.rounds, bondRound(command.question)] };
  }
  requireCondition(command.type === "comment", "此操作不适用于心有灵犀");
  return { ...state, rounds: replaceRound(state.rounds, { ...round, comments: comment(round.comments, actor, command.text) }) };
}

function comment(comments: Comment[], actor: Seat, text: string) {
  requireCondition(comments.length < 20, "此处已达到留言上限");
  return [...comments, { by: actor, text: content(text, 300) }];
}

function applyQuiz(state: Quiz, command: AsyncCommand, actor: Seat): Quiz {
  const round = state.rounds.at(-1)!;
  let next: QuizRound;
  switch (command.type) {
    case "quiz.ask": {
      requireCondition(round.author === actor && !round.hidden, "请由当前出题者发布题目");
      requireCondition(command.hidden?.envelope?.version === 1 && typeof command.hidden.deviceId === "string" &&
        typeof command.hidden.deviceOnly === "boolean", "答案密文格式不正确");
      if (state.id === "g07") requireCondition(Array.isArray(command.symbols) && command.symbols.length >= 3 &&
        command.symbols.length <= 12 && command.symbols.every((symbol) => symbolSet.has(symbol)), "请选择 3–12 个表情");
      next = { ...round, prompt: state.id === "g07" ? "" : content(command.prompt, 240),
        symbols: state.id === "g07" ? command.symbols : undefined, hidden: command.hidden };
      break;
    }
    case "quiz.guess":
      requireCondition(round.hidden && round.author !== actor && round.guess === null, "当前无法提交猜测");
      next = { ...round, guess: content(command.guess, 400) };
      break;
    case "quiz.reveal":
      requireCondition(round.author === actor && round.guess !== null && !round.answer, "等对方猜完再揭晓");
      next = { ...round, answer: { text: content(command.answer.text, 500), memoryId: command.answer.memoryId } };
      break;
    case "quiz.next":
      requireCondition(round.answer && state.rounds.length < maxRounds, "揭晓后可交换角色，每个房间最多 24 轮");
      return { ...state, rounds: [...state.rounds, quizRound(otherSeat(round.author))] };
    case "comment":
      requireCondition(round.answer, "揭晓后可以留言");
      next = { ...round, comments: comment(round.comments, actor, command.text) };
      break;
    default:
      throw new AppError("INVALID_MOVE", "此操作不适用于猜题");
  }
  return { ...state, rounds: replaceRound(state.rounds, next) };
}

function applyBoxes(state: Boxes, command: AsyncCommand, actor: Seat): Boxes {
  const own = state.boxes[actor];
  const other = otherSeat(actor);
  const partner = state.boxes[other];
  switch (command.type) {
    case "box.put":
      requireCondition(!own && ["surprise", "date", "task"].includes(command.kind), "请先处理已有的盲盒");
      return { ...state, boxes: withSeat(state.boxes, actor, {
        kind: command.kind, text: content(command.text, 500), instant: command.instant === true, opened: false,
        memory: command.memory,
      }) };
    case "box.remove":
      requireCondition(own && !own.opened && !own.instant, "手动开启的盲盒在揭晓前可以收回");
      return { ...state, boxes: withSeat(state.boxes, actor, null) };
    case "box.open":
      requireCondition(partner && !partner.opened, "对方的盲盒已开启或还未准备好");
      return { ...state, boxes: withSeat(state.boxes, other, { ...partner, opened: true }) };
    case "box.respond":
      requireCondition(partner && (partner.opened || partner.instant) && partner.kind === "task" && !partner.reply &&
        ["accept", "decline"].includes(command.reply), "当前没有待回应的任务");
      return { ...state, boxes: withSeat(state.boxes, other, { ...partner, opened: true, reply: command.reply }) };
    default:
      throw new AppError("INVALID_MOVE", "此操作不适用于盲盒");
  }
}

export function storyTurn(story: Story): Seat {
  return story.chapters.length % 2 ? 1 : 0;
}

function applyStory(story: Story, command: AsyncCommand, actor: Seat): Story {
  const last = story.chapters.at(-1);
  switch (command.type) {
    case "story.write": {
      requireCondition(storyTurn(story) === actor && story.chapters.length < 48, "请等到自己的回合，每篇故事最多 48 章");
      const prior = last && !last.accepted ? replaceRound(story.chapters, { ...last, accepted: true }) : story.chapters;
      return { ...story, chapters: [...prior, {
        author: actor, title: content(command.title || `第 ${prior.length + 1} 章`, 60),
        text: content(command.text, 1000, 100), accepted: false, comments: [],
      }] };
    }
    case "story.accept":
      requireCondition(last && !last.accepted && last.author !== actor, "没有待确认的对方章节");
      return { ...story, chapters: replaceRound(story.chapters, { ...last, accepted: true }) };
    case "story.withdraw":
      requireCondition(last && !last.accepted && last.author === actor, "只能撤回对方尚未确认的最后一章");
      return { ...story, chapters: story.chapters.slice(0, -1) };
    case "comment": {
      const index = command.chapter;
      requireCondition(index !== undefined && Number.isInteger(index) && story.chapters[index]?.accepted, "请先确认章节");
      return { ...story, chapters: story.chapters.map((chapter, i) => i === index
        ? { ...chapter, comments: comment(chapter.comments, actor, command.text) } : chapter) };
    }
    default:
      throw new AppError("INVALID_MOVE", "此操作不适用于小说接龙");
  }
}

export function applyAsync(state: AsyncActivity, command: AsyncCommand, actor: Seat): AsyncActivity {
  switch (state.id) {
    case "g03": return applyBond(state, command, actor);
    case "g06":
    case "g07": return applyQuiz(state, command, actor);
    case "g09": return applyBoxes(state, command, actor);
    case "c19": return applyStory(state, command, actor);
    case "g05":
      switch (command.type) {
        case "chess.move": return { ...state, game: moveGomoku(state.game, actor, command.x, command.y) };
        case "chess.undo": return { ...state, game: requestGomokuUndo(state.game, actor) };
        case "chess.respond":
          requireCondition(typeof command.accept === "boolean", "请选择是否同意悔棋");
          return { ...state, game: respondGomokuUndo(state.game, actor, command.accept) };
        case "chess.rematch": return { ...state, game: rematchGomoku(state.game, actor) };
        default: throw new AppError("INVALID_MOVE", "此操作不适用于五子棋");
      }
  }
}

export function asyncGate(before: AsyncActivity, after: AsyncActivity, command: AsyncCommand) {
  return {
    turn: before.id === "g05" && command.type !== "chess.undo" ? gomokuTurn(before.game) : null,
    nextTurn: after.id === "g05" ? gomokuTurn(after.game) : null,
  };
}
