// What the assistant can do: fledge's own functions, described for the model.
// Phase 1 is read-only. Model output is untrusted, so every input is checked
// against its schema here and then against fledge's own state (the app must
// exist, a checkout must be one of its worktrees, refs and ticket keys must be
// well-formed) before anything runs.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ToolDef } from "./types.ts";

const run = promisify(execFile);
const MAX_RESULT = 12_000;

/** What index.ts gives the tools: views of fledge's live state. */
export interface ToolContext {
  apps(): Promise<{ id: string; name: string; root: string; ready: boolean; source: string | null; error: string | null }[]>;
  app(id: string): Promise<{
    id: string;
    name: string;
    root: string;
    config: {
      flavors: { name: string; label: string; flavor: string | null; target?: string; confirm: boolean }[];
      toggles: { id: string; label: string }[];
      commands: unknown;
      release: unknown;
    } | null;
    source: string | null;
    error?: string;
  } | null>;
  checkouts(appId: string): Promise<{ path: string; branch: string; sha: string; dirty: number; version: string }[]>;
  builds(): { id: string; project?: string; flavor: string; mode: string; platform: string; artifact: string; status: string; branch: string; sha: string; checkout: string; command: string; error?: string; createdAt: number; startedAt?: number; endedAt?: number; verified?: Record<string, string>; install?: unknown }[];
  log(buildId: string): string | undefined;
  devices(): Promise<{ platform: string; name: string; detail: string; available: boolean }[]>;
  releases(appId: string): Promise<{ tag: string; prerelease: boolean; createdAt: string }[]>;
  changes(appId: string, since: string | null): Promise<unknown>;
  plan(appId: string, checkout: string | undefined, target: { platform: string; flavor: string; mode: string }, output?: string): Promise<unknown>;
}

interface Tool {
  def: ToolDef;
  run(input: Record<string, unknown>, ctx: ToolContext): Promise<unknown>;
}

const str = (description: string, extra: Record<string, unknown> = {}) => ({ type: "string", description, ...extra });
const num = (description: string) => ({ type: "integer", description });
const obj = (properties: Record<string, unknown>, required: string[] = []): ToolDef["schema"] => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const APP = str("The app's id, as list_apps returns it.");

async function needApp(ctx: ToolContext, id: unknown) {
  const app = typeof id === "string" ? await ctx.app(id) : null;
  if (!app) throw new Error(`no app "${String(id)}" — use list_apps for the ids`);
  return app;
}

async function needCheckout(ctx: ToolContext, appId: string, checkout: unknown) {
  const list = await ctx.checkouts(appId);
  if (checkout === undefined) return list[0];
  const c = list.find((x) => x.path === checkout || x.branch === checkout);
  if (!c) throw new Error(`"${String(checkout)}" isn't a checkout of this app — use list_checkouts`);
  return c;
}

const REF = /^[A-Za-z0-9._\/-]{1,200}$/;

