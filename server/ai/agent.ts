// The assistant's loop, the same for every provider: send the conversation and
// tools, stream the reply, run the tools it asks for, send the results back,
// repeat until it answers. Conversations live in memory for this phase.

import { connectorFor } from "./providers.ts";
import { runTool, toolDefs, type ToolContext } from "./tools.ts";
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
  | { type: "note"; text: string }
  | { type: "done" }
  | { type: "error"; message: string };

const conversations = new Map<string, Conversation>();

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
    "For now you can only read. When asked to change something (create a branch, start a build, publish a release), say exactly what you would do and that actions arrive in a later version of fledge.",
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
        const res = await runTool(call.name, call.input, ctx);
        results.push({ id: call.id, name: call.name, content: res.content, isError: res.isError });
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
