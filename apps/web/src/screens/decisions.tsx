// The Decisions screen (RSVA-644, the Decisions artboards 1–6 of the Quire canvas): the questions agents wait on the
// viewer to answer, one card at a time. A digit answers, ↵ takes the recommendation, S skips, O opens the issue, R
// answers in one's own words, A saves the answer as a rule, Z takes the last answer back within 8 s. The questions are
// the workspace's Decision rows (`rsva ask`); an answer goes through the sync engine, and the server writes it with the
// reply "Decision: …" that the agent reads. What the agent is doing is not shown here
// (owner 2026-11-06: agents live in Rex). Desktop layout; the phone's is RSVA-644's follow-up.
import {
  ArchiveIcon,
  ArrowSquareOutIcon,
  CodeIcon,
  DatabaseIcon,
  GitPullRequestIcon,
  RobotIcon,
  SealQuestionIcon,
  SignpostIcon,
  SlidersHorizontalIcon,
  StackIcon,
  XIcon,
} from "@phosphor-icons/react";
import { HANDOFF_OPTION, isOpenIssue, type Decision, type DecisionAnswer, type DecisionKind, type Issue } from "@rsva/schema/models";
import { Checkbox } from "@rsva/ui/components/checkbox";
import { errorText, plural } from "@rsva/schema/util";
import { Button } from "@rsva/ui/components/button";
import { Kbd } from "@rsva/ui/components/kbd";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@rsva/ui/components/popover";
import { Segmented } from "@rsva/ui/components/segmented";
import { Spinner } from "@rsva/ui/components/spinner";
import { Switch } from "@rsva/ui/components/switch";
import { Textarea } from "@rsva/ui/components/textarea";
import { keys } from "@rsva/ui/lib/keys";
import { cn } from "@rsva/ui/lib/utils";
import { compactAge } from "@rsva/display/time";
import { reaction, when } from "mobx";
import { observer } from "mobx-react-lite";
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { answerText, buildQueue, canRule, commandOf, evidenceOf, relationsOf, ruleLine, Sitting, UNDO_MS, unblockCounts, type Answer, type Card, type Entry, type Order } from "../lib/decisions.ts";
import { typedInto } from "../lib/typing.ts";
import { currentWs, store } from "../store.ts";
import { rules } from "./decision-rules.ts";
import { decisions, keepHeld, waitingDecisions } from "./decisions-state.ts";
import { openIssue } from "./issue-actions.ts";
import { notice } from "./notice.ts";
import { IssueStateGlyph } from "./state-glyph.tsx";

/** The op an entry's answer is, for one of its questions. */
const answerOf = (e: Entry): DecisionAnswer => {
  const rule = e.rule && canRule(e.card) ? { rule: true } : {};
  return "text" in e.answer ? { status: "answered", option: null, text: e.answer.text, ...rule } : { status: "answered", option: e.answer.option, ...rule };
};

let leaving = false;
/**
 * Sends an answer once its undo window is over: each question answered, the rule saved with a lone one's answer, and
 * Rules read again once the server has it. Leaving the page sends what is held and also keeps it on the device: the
 * engine's own queue may not reach the disk before the tab is gone, and the next start sends what is still open.
 */
function post(e: Entry): void {
  for (const m of e.members) store.answerDecision(m.id, answerOf(e));
  if (leaving) keepHeld(e.members.map((m) => ({ id: m.id, set: answerOf(e) })));
  else if (e.rule && canRule(e.card)) {
    const ws = currentWs();
    void when(() => store.pendingCount === 0).then(() => rules.load(ws));
  }
}

// One sitting per tab: the answers outlive the screen, so leaving it within the undo window loses nothing.
const sitting = new Sitting(post);
reaction(
  () => sitting.answered,
  (ids) => decisions.setAnswered(ids),
);
addEventListener("pagehide", () => {
  leaving = true;
  sitting.flush();
});

