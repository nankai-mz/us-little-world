import { useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { QUESTION_BANK, QUESTION_CATEGORIES } from "../../../src/core/questions";
import type { Entry } from "../../../src/core/types";
import type { UsService } from "../../../src/core/service";
import {
  emojiChoices, storyTurn, type AsyncCommand, type Bond, type Boxes, type Chess, type Quiz, type Story,
} from "../../../src/features/play-core/async-games";
import { boardSize, gomokuTurn, type Stone } from "../../../src/features/play-core/gomoku";
import { otherSeat, type Seat } from "../../../src/features/play-core/protocol";
import { isMediaGame } from "../../../src/features/play-core/game";
import { isSceneGame } from "../../../src/features/scene-core/scene";
import type { PlayClient, RoomView } from "./client";
import { PlayPhoto } from "./MediaRoom";

type GameProps = {
  client: PlayClient;
  service: UsService;
  view: RoomView;
  seat: Seat;
  disabled: boolean;
  members: [string, string];
  shared: Entry[];
  submit: (command: AsyncCommand) => Promise<boolean>;
  openMemory: (entry: Entry) => void;
  report: (failure: unknown) => void;
};

export function QuestionPicker({ value, select }: { value: string; select: (question: string) => void }) {
  const [category, setCategory] = useState(() => QUESTION_BANK.find(({ text }) => text === value)?.category ?? QUESTION_CATEGORIES[0]);
  const available = QUESTION_BANK.filter((question) => question.category === category);
  return <div className="play-fields play-split">
    <label>题目主题<select value={category} onChange={(event) => {
      const selected = event.target.value;
      setCategory(selected);
      select(QUESTION_BANK.find((question) => question.category === selected)!.text);
    }}>{QUESTION_CATEGORIES.map((item) => <option key={item}>{item}</option>)}</select></label>
    <label>选择题目<select value={available.some(({ text }) => text === value) ? value : available[0].text}
      onChange={(event) => select(event.target.value)}>
      {available.map(({ text }) => <option key={text}>{text}</option>)}
    </select></label>
  </div>;
}

function DraftForm({ client, view, field, disabled, label, action, limit, withTitle, children, send }: {
  client: PlayClient; view: RoomView; field: string; disabled: boolean; label: string; action: string;
  limit: number; withTitle?: boolean; children?: ReactNode; send: (text: string, title: string) => Promise<boolean>;
}) {
  const [saved] = useState(() => client.loadDraft(view.room, field));
  const [text, setText] = useState(saved?.text ?? "");
  const [title, setTitle] = useState(saved?.title ?? "");
  const [warning, setWarning] = useState("");
  const [sending, setSending] = useState(false);
  const sequence = useRef(0);

  function store(text: string, title: string) {
    const latest = ++sequence.current;
    void client.saveDraft(view.room, field, text || title ? { text, title } : null, () => latest === sequence.current)
      .catch(() => setWarning("本机无法保存草稿，请保留当前页面。"));
  }

  async function sendForm(event: FormEvent) {
    event.preventDefault();
    setSending(true);
    try {
      if (await send(text, title)) {
        setText("");
        setTitle("");
        store("", "");
      }
    } finally { setSending(false); }
  }

  return <form className="play-fields" onSubmit={sendForm}>
    {withTitle && <label>章节标题<input value={title} maxLength={60} onChange={(event) => {
      setTitle(event.target.value); store(text, event.target.value);
    }} placeholder="可留空" /></label>}
    {children}
    <label>{label}<textarea required value={text} maxLength={limit * 2} rows={withTitle ? 6 : 3}
      onChange={(event) => { setText(event.target.value); store(event.target.value, title); }} /></label>
    <div className="play-actions">
      <button className="primary" disabled={disabled || sending || !text.trim()}>{action}</button>
      {withTitle && <small>{Array.from(text.trim()).length} / {limit} 字</small>}
    </div>
    {warning && <small role="status">{warning}</small>}
  </form>;
}

function Comments({ props, items, field, chapter }: {
  props: GameProps; items: { by: Seat; text: string }[]; field: string; chapter?: number;
}) {
  return <div className="play-comments">
    {items.map(({ by, text }, i) => <p key={i}><strong>{props.members[by]}</strong>　{text}</p>)}
    {!props.disabled && <details><summary>留言</summary>
      <DraftForm {...props} field={field} label="留言内容" action="发送留言" limit={300}
        send={(text) => props.submit({ type: "comment", text, chapter })} />
    </details>}
  </div>;
}

function BondGame({ props, state }: { props: GameProps; state: Bond }) {
  const [question, select] = useState(QUESTION_BANK[0].text);
  const round = state.rounds.at(-1)!;
  const revealed = round.answers.every(Boolean);
  return <>
    <h3>{round.question}</h3>
    {!revealed && <p>答案会在双方都提交后显示。两人持有共同空间密钥，提前查看受页面规则约束。</p>}
    {revealed ? <>
      <div className="play-pair">{round.answers.map((answer, index) => <article key={index}>
        <h4>{props.members[index]}</h4><p>{answer?.text ?? "跳过了这题"}</p>
      </article>)}</div>
      <Comments props={props} items={round.comments} field={"bond-comment-" + state.rounds.length} />
      {!props.disabled && state.rounds.length < 24 && <details><summary>开始下一题</summary>
        <QuestionPicker value={question} select={select} />
        <button onClick={() => void props.submit({ type: "bond.next", question })}>发起下一题</button>
      </details>}
    </> : round.answers[props.seat]
      ? <div className="play-actions"><p>已提交，等对方回答。</p>
        <button disabled={props.disabled} onClick={() => void props.submit({ type: "bond.withdraw" })}>撤回答案</button></div>
      : !props.disabled && <>
        <DraftForm key={state.rounds.length} {...props} field={"bond-" + state.rounds.length} label="我的答案" limit={500}
          action="提交答案" send={(text) => props.submit({ type: "bond.answer", text })} />
        <button onClick={() => void props.submit({ type: "bond.answer", text: null })}>跳过这题</button>
      </>}
    {state.rounds.length > 1 && <details><summary>历史答题</summary>
      {state.rounds.slice(0, -1).map((item, index) => <article key={index} className="history-entry">
        <strong>{item.question}</strong>
        {item.answers.map((answer, seat) => <p key={seat}>{props.members[seat]}　{answer?.text ?? "跳过"}</p>)}
        {item.comments.map(({ by, text }, i) => <p key={i}>{props.members[by]}　{text}</p>)}
      </article>)}
    </details>}
  </>;
}

export function ChessBoard({ stones, enabled, onMove }: { stones: Stone[]; enabled: boolean; onMove?: (x: number, y: number) => void }) {
  const [cursor, setCursor] = useState(7 * boardSize + 7);
  const board = new Map(stones.map((stone) => [stone.y * boardSize + stone.x, stone]));
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  function keyboard(event: KeyboardEvent, index: number) {
    const x = index % boardSize;
    const y = Math.floor(index / boardSize);
    const move = { ArrowLeft: x > 0 ? -1 : 0, ArrowRight: x < boardSize - 1 ? 1 : 0,
      ArrowUp: y > 0 ? -boardSize : 0, ArrowDown: y < boardSize - 1 ? boardSize : 0 }[event.key];
    if (move === undefined) return;
    event.preventDefault();
    setCursor(index + move);
    buttons.current[index + move]?.focus();
  }
  return <div className="play-chess" aria-label="十五路棋盘">
    {Array.from({ length: boardSize ** 2 }, (_, index) => {
      const x = index % boardSize;
      const y = Math.floor(index / boardSize);
      const stone = board.get(index);
      const last = stone && stone === stones.at(-1);
      return <button type="button" key={index} ref={(element) => { buttons.current[index] = element; }}
        aria-label={`${String.fromCharCode(65 + x)}${y + 1} ${stone ? stone.by === 0 ? "黑棋" : "白棋" : "空位"}`}
        aria-disabled={!enabled || !!stone} data-stone={stone?.by} data-last={last || undefined}
        tabIndex={cursor === index ? 0 : -1} onFocus={() => setCursor(index)} onKeyDown={(event) => keyboard(event, index)}
        onClick={() => { if (enabled && !stone) onMove?.(x, y); }} />;
    })}
  </div>;
}

function ChessGame({ props, state }: { props: GameProps; state: Chess }) {
  const { game } = state;
  const turn = gomokuTurn(game);
  const [history, show] = useState<number | null>(null);
  const [step, setStep] = useState(0);
  const [column, setColumn] = useState(7);
  const [row, setRow] = useState(7);
  const replay = history === null ? null : game.history[history] ?? { stones: game.stones };
  const place = (x: number, y: number) => void props.submit({ type: "chess.move", x, y });
  const ownTurn = !replay && !props.disabled && turn === props.seat && game.winner === null && game.undo === null;
  return <>
    <p className="play-turn" role="status">{game.winner === "draw" ? "棋盘已满，平局" : game.winner !== null
      ? `${props.members[game.winner]} 连成五颗，赢得本局` : props.seat === turn ? "轮到你落子" : `等待 ${props.members[turn]} 落子`}</p>
    <ChessBoard stones={replay ? replay.stones.slice(0, step) : game.stones}
      enabled={ownTurn} onMove={place} />
    {ownTurn && <details><summary>按坐标落子</summary>
      <div className="play-fields play-split">
        <label>棋盘列<select value={column} onChange={(event) => setColumn(Number(event.target.value))}>
          {Array.from({ length: boardSize }, (_, i) => <option key={i} value={i}>{String.fromCharCode(65 + i)}</option>)}
        </select></label>
        <label>棋盘行<select value={row} onChange={(event) => setRow(Number(event.target.value))}>
          {Array.from({ length: boardSize }, (_, i) => <option key={i} value={i}>{i + 1}</option>)}
        </select></label>
      </div>
      <button disabled={game.stones.some((stone) => stone.x === column && stone.y === row)} onClick={() => place(column, row)}>在所选位置落子</button>
    </details>}
    <div className="play-actions">
      {!props.disabled && !replay && game.undo === null && game.stones.at(-1)?.by === props.seat &&
        <button onClick={() => void props.submit({ type: "chess.undo" })}>申请悔棋</button>}
      {!props.disabled && !replay && game.undo !== null && (game.undo === props.seat ? <span>等待对方确认悔棋</span>
        : <><button onClick={() => void props.submit({ type: "chess.respond", accept: true })}>同意悔棋</button>
          <button onClick={() => void props.submit({ type: "chess.respond", accept: false })}>继续这一局</button></>)}
      {!props.disabled && !replay && game.winner !== null && game.undo === null && turn === props.seat && game.match < 12 &&
        <button onClick={() => void props.submit({ type: "chess.rematch" })}>交换先手，再来一局</button>}
    </div>
    {(game.history.length > 0 || game.stones.length > 0) && <details onToggle={(event) => {
      if (!event.currentTarget.open) show(null);
    }}><summary>棋谱回放</summary>
      <div className="play-fields">
        <label>选择棋局<select value={history ?? ""} onChange={(event) => {
          show(event.target.value === "" ? null : Number(event.target.value)); setStep(0);
        }}><option value="">返回当前棋盘</option>
          {[...game.history, game].map((_, i) => <option key={i} value={i}>第 {i + 1} 局</option>)}
        </select></label>
        {replay && <label>回放到第 {step} 手<input type="range" min={0} max={replay.stones.length} value={step}
          onChange={(event) => setStep(Number(event.target.value))} /></label>}
      </div>
    </details>}
  </>;
}

function MemoryPicker({ shared, value, set, photos = false }: { shared: Entry[]; value: string; set: (value: string) => void; photos?: boolean }) {
  return <label>{photos ? "附一张共同照片" : "关联共同回忆"}<select value={value} onChange={(event) => set(event.target.value)}>
    <option value="">暂不关联</option>
    {shared.filter((entry) => !photos || entry.data.photos?.some(({ fileId }) => !!fileId))
      .map((entry) => <option key={entry.id} value={entry.id}>{entry.data.date}　{entry.data.title}</option>)}
  </select></label>;
}

function MemoryLink({ props, id }: { props: GameProps; id: string }) {
  const memory = props.shared.find((entry) => entry.id === id);
  return memory ? <button onClick={() => props.openMemory(memory)}>打开回忆 · {memory.data.title}</button> : <p>这条回忆已移除或无法访问。</p>;
}

function QuizGame({ props, state }: { props: GameProps; state: Quiz }) {
  const [prompt, setPrompt] = useState("");
  const [memory, setMemory] = useState("");
  const [symbols, setSymbols] = useState<string[]>([]);
  const round = state.rounds.at(-1)!;
  const author = round.author === props.seat;
  const index = state.rounds.length;
  return <>
    {!round.hidden && author && !props.disabled ? <DraftForm {...props} field={"answer-" + index} label="谜底" action="发布题目" limit={500}
      send={async (text) => {
        try {
          const hidden = await props.client.sealAnswer(props.view.room, index, { text, memoryId: memory || undefined });
          return await props.submit({ type: "quiz.ask", prompt, symbols, hidden });
        } catch (error) { props.report(error); return false; }
      }}>
      {state.id === "g06" ? <><label>关于我的问题<input required maxLength={240} value={prompt}
        placeholder="例如：我最喜欢哪一种甜点？" onChange={(event) => setPrompt(event.target.value)} /></label>
        <QuestionPicker value={prompt} select={setPrompt} /></> : <>
        <div className="play-emoji-selected" aria-live="polite">{symbols.join(" ") || "选择 3–12 个表情"}</div>
        <div className="play-emoji">{emojiChoices.map((emoji) => <button key={emoji} type="button" disabled={symbols.length >= 12}
          onClick={() => setSymbols((current) => [...current, emoji])}>{emoji}</button>)}</div>
        <button type="button" disabled={!symbols.length} onClick={() => setSymbols((current) => current.slice(0, -1))}>收回最后一个</button>
        <MemoryPicker shared={props.shared} value={memory} set={setMemory} />
      </>}
    </DraftForm> : !round.hidden ? <p>等 {props.members[round.author]} 出题。</p> : <>
      <h3>{round.symbols?.join(" ") || round.prompt}</h3>
      {round.guess === null ? author ? <p>等对方提交猜测。</p>
        : !props.disabled && <DraftForm {...props} field={"guess-" + index} label="我的猜测" action="提交猜测" limit={400}
          send={(guess) => props.submit({ type: "quiz.guess", guess })} /> : <p>猜测　{round.guess}</p>}
      {round.guess !== null && !round.answer && (author && !props.disabled
        ? <button className="primary" onClick={() => {
          try {
            const answer = props.client.openAnswer(props.view.room, index, round.hidden!);
            void props.submit({ type: "quiz.reveal", answer });
          } catch (error) { props.report(error); }
        }}>揭晓谜底</button> : <p>等出题者揭晓谜底。</p>)}
      {round.answer && <>
        <p>谜底　{round.answer.text}</p>
        {round.answer.memoryId && <MemoryLink props={props} id={round.answer.memoryId} />}
        <Comments props={props} items={round.comments} field={"quiz-comment-" + index} />
        <button disabled={props.disabled || index >= 24} onClick={() => void props.submit({ type: "quiz.next" })}>交换角色</button>
      </>}
    </>}
    {index > 1 && <details><summary>看过的题</summary>
      {state.rounds.slice(0, -1).map((item, i) => <article key={i} className="history-entry">
        <h4>{item.symbols?.join(" ") || item.prompt}</h4><p>猜测　{item.guess}</p><p>谜底　{item.answer?.text}</p>
        {item.answer?.memoryId && <MemoryLink props={props} id={item.answer.memoryId} />}
      </article>)}
    </details>}
  </>;
}

function BoxGame({ props, state }: { props: GameProps; state: Boxes }) {
  const [kind, setKind] = useState<"surprise" | "date" | "task">("surprise");
  const [instant, setInstant] = useState(false);
  const [memory, setMemory] = useState("");
  const own = state.boxes[props.seat];
  const partner = state.boxes[otherSeat(props.seat)];
  const names = { surprise: "小惊喜", date: "约会提议", task: "任务卡" };
  return <>
    <p>手动开启的盲盒会先折起来。两人持有共同空间密钥，提前查看受页面规则约束。</p>
    {!own && !props.disabled && <DraftForm {...props} field="box" action="放进盲盒" label="我准备的小惊喜" limit={500}
      send={(text) => {
        const photo = props.shared.find((entry) => entry.id === memory)?.data.photos?.find(({ fileId }) => !!fileId);
        return props.submit({ type: "box.put", text, kind, instant, memory: photo ? { recordId: memory, fileId: photo.fileId } : undefined });
      }}>
      <label>盲盒类型<select value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}>
        {Object.entries(names).map(([id, text]) => <option value={id} key={id}>{text}</option>)}</select></label>
      <MemoryPicker shared={props.shared} value={memory} set={setMemory} photos />
      <label className="play-check"><input type="checkbox" checked={instant} onChange={(event) => setInstant(event.target.checked)} />对方打开房间即可查看</label>
    </DraftForm>}
    <div className="play-pair">
      <article><h4>我的盲盒</h4>{own ? <>
        <p>{names[own.kind]}　{own.text}</p>
        {own.reply && <p>{own.reply === "accept" ? "对方接受了" : "对方选择跳过"}</p>}
        {!own.opened && !own.instant && <button disabled={props.disabled} onClick={() => void props.submit({ type: "box.remove" })}>收回盲盒</button>}
      </> : <p>等你放入一件小惊喜。</p>}</article>
      <article><h4>对方的盲盒</h4>{partner ? (partner.opened || partner.instant ? <>
        <p>{names[partner.kind]}　{partner.text}</p>
        {partner.memory?.fileId && <PlayPhoto service={props.service} photo={{ recordId: partner.memory.recordId,
          fileId: partner.memory.fileId }} label="盲盒里的共同照片" />}
        {partner.memory && <MemoryLink props={props} id={partner.memory.recordId} />}
        {partner.kind === "task" && (partner.reply ? <p>{partner.reply === "accept" ? "已接受" : "已跳过"}</p>
          : <div className="play-actions"><button disabled={props.disabled}
            onClick={() => void props.submit({ type: "box.respond", reply: "accept" })}>接受邀请</button>
            <button disabled={props.disabled} onClick={() => void props.submit({ type: "box.respond", reply: "decline" })}>这次先跳过</button></div>)}
      </> : <button disabled={props.disabled} onClick={() => void props.submit({ type: "box.open" })}>拆开盲盒</button>) : <p>对方还没有放进惊喜。</p>}</article>
    </div>
  </>;
}

