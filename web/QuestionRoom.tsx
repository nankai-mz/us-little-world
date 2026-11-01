import { useEffect, useState } from "react";
import { BookOpen, Check, Coffee, Send } from "lucide-react";
import type { UsService } from "../src/core/service";
import type { Entry } from "../src/core/types";
import { today } from "../src/core/date";
import { secureChoice } from "../src/core/domain";
import {
  dailyQuestion,
  dailyQuiz,
  QUESTION_BANK,
  QUESTION_CATEGORIES,
  QUIZ_BANK,
  QUIZ_CATEGORIES,
} from "../src/core/questions";

type QuestionContext = {
  title: string;
  date: string;
  kind: "question" | "quiz";
};
export function QuestionRoom({
  service,
  entries,
  mode,
  busy,
  perform,
}: {
  service: UsService;
  entries: Entry[];
  mode: string;
  busy: boolean;
  perform: (
    operation: () => Promise<void>,
    success?: string,
  ) => Promise<unknown>;
}) {
  const [view, setView] = useState("answer");
  const [category, setCategory] = useState("全部");
  const [answer, setAnswer] = useState("");
  const [custom, setCustom] = useState("");
  const defaultContext = (): QuestionContext => ({
    title: mode === "quiz" ? dailyQuiz().title : dailyQuestion().text,
    date: today(),
    kind: mode === "quiz" ? "quiz" : "question",
  });
  const [context, setContext] = useState<QuestionContext>(defaultContext);
  useEffect(() => {
    setContext(defaultContext());
    setView("answer");
    setCategory("全部");
    setAnswer("");
  }, [mode]);
  const record = entries.find(
    (entry) =>
      entry.data.kind === context.kind &&
      entry.data.title === context.title &&
      entry.data.date === context.date,
  );
  const answers = Object.entries(record?.data.answers || {});
  const quiz = QUIZ_BANK.find((item) => item.title === context.title);
  const history = entries.filter((entry) =>
    ["question", "quiz"].includes(entry.data.kind),
  );
  function open(entry: Entry) {
    setContext({
      title: entry.data.title,
      date: entry.data.date,
      kind: entry.data.kind === "quiz" ? "quiz" : "question",
    });
    setAnswer("");
    setView("answer");
  }
  async function ask(text: string, group = "自定义") {
    await perform(async () => {
      const entry = await service.askQuestion(text, group);
      open(entry);
      setCustom("");
    }, "问题已加密保存，对方刷新后也能看到");
  }
  return (
    <section className="question-room">
      <nav className="question-toolbar" aria-label="问题工具">
        <button
          className={view === "answer" ? "selected" : ""}
          onClick={() => {
            setContext(defaultContext());
            setAnswer("");
            setView("answer");
          }}
        >
          今天慢慢聊
        </button>
        <button
          className={view === "library" ? "selected" : ""}
          onClick={() => {
            setCategory("全部");
            setView("library");
          }}
        >
          <BookOpen size={15} />
          {mode === "quiz" ? "24 道默契题" : "120 个温柔话题"}
        </button>
        <button
          className={view === "custom" ? "selected" : ""}
          onClick={() => setView("custom")}
        >
          ＋ 自己出一题
        </button>
        <button
          className={view === "history" ? "selected" : ""}
          onClick={() => setView("history")}
        >
          我们的问题
        </button>
      </nav>
      {view === "answer" && (
        <div className="question-page card card-tape">
          <span className="eyebrow">LET'S KNOW EACH OTHER A LITTLE MORE</span>
          <span className="question-decoration">
            <Coffee size={36} />
          </span>
          <p className="question-date">
            {context.date} ·{" "}
            {record?.data.category ||
              (context.kind === "quiz" ? "默契小测试" : "慢慢了解彼此")}
          </p>
          <h2>{context.title}</h2>
          <p className="muted">各自写下答案，不着急，等对方也准备好。</p>
          {context.kind === "quiz" && quiz ? (
            <div className="quiz-options">
              {quiz.options.map((option) => (
                <button
                  key={option}
                  className={answer === option ? "selected" : ""}
                  onClick={() => setAnswer(option)}
                >
                  {option}
                  {answer === option && <Check size={16} />}
                </button>
              ))}
            </div>
          ) : (
            <textarea
              aria-label="我的答案"
              placeholder="这一刻，我想说…"
              value={answer}
              maxLength={1000}
              rows={5}
              onChange={(event) => setAnswer(event.target.value)}
            />
          )}
          <div className="question-actions">
            <button
              className="primary"
              disabled={busy || !answer.trim()}
              onClick={() =>
                perform(async () => {
                  await service.answer(
                    context.title,
                    answer,
                    context.kind,
                    context.date,
                  );
                  setAnswer("");
                }, "答案已加密保存，等待彼此都准备好")
              }
            >
              <Send size={15} />
              留下我的答案
            </button>
            {mode === "truth" && (
              <button
                className="text-button"
                disabled={busy}
                onClick={() =>
                  perform(async () => {
                    const item = secureChoice(
                      QUESTION_BANK,
                      await service.rng(64),
                    );
                    setContext({
                      title: item.text,
                      date: today(),
                      kind: "question",
                    });
                    setAnswer("");
                  })
                }
              >
                跳过，换个话题
              </button>
            )}
          </div>
          {!!answers.length && (
            <div className="answer-reveal">
              <h3>
                {answers.length < 2
                  ? "答案已留下，等彼此都准备好"
                  : "原来，我们是这样想的"}
              </h3>
              {answers
                .filter(([id]) => answers.length === 2 || id === service.userId)
                .map(([id, text]) => (
                  <p key={id}>
                    <strong>
                      {id === service.userId ? "我的答案" : "对方的答案"}
                    </strong>
                    {text}
                  </p>
                ))}
              {answers.length === 1 && answers[0][0] !== service.userId && (
                <p>对方已经准备好，写下你的答案后一起揭晓。</p>
              )}
            </div>
          )}
          <p className="fineprint">
            自愿回答，没有感情评分。答案揭晓由客户端控制，不是密码学盲答。
          </p>
        </div>
      )}
      {view === "library" && (
        <div className="question-library card">
          <span className="eyebrow">A LITTLE LIBRARY OF US</span>
          <h2>
            {mode === "quiz" ? "选一道今天想猜的小题" : "从好奇开始，慢慢靠近"}
          </h2>
          <div className="pills category-pills">
            {[
              "全部",
              ...(mode === "quiz" ? QUIZ_CATEGORIES : QUESTION_CATEGORIES),
            ].map((group) => (
              <button
                key={group}
                className={category === group ? "selected" : ""}
                onClick={() => setCategory(group)}
              >
                {group}
              </button>
            ))}
          </div>
          <div className="topic-grid">
            {mode === "quiz"
              ? QUIZ_BANK.filter(
                  (item) => category === "全部" || item.category === category,
                ).map((item) => (
                  <article className="topic-note" key={item.id}>
                    <span>{item.category}</span>
                    <h3>{item.title}</h3>
                    <button
                      className="text-button"
                      onClick={() => {
                        setContext({
                          title: item.title,
                          date: today(),
                          kind: "quiz",
                        });
                        setView("answer");
                        setAnswer("");
                      }}
                    >
                      猜猜彼此的选择 →
                    </button>
                  </article>
                ))
              : QUESTION_BANK.filter(
                  (item) => category === "全部" || item.category === category,
                ).map((item) => (
                  <article className="topic-note" key={item.id}>
                    <span>{item.category}</span>
                    <h3>{item.text}</h3>
                    <button
                      className="text-button"
                      disabled={busy}
                      onClick={() => ask(item.text, item.category)}
                    >
                      把这个问题留给我们 →
                    </button>
                  </article>
                ))}
          </div>
        </div>
      )}
      {view === "custom" && (
        <div className="question-page card card-tape">
          <span className="eyebrow">A QUESTION FROM THE HEART</span>
          <h2>有件小事，想问问你</h2>
          <p className="muted">
            不必很特别，也不必立刻回答。一起把好奇留在这里。
          </p>
          <textarea
            aria-label="自定义问题"
            value={custom}
            maxLength={180}
            rows={4}
            placeholder="如果周末只留一件想一起做的小事，你会选什么？"
            onChange={(event) => setCustom(event.target.value)}
          />
          <span className="question-date">
            {custom.length}/180 · 仅在我们的共同空间中可见
          </span>
          <button
            className="primary"
            disabled={busy || !custom.trim()}
            onClick={() => ask(custom)}
          >
            <Send size={15} />
            把问题留给我们
          </button>
        </div>
      )}
      {view === "history" && (
        <div className="question-library card">
          <span className="eyebrow">LITTLE CONVERSATIONS, KEPT SAFE</span>
          <h2>我们还想慢慢聊的事</h2>
          <p className="muted">过去的问题也留在这里，可以继续回答和回看。</p>
          <div className="topic-grid">
            {history.map((entry) => (
              <article className="topic-note" key={entry.id}>
                <span>
                  {entry.data.date} ·{" "}
                  {entry.data.category ||
                    (entry.data.kind === "quiz" ? "默契小测试" : "双人问答")}
                </span>
                <h3>{entry.data.title}</h3>
                <p>
                  {Object.keys(entry.data.answers || {}).length === 2
                    ? "双方都已留下答案"
                    : "等彼此都准备好"}
                </p>
                <button className="text-button" onClick={() => open(entry)}>
                  打开这段对话 →
                </button>
              </article>
            ))}
          </div>
          {!history.length && (
            <p className="empty-copy">第一句好奇，等我们一起留下。</p>
          )}
        </div>
      )}
    </section>
  );
}
