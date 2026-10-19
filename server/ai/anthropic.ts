// Anthropic Messages API connector (official SDK). One call per turn; the tool
// loop and approvals live in agent.ts so every provider behaves the same.

import Anthropic from "@anthropic-ai/sdk";
import type { AiMessage, Connector, ToolCall, ToolDef, TurnRequest, TurnResult } from "./types.ts";

export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5-5";

// Models that take the server-side refusal fallback ("default" routing).
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5"]);

export interface AnthropicSettings {
  apiKey?: string; // unset: the SDK's own lookup (ANTHROPIC_API_KEY, `ant auth login` profile)
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  fallbacks: boolean;
}

export function toParams(messages: AiMessage[], model: string): Anthropic.Beta.BetaMessageParam[] {
  return messages.map((m): Anthropic.Beta.BetaMessageParam => {
    if (m.role === "user") return { role: "user", content: m.text };
    if (m.role === "tool") {
      return {
        role: "user",
        content: m.results.map((r) => ({ type: "tool_result" as const, tool_use_id: r.id, content: r.content, is_error: r.isError })),
      };
    }
    // Replay Claude's own reply unchanged (thinking blocks included); rebuild
    // only turns that another provider or model wrote.
    if (m.raw?.provider === "anthropic" && m.raw.model === model) {
      return { role: "assistant", content: m.raw.content as Anthropic.Beta.BetaContentBlockParam[] };
    }
    return {
      role: "assistant",
      content: [
        ...(m.text ? [{ type: "text" as const, text: m.text }] : []),
        ...m.toolCalls.map((c) => ({ type: "tool_use" as const, id: c.id, name: c.name, input: c.input })),
      ],
    };
  });
}

function toTools(tools: ToolDef[]): Anthropic.Beta.BetaTool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.schema,
    // Streams tool inputs as generated; agent.ts validates every input before running it.
    eager_input_streaming: true,
  }));
}

export function anthropicConnector(s: AnthropicSettings): Connector {
  const client = s.apiKey ? new Anthropic({ apiKey: s.apiKey }) : new Anthropic();
  const fallbacks = s.fallbacks && FALLBACK_MODELS.has(s.model);

  return {
    async turn(req: TurnRequest): Promise<TurnResult> {
      let message: Anthropic.Beta.BetaMessage | null = null;
      for (let attempt = 0; attempt < 3 && !message; attempt++) {
        const stream = client.beta.messages.stream(
          {
            model: s.model,
            max_tokens: 32000,
            system: req.system,
            messages: toParams(req.messages, s.model),
            tools: toTools(req.tools),
            output_config: { effort: s.effort },
            ...(fallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
          },
          { signal: req.signal },
        );
        stream.on("text", (delta) => req.onText(delta));
        try {
          message = await stream.finalMessage();
        } catch (err) {
          // Only an unparseable streamed tool input is retried; API errors go up.
          if (err instanceof Anthropic.APIError || attempt === 2) throw err;
        }
      }
      const m = message!;
      const text = m.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
      const toolCalls: ToolCall[] = m.content.flatMap((b) =>
        b.type === "tool_use" ? [{ id: b.id, name: b.name, input: (b.input ?? {}) as Record<string, unknown> }] : [],
      );
      const raw = { provider: "anthropic", model: s.model, content: m.content };

      if (m.stop_reason === "refusal") {
        return { text, toolCalls: [], stop: "refusal", detail: m.stop_details?.category ?? undefined, raw };
      }
      // A tool input cut off at max_tokens can still parse; never run it.
      if (m.stop_reason === "max_tokens") return { text, toolCalls: [], stop: "max_tokens", raw };
      return { text, toolCalls, stop: toolCalls.length ? "tools" : "end", raw };
    },
  };
}

/** Model IDs the key can use, for the settings picker. */
export async function listAnthropicModels(apiKey?: string): Promise<string[]> {
  const client = apiKey ? new Anthropic({ apiKey }) : new Anthropic();
  const ids: string[] = [];
  for await (const m of client.models.list()) ids.push(m.id);
  return ids;
}