const KIND: Record<DecisionKind, { icon: typeof SealQuestionIcon; one: string; many: string; own: string }> = {
  question: { icon: SealQuestionIcon, one: "Question from", many: "similar questions from", own: "Answer in your own words" },
  close: { icon: ArchiveIcon, one: "Close proposal from", many: "close proposals from", own: "Keep it, and say why" },
  handoff: { icon: RobotIcon, one: "Hand-off plan from", many: "hand-off plans from", own: "Change Done when in the issue, then hand it over" },
};
const ORDERS = [
  { value: "unblocks", label: "Unblocks most" },
  { value: "oldest", label: "Oldest" },
] as const;

const nameOf = (id: string) => store.users.get(id)?.name ?? "an agent";
/** The key of a decision's issue, as the lists show it. */
const keyOf = (d: Decision) => {
  const issue = store.issues.get(d.issueId);
  return issue ? store.issueKey(issue) : "";
};
const projectOf = (d: Decision) => keyOf(d).split("-")[0] ?? "";
const ago = (iso: string) => {
  const a = compactAge(Date.now() - Date.parse(iso));
  return a === "now" ? "just now" : `${a} ago`;
};

export const Decisions = observer(function Decisions({ ws }: { ws: string }) {
  useEffect(() => void rules.load(ws), [ws]);
  const [order, setOrder] = useState<Order>("unblocks");
  const [skipped, setSkipped] = useState<string[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [focus, setFocus] = useState(0);
  const [left, setLeft] = useState<ReadonlySet<string>>(() => new Set());
  const [own, setOwn] = useState<string | null>(null);
  const [rule, setRule] = useState(false);
  const ownRef = useRef<HTMLTextAreaElement>(null);

  const waiting = waitingDecisions.get();
  const unblocks = unblockCounts(store.issues.values(), (i) => isOpenIssue(i, store.states.get(i.stateId)?.group));
  const queue = buildQueue(waiting, unblocks, order, skipped);
  const card = queue.find((c) => c.id === activeId) ?? queue[0] ?? null;
  const at = card ? queue.indexOf(card) : -1;

  const show = (id: string | null) => {
    setActiveId(id);
    setFocus(0);
    setLeft(new Set());
    setOwn(null);
    setRule(false);
  };
  const undo = () => {
    const e = sitting.undo();
    if (e) show(e.card.id);
  };
  const answer = (c: Card, a: Answer) => {
    // What was left out belongs to the group on screen; a lone question is answered whatever was unchecked before.
    const members = c.members.length > 1 ? c.members.filter((m) => !left.has(m.id)) : c.members;
    if (!members.length) return;
    const e = sitting.answer(c, a, rule, members);
    show((queue[at + 1] ?? queue[at - 1])?.id ?? null);
    const lead = members.length > 1 ? plural(members.length, "issue") : keyOf(members[0]!);
    notice.show(`${answerText(a)}${e.rule ? " · rule saved" : ""}`, undo, { ms: UNDO_MS, kbd: "Z", lead });
  };
  const toggle = (id: string) => setLeft((s) => (s.has(id) ? new Set([...s].filter((x) => x !== id)) : new Set([...s, id])));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || typedInto(e)) return;
      // Enter on a focused button or link (the toast's Undo, a queue row) presses it; it answers nothing here.
      const onControl = e.target instanceof Element && !!e.target.closest("button, a, [role=button], [role=checkbox]");
      const cmd = commandOf(e, card, onControl);
      if (!cmd) return;
      e.preventDefault();
      if (cmd.t === "undo") return notice.undoFor ? notice.runUndo() : undo();
      if (!card) return;
      if (cmd.t === "answer") return answer(card, { option: cmd.option, label: card.options[cmd.option]!.label });
      if (cmd.t === "skip") {
        setSkipped((s) => [...s.filter((x) => x !== card.id), card.id]);
        return show((queue[at + 1] ?? queue[0])?.id ?? null);
      }
      if (cmd.t === "open") {
        const issue = store.issues.get(card.members[0]!.issueId);
        return issue && openIssue(issue);
      }
      if (cmd.t === "own") {
        // A hand-off is changed in the issue: its Done when is the issue's to edit, not an answer's words.
        if (card.kind === "handoff" && card.members.length === 1) {
          const issue = store.issues.get(card.members[0]!.issueId);
          return issue && openIssue(issue);
        }
        setOwn((t) => t ?? "");
        return requestAnimationFrame(() => ownRef.current?.focus());
      }
      if (cmd.t === "rule") return canRule(card) && setRule((r) => !r);
      if (cmd.t === "move") {
        if (card.members.length > 1) return setFocus((f) => Math.max(0, Math.min(card.members.length - 1, f + cmd.by)));
        return show(queue[Math.max(0, Math.min(queue.length - 1, at + cmd.by))]?.id ?? null);
      }
      if (cmd.t === "check") toggle(card.members[focus]!.id);
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  });

  const total = waiting.length;
  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-panel">
      <header className="flex h-(--topbar) shrink-0 items-center gap-2.5 border-b pr-4 pl-6">
        <SignpostIcon className="size-4 shrink-0 text-ink-2" />
        <h1 className="text-[15px] font-semibold tracking-[-0.01em]">Decisions</h1>
        <span className="font-mono text-meta text-ink-3">{store.status === "loading" ? "" : total ? `${total} waiting` : "all answered"}</span>
        <span className="flex-1" />
        <Segmented variant="quiet" label="Order" options={ORDERS} value={order} onChange={setOrder} />
        <RulesButton ws={ws} />
      </header>
      <div className="flex min-h-0 flex-1">
        <aside aria-label="Queue" className="flex w-[344px] shrink-0 flex-col border-r border-rule-soft bg-sidebar max-md:hidden">
          {(card || sitting.entries.length > 0) && <Progress done={sitting.summary.decisions} left={total} />}
          <div className="min-h-0 flex-1 overflow-auto px-1.5 pb-3">
            {queue.map((c) => (
              <QueueRow key={c.id} card={c} on={c === card} skipped={skipped.includes(c.id)} onClick={() => show(c.id)} />
            ))}
            <Answered onUndo={() => (notice.undoFor ? notice.runUndo() : undo())} />
          </div>
        </aside>
        <section className="relative flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-auto px-8 pt-[22px] pb-6">
            {card ? (
              <CardView
                key={card.id}
                card={card}
                pos={`${at + 1} of ${queue.length}`}
                left={left}
                focus={focus}
                onToggle={toggle}
                onAnswer={(a) => answer(card, a)}
                own={own}
                ownRef={ownRef}
                onOwn={setOwn}
                rule={rule}
                onRule={setRule}
              />
            ) : store.status === "loading" ? (
              <Waiting />
            ) : (
              <Empty />
            )}
          </div>
          {card && <KeyLine max={card.options.length} />}
        </section>
      </div>
    </main>
  );
});

