// fledge's tools for other agents (Claude Code, Cursor, …) over the Model
// Context Protocol: Streamable HTTP at /mcp, answered with plain JSON (no
// server-sent stream). Lookups answer straight away. An action waits for the
// developer to approve it in fledge's page, exactly as in the assistant, so a
// client can't act on its own; it gets a declined result after ten minutes
// without an answer, or as soon as it hangs up.

import { randomUUID } from "node:crypto";
import { answerApproval, requestApproval, type AgentEvent } from "./agent.ts";
import { isAction, runTool, toolDefs, type ToolContext } from "./tools.ts";

const VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
const WAIT_MS = 10 * 60_000;
export const MCP_CONVERSATION = "mcp";

type Rpc = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
export type McpReply = { status: number; body?: unknown; session?: string };

export function mcpServer(ctx: ToolContext, emit: (e: AgentEvent) => void, info: { version: string; page: string }) {
  const sessions = new Map<string, string>(); // session id → client name

  const result = (id: unknown, r: unknown): McpReply => ({ status: 200, body: { jsonrpc: "2.0", id, result: r } });
  const error = (id: unknown, code: number, message: string, status = 200): McpReply => ({ status, body: { jsonrpc: "2.0", id: id ?? null, error: { code, message } } });

  async function callTool(name: string, args: Record<string, unknown>, client: string, gone: AbortSignal) {
    const res = await runTool(name, args, ctx, (approval) => {
      const id = `mcp-${randomUUID()}`;
      const decline = () => answerApproval(MCP_CONVERSATION, id, false);
      const timer = setTimeout(decline, WAIT_MS);
      gone.addEventListener("abort", decline, { once: true });
      return requestApproval(MCP_CONVERSATION, id, { title: approval.title, details: [`Asked by ${client}`, ...approval.details] }, emit).finally(() => {
        clearTimeout(timer);
        gone.removeEventListener("abort", decline);
      });
    });
    return { content: [{ type: "text", text: res.content }], isError: res.isError };
  }

  return {
    /** One JSON-RPC message. `gone` aborts when the client hangs up. */
    async handle(msg: unknown, session: string | undefined, gone: AbortSignal): Promise<McpReply> {
      // One message per request: batches left the protocol in 2025-06-18.
      if (!msg || typeof msg !== "object" || Array.isArray(msg) || (msg as Rpc).jsonrpc !== "2.0") return error(null, -32600, "not a JSON-RPC 2.0 message", 400);
      const m = msg as Rpc;
      if (typeof m.method !== "string") return { status: 202 }; // a response from the client; fledge never asks it anything
      if (m.id === undefined) return { status: 202 }; // notifications need no answer
      const params = (m.params ?? {}) as Record<string, unknown>;

      if (m.method === "initialize") {
        const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
        const id = randomUUID();
        const client = (params.clientInfo as { name?: unknown } | undefined)?.name;
        sessions.set(id, typeof client === "string" && client ? client.slice(0, 60) : "an MCP client");
        return {
          ...result(m.id, {
            protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0],
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "fledge", version: info.version },
            instructions: `fledge builds, installs and releases the Flutter apps on this Mac. Look things up freely. Every action (branches, pushes, builds, installs, releases, Jira) waits for the developer to approve it in fledge's page at ${info.page}; tell them it's waiting there. A declined action must not be retried.`,
          }),
          session: id,
        };
      }
      // A session fledge doesn't know (it restarted): the client starts a new one.
      if (session !== undefined && !sessions.has(session)) return error(m.id, -32001, "unknown session; initialize again", 404);
      const client = (session && sessions.get(session)) || "an MCP client";

      if (m.method === "ping") return result(m.id, {});
      if (m.method === "tools/list") {
        return result(m.id, {
          tools: toolDefs().map((d) => ({
            name: d.name,
            description: d.description,
            inputSchema: d.schema,
            annotations: isAction(d.name) ? { readOnlyHint: false, openWorldHint: true } : { readOnlyHint: true },
          })),
        });
      }
      if (m.method === "tools/call") {
        if (typeof params.name !== "string") return error(m.id, -32602, "name is required");
        const args = params.arguments ?? {};
        if (typeof args !== "object" || Array.isArray(args)) return error(m.id, -32602, "arguments must be an object");
        return result(m.id, await callTool(params.name, args as Record<string, unknown>, client, gone));
      }
      return error(m.id, -32601, `fledge doesn't support ${m.method}`);
    },
    end(session: string) {
      return sessions.delete(session);
    },
  };
}
