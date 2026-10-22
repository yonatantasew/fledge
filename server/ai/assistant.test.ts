import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { send, newConversation, type AgentEvent } from "./agent.ts";
import { toParams } from "./anthropic.ts";
import { openAiConnector } from "./openai.ts";
import { inputProblem, runTool, toolDefs, type ToolContext } from "./tools.ts";
import type { AiMessage, Connector, TurnResult } from "./types.ts";

const ctx: ToolContext = {
  apps: async () => [{ id: "demo", name: "demo", root: "/tmp/demo", ready: true, source: "local", error: null }],
  app: async (id) => (id === "demo" ? { id, name: "demo", root: "/tmp/demo", source: "local", config: null } : null),
  checkouts: async () => [{ path: "/tmp/demo", branch: "main", sha: "abc12345", dirty: 0, version: "1.0.0+1" }],
  builds: () => [
    { id: "b1", project: "demo", flavor: "dev", mode: "debug", platform: "android", artifact: "apk", status: "failed", branch: "main", sha: "abc", checkout: "/tmp/demo", command: "flutter build apk", createdAt: 1 },
    { id: "b2", project: "other", flavor: "dev", mode: "debug", platform: "ios", artifact: "app", status: "succeeded", branch: "main", sha: "abc", checkout: "/x", command: "flutter build ios", createdAt: 2 },
  ],
  log: (id) => (id === "b1" ? "line 1\nerror: boom\nline 3" : undefined),
  devices: async () => [],
  releases: async () => [],
  changes: async () => ({}),
  plan: async () => ({ command: "flutter build apk --debug" }),
  prepareBuilds: async () => ({ builds: [], skipped: [], queue: () => [] }),
  cancelBuild: () => {},
  prepareResume: async () => {
    throw new Error("only a stopped or failed build can be resumed");
  },
  prepareInstall: async () => {
    throw new Error("no devices");
  },
  deployments: async () => [],
  prepareDeploy: async () => {
    throw new Error("this app has no deploy route");
  },
  prepareShip: async () => {
    throw new Error("this app has no Slack channel");
  },
  releaseDraft: async () => {
    throw new Error("releases aren't set up for this app");
  },
  publishRelease: async () => ({}),
};

test("every tool has a strict object schema the providers accept", () => {
  for (const t of toolDefs()) {
    assert.equal(t.schema.type, "object", t.name);
    assert.equal(t.schema.additionalProperties, false, t.name);
    assert.match(t.name, /^[a-z_]+$/);
  }
});

test("model-supplied inputs are checked before anything runs", async () => {
  const def = toolDefs().find((t) => t.name === "list_builds")!;
  assert.equal(inputProblem(def, {}), null);
  assert.match(inputProblem(def, { status: "exploded" })!, /one of/);
  assert.match(inputProblem(def, { limit: "5" })!, /whole number/);
  assert.match(inputProblem(def, { surprise: 1 })!, /unknown field/);
  assert.match((await runTool("rm_rf", {}, ctx)).content, /no tool/);
  assert.match((await runTool("app_overview", {}, ctx)).content, /missing "app"/);
  assert.match((await runTool("app_overview", { app: "nope" }, ctx)).content, /no app "nope"/);
  // A ref that tries to smuggle in a git option is refused before git runs.
  const ref = await runTool("git_log", { app: "demo", ref: "--output=/tmp/pwned" }, ctx);
  assert.ok(ref.isError && /valid branch/.test(ref.content));
  assert.ok((await runTool("jira_ticket", { key: "x; rm -rf /" }, ctx)).isError);
  assert.ok((await runTool("list_builds", { app: "demo", __unparseable: "{" } as Record<string, unknown>, ctx)).isError);
});

test("read tools filter and trim what they return", async () => {
  const builds = JSON.parse((await runTool("list_builds", { app: "demo" }, ctx)).content);
  assert.deepEqual(builds.map((b: { id: string }) => b.id), ["b1"]);
  assert.equal((await runTool("build_log", { build_id: "b1", contains: "ERROR" }, ctx)).content, "error: boom");
  assert.equal((await runTool("build_log", { build_id: "b1", tail: 1 }, ctx)).content, "line 3");
});

