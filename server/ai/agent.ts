// The assistant's loop, the same for every provider: send the conversation and
// tools, stream the reply, run the tools it asks for, send the results back,
// repeat until it answers. An action waits for the developer to approve it in
// the page; the model can't answer for them. Conversations live in memory.

import { connectorFor } from "./providers.ts";
import { runTool, toolDefs, type Approval, type ToolContext } from "./tools.ts";
import type { AiMessage, Connector, ToolResult } from "./types.ts";

const MAX_STEPS = 12;

export interface Conversation {
  id: string;
  app: string | null; // the app open in the UI when it started
  title: string;
  messages: AiMessage[];
  busy: boolean;
  createdAt: number;
  updatedAt: number;
}

export type AgentEvent =
  | { type: "start"; provider: string; model: string }
  | { type: "text"; delta: string }
  | { type: "tool"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; name: string; isError: boolean; preview: string }
  | { type: "approval"; id: string; title: string; details: string[] }
  | { type: "approval_result"; id: string; approved: boolean }
  | { type: "note"; text: string }
  | { type: "done" }
  | { type: "error"; message: string };

const conversations = new Map<string, Conversation>();
// Actions waiting for the developer, by tool call id.
const waiting = new Map<string, { conversation: string; approval: Approval; answer: (approved: boolean) => void }>();

/** The actions in a conversation still waiting for an answer, for a page that opens it mid-wait. */
export function pendingApprovals(conversation: string) {
  return [...waiting].filter(([, w]) => w.conversation === conversation).map(([id, w]) => ({ id, ...w.approval }));
}

/**
 * Shows an action to the developer and waits for the answer, reporting both
 * through emit. Used by conversations, and by MCP clients under "mcp".
 */
export function requestApproval(conversation: string, id: string, approval: Approval, emit: (e: AgentEvent) => void): Promise<boolean> {
  return new Promise<boolean>((answer) => {
    waiting.set(id, { conversation, approval, answer });
    emit({ type: "approval", id, ...approval });
  }).then((approved) => {
    emit({ type: "approval_result", id, approved });
    return approved;
  });
}

/** The developer's answer to an action; false if nothing was waiting for it. */
export function answerApproval(conversation: string, id: string, approved: boolean) {
  const w = waiting.get(id);
  if (!w || w.conversation !== conversation) return false;
  waiting.delete(id);
  w.answer(approved);
  return true;
}

export function listConversations() {
  return [...conversations.values()]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(({ id, app, title, busy, updatedAt }) => ({ id, app, title, busy, updatedAt }));
}

export function getConversation(id: string) {
  return conversations.get(id);
}

export function newConversation(app: string | null): Conversation {
  const c: Conversation = {
    id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    app,
    title: "New conversation",
    messages: [],
    busy: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  conversations.set(c.id, c);
  return c;
}

function system(app: string | null) {
  return [
    "You are the assistant inside fledge, a tool that builds, installs and releases Flutter apps on the developer's Mac.",
    `Today is ${new Date().toISOString().slice(0, 10)}.`,
    app ? `The app open in fledge is "${app}"; questions without an app are about it.` : "No app is open in fledge right now.",
    "Use the tools to look things up instead of guessing: builds and their logs, checkouts, git history, releases, tickets, devices, and the exact build commands from the app's config.",
    "You can also act: create a local branch, push a branch, queue builds, cancel or resume a build, install a build on a phone, ship a build to Slack, deploy (build and post with notes), publish a release, comment on or move a Jira ticket. Each action is shown to the developer, who approves or declines it, so call the tool directly instead of asking for permission in text. If one is declined, don't retry it; ask what they'd like instead.",
    "Branches stay local until the developer asks for them to be pushed. Name new branches like the repository's existing ones (check git_branches).",
    "For a release, read release_notes first. When asked to improve the notes, rewrite the item titles for testers (plain, specific, at most ~14 words, no ticket-key prefix), keep the template's structure and every SHA, PR number, version and date exactly, and show the result before publishing it.",
    "Answer briefly and concretely. Name builds, commits, branches and tickets by their ids so the developer can find them. If a tool fails, say what failed.",
  ].join("\n");
}

/** Runs one user message to the end, reporting progress through emit. */
export async function send(
  c: Conversation,
  text: string,
  ctx: ToolContext,
  emit: (e: AgentEvent) => void,
  providerId?: string,
  use?: { connector: Connector; provider: { name: string; model: string } }, // tests
) {
  if (c.busy) throw new Error("this conversation is still answering");
  c.busy = true;
  c.messages.push({ role: "user", text });
  if (c.title === "New conversation") c.title = text.slice(0, 60);
  c.updatedAt = Date.now();
  try {
    const { connector, provider } = use ?? (await connectorFor(providerId));
    emit({ type: "start", provider: provider.name, model: provider.model || "default" });
    for (let step = 0; step < MAX_STEPS; step++) {
      const r = await connector.turn({
        system: system(c.app),
        messages: c.messages,
        tools: toolDefs(),
        onText: (delta) => emit({ type: "text", delta }),
      });
      c.messages.push({ role: "assistant", text: r.text, toolCalls: r.toolCalls, raw: r.raw });
      if (r.stop === "refusal") {
        emit({ type: "note", text: `The model declined to answer${r.detail ? ` (${r.detail})` : ""}.` });
        break;
      }
      if (r.stop === "max_tokens") {
        emit({ type: "note", text: "The reply hit the length limit and was cut off." });
        break;
      }
      if (r.stop !== "tools") break;

      const results: ToolResult[] = [];
      for (const call of r.toolCalls) {
        emit({ type: "tool", id: call.id, name: call.name, input: call.input });
        const res = await runTool(call.name, call.input, ctx, (approval) => requestApproval(c.id, call.id, approval, emit));
        results.push({ id: call.id, name: call.name, content: res.content, isError: res.isError, approval: res.approval });
        emit({ type: "tool_result", id: call.id, name: call.name, isError: res.isError, preview: res.content.slice(0, 600) });
      }
      c.messages.push({ role: "tool", results });
      if (step === MAX_STEPS - 1) emit({ type: "note", text: `Stopped after ${MAX_STEPS} steps.` });
    }
    emit({ type: "done" });
  } catch (e) {
    emit({ type: "error", message: (e as Error).message });
  } finally {
    c.busy = false;
    c.updatedAt = Date.now();
  }
}