/** The workspace's copy is still loading: said so, never as an empty queue. */
function Waiting() {
  return (
    <p className="mx-auto mt-[70px] flex max-w-160 items-center gap-2 text-body text-ink-3">
      <Spinner className="size-3.5" /> Loading the questions…
    </p>
  );
}

function Progress({ done, left }: { done: number; left: number }) {
  return (
    <div className="flex h-10 shrink-0 items-center gap-2.5 pr-3.5 pl-4 font-mono text-meta text-ink-3">
      <span>
        {done} answered · {left} left
      </span>
      <span className="h-1 flex-1 overflow-hidden rounded-xs bg-rail">
        <i className="block h-full rounded-xs bg-ink-2 transition-[width] duration-400" style={{ width: `${done + left ? (done / (done + left)) * 100 : 0}%` }} />
      </span>
    </div>
  );
}

const QueueRow = observer(function QueueRow({ card, on, skipped, onClick }: { card: Card; on: boolean; skipped: boolean; onClick: () => void }) {
  const Icon = card.members.length > 1 ? StackIcon : KIND[card.kind].icon;
  const m = card.members[0]!;
  const what = card.kind === "close" ? `close${card.members.length > 1 ? ` ${card.members.length}` : ""}?` : card.kind === "handoff" ? "hand off?" : `unblocks ${card.unblocks}`;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={on || undefined}
      className={cn(
        "grid w-full cursor-pointer grid-cols-[16px_minmax(0,1fr)] items-start gap-2.5 rounded-lg px-2.5 py-[9px] text-left hover:bg-row-hover",
        on && "bg-panel shadow-[inset_0_0_0_1px_var(--color-rule)] hover:bg-panel",
      )}
    >
      <Icon className={cn("mt-0.5 size-3.5", on ? "text-ink" : "text-ink-3")} />
      <span className="flex min-w-0 flex-col gap-1">
        <span className="font-mono text-[11px] text-ink-3">{card.members.length > 1 ? `${card.members.length} alike` : keyOf(m)}</span>
        <span className={cn("line-clamp-2 text-[13px] leading-[1.35]", skipped ? "text-ink-3" : "text-ink")}>{card.question}</span>
        <span className="flex gap-2.5 font-mono text-[11px] whitespace-nowrap text-ink-3">
          <span className={card.unblocks ? "text-ink-2" : undefined}>{what}</span>
          <span className="truncate">
            {nameOf(m.askedById)} · {compactAge(Date.now() - Date.parse(card.at))}
          </span>
        </span>
      </span>
    </button>
  );
});