test("Anthropic: Claude's own replies are replayed unchanged; other providers' turns are rebuilt", () => {
  const raw = [{ type: "thinking", thinking: "", signature: "sig" }, { type: "text", text: "hi" }];
  const history: AiMessage[] = [
    { role: "user", text: "q" },
    { role: "assistant", text: "hi", toolCalls: [], raw: { provider: "anthropic", model: "claude-opus-5-5", content: raw } },
    { role: "assistant", text: "", toolCalls: [{ id: "call_1", name: "list_apps", input: {} }], raw: { provider: "openai", model: "x", content: {} } },
    { role: "tool", results: [{ id: "call_1", name: "list_apps", content: "[]" }] },
  ];
  const p = toParams(history, "claude-opus-5-5");
  assert.deepEqual(p[1].content, raw);
  assert.deepEqual(p[2].content, [{ type: "tool_use", id: "call_1", name: "list_apps", input: {} }]);
  assert.deepEqual(p[3], { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "[]", is_error: undefined }] });
  // A different Claude model doesn't get the old model's thinking blocks.
  assert.deepEqual(toParams(history, "claude-sonnet-5-5")[1].content, [{ type: "text", text: "hi" }]);
});

test("OpenAI-compatible: sends tools and tool results in the chat completions format and reads tool calls back", async () => {
  let body: { messages: { role: string; tool_call_id?: string; tool_calls?: unknown[] }[]; tools: { type: string; function: { name: string } }[]; model: string } | null = null;
  let auth: string | undefined;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      body = JSON.parse(raw);
      auth = req.headers.authorization;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ finish_reason: "tool_calls", message: { content: "", tool_calls: [{ id: "c9", type: "function", function: { name: "list_apps", arguments: "{}" } }] } }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  try {
    const conn = openAiConnector({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "k", model: "m" });
    const r = await conn.turn({
      system: "sys",
      tools: toolDefs().slice(0, 1),
      onText: () => {},
      messages: [
        { role: "user", text: "q" },
        { role: "assistant", text: "", toolCalls: [{ id: "c1", name: "list_apps", input: {} }] },
        { role: "tool", results: [{ id: "c1", name: "list_apps", content: "[]" }] },
      ],
    });
    assert.equal(r.stop, "tools");
    assert.deepEqual(r.toolCalls, [{ id: "c9", name: "list_apps", input: {} }]);
    assert.equal(auth, "Bearer k");
    assert.equal(body!.model, "m");
    assert.deepEqual(body!.messages.map((m) => m.role), ["system", "user", "assistant", "tool"]);
    assert.equal(body!.messages[3].tool_call_id, "c1");
    assert.equal(body!.tools[0].type, "function");
  } finally {
    server.close();
  }
});

test("the loop runs requested tools, sends results back, and stops on an answer", async () => {
  const turns: TurnResult[] = [
    { text: "", toolCalls: [{ id: "t1", name: "list_builds", input: { app: "demo", status: "failed" } }], stop: "tools" },
    { text: "Build b1 failed.", toolCalls: [], stop: "end" },
  ];
  const seen: number[] = [];
  const connector: Connector = {
    async turn(req) {
      seen.push(req.messages.length);
      const r = turns.shift()!;
      if (r.text) req.onText(r.text);
      return r;
    },
  };
  const events: AgentEvent[] = [];
  const c = newConversation("demo");
  await send(c, "what failed?", ctx, (e) => events.push(e), undefined, { connector, provider: { name: "fake", model: "m" } });
  assert.deepEqual(seen, [1, 3]); // second call carries the assistant turn and the tool results
  assert.deepEqual(events.map((e) => e.type), ["start", "tool", "tool_result", "text", "done"]);
  assert.equal(c.messages.length, 4);
  assert.equal(c.busy, false);
});

test("a refusal ends the turn with a note instead of running tools", async () => {
  const connector: Connector = { turn: async () => ({ text: "", toolCalls: [{ id: "x", name: "list_apps", input: {} }], stop: "refusal", detail: "cyber" }) };
  const events: AgentEvent[] = [];
  await send(newConversation(null), "q", ctx, (e) => events.push(e), undefined, { connector, provider: { name: "f", model: "m" } });
  assert.ok(events.some((e) => e.type === "note" && /declined.*cyber/.test(e.text)));
  assert.ok(!events.some((e) => e.type === "tool"));
});