const TOOLS: Tool[] = [
  {
    def: { name: "list_apps", description: "The Flutter apps fledge manages, with whether each has a usable config.", schema: obj({}) },
    run: (_i, ctx) => ctx.apps(),
  },
  {
    def: {
      name: "app_overview",
      description: "An app's environments (and their native flavors / entry files), the build commands from its config, its switches, and its release settings.",
      schema: obj({ app: APP }, ["app"]),
    },
    async run(i, ctx) {
      const a = await needApp(ctx, i.app);
      return { id: a.id, name: a.name, root: a.root, configSource: a.source, configError: a.error, config: a.config };
    },
  },
  {
    def: {
      name: "list_checkouts",
      description: "The app's git worktrees: path, branch, commit, uncommitted file count, pubspec version.",
      schema: obj({ app: APP }, ["app"]),
    },
    async run(i, ctx) {
      const a = await needApp(ctx, i.app);
      return ctx.checkouts(a.id);
    },
  },
  {
    def: {
      name: "list_builds",
      description: "Recent builds, newest first: environment, build type, platform, output, status, timing, read-back version, install state, and the exact command.",
      schema: obj({
        app: str("Only this app's builds (optional)."),
        status: str("Only builds with this status (optional).", { enum: ["queued", "running", "succeeded", "failed", "cancelled"] }),
        limit: num("How many (default 15, max 50)."),
      }),
    },
    async run(i, ctx) {
      const limit = Math.min(50, Math.max(1, Number(i.limit ?? 15)));
      return ctx
        .builds()
        .filter((b) => (!i.app || b.project === i.app) && (!i.status || b.status === i.status))
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, limit)
        .map((b) => ({
          id: b.id,
          app: b.project,
          environment: b.flavor,
          mode: b.mode,
          platform: b.platform,
          output: b.artifact,
          status: b.status,
          error: b.error,
          branch: b.branch,
          sha: b.sha,
          seconds: b.startedAt ? Math.round(((b.endedAt ?? Date.now()) - b.startedAt) / 1000) : null,
          version: b.verified?.version,
          install: b.install,
          command: b.command,
        }));
    },
  },
  {
    def: {
      name: "build_log",
      description: "A build's log: the last lines, or only lines containing some text (case-insensitive). Use it to explain failures.",
      schema: obj({ build_id: str("The build's id from list_builds."), tail: num("Last N lines (default 120, max 400)."), contains: str("Only lines containing this text.") }, ["build_id"]),
    },
    async run(i, ctx) {
      const log = ctx.log(String(i.build_id));
      if (log === undefined) throw new Error("no build with that id");
      let lines = log.split("\n");
      if (typeof i.contains === "string" && i.contains) lines = lines.filter((l) => l.toLowerCase().includes(String(i.contains).toLowerCase()));
      const tail = Math.min(400, Math.max(1, Number(i.tail ?? 120)));
      return lines.slice(-tail).join("\n");
    },
  },
  {
    def: { name: "list_devices", description: "Phones connected to this Mac (Android via adb, iPhones via devicectl) and whether each is ready.", schema: obj({}) },
    run: (_i, ctx) => ctx.devices(),
  },
  {
    def: {
      name: "git_log",
      description: "Recent commits on a checkout's branch or another ref: hash, date, author, subject.",
      schema: obj({ app: APP, checkout: str("A checkout path or branch (default: the main checkout)."), ref: str("A branch, tag or commit to read instead of HEAD."), limit: num("How many (default 20, max 100).") }, ["app"]),
    },
    async run(i, ctx) {
      const a = await needApp(ctx, i.app);
      const c = await needCheckout(ctx, a.id, i.checkout);
      if (i.ref !== undefined && (typeof i.ref !== "string" || !REF.test(i.ref) || i.ref.startsWith("-"))) throw new Error("that ref isn't a valid branch, tag or commit name");
      const limit = Math.min(100, Math.max(1, Number(i.limit ?? 20)));
      const { stdout } = await run("git", ["-C", c.path, "log", "-n", String(limit), "--date=short", "--format=%h %ad %an | %s", ...(i.ref ? [String(i.ref), "--"] : [])], { maxBuffer: 8 << 20 });
      return stdout.trim();
    },
  },
  {
    def: {
      name: "git_branches",
      description: "The app's local and remote branches, most recently updated first.",
      schema: obj({ app: APP, limit: num("How many (default 30, max 100).") }, ["app"]),
    },
    async run(i, ctx) {
      const a = await needApp(ctx, i.app);
      const limit = Math.min(100, Math.max(1, Number(i.limit ?? 30)));
      const { stdout } = await run("git", ["-C", a.root, "for-each-ref", "--sort=-committerdate", `--count=${limit}`, "--format=%(refname:short) %(committerdate:short) %(subject)", "refs/heads", "refs/remotes"], { maxBuffer: 8 << 20 });
      return stdout.trim();
    },
  },
  {
    def: { name: "list_releases", description: "The app's GitHub releases and pre-releases, newest first.", schema: obj({ app: APP }, ["app"]) },
    async run(i, ctx) {
      const a = await needApp(ctx, i.app);
      return ctx.releases(a.id);
    },
  },
  {
    def: {
      name: "changes_since_release",
      description: "Everything merged to the base branch since a release (default: the latest): PRs with authors and sizes, their tickets with live Jira status, and the suggested next version. Slow (about 20 seconds).",
      schema: obj({ app: APP, since: str("A release tag, e.g. v1.3.1+3 (default: the latest).") }, ["app"]),
    },
    async run(i, ctx) {
      const a = await needApp(ctx, i.app);
      if (i.since !== undefined && (typeof i.since !== "string" || !/^v[\w.+-]+$/.test(i.since))) throw new Error("since must be a tag like v1.3.1+3");
      return ctx.changes(a.id, (i.since as string | undefined) ?? null);
    },
  },
  {
    def: {
      name: "jira_ticket",
      description: "A Jira ticket's summary, status, assignee and description.",
      schema: obj({ key: str("The ticket key, e.g. PROJ-123.") }, ["key"]),
    },
    async run(i) {
      const key = String(i.key ?? "");
      if (!/^[A-Z][A-Z0-9]+-\d+$/.test(key)) throw new Error("not a ticket key like PROJ-123");
      const { stdout } = await run("acli", ["jira", "workitem", "view", key, "--fields", "summary,status,assignee,description", "--json"], { maxBuffer: 8 << 20, timeout: 60_000 });
      const t = JSON.parse(stdout) as { key: string; fields: { summary?: string; status?: { name?: string }; assignee?: { displayName?: string }; description?: unknown } };
      const text = (n: unknown): string =>
        !n || typeof n !== "object" ? "" : Array.isArray(n) ? n.map(text).join("") : "text" in n ? String((n as { text: unknown }).text) : "content" in n ? text((n as { content: unknown }).content) + "\n" : "";
      return { key: t.key, summary: t.fields.summary, status: t.fields.status?.name, assignee: t.fields.assignee?.displayName, description: text(t.fields.description).trim().slice(0, 4000) };
    },
  },
  {
    def: {
      name: "planned_command",
      description: "The exact command a build would run (from the app's config), without running it.",
      schema: obj(
        {
          app: APP,
          environment: str("The environment's name."),
          platform: str("android or ios.", { enum: ["android", "ios"] }),
          mode: str("Build type.", { enum: ["debug", "profile", "release"] }),
          output: str("apk / appbundle for Android, ipa / app / xcode for iOS (default apk / ipa).", { enum: ["apk", "appbundle", "ipa", "app", "xcode"] }),
          checkout: str("A checkout path or branch (default: the main checkout)."),
        },
        ["app", "environment", "platform", "mode"],
      ),
    },
    async run(i, ctx) {
      const a = await needApp(ctx, i.app);
      const c = await needCheckout(ctx, a.id, i.checkout);
      return ctx.plan(a.id, c.path, { platform: String(i.platform), flavor: String(i.environment), mode: String(i.mode) }, i.output as string | undefined);
    },
  },
];