/** "Answered this sitting": what was answered here, the last one held still taken back with Z. */
const Answered = observer(function Answered({ onUndo }: { onUndo: () => void }) {
  if (!sitting.entries.length) return null;
  return (
    <>
      <div className="mx-2.5 mt-4 mb-1 flex items-center gap-2">
        <span className="eyebrow">Answered this sitting</span>
        <span className="font-mono text-meta text-ink-3">{sitting.summary.decisions}</span>
        <span className="flex-1" />
        {sitting.canUndo && (
          <Button variant="ghost" size="sm" onClick={onUndo}>
            Undo last <Kbd>Z</Kbd>
          </Button>
        )}
      </div>
      {sitting.entries
        .slice()
        .reverse()
        .map((e, i) => (
          <div key={i} className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 px-2.5 py-[5px] text-[12.5px] text-ink-3">
            <span className="font-mono text-[11px] leading-[1.5]">{e.members.length > 1 ? `×${e.members.length}` : keyOf(e.members[0]!)}</span>
            <span className="truncate text-ink-2">{e.card.group ? `${e.card.group}: ${answerText(e.answer)}` : answerText(e.answer)}</span>
            {e.rule && <span className="col-start-2 text-[11.5px]">saved as a rule</span>}
          </div>
        ))}
    </>
  );
});

interface CardProps {
  card: Card;
  pos: string;
  left: ReadonlySet<string>;
  focus: number;
  onToggle: (id: string) => void;
  onAnswer: (a: Answer) => void;
  own: string | null;
  ownRef: RefObject<HTMLTextAreaElement | null>;
  onOwn: (text: string | null) => void;
  rule: boolean;
  onRule: (on: boolean) => void;
}

