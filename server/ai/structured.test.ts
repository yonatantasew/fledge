import assert from "node:assert/strict";
import { test } from "node:test";
import { structuredAnswer } from "./structured.ts";
import type { Connector, ToolDef, TurnResult } from "./types.ts";

const tool: ToolDef = {
  name: "submit",
  description: "Hand in the answer.",
  schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
};
const scripted = (turns: TurnResult[]): Connector => ({ turn: async () => turns.shift()! });

test("a structured answer is the tool call's input", async () => {
  const c = scripted([{ text: "", toolCalls: [{ id: "1", name: "submit", input: { text: "hi" } }], stop: "tools" }]);
  assert.deepEqual(await structuredAnswer(c, { system: "s", prompt: "p", tool }), { text: "hi" });
});

test("a reply in prose, or an invalid answer, gets one more try", async () => {
  const prose = scripted([
    { text: "Here you go: hi", toolCalls: [], stop: "end" },
    { text: "", toolCalls: [{ id: "2", name: "submit", input: { text: "hi" } }], stop: "tools" },
  ]);
  assert.deepEqual(await structuredAnswer(prose, { system: "s", prompt: "p", tool }), { text: "hi" });
  const invalid = scripted([
    { text: "", toolCalls: [{ id: "1", name: "submit", input: { text: 1 } }], stop: "tools" },
    { text: "", toolCalls: [{ id: "2", name: "submit", input: { words: "hi" } }], stop: "tools" },
  ]);
  await assert.rejects(structuredAnswer(invalid, { system: "s", prompt: "p", tool }), /didn't answer with submit/);
});

test("a refusal is an error, not an empty answer", async () => {
  const c = scripted([{ text: "", toolCalls: [], stop: "refusal", detail: "policy" }]);
  await assert.rejects(structuredAnswer(c, { system: "s", prompt: "p", tool }), /declined \(policy\)/);
});
