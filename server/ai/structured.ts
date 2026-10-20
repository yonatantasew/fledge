// One structured answer from whichever model is set up: the model gets a
// single tool and answers by calling it, which every connector supports
// (Anthropic and OpenAI-compatible natively, the claude CLI through its
// emulation). The answer is checked against the schema like any tool input.

import { inputProblem } from "./tools.ts";
import type { AiMessage, Connector, ToolDef } from "./types.ts";

export async function structuredAnswer(connector: Connector, ask: { system: string; prompt: string; tool: ToolDef }): Promise<Record<string, unknown>> {
  const messages: AiMessage[] = [{ role: "user", text: ask.prompt }];
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await connector.turn({ system: ask.system, messages, tools: [ask.tool], onText: () => {} });
    if (r.stop === "refusal") throw new Error(`the model declined${r.detail ? ` (${r.detail})` : ""}`);
    if (r.stop === "max_tokens") throw new Error("the answer hit the model's length limit");
    const call = r.toolCalls.find((c) => c.name === ask.tool.name);
    const problem = call ? inputProblem(ask.tool, call.input) : `answer by calling ${ask.tool.name}`;
    if (call && !problem) return call.input;
    messages.push({ role: "assistant", text: r.text, toolCalls: r.toolCalls, raw: r.raw });
    if (r.toolCalls.length) {
      messages.push({ role: "tool", results: r.toolCalls.map((c) => ({ id: c.id, name: c.name, content: c === call ? `invalid: ${problem}` : `only ${ask.tool.name} is available`, isError: true })) });
    } else {
      messages.push({ role: "user", text: `Answer by calling ${ask.tool.name}.` });
    }
  }
  throw new Error(`the model didn't answer with ${ask.tool.name}`);
}
