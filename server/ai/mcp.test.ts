import assert from "node:assert/strict";
import { test } from "node:test";
import { answerApproval, pendingApprovals, type AgentEvent } from "./agent.ts";
import { MCP_CONVERSATION, mcpServer, type McpReply } from "./mcp.ts";
import type { ToolContext } from "./tools.ts";

let cancelled: string[] = [];
const ctx = {
  apps: async () => [{ id: "demo", name: "demo", root: "/tmp/demo", ready: true, source: "local", error: null }],
  builds: () => [{ id: "run1", project: "demo", flavor: "staging", mode: "release", platform: "android", artifact: "apk", status: "running", branch: "main", sha: "abcdef12", checkout: "/tmp/demo", command: "x", createdAt: 1, startedAt: Date.now() }],
  cancelBuild: (id: string) => void cancelled.push(id),
} as unknown as ToolContext;

const events: AgentEvent[] = [];
const server = mcpServer(ctx, (e) => events.push(e), { version: "9.9.9", page: "http://localhost:1" });
const live = () => new AbortController().signal;
const rpc = (id: number, method: string, params?: unknown) => ({ jsonrpc: "2.0", id, method, params });
const result = (r: McpReply) => (r.body as { result: Record<string, unknown> }).result;

async function session(name = "Test client") {
  const r = await server.handle(rpc(1, "initialize", { protocolVersion: "2025-06-18", clientInfo: { name } }), undefined, live());
  assert.equal(result(r).protocolVersion, "2025-06-18");
  assert.ok(r.session);
  return r.session!;
}

test("initialize starts a session and names fledge; unknown sessions must start again", async () => {
  const r = await server.handle(rpc(1, "initialize", { protocolVersion: "1999-01-01" }), undefined, live());
  assert.equal(result(r).protocolVersion, "2025-11-25");
  assert.deepEqual(result(r).serverInfo, { name: "fledge", version: "9.9.9" });
  assert.equal((await server.handle(rpc(2, "ping"), "no-such-session", live())).status, 404);
  assert.equal((await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" }, r.session, live())).status, 202);
  assert.equal((await server.handle([rpc(3, "ping")], r.session, live())).status, 400);
  assert.equal((await server.handle("nonsense", r.session, live())).status, 400);
  const unknown = await server.handle(rpc(4, "resources/list"), r.session, live());
  assert.equal((unknown.body as { error: { code: number } }).error.code, -32601);
});

test("tools/list marks lookups read-only and actions not", async () => {
  const s = await session();
  const tools = result(await server.handle(rpc(2, "tools/list"), s, live())).tools as { name: string; inputSchema: { type: string }; annotations: { readOnlyHint: boolean } }[];
  assert.equal(tools.find((t) => t.name === "list_builds")?.annotations.readOnlyHint, true);
  assert.equal(tools.find((t) => t.name === "publish_release")?.annotations.readOnlyHint, false);
  assert.ok(tools.every((t) => t.inputSchema.type === "object"));
});

test("a lookup answers straight away; bad input is a tool error the client can read", async () => {
  const s = await session();
  const ok = result(await server.handle(rpc(2, "tools/call", { name: "list_apps", arguments: {} }), s, live()));
  assert.equal(ok.isError, false);
  assert.match((ok.content as { text: string }[])[0].text, /"demo"/);
  const bad = result(await server.handle(rpc(3, "tools/call", { name: "list_builds", arguments: { limit: "all" } }), s, live()));
  assert.equal(bad.isError, true);
});

test("an action waits for the page, which sees who asked", async () => {
  cancelled = [];
  const s = await session("Claude Code");
  const call = server.handle(rpc(2, "tools/call", { name: "cancel_build", arguments: { build_id: "run1" } }), s, live());
  while (!pendingApprovals(MCP_CONVERSATION).length) await new Promise((r) => setTimeout(r, 5));
  const [waiting] = pendingApprovals(MCP_CONVERSATION);
  assert.equal(waiting.details[0], "Asked by Claude Code");
  assert.deepEqual(cancelled, [], "nothing before the answer");
  assert.ok(answerApproval(MCP_CONVERSATION, waiting.id, true));
  const r = result(await call);
  assert.equal(r.isError, false);
  assert.deepEqual(cancelled, ["run1"]);
  assert.ok(events.some((e) => e.type === "approval_result" && e.approved));
});

test("a client that hangs up withdraws its action", async () => {
  cancelled = [];
  const s = await session();
  const hangUp = new AbortController();
  const call = server.handle(rpc(2, "tools/call", { name: "cancel_build", arguments: { build_id: "run1" } }), s, hangUp.signal);
  while (!pendingApprovals(MCP_CONVERSATION).length) await new Promise((r) => setTimeout(r, 5));
  hangUp.abort();
  const r = result(await call);
  assert.equal(r.isError, true);
  assert.equal(pendingApprovals(MCP_CONVERSATION).length, 0);
  assert.deepEqual(cancelled, []);
});