export const toolDefs = (): ToolDef[] => TOOLS.map((t) => t.def);

/** Checks a model-supplied input against the tool's schema (types, enums, required, no extras). */
export function inputProblem(def: ToolDef, input: Record<string, unknown>): string | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "input must be an object";
  if ("__unparseable" in input) return "the tool input wasn't valid JSON";
  for (const r of def.schema.required ?? []) if (!(r in input)) return `missing "${r}"`;
  for (const [k, v] of Object.entries(input)) {
    const p = def.schema.properties[k] as { type?: string; enum?: string[] } | undefined;
    if (!p) return `unknown field "${k}"`;
    if (p.type === "string" && typeof v !== "string") return `"${k}" must be text`;
    if (p.type === "integer" && !Number.isInteger(v)) return `"${k}" must be a whole number`;
    if (p.enum && !p.enum.includes(v as string)) return `"${k}" must be one of ${p.enum.join(", ")}`;
  }
  return null;
}

/** Runs a tool call; failures come back as error results the model can read and correct. */
export async function runTool(name: string, input: Record<string, unknown>, ctx: ToolContext): Promise<{ content: string; isError: boolean }> {
  const tool = TOOLS.find((t) => t.def.name === name);
  if (!tool) return { content: `there's no tool called "${name}"`, isError: true };
  const problem = inputProblem(tool.def, input);
  if (problem) return { content: `invalid input for ${name}: ${problem}`, isError: true };
  try {
    const out = await tool.run(input, ctx);
    let content = typeof out === "string" ? out : JSON.stringify(out, null, 1);
    if (content.length > MAX_RESULT) content = `${content.slice(0, MAX_RESULT)}\n… (cut; ask for less, e.g. a smaller limit or tail)`;
    return { content: content || "(empty)", isError: false };
  } catch (e) {
    return { content: (e as Error).message.split("\n")[0], isError: true };
  }
}
