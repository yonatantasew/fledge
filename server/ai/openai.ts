// OpenAI-compatible chat completions with function calling. One connector for
// OpenAI, Google Gemini, Ollama, OpenRouter, Groq and LM Studio: they differ
// only in base URL, key and model name (see PRESETS in providers.ts).

import type { AiMessage, Connector, ToolCall, ToolDef, TurnRequest, TurnResult } from "./types.ts";

export interface OpenAiSettings {
  baseUrl: string; // e.g. https://api.openai.com/v1
  apiKey?: string; // local servers (Ollama, LM Studio) don't need one
  model: string;
}

interface OaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

function toMessages(system: string, messages: AiMessage[]): OaMessage[] {
  const out: OaMessage[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "user") out.push({ role: "user", content: m.text });
    else if (m.role === "assistant") {
      out.push({
        role: "assistant",
        content: m.text || null,
        ...(m.toolCalls.length
          ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: JSON.stringify(c.input) } })) }
          : {}),
      });
    } else {
      for (const r of m.results) out.push({ role: "tool", tool_call_id: r.id, content: r.content });
    }
  }
  return out;
}

const url = (base: string, p: string) => `${base.replace(/\/+$/, "")}/${p}`;

async function call(s: OpenAiSettings, p: string, body?: unknown, signal?: AbortSignal) {
  const res = await fetch(url(s.baseUrl, p), {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json", ...(s.apiKey ? { authorization: `Bearer ${s.apiKey}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 400);
    try {
      const j = JSON.parse(text);
      msg = j.error?.message ?? j.message ?? msg;
    } catch {}
    throw new Error(`${res.status} from ${new URL(s.baseUrl).host}: ${msg}`);
  }
  return JSON.parse(text);
}

export function openAiConnector(s: OpenAiSettings): Connector {
  return {
    async turn(req: TurnRequest): Promise<TurnResult> {
      const data = await call(
        s,
        "chat/completions",
        {
          model: s.model,
          messages: toMessages(req.system, req.messages),
          tools: req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.schema } })),
        },
        req.signal,
      );
      const choice = data.choices?.[0];
      if (!choice) throw new Error("the model returned no answer");
      const msg = choice.message ?? {};
      const text: string = typeof msg.content === "string" ? msg.content : "";
      if (text) req.onText(text);
      const toolCalls: ToolCall[] = [];
      for (const [i, c] of (msg.tool_calls ?? []).entries()) {
        let input: Record<string, unknown> = {};
        try {
          input = c.function?.arguments ? JSON.parse(c.function.arguments) : {};
        } catch {
          input = { __unparseable: String(c.function?.arguments ?? "") }; // agent.ts reports it back as an error
        }
        toolCalls.push({ id: c.id || `call_${Date.now()}_${i}`, name: c.function?.name ?? "", input });
      }
      if (choice.finish_reason === "length") return { text, toolCalls: [], stop: "max_tokens" };
      if (choice.finish_reason === "content_filter") return { text, toolCalls: [], stop: "refusal", detail: "content_filter" };
      return { text, toolCalls, stop: toolCalls.length ? "tools" : "end" };
    },
  };
}

/** Model IDs the endpoint offers (GET /models), for the settings picker. */
export async function listOpenAiModels(s: Omit<OpenAiSettings, "model">): Promise<string[]> {
  const data = await call({ ...s, model: "" }, "models");
  return ((data.data ?? data.models ?? []) as { id?: string; name?: string }[]).map((m) => m.id ?? m.name ?? "").filter(Boolean).sort();
}