const CardView = observer(function CardView({ card, pos, left, focus, onToggle, onAnswer, own, ownRef, onOwn, rule, onRule }: CardProps) {
  const group = card.members.length > 1;
  const m = card.members[0]!;
  const kind = KIND[card.kind];
  const Icon = group ? StackIcon : kind.icon;
  const issue = store.issues.get(m.issueId);
  const blocked = group ? [] : [...store.issues.values()].filter((i) => i.blockedByIds.includes(m.issueId) && isOpenIssue(i, store.states.get(i.stateId)?.group));
  const relations = group || !issue ? [] : relationsOf(issue, store.issues.values());
  const ruleOn = canRule(card);
  return (
    <article className="max-w-[980px] animate-in fade-in-0 slide-in-from-bottom-2 duration-300">
      <div className="flex items-center gap-[7px] text-[12.5px] text-ink-2">
        <Icon className="size-3.5" />
        <span>{group ? `${card.members.length} ${kind.many} ${nameOf(m.askedById)}` : `${kind.one} ${nameOf(m.askedById)}`}</span>
        <span className="text-faint">·</span>
        <span>asked {ago(card.at)}</span>
        <span className="flex-1" />
        <span className="font-mono text-meta text-ink-3">{pos}</span>
      </div>
      {!group && (
        <div className="mt-3.5 flex items-center gap-2.5">
          <span className="font-mono text-id text-ink-2">{keyOf(m)}</span>
          <span className="min-w-0 truncate text-[14px] font-medium">{issue?.title ?? ""}</span>
          {issue && (
            <Button variant="ghost" size="sm" onClick={() => openIssue(issue)}>
              <ArrowSquareOutIcon /> Open issue <Kbd>O</Kbd>
            </Button>
          )}
        </div>
      )}
      <h2 className="mt-3 max-w-[760px] text-[21px] leading-[1.3] font-semibold tracking-[-0.01em]">{card.question}</h2>
      <p className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12.5px] text-ink-2">
        <span className="eyebrow">Unblocks</span>
        {blocked.length ? (
          blocked.map((b) => <IssueRef key={b.id} issue={b} />)
        ) : (
          <span className="text-ink-3">{group ? (card.unblocks ? plural(card.unblocks, "issue") : "nothing waits on them") : "nothing waits on it"}</span>
        )}
      </p>
      {relations.length > 0 && (
        <p className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12.5px] text-ink-2">
          <span className="eyebrow">Relations</span>
          {relations.map((r) => (
            <IssueRef key={r.issue.id} issue={r.issue} rel={r.rel} />
          ))}
        </p>
      )}
      <div className={cn("mt-5 grid items-start gap-8", group ? "grid-cols-[minmax(0,640px)]" : "grid-cols-[minmax(0,1fr)_290px]")}>
        <div>
          {group && <Members card={card} left={left} focus={focus} onToggle={onToggle} />}
          {card.kind === "handoff" && !group && m.criteria.length > 0 && <DoneWhen items={m.criteria} />}
          <div className="flex flex-col gap-1.5">
            {card.options.map((o, i) => (
              <button
                key={i}
                type="button"
                onClick={() => onAnswer({ option: i, label: o.label })}
                className={cn(
                  "grid w-full cursor-pointer grid-cols-[22px_minmax(0,1fr)_auto] items-start gap-3 rounded-[10px] py-[11px] pr-3.5 pl-3 text-left shadow-[inset_0_0_0_1px_var(--color-rule)] hover:bg-row-hover",
                  i === card.recommended && "bg-panel shadow-[inset_0_0_0_1.5px_var(--color-ink-3)]",
                )}
              >
                <Kbd className="mt-px justify-self-center">{i + 1}</Kbd>
                <span className="flex min-w-0 flex-col gap-[3px]">
                  <span className="text-[14px] leading-[1.3] font-semibold">{o.label}</span>
                  {o.detail && <span className="text-[12.5px] text-ink-3">{o.detail}</span>}
                  {i === card.recommended && card.why && <span className="mt-[3px] text-[12.5px] leading-[1.45] text-ink-2">{card.why}</span>}
                </span>
                {i === card.recommended && (
                  <span className="mt-0.5 inline-flex items-center gap-1.5 font-mono text-[11px] font-medium whitespace-nowrap text-ink-2">
                    Recommended <Kbd>↵</Kbd>
                  </span>
                )}
              </button>
            ))}
            {own === null ? (
              <button type="button" onClick={() => (card.kind === "handoff" && !group ? issue && openIssue(issue) : onOwn(""))} className="grid w-full cursor-pointer grid-cols-[22px_minmax(0,1fr)] items-start gap-3 rounded-[10px] py-2 pr-3.5 pl-3 text-left hover:bg-row-hover">
                <Kbd className="mt-px justify-self-center">R</Kbd>
                <span className="text-[13px] text-ink-2">{group ? "Answer them in your own words" : kind.own}</span>
              </button>
            ) : (
              <OwnWords card={card} text={own} ownRef={ownRef} onChange={onOwn} onSend={(text) => onAnswer({ text })} />
            )}
          </div>
          {ruleOn && (
            <label className={cn("mt-4 flex cursor-pointer items-start gap-3 rounded-[10px] bg-sidebar px-3.5 py-3", rule && "shadow-[inset_0_0_0_1px_var(--color-rule-strong)]")}>
              <Switch checked={rule} onCheckedChange={onRule} className="mt-0.5" />
              <span className="flex flex-col gap-0.5">
                <span className="text-[13px] font-medium">
                  Answer the same way next time <Kbd className="ml-1">A</Kbd>
                </span>
                <span className="text-[12px] leading-[1.45] text-ink-3">
                  In {projectOf(m)}, questions on “{m.topic}” get the answer you choose here from now on, when it is one of their options, without asking you. Saved with the answer; listed in Rules.
                </span>
              </span>
            </label>
          )}
        </div>
        {!group && <Evidence lines={m.evidence} />}
      </div>
    </article>
  );
});