const dice = [
  ["一位忘了带钥匙的旅人", "一只喜欢收集旧车票的猫", "第一次远行的邮差", "守着一家唱片店的人"],
  ["雨后的夜市", "一趟快到终点的列车", "清晨的海边", "一间只在冬天营业的咖啡馆"],
  ["信里夹着一张旧地图", "停电时响起一首熟悉的歌", "有人送来一封写给未来的信", "窗外飘进一张陌生的照片"],
] as const;

function StoryGame({ props, story }: { props: GameProps; story: Story }) {
  const [prompt, setPrompt] = useState("");
  const last = story.chapters.at(-1);
  const next = storyTurn(story);
  return <>
    <h3>{story.title}</h3>
    {!story.chapters.length && <p>从第一个片段开始。每章 100–1000 字。</p>}
    {story.chapters.map((chapter, i) => <article key={i} className="play-chapter">
      <h4>{chapter.title}</h4><small>{props.members[chapter.author]}{chapter.accepted ? "" : " · 待确认"}</small>
      <p>{chapter.text}</p>
      {chapter.accepted && <Comments props={props} items={chapter.comments} field={"story-comment-" + i} chapter={i} />}
    </article>)}
    {last && !last.accepted && !props.disabled && (last.author === props.seat
      ? <button onClick={() => void props.submit({ type: "story.withdraw" })}>撤回待确认章节</button>
      : <button onClick={() => void props.submit({ type: "story.accept" })}>确认上一章</button>)}
    {!props.disabled && story.chapters.length < 48 && (next === props.seat ? <>
      <div className="play-actions"><button onClick={() => {
        const random = crypto.getRandomValues(new Uint8Array(3));
        setPrompt(dice.map((group, i) => group[random[i] % group.length]).join(" · "));
      }}>掷剧情骰子</button>{prompt && <span>{prompt}</span>}</div>
      <DraftForm key={story.chapters.length} {...props} field={"chapter-" + story.chapters.length} label="本章正文" action="交给对方"
        limit={1000} withTitle send={(text, title) => props.submit({ type: "story.write", title, text })} />
    </> : <p>轮到 {props.members[next]} 接着写。</p>)}
  </>;
}

export function AsyncGames(props: GameProps) {
  const { game } = props.view;
  if ("objects" in game || isMediaGame(game) || isSceneGame(game)) return null;
  switch (game.id) {
    case "g03": return <BondGame props={props} state={game} />;
    case "g05": return <ChessGame props={props} state={game} />;
    case "g06":
    case "g07": return <QuizGame key={game.rounds.length} props={props} state={game} />;
    case "g09": return <BoxGame props={props} state={game} />;
    case "c19": return <StoryGame props={props} story={game} />;
  }
}
