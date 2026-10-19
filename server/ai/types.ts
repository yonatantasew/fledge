// The assistant's provider-neutral pieces: a conversation every connector can
// continue, and the shape each connector turn returns.

/** A tool the assistant can call: fledge's own functions, not shell access. */
export interface ToolDef {
  name: string;
  description: string;
  schema: { type: "object"; properties: Record<string, unknown>; required?: string[]; additionalProperties?: boolean };
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  id: string;
  name: string;
  content: string;
  isError?: boolean;
}

export type AiMessage =
  | { role: "user"; text: string }
  | {
      role: "assistant";
      text: string;
      toolCalls: ToolCall[];
      // The provider's own reply, replayed unchanged when the same provider and
      // model continue the conversation (Claude's thinking blocks must not be
      // edited or dropped between turns).
      raw?: { provider: string; model: string; content: unknown };
    }
  | { role: "tool"; results: ToolResult[] };

export interface TurnRequest {
  system: string;
  messages: AiMessage[];
  tools: ToolDef[];
  onText: (delta: string) => void;
  signal?: AbortSignal;
}

export interface TurnResult {
  text: string;
  toolCalls: ToolCall[];
  stop: "end" | "tools" | "refusal" | "max_tokens";
  detail?: string; // e.g. the refusal category
  raw?: { provider: string; model: string; content: unknown };
}

export interface Connector {
  /** One model call: text so far is streamed through onText where the provider supports it. */
  turn(req: TurnRequest): Promise<TurnResult>;
}