function OwnWords({ card, text, ownRef, onChange, onSend }: { card: Card; text: string; ownRef: CardProps["ownRef"]; onChange: (t: string | null) => void; onSend: (t: string) => void }) {
  const send = () => text.trim() && onSend(text.trim());
  return (
    <div className="flex flex-col gap-2 rounded-[10px] bg-panel p-2.5 shadow-[inset_0_0_0_1px_var(--color-rule-strong)]">
      <Textarea
        ref={ownRef}
        autoFocus
        value={text}
        aria-label="Your answer"
        placeholder={card.kind === "close" ? "Why it should stay open" : `Your answer; posted as a comment on ${card.members.length > 1 ? "each issue" : keyOf(card.members[0]!)}`}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onChange(null);
          } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            send();
          }
        }}
        className="h-16 resize-none text-[13px] leading-[1.45]"
      />
      <div className="flex items-center gap-1.5">
        <span className="text-meta text-ink-3">Posted as your comment; the agent reads it.</span>
        <span className="flex-1" />
        <Button variant="ghost" size="sm" onClick={() => onChange(null)}>
          Cancel <Kbd>Esc</Kbd>
        </Button>
        <Button size="sm" disabled={!text.trim()} onClick={send}>
          Send <Kbd inverse>{keys("mod", "↵")}</Kbd>
        </Button>
      </div>
    </div>
  );
}

function Members({ card, left, focus, onToggle }: { card: Card; left: ReadonlySet<string>; focus: number; onToggle: (id: string) => void }) {
  const checked = card.members.filter((m) => !left.has(m.id)).length;
  return (
    <div className="mb-3.5 flex flex-col gap-px">
      {card.members.map((m, i) => {
        const on = !left.has(m.id);
        const issue = store.issues.get(m.issueId);
        return (
          <label key={m.id} className={cn("grid h-9 cursor-pointer grid-cols-[16px_auto_minmax(0,1fr)] items-center gap-2.5 rounded-lg px-2.5 text-[13px] hover:bg-row-hover", i === focus && "bg-row-selected")}>
            <Checkbox checked={on} onCheckedChange={() => onToggle(m.id)} aria-label={`Answer ${keyOf(m)} too`} />
            <span className="font-mono text-id text-ink-2">{keyOf(m)}</span>
            <span className={cn("truncate", !on && "text-ink-3")}>{issue?.title ?? m.question}</span>
          </label>
        );
      })}
      <p className="mx-2.5 mt-2 flex items-center gap-2 text-[12px] text-ink-3">
        {checked} of {card.members.length} checked
        <span className="ml-auto inline-flex items-center gap-1">
          <Kbd>J</Kbd>
          <Kbd>K</Kbd> move · <Kbd>X</Kbd> check
        </span>
      </p>
    </div>
  );
}

