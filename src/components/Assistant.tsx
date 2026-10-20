import {
  Add01Icon,
  Alert02Icon,
  ArrowDown01Icon,
  ArrowRight01Icon,
  Cancel01Icon,
  CheckmarkCircle02Icon,
  Loading03Icon,
  SentIcon,
  Settings02Icon,
  Wrench01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { aiApi, useAssistantEvents, type AiEvent, type AiPendingApproval, type AiServerMessage } from "@/api";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { AssistantSettings } from "./AssistantSettings";
import { MascotBird } from "./Mascot";

// What each tool call looks like in the conversation.
const TOOL_LABEL: Record<string, string> = {
  list_apps: "Listed the apps",
  app_overview: "Read the app's config",
  list_checkouts: "Listed checkouts",
  list_builds: "Looked at builds",
  build_log: "Read a build log",
  list_devices: "Checked connected phones",
  git_log: "Read git history",
  git_branches: "Listed branches",
  list_releases: "Listed releases",
  changes_since_release: "Gathered changes since a release",
  jira_ticket: "Looked up a ticket",
  planned_command: "Worked out a build command",
  release_notes: "Rendered the release notes",
  create_branch: "Create a branch",
  push_branch: "Push a branch",
  start_builds: "Queue builds",
  cancel_build: "Cancel a build",
  install_build: "Install a build",
  publish_release: "Publish a release",
  jira_comment: "Comment on a ticket",
  jira_transition: "Move a ticket",
};

type Approval = { title: string; details: string[]; state: "pending" | "approved" | "declined" };

type Part =
  | { type: "text"; text: string }
  | { type: "tool"; id: string; name: string; input: unknown; result?: string; isError?: boolean; approval?: Approval };

type Item = { kind: "user"; text: string } | { kind: "assistant"; parts: Part[]; notes: string[]; busy: boolean };

/** Server messages → chat items: each user turn's assistant steps form one reply. */
function toItems(messages: AiServerMessage[], pending: AiPendingApproval[] = []): Item[] {
  const items: Item[] = [];
  let reply: Extract<Item, { kind: "assistant" }> | null = null;
  for (const m of messages) {
    if (m.role === "user") {
      items.push({ kind: "user", text: m.text });
      reply = null;
    } else if (m.role === "assistant") {
      if (!reply) items.push((reply = { kind: "assistant", parts: [], notes: [], busy: false }));
      if (m.text) reply.parts.push({ type: "text", text: m.text });
      for (const c of m.toolCalls) reply.parts.push({ type: "tool", id: c.id, name: c.name, input: c.input });
    } else if (reply) {
      for (const r of m.results) {
        const part = reply.parts.find((p) => p.type === "tool" && p.id === r.id) as Extract<Part, { type: "tool" }> | undefined;
        if (part) {
          Object.assign(part, { result: r.content.slice(0, 600), isError: r.isError });
          if (r.approval) part.approval = { title: r.approval.title, details: r.approval.details, state: r.approval.approved ? "approved" : "declined" };
        }
      }
    }
  }
  // Actions still waiting for an answer (the page was opened mid-turn).
  for (const a of pending) {
    for (const item of items) {
      if (item.kind !== "assistant") continue;
      const part = item.parts.find((p) => p.type === "tool" && p.id === a.id) as Extract<Part, { type: "tool" }> | undefined;
      if (part) {
        part.approval = { title: a.title, details: a.details, state: "pending" };
        item.busy = true;
      }
    }
  }
  return items;
}

/** Minimal, safe formatting for replies: paragraphs, bullets, **bold**, `code`. Never raw HTML. */
function Formatted({ text }: { text: string }) {
  const inline = (s: string) =>
    s.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).map((seg, i) =>
      seg.startsWith("`") && seg.endsWith("`") && seg.length > 2 ? (
        <code key={i} className="rounded bg-muted px-1 py-px font-mono text-[0.85em]">
          {seg.slice(1, -1)}
        </code>
      ) : seg.startsWith("**") && seg.endsWith("**") && seg.length > 4 ? (
        <strong key={i}>{seg.slice(2, -2)}</strong>
      ) : (
        <Fragment key={i}>{seg}</Fragment>
      ),
    );
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  let rows: string[][] = [];
  const flush = () => {
    if (list.length) blocks.push(<ul key={`l${blocks.length}`} className="list-disc space-y-0.5 pl-5">{list.map((l, i) => <li key={i}>{inline(l)}</li>)}</ul>);
    list = [];
    if (rows.length) {
      const [head, ...body] = rows;
      blocks.push(
        <div key={`t${blocks.length}`} className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b text-left">{head.map((c, i) => <th key={i} className="px-1.5 py-1 font-medium">{inline(c)}</th>)}</tr>
            </thead>
            <tbody>
              {body.map((r, i) => (
                <tr key={i} className="border-b last:border-0 align-top">{r.map((c, j) => <td key={j} className="px-1.5 py-1">{inline(c)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
    }
    rows = [];
  };
  for (const line of text.split("\n")) {
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const row = /^\s*\|(.*)\|\s*$/.exec(line);
    if (row) {
      if (list.length) flush();
      // The |---|---| line under the header carries nothing to show.
      if (!/^[\s|:-]+$/.test(row[1])) rows.push(row[1].split("|").map((c) => c.trim()));
    } else if (bullet) {
      if (rows.length) flush();
      list.push(bullet[1]);
    } else {
      flush();
      if (line.trim()) blocks.push(<p key={`p${blocks.length}`}>{inline(line.replace(/^#+\s*/, ""))}</p>);
    }
  }
  flush();
  return <div className="space-y-2 leading-relaxed">{blocks}</div>;
}

function ToolChip({ part, onAnswer }: { part: Extract<Part, { type: "tool" }>; onAnswer: (approved: boolean) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const running = part.result === undefined;
  if (part.approval) return <ApprovalCard part={part} approval={part.approval} onAnswer={onAnswer} />;
  return (
    <div className="rounded-md border bg-muted/40 text-xs">
      <button className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-muted-foreground" onClick={() => setOpen(!open)}>
        <HugeiconsIcon icon={running ? Loading03Icon : part.isError ? Alert02Icon : Wrench01Icon} className={cn("size-3.5 shrink-0", running && "animate-spin", part.isError && "text-destructive")} />
        <span className="flex-1 truncate">{TOOL_LABEL[part.name] ?? part.name}</span>
        <HugeiconsIcon icon={open ? ArrowDown01Icon : ArrowRight01Icon} className="size-3" />
      </button>
      {open && (
        <div className="space-y-1 border-t px-2 py-1.5 font-mono text-[10.5px] break-all whitespace-pre-wrap">
          <div className="text-muted-foreground">
            {part.name} {JSON.stringify(part.input)}
          </div>
          {part.result !== undefined && <div className={cn(part.isError && "text-destructive")}>{part.result}</div>}
        </div>
      )}
    </div>
  );
}

/** An action the assistant wants to take: what exactly it will do, and the developer's answer. */
function ApprovalCard({ part, approval, onAnswer }: { part: Extract<Part, { type: "tool" }>; approval: Approval; onAnswer: (approved: boolean) => Promise<void> }) {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = approval.state === "pending";
  const ran = approval.state === "approved" && part.result !== undefined;
  const answer = async (approved: boolean) => {
    setSending(true);
    setError(null);
    try {
      await onAnswer(approved);
    } catch (e) {
      setError((e as Error).message);
      setSending(false);
    }
  };
  return (
    <div className={cn("rounded-lg border text-sm", pending ? "border-primary/50 bg-primary/5" : "bg-muted/30")}>
      <div className="space-y-1.5 px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="flex-1 font-medium">{approval.title}</span>
          {!pending && (
            <span className={cn("flex items-center gap-1 text-xs", approval.state === "declined" ? "text-muted-foreground" : part.isError ? "text-destructive" : "text-success")}>
              <HugeiconsIcon
                icon={approval.state === "declined" ? Cancel01Icon : !ran ? Loading03Icon : part.isError ? Alert02Icon : CheckmarkCircle02Icon}
                className={cn("size-3.5", approval.state === "approved" && !ran && "animate-spin")}
              />
              {approval.state === "declined" ? "Declined" : !ran ? "Running" : part.isError ? "Failed" : "Done"}
            </span>
          )}
        </div>
        <ul className="list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
          {approval.details.map((d, i) => (
            <li key={i}>{d}</li>
          ))}
        </ul>
        {ran && <p className={cn("text-xs whitespace-pre-wrap", part.isError && "text-destructive")}>{part.result}</p>}
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
      {pending && (
        <div className="flex justify-end gap-2 border-t px-3 py-2">
          <Button size="sm" variant="ghost" disabled={sending} onClick={() => void answer(false)}>
            Decline
          </Button>
          <Button size="sm" disabled={sending} onClick={() => void answer(true)}>
            Approve
          </Button>
        </div>
      )}
    </div>
  );
}

/** The assistant panel: conversations about the open app, with fledge's tools. */
export function Assistant({ app, onClose }: { app: string | null; onClose: () => void }) {
  const [conversations, setConversations] = useState<{ id: string; title: string }[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [model, setModel] = useState<string | null>(null);
  const [hasProvider, setHasProvider] = useState<boolean | null>(null);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const busy = items.some((i) => i.kind === "assistant" && i.busy);

  const loadProviders = useCallback(() => {
    void aiApi.providers().then((p) => {
      setHasProvider(p.providers.length > 0);
      const active = p.providers.find((x) => x.id === p.active);
      setModel(active ? `${active.name}${active.model ? ` · ${active.model}` : ""}` : null);
    });
  }, []);
  useEffect(loadProviders, [loadProviders]);
  useEffect(() => {
    void aiApi.conversations().then((list) => {
      setConversations(list);
      if (list[0]) setCurrent((c) => c ?? list[0].id);
    });
  }, []);
  useEffect(() => {
    if (!current) {
      setItems([]);
      return;
    }
    void aiApi.conversation(current).then((c) => setItems(toItems(c.messages, c.pending)));
  }, [current]);
  // A block body: scrollIntoView returns a Promise in newer browsers, which React would take as the cleanup.
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [items]);

  useAssistantEvents(current, (e: AiEvent) =>
    setItems((prev) => {
      const next = [...prev];
      let reply = next[next.length - 1];
      if (reply?.kind !== "assistant") next.push((reply = { kind: "assistant", parts: [], notes: [], busy: true }));
      const r = { ...reply, parts: [...reply.parts], notes: [...reply.notes] };
      next[next.length - 1] = r;
      if (e.type === "start") setModel(`${e.provider}${e.model !== "default" ? ` · ${e.model}` : ""}`);
      else if (e.type === "text") {
        const last = r.parts[r.parts.length - 1];
        if (last?.type === "text") r.parts[r.parts.length - 1] = { ...last, text: last.text + e.delta };
        else r.parts.push({ type: "text", text: e.delta });
      } else if (e.type === "tool") r.parts.push({ type: "tool", id: e.id, name: e.name, input: e.input });
      else if (e.type === "tool_result" || e.type === "approval" || e.type === "approval_result") {
        const i = r.parts.findIndex((p) => p.type === "tool" && p.id === e.id);
        if (i >= 0) {
          const part = r.parts[i] as Extract<Part, { type: "tool" }>;
          r.parts[i] =
            e.type === "tool_result"
              ? { ...part, result: e.preview, isError: e.isError }
              : e.type === "approval"
                ? { ...part, approval: { title: e.title, details: e.details, state: "pending" } }
                : { ...part, approval: part.approval && { ...part.approval, state: e.approved ? "approved" : "declined" } };
        }
      } else if (e.type === "note") r.notes.push(e.text);
      else if (e.type === "error") {
        r.notes.push(e.message);
        r.busy = false;
      } else if (e.type === "done") r.busy = false;
      return next;
    }),
  );

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    setError(null);
    let id = current;
    if (!id) {
      id = (await aiApi.newConversation(app)).id;
      setConversations((c) => [{ id: id!, title: text.slice(0, 60) }, ...c]);
      setCurrent(id);
    }
    setItems((prev) => [...prev, { kind: "user", text }, { kind: "assistant", parts: [], notes: [], busy: true }]);
    setInput("");
    try {
      await aiApi.send(id, text);
    } catch (e) {
      setError((e as Error).message);
      setItems((prev) => prev.slice(0, -1));
    }
  }

  return (
    // A chat window rising from the mascot in the corner.
    <aside className="fixed right-4 bottom-24 z-40 flex h-[min(680px,calc(100svh-7.5rem))] w-[calc(100vw-2rem)] origin-bottom-right animate-in flex-col overflow-hidden rounded-xl border bg-background shadow-2xl duration-150 fade-in-0 zoom-in-95 sm:w-[440px]">
      <div className="flex items-center gap-1.5 border-b px-3 py-2.5">
        <MascotBird className="size-6" />
        <span className="text-sm font-semibold">Assistant</span>
        <Select value={current ?? undefined} onValueChange={setCurrent}>
          <SelectTrigger className="ml-2 h-8 min-w-0 flex-1 text-xs" aria-label="Conversation">
            <SelectValue placeholder="New conversation" />
          </SelectTrigger>
          <SelectContent>
            {conversations.map((c) => (
              <SelectItem key={c.id} value={c.id} className="text-xs">
                {c.title}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" className="size-8" aria-label="New conversation" onClick={() => (setCurrent(null), setItems([]))}>
              <HugeiconsIcon icon={Add01Icon} className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>New conversation</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" className="size-8" aria-label="Assistant settings" onClick={() => setSettings(true)}>
              <HugeiconsIcon icon={Settings02Icon} className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Models</TooltipContent>
        </Tooltip>
        <Button variant="ghost" size="icon" className="size-8" aria-label="Close assistant" onClick={onClose}>
          <HugeiconsIcon icon={Cancel01Icon} className="size-4" />
        </Button>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4 text-sm">
        {hasProvider === false ? (
          <div className="space-y-3 rounded-lg border p-4">
            <p className="font-medium">Set up a model first</p>
            <p className="text-muted-foreground">
              The assistant works with Claude (your claude CLI login or an API key), OpenAI, Gemini, Ollama on this Mac,
              or any OpenAI-compatible service.
            </p>
            <Button size="sm" onClick={() => setSettings(true)}>
              Add a model
            </Button>
          </div>
        ) : items.length === 0 ? (
          <div className="space-y-2 text-muted-foreground">
            <p>Ask about {app ?? "your apps"}: builds, logs, branches, releases, tickets, devices.</p>
            <ul className="list-disc space-y-1 pl-5 text-xs">
              <li>Why did the last iOS build fail?</li>
              <li>What's merged since the last release, and which tickets aren't ready for test?</li>
              <li>Which branches changed this week?</li>
            </ul>
            <p className="text-xs">It can also create and push branches, queue and install builds, publish releases and update Jira. Each action waits for your approval here.</p>
          </div>
        ) : (
          items.map((item, i) =>
            item.kind === "user" ? (
              <div key={i} className="ml-8 rounded-lg bg-primary px-3 py-2 whitespace-pre-wrap text-primary-foreground">
                {item.text}
              </div>
            ) : (
              <div key={i} className="mr-4 space-y-2">
                {item.parts.map((p, j) => (p.type === "text" ? <Formatted key={j} text={p.text} /> : <ToolChip key={j} part={p} onAnswer={(approved) => aiApi.answer(current!, p.id, approved).then(() => {})} />))}
                {item.busy && !item.parts.some((p) => p.type === "tool" && p.approval?.state === "pending") && (
                  <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <HugeiconsIcon icon={Loading03Icon} className="size-3.5 animate-spin" />
                    Working…
                  </p>
                )}
                {item.notes.map((n, j) => (
                  <p key={j} className="flex items-start gap-1.5 text-xs text-warning">
                    <HugeiconsIcon icon={Alert02Icon} className="mt-px size-3.5 shrink-0" />
                    {n}
                  </p>
                ))}
              </div>
            ),
          )
        )}
        <div ref={bottom} />
      </div>

      <div className="space-y-1.5 border-t p-3">
        {error && <p className="text-xs text-destructive">{error}</p>}
        <div className="flex items-end gap-2">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder={hasProvider === false ? "Add a model to start" : "Ask about builds, branches, releases…"}
            disabled={hasProvider === false}
            className="max-h-40 min-h-10 resize-none text-sm"
            rows={2}
          />
          <Button size="icon" aria-label="Send" disabled={!input.trim() || busy || hasProvider === false} onClick={() => void send()}>
            <HugeiconsIcon icon={busy ? Loading03Icon : SentIcon} className={cn("size-4", busy && "animate-spin")} />
          </Button>
        </div>
        <p className="truncate text-[11px] text-muted-foreground">{model ? `Using ${model}` : "No model selected"} · Enter to send</p>
      </div>

      <AssistantSettings open={settings} onOpenChange={setSettings} onChanged={loadProviders} />
    </aside>
  );
}
