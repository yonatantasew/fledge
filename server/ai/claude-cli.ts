// The `claude` CLI (Claude Code) as a model, using the login already on this
// Mac. It can't call fledge's tools natively, so each turn is one `claude -p`
// with the conversation and the tool list, answering in a fixed JSON shape:
// either a reply, or the tool calls it wants. It runs with no tools of its own,
// no MCP servers and no saved session.

import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { AiMessage, Connector, ToolCall, TurnRequest, TurnResult } from "./types.ts";

const run = promisify(execFile);

export interface ClaudeCliSettings {
  model?: string; // e.g. "opus", "sonnet", or a full model ID; empty: the CLI's default
}

const SCHEMA = {
  type: "object",
  properties: {
    reply: { type: "string", description: "Text for the user. May be empty when calling tools." },
    calls: {
      type: "array",
      description: "Tools to call now. Empty when you're done and answering.",
      items: {
        type: "object",
        properties: { name: { type: "string" }, input: { type: "object" } },
        required: ["name", "input"],
      },
    },
  },
  required: ["reply", "calls"],
};

function transcript(messages: AiMessage[]): string {
  return messages
    .map((m) => {
      if (m.role === "user") return `USER: ${m.text}`;
      if (m.role === "assistant") {
        const calls = m.toolCalls.map((c) => `CALL ${c.id} ${c.name} ${JSON.stringify(c.input)}`).join("\n");
        return `ASSISTANT: ${m.text}${calls ? `\n${calls}` : ""}`;
      }
      return m.results.map((r) => `RESULT ${r.id} ${r.name}${r.isError ? " (error)" : ""}: ${r.content}`).join("\n");
    })
    .join("\n\n");
}

export function claudeCliConnector(s: ClaudeCliSettings): Connector {
  return {
    async turn(req: TurnRequest): Promise<TurnResult> {
      const prompt = [
        req.system,
        "",
        "You can call these tools. To call any, list them in `calls` and leave the user waiting for the results; when you have what you need, answer in `reply` with `calls` empty.",
        JSON.stringify(req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema }))),
        "",
        "Conversation so far:",
        transcript(req.messages),
      ].join("\n");
      const dir = await mkdtemp(path.join(tmpdir(), "fledge-claude-"));
      try {
        const child = run(
          "claude",
          [
            "-p",
            "--output-format", "json",
            "--json-schema", JSON.stringify(SCHEMA),
            "--tools", "",
            "--no-session-persistence",
            "--strict-mcp-config",
            "--setting-sources", "",
            ...(s.model ? ["--model", s.model] : []),
          ],
          { cwd: dir, timeout: 300_000, maxBuffer: 16 << 20, signal: req.signal },
        );
        child.child.stdin!.end(prompt);
        const out = JSON.parse((await child).stdout) as {
          is_error?: boolean;
          result?: string;
          structured_output?: { reply?: string; calls?: { name?: string; input?: Record<string, unknown> }[] };
        };
        if (out.is_error || !out.structured_output) throw new Error(out.result ?? "claude returned nothing");
        const text = out.structured_output.reply ?? "";
        if (text) req.onText(text);
        const toolCalls: ToolCall[] = (out.structured_output.calls ?? []).map((c, i) => ({
          id: `call_${Date.now().toString(36)}_${i}`,
          name: c.name ?? "",
          input: c.input ?? {},
        }));
        return { text, toolCalls, stop: toolCalls.length ? "tools" : "end" };
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}