/** A hand-off's proposed Done when: what handing it over writes into the issue's description, when it has none. */
function DoneWhen({ items }: { items: string[] }) {
  return (
    <div className="mb-3.5 rounded-[10px] bg-panel px-3.5 pt-3 pb-2 shadow-[inset_0_0_0_1px_var(--color-rule-soft)]">
      <div className="mb-1.5 flex items-baseline gap-2.5">
        <span className="eyebrow">Done when</span>
        <span className="text-[12px] text-ink-3">proposed; option {HANDOFF_OPTION + 1} writes it into the issue if it has none</span>
      </div>
      {items.map((t, i) => (
        <div key={i} className="grid grid-cols-[18px_minmax(0,1fr)] gap-1.5 py-[5px] text-[13px] leading-[1.45]">
          <i className="font-mono text-[11px] leading-[1.75] text-ink-3 not-italic">{i + 1}</i>
          <span>{t}</span>
        </div>
      ))}
    </div>
  );
}

/** An issue named on a card: its state, key and title; `rel` says how it stands to the card's issue. */
const IssueRef = observer(function IssueRef({ issue, rel }: { issue: Issue; rel?: string }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      {rel && <span className="text-ink-3">{rel}</span>}
      <IssueStateGlyph issue={issue} />
      <b className="font-mono text-[11.5px] font-medium text-ink">{store.issueKey(issue)}</b>
      <span className="max-w-[260px] truncate">{issue.title}</span>
    </span>
  );
});

const Evidence = observer(function Evidence({ lines }: { lines: string[] }) {
  return (
    <aside className="flex flex-col gap-2 pt-0.5">
      <div className="eyebrow mb-0.5">Evidence · {lines.length}</div>
      {lines.length === 0 && <p className="text-[12.5px] text-ink-3">The agent gave none.</p>}
      {lines.map((line, i) => {
        const e = evidenceOf(line);
        const issue = e.t === "issue" ? store.issueByKey(e.key) : undefined;
        const [icon, head, body]: [ReactNode, string, string] =
          e.t === "code"
            ? [<CodeIcon key="i" className="size-[13px]" />, e.text, ""]
            : e.t === "pr"
              ? [<GitPullRequestIcon key="i" className="size-[13px]" />, e.text.split(" ")[0]!, e.text.split(" ").slice(1).join(" ")]
              : e.t === "issue"
                ? [issue ? <IssueStateGlyph key="i" issue={issue} /> : <SealQuestionIcon key="i" className="size-[13px]" />, e.key, issue?.title ?? ""]
                : [<DatabaseIcon key="i" className="size-[13px]" />, "", e.text];
        return (
          <div key={i} className="grid grid-cols-[14px_auto_minmax(0,1fr)] items-baseline gap-x-[7px] rounded-[9px] bg-panel px-3 py-2.5 text-[12.5px] shadow-[inset_0_0_0_1px_var(--color-rule-soft)]">
            <span className="self-center text-ink-3">{icon}</span>
            <span className="font-mono text-[11.5px] font-medium text-ink">{head}</span>
            <span className="min-w-0 leading-[1.35] text-ink-2">{body}</span>
          </div>
        );
      })}
    </aside>
  );
});

function KeyLine({ max }: { max: number }) {
  const k = (key: string, what: string) => (
    <>
      <Kbd>{key}</Kbd>
      <em className="mr-3 not-italic">{what}</em>
    </>
  );
  return (
    <footer className="flex shrink-0 flex-wrap items-center gap-[5px] px-8 pt-2.5 pb-3 text-[12px] text-ink-3">
      <Kbd>1</Kbd>–<Kbd>{max}</Kbd>
      <em className="mr-3 not-italic">answer</em>
      {k("↵", "recommended")}
      {k("S", "skip")}
      {k("O", "open issue")}
      {k("R", "own words")}
      {k("A", "same next time")}
      {k("Z", "undo")}
      <Kbd>J</Kbd>
      {k("K", "move")}
    </footer>
  );
}

/** The empty queue: what this sitting moved, from what was answered, and the rules it saved. */
const Empty = observer(function Empty() {
  const s = sitting.summary;
  const figures: [string, string][] = [
    [String(s.decisions), s.decisions === 1 ? "decision" : "decisions"],
    [String(s.moved), s.moved === 1 ? "issue moved on" : "issues moved on"],
    [String(s.askers), s.askers === 1 ? "agent answered" : "agents answered"],
    [s.decisions > 1 ? `${s.minutes} min` : "–", "this sitting"],
  ];
  return (
    <div className="mx-auto mt-[70px] max-w-160">
      <h2 className="text-[22px] font-semibold tracking-[-0.01em]">Nothing waits for you</h2>
      <p className="mt-2 text-[14px] text-ink-2">{s.decisions ? `You went through ${plural(s.decisions, "decision")}. Each answer is a comment the agent reads.` : "No agent has a question for you now."}</p>
      {s.decisions > 0 && (
        <div className="mt-[26px] grid grid-cols-4 gap-2">
          {figures.map(([n, label]) => (
            <div key={label} className="flex flex-col gap-1.5 rounded-[10px] bg-panel p-3.5 shadow-[inset_0_0_0_1px_var(--color-rule-soft)]">
              <b className="font-mono text-[22px] leading-none font-medium">{n}</b>
              <span className="text-[12px] text-ink-3">{label}</span>
            </div>
          ))}
        </div>
      )}
      {s.rules.length > 0 && (
        <div className="mt-[26px]">
          <div className="eyebrow">Rules you saved</div>
          {s.rules.map((r) => (
            <p key={r} className="mt-2 text-[13.5px] leading-[1.45]">
              {r}
            </p>
          ))}
        </div>
      )}
      <p className="mt-[30px] flex items-center gap-[5px] text-[12.5px] text-ink-3">
        New questions land here as agents ask them. <Kbd>G</Kbd>
        <Kbd>D</Kbd> brings you back.
      </p>
    </div>
  );
});

/** Rules: every saved rule of the workspace, the viewer's own with Remove. */
const RulesButton = observer(function RulesButton({ ws }: { ws: string }) {
  const list = rules.list;
  return (
    <Popover onOpenChange={(open) => open && void rules.load(ws)}>
      <PopoverTrigger
        render={
          <Button variant="ghost" size="sm">
            <SlidersHorizontalIcon /> Rules <span className="font-mono text-[11px] text-ink-3">{list?.length ?? ""}</span>
          </Button>
        }
      />
      <PopoverContent align="end" sideOffset={6} className="w-[380px] gap-2 p-3">
        <PopoverTitle className="text-caption font-medium">Rules</PopoverTitle>
        {rules.error && list === null ? (
          <p className="text-caption text-ink-3">The rules did not load: {rules.error}</p>
        ) : list === null ? (
          <p className="text-caption text-ink-3">Loading…</p>
        ) : list.length === 0 ? (
          <p className="text-caption text-ink-3">None yet. “Answer the same way next time” on a question with a topic saves one; agents read them, and a question on the same topic in the project is answered by it.</p>
        ) : (
          <ul className="flex max-h-80 flex-col gap-1 overflow-auto">
            {list.map((r) => (
              <li key={r.id} className="flex items-start gap-2 rounded-md px-1 py-1 text-caption">
                <span className="min-w-0 flex-1 leading-[1.45]">
                  In {r.project}, {ruleLine(r.topic, r.answer)}
                </span>
                {r.mine && (
                  <Button variant="ghost" size="icon-sm" aria-label="Remove the rule" title="Remove" onClick={() => rules.remove(ws, r.id).catch((e: unknown) => notice.show(errorText(e)))}>
                    <XIcon />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
});
