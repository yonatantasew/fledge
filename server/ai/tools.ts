// What the assistant can do: fledge's own functions, described for the model.
// Model output is untrusted, so every input is checked against its schema here
// and then against fledge's own state (the app must exist, a checkout must be
// one of its worktrees, refs and ticket keys must be well-formed) before
// anything runs. Lookups run straight away. Actions (branches, pushes, builds,
// installs) first say exactly what they will do, and run only once the
// developer approves that in the page.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ReleaseFacts } from "../notes.ts";
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
      deploy?: unknown;
    } | null;
    source: string | null;
    error?: string;
  } | null>;
  checkouts(appId: string): Promise<{ path: string; branch: string; sha: string; dirty: number; version: string }[]>;
  builds(): { id: string; project?: string; flavor: string; mode: string; platform: string; artifact: string; status: string; branch: string; sha: string; checkout: string; command: string; error?: string; createdAt: number; startedAt?: number; endedAt?: number; verified?: Record<string, string>; install?: unknown }[];
  log(buildId: string): string | undefined;
  devices(): Promise<{ platform: string; id: string; name: string; detail: string; available: boolean }[]>;
  releases(appId: string): Promise<{ tag: string; prerelease: boolean; createdAt: string }[]>;
  changes(appId: string, since: string | null): Promise<unknown>;
  plan(appId: string, checkout: string | undefined, target: { platform: string; flavor: string; mode: string }, output?: string): Promise<unknown>;
  /** Plans builds without queueing them; queue() queues exactly that plan. Throws when it can't be built. */
  prepareBuilds(
    appId: string,
    checkout: string,
    targets: { platform: string; flavor: string; mode: string }[],
    options: Record<string, unknown>,
  ): Promise<{
    builds: { flavor: string; label: string; confirm: boolean; mode: string; platform: string; artifact: string }[];
    skipped: string[];
    queue(): string[];
  }>;
  cancelBuild(id: string): void;
  /** Checks a stopped or failed build can run again unchanged; resume() queues it. Throws with the reason otherwise. */
  prepareResume(id: string): Promise<{ attempt: number; resume(): void }>;
  /** Checks a build can go on the device now; install() runs it and reports how it went. Throws otherwise. */
  prepareInstall(buildId: string, deviceId: string): Promise<{ device: string; install(opts: { launch: boolean; replace: boolean }): Promise<unknown> }>;
  /** The app's deployments, newest first. */
  deployments(appId: string): Promise<unknown[]>;
  /** What a deploy would do and post (notes since the last deploy); start() queues it. Throws when it can't. */
  prepareDeploy(
    appId: string,
    req: { route?: string; targets?: unknown; options?: unknown; channel?: string; checkout?: string },
  ): Promise<{ label: string; channel: string; version: string; branch: string; sha: string; since: string | null; notes: string; builds: { name: string; confirm: boolean }[]; start(notes: string): string }>;
  /** What shipping a build to Slack would post; ship() posts it. Throws when it can't be shipped. */
  prepareShip(buildId: string, note: string): Promise<{ channel: string; text: string; file: string; size: number; ship(): Promise<unknown> }>;
  /** The next release: its facts without the excluded PRs (and version bumps), and the template notes. Slow. */
  releaseDraft(
    appId: string,
    since: string | null,
    prerelease: boolean,
    exclude: number[],
  ): Promise<{ facts: ReleaseFacts; templates: { slack: string; github: string }; baseBranch: string; bumpBranch: string; jira: { from: string; to: string } | null }>;
  /** Cuts the release as the Release tab does; throws if one is already being published. */
  publishRelease(appId: string, req: { facts: ReleaseFacts; githubNotes: string; prerelease: boolean; updateJira: boolean; dryRun: boolean }): Promise<unknown>;
}

/** What an action will do, shown to the developer to approve or decline. */
export interface Approval {
  title: string;
  details: string[];
}

export type Approver = (a: Approval) => Promise<boolean>;

interface Lookup {
  def: ToolDef;
  run(input: Record<string, unknown>, ctx: ToolContext): Promise<unknown>;
}

interface Action {
  def: ToolDef;
  /** Checks the input and describes the action; nothing has changed yet. run() does it. */
  prepare(input: Record<string, unknown>, ctx: ToolContext): Promise<Approval & { run(): Promise<unknown> }>;
}

type Tool = Lookup | Action;

const str = (description: string, extra: Record<string, unknown> = {}) => ({ type: "string", description, ...extra });
const num = (description: string) => ({ type: "integer", description });
const bool = (description: string) => ({ type: "boolean", description });
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
const git = async (cwd: string, args: string[], timeout = 30_000) => (await run("git", ["-C", cwd, ...args], { maxBuffer: 8 << 20, timeout })).stdout.trim();
const gitOk = (cwd: string, args: string[]) => git(cwd, args).then(() => true, () => false);

/** A branch name git accepts, that can't be read as an option. */
async function needBranchName(cwd: string, name: unknown) {
  if (typeof name !== "string" || !REF.test(name) || name.startsWith("-") || !(await gitOk(cwd, ["check-ref-format", "--branch", name]))) {
    throw new Error(`"${String(name)}" isn't a valid branch name`);
  }
  return name;
}

const KEY = /^[A-Z][A-Z0-9]+-\d+$/;

async function jiraTicket(key: string) {
  if (!KEY.test(key)) throw new Error("not a ticket key like PROJ-123");
  const { stdout } = await run("acli", ["jira", "workitem", "view", key, "--fields", "summary,status,assignee,description", "--json"], { maxBuffer: 8 << 20, timeout: 60_000 });
  const t = JSON.parse(stdout) as { key: string; fields: { summary?: string; status?: { name?: string }; assignee?: { displayName?: string }; description?: unknown } };
  const text = (n: unknown): string =>
    !n || typeof n !== "object" ? "" : Array.isArray(n) ? n.map(text).join("") : "text" in n ? String((n as { text: unknown }).text) : "content" in n ? text((n as { content: unknown }).content) + "\n" : "";
  return { key: t.key, summary: t.fields.summary, status: t.fields.status?.name, assignee: t.fields.assignee?.displayName, description: text(t.fields.description).trim().slice(0, 4000) };
}

const commitLine = (cwd: string, ref: string) => git(cwd, ["log", "-1", "--format=%h %s", ref, "--"]);

function sinceTag(since: unknown) {
  if (since === undefined) return null;
  if (typeof since !== "string" || !/^v[\w.+-]+$/.test(since)) throw new Error("since must be a tag like v1.3.1+3");
  return since;
}

async function baseBranch(ctx: ToolContext, appId: string) {
  const a = await ctx.app(appId);
  return (a?.config?.release as { baseBranch?: string } | null | undefined)?.baseBranch ?? null;
}

const TOOLS: Tool[] = [
  {
    def: { name: "list_apps", description: "The Flutter apps fledge manages, with whether each has a usable config.", schema: obj({}) },
    run: (_i, ctx) => ctx.apps(),
  },
  {
    def: {
      name: "app_overview",
      description: "An app's environments (and their native flavors / entry files), the build commands from its config, its switches, its release settings, and its deploy routes.",
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
      return jiraTicket(String(i.key ?? ""));
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

  {
    def: {
      name: "release_notes",
      description:
        "The next release's notes as the app's templates render them (channel note and GitHub body), with its version, range and PRs. Rewrite the item titles for testers when asked; publish_release takes the GitHub body. Slow (about 20 seconds).",
      schema: obj(
        {
          app: APP,
          since: str("The release to start from, e.g. v1.3.1+3 (default: the latest)."),
          prerelease: bool("A pre-release (default true)."),
          exclude_prs: { type: "array", description: "PR numbers to leave out.", items: num("A PR number.") },
        },
        ["app"],
      ),
    },
    async run(i, ctx) {
      const a = await needApp(ctx, i.app);
      const d = await ctx.releaseDraft(a.id, sinceTag(i.since), i.prerelease !== false, (i.exclude_prs as number[] | undefined) ?? []);
      return {
        version: d.facts.version,
        previous: d.facts.previous?.tag ?? null,
        prs: d.facts.prs.map((pr) => ({ number: pr.number, title: pr.title, tickets: pr.tickets, dri: pr.dri })),
        channelNote: d.templates.slack,
        githubNotes: d.templates.github,
      };
    },
  },
  {
    def: {
      name: "list_deployments",
      description: "The app's deployments (builds posted together with notes to a channel), newest first: status (building, posting, posted, held, failed, cancelled), why it's held or failed, upload progress, and each build's status.",
      schema: obj({ app: APP, limit: num("How many (default 10, max 50).") }, ["app"]),
    },
    async run(i, ctx) {
      const a = await needApp(ctx, i.app);
      return (await ctx.deployments(a.id)).slice(0, Math.min(50, Math.max(1, Number(i.limit ?? 10))));
    },
  },
  // ------------------------------------------------------------------ actions
  {
    def: {
      name: "create_branch",
      description:
        "Create a local git branch (needs the developer's approval). It is not pushed; use push_branch for that. Optionally switch a checkout with no uncommitted changes to it.",
      schema: obj(
        {
          app: APP,
          name: str("The new branch's name, following the repository's convention (look at git_branches first)."),
          from: str("What to branch from: a branch, tag or commit. A remote branch like origin/main is fetched first. Default: origin/<the release base branch>, else the main checkout's branch."),
          switch_checkout: str("A checkout (path or branch) to switch to the new branch (optional)."),
        },
        ["app", "name"],
      ),
    },
    async prepare(i, ctx) {
      const a = await needApp(ctx, i.app);
      const name = await needBranchName(a.root, i.name);
      if (await gitOk(a.root, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`])) throw new Error(`a branch "${name}" already exists`);
      const base = await baseBranch(ctx, a.id);
      const from = i.from === undefined ? (base ? `origin/${base}` : (await needCheckout(ctx, a.id, undefined)).branch) : String(i.from);
      if (!REF.test(from) || from.startsWith("-")) throw new Error("from isn't a valid branch, tag or commit name");
      const remote = /^origin\/(.+)$/.exec(from)?.[1];
      if (!(await gitOk(a.root, ["rev-parse", "--verify", "--quiet", `${from}^{commit}`]))) throw new Error(`there's no "${from}" here`);
      const sw = i.switch_checkout === undefined ? null : await needCheckout(ctx, a.id, i.switch_checkout);
      if (sw && sw.dirty) throw new Error(`${sw.path} has ${sw.dirty} uncommitted file(s); it can't be switched`);
      return {
        title: `Create branch ${name}`,
        details: [
          ...(remote ? [`Fetch ${from} first`] : []),
          `From ${from}: ${await commitLine(a.root, from)}${remote ? " (before fetching)" : ""}`,
          sw ? `Switch ${sw.path} from ${sw.branch} to it` : "No checkout is switched",
          "Local only: nothing is pushed",
        ],
        async run() {
          if (remote) await git(a.root, ["fetch", "--quiet", "origin", `refs/heads/${remote}:refs/remotes/origin/${remote}`], 120_000);
          // --no-track: a branch made from origin/main must not push to main.
          await git(a.root, ["branch", "--no-track", name, from]);
          if (sw) await git(sw.path, ["switch", name]);
          return `Created ${name} at ${await commitLine(a.root, name)}${sw ? `, and ${sw.path} is on it` : ""}. It has not been pushed.`;
        },
      };
    },
  },
  {
    def: {
      name: "push_branch",
      description: "Push a local branch to origin and set it as the upstream (needs the developer's approval). Never forces, and refuses the release base branch.",
      schema: obj({ app: APP, branch: str("The local branch to push.") }, ["app", "branch"]),
    },
    async prepare(i, ctx) {
      const a = await needApp(ctx, i.app);
      const branch = await needBranchName(a.root, i.branch);
      if (!(await gitOk(a.root, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]))) throw new Error(`there's no local branch "${branch}"`);
      const base = await baseBranch(ctx, a.id);
      if ([base, "main", "master"].includes(branch)) throw new Error(`fledge doesn't push ${branch}; that goes through a pull request`);
      const onRemote = await gitOk(a.root, ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${branch}`]);
      const against = onRemote ? `origin/${branch}` : base && (await gitOk(a.root, ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${base}`])) ? `origin/${base}` : null;
      const count = against ? await git(a.root, ["rev-list", "--count", `${against}..${branch}`]) : null;
      return {
        title: `Push ${branch} to origin`,
        details: [
          onRemote ? `Updates origin/${branch}` : `Creates origin/${branch}`,
          ...(count !== null ? [`${count} commit(s) not on ${against}`] : []),
          `Latest: ${await commitLine(a.root, branch)}`,
          "No force: git refuses if origin has commits this branch lacks",
        ],
        async run() {
          await git(a.root, ["push", "--set-upstream", "origin", `refs/heads/${branch}:refs/heads/${branch}`], 180_000);
          return `Pushed ${branch} to origin.`;
        },
      };
    },
  },
  {
    def: {
      name: "start_builds",
      description: "Queue builds (needs the developer's approval). Each one runs the command from the app's config; list_builds shows progress.",
      schema: obj(
        {
          app: APP,
          checkout: str("A checkout path or branch (default: the main checkout)."),
          builds: {
            type: "array",
            description: "The builds to queue (at most 18).",
            items: obj(
              {
                environment: str("The environment's name."),
                platform: str("android or ios.", { enum: ["android", "ios"] }),
                mode: str("Build type.", { enum: ["debug", "profile", "release"] }),
              },
              ["environment", "platform", "mode"],
            ),
          },
          android_output: str("apk (default) or appbundle.", { enum: ["apk", "appbundle"] }),
          ios_output: str("ipa (default), app (for a device), or xcode (Prepare Xcode).", { enum: ["ipa", "app", "xcode"] }),
          export_method: str("For an ipa (default app-store).", { enum: ["app-store", "ad-hoc", "development"] }),
          split_debug_info: bool("Keep Dart symbols out of the binary, as CI does."),
          obfuscate: bool("Rename Dart symbols; needs split_debug_info."),
          arm64_only: bool("Android: 64-bit ARM phones only (faster; for a developer's own phone)."),
          toggles: { type: "array", description: "Ids of the app's switches to turn on (see app_overview).", items: str("A switch id.") },
        },
        ["app", "builds"],
      ),
    },
    async prepare(i, ctx) {
      const a = await needApp(ctx, i.app);
      const c = await needCheckout(ctx, a.id, i.checkout);
      const targets = (i.builds as { environment: string; platform: string; mode: string }[]).map((b) => ({ platform: b.platform, flavor: b.environment, mode: b.mode }));
      const p = await ctx.prepareBuilds(a.id, c.path, targets, {
        androidArtifact: i.android_output,
        iosArtifact: i.ios_output,
        exportMethod: i.export_method,
        splitDebugInfo: i.split_debug_info === true,
        obfuscate: i.obfuscate === true,
        arm64Only: i.arm64_only === true,
        toggles: i.toggles ?? [],
      });
      if (!p.builds.length) throw new Error(`none of these can be built: ${p.skipped.join("; ")}`);
      const flags = [i.split_debug_info && "split debug info", i.obfuscate && "obfuscated", i.arm64_only && "arm64 only", ...((i.toggles as string[] | undefined) ?? [])].filter(Boolean);
      return {
        title: `Queue ${p.builds.length} build${p.builds.length > 1 ? "s" : ""} of ${a.name}`,
        details: [
          `On ${c.branch} @ ${c.sha.slice(0, 8)}${c.dirty ? ` with ${c.dirty} uncommitted file(s)` : ""}`,
          ...p.builds.map((b) => `${b.label} · ${b.mode} · ${b.platform} ${b.artifact}${b.confirm ? " (this environment asks for confirmation)" : ""}`),
          ...(flags.length ? [`Options: ${flags.join(", ")}`] : []),
          ...p.skipped.map((s) => `Skipped: ${s}`),
        ],
        async run() {
          return { queued: p.queue(), skipped: p.skipped };
        },
      };
    },
  },
  {
    def: {
      name: "cancel_build",
      description: "Stop a running build or take a queued one off the queue (needs the developer's approval).",
      schema: obj({ build_id: str("The build's id from list_builds.") }, ["build_id"]),
    },
    async prepare(i, ctx) {
      const b = ctx.builds().find((x) => x.id === i.build_id);
      if (!b) throw new Error("no build with that id");
      if (b.status !== "queued" && b.status !== "running") throw new Error(`that build has already ${b.status}`);
      return {
        title: `${b.status === "running" ? "Stop" : "Unqueue"} ${b.flavor} ${b.mode} ${b.platform} ${b.artifact}`,
        details: [`${b.project ?? ""} on ${b.branch} @ ${b.sha.slice(0, 8)}`, b.status === "running" ? `Running for ${Math.round((Date.now() - (b.startedAt ?? Date.now())) / 60_000)} min` : "Queued, not started"],
        async run() {
          ctx.cancelBuild(b.id);
          return "Cancelled.";
        },
      };
    },
  },
  {
    def: {
      name: "resume_build",
      description:
        "Run a stopped or failed build again as the same build (needs the developer's approval): the same command in the same checkout, which reuses Gradle's and Xcode's finished work. Refused if the checkout's commit or files changed since it stopped.",
      schema: obj({ build_id: str("The build's id from list_builds.") }, ["build_id"]),
    },
    async prepare(i, ctx) {
      const b = ctx.builds().find((x) => x.id === i.build_id);
      if (!b) throw new Error("no build with that id");
      const r = await ctx.prepareResume(b.id);
      return {
        title: `Resume ${b.flavor} ${b.mode} ${b.platform} ${b.artifact}`,
        details: [`${b.project ?? ""} on ${b.branch} @ ${b.sha.slice(0, 8)}, unchanged since it ${b.status === "failed" ? "failed" : "stopped"}`, `Attempt ${r.attempt}, the same command: ${b.command}`],
        async run() {
          r.resume();
          return "Queued again; list_builds shows its progress.";
        },
      };
    },
  },
  {
    def: {
      name: "install_build",
      description: "Install a finished build on a connected phone (needs the developer's approval). Waits for the install and reports how it went.",
      schema: obj(
        {
          build_id: str("The build's id from list_builds."),
          device_id: str("The phone's id from list_devices."),
          launch: bool("Open the app afterwards (default false)."),
          replace: bool("Uninstall the existing app first, erasing its data. Only when an install failed because the signatures differ."),
        },
        ["build_id", "device_id"],
      ),
    },
    async prepare(i, ctx) {
      const b = ctx.builds().find((x) => x.id === i.build_id);
      if (!b) throw new Error("no build with that id");
      const ready = await ctx.prepareInstall(b.id, String(i.device_id));
      const opts = { launch: i.launch === true, replace: i.replace === true };
      return {
        title: `Install ${b.flavor} ${b.mode} ${b.artifact} on ${ready.device}`,
        details: [
          `Built from ${b.branch} @ ${b.sha.slice(0, 8)}${b.verified?.version ? `, version ${b.verified.version}` : ""}`,
          ...(opts.replace ? ["Uninstalls the app first: its data on the phone is erased"] : []),
          opts.launch ? "Opens the app afterwards" : "Doesn't open the app",
        ],
        run: () => ready.install(opts),
      };
    },
  },
  {
    def: {
      name: "ship_build",
      description:
        "Upload a finished build (apk, appbundle or ipa) to the app's Slack channel with a message (needs the developer's approval). The channel and message come from the app's config; a note is added to the message.",
      schema: obj({ build_id: str("The build's id from list_builds."), note: str("A short note for testers, e.g. what to test (optional).") }, ["build_id"]),
    },
    async prepare(i, ctx) {
      const b = ctx.builds().find((x) => x.id === i.build_id);
      if (!b) throw new Error("no build with that id");
      const p = await ctx.prepareShip(b.id, typeof i.note === "string" ? i.note.slice(0, 2000) : "");
      return {
        title: `Ship ${b.flavor} ${b.mode} ${b.artifact} to ${p.channel}`,
        details: [`${p.file}, ${(p.size / 1048576).toFixed(1)} MB`, `Built from ${b.branch} @ ${b.sha.slice(0, 8)}`, `Message: “${p.text.replace(/\n/g, " / ")}”`],
        run: () => p.ship(),
      };
    },
  },
  {
    def: {
      name: "deploy",
      description:
        "Build and post to Slack in one go (needs the developer's approval): a deploy route from the app's config, or builds and a channel. Once every build has built, one message goes out with notes (what changed since the last deploy) and all the files; if a build fails, nothing is posted. A note is added under the notes.",
      schema: obj(
        {
          app: APP,
          route: str("A deploy route's id from the app's config (app_overview lists them)."),
          builds: {
            type: "array",
            description: "Instead of a route: the builds (at most 10).",
            items: obj(
              {
                environment: str("The environment's name."),
                platform: str("android or ios.", { enum: ["android", "ios"] }),
                mode: str("Build type.", { enum: ["debug", "profile", "release"] }),
              },
              ["environment", "platform", "mode"],
            ),
          },
          channel: str("Instead of a route: the Slack channel, like #deployments."),
          android_output: str("With builds: apk (default) or appbundle.", { enum: ["apk", "appbundle"] }),
          ios_output: str("With builds: ipa (default) or app.", { enum: ["ipa", "app"] }),
          export_method: str("With builds, for an ipa (default app-store).", { enum: ["app-store", "ad-hoc", "development"] }),
          checkout: str("A checkout path or branch (default: the main checkout)."),
          note: str("A line for testers added under the notes, e.g. what to test."),
        },
        ["app"],
      ),
    },
    async prepare(i, ctx) {
      const a = await needApp(ctx, i.app);
      if (!i.route && !(i.builds && i.channel)) throw new Error("give a route, or builds and a channel");
      const c = await needCheckout(ctx, a.id, i.checkout);
      const req = i.route
        ? { route: String(i.route), checkout: c.path }
        : {
            checkout: c.path,
            channel: String(i.channel),
            targets: (i.builds as { environment: string; platform: string; mode: string }[]).map((b) => ({ platform: b.platform, flavor: b.environment, mode: b.mode })),
            options: { androidArtifact: i.android_output, iosArtifact: i.ios_output, exportMethod: i.export_method },
          };
      const d = await ctx.prepareDeploy(a.id, req);
      const notes = typeof i.note === "string" && i.note.trim() ? `${d.notes}\n\n${i.note.trim()}` : d.notes;
      const items = notes.split("\n").filter((l) => /^\d+\. /.test(l)).length;
      const confirm = d.builds.filter((b) => b.confirm).map((b) => b.name);
      return {
        title: `Deploy ${d.label} to ${d.channel}`,
        details: [
          `Builds: ${d.builds.map((b) => b.name).join(", ")}`,
          `From ${d.branch} @ ${d.sha.slice(0, 8)}, version ${d.version}`,
          `Notes: ${items ? `${items} change${items === 1 ? "" : "s"}` : "no listed changes"} since ${d.since ? `the last deploy (${d.since.slice(0, 8)})` : "the last release"}${i.note ? ", plus your note" : ""}`,
          ...(confirm.length ? [`Includes builds that ask for confirmation: ${confirm.join(", ")}`] : []),
          "Posts once every build has built; nothing is posted if one fails",
        ],
        async run() {
          return { deployment: d.start(notes), note: "list_deployments shows its progress" };
        },
      };
    },
  },
  {
    def: {
      name: "publish_release",
      description:
        "Cut the next release as the Release tab does (needs the developer's approval): commit the version bump in a temporary worktree, push its branch, open the bump PR, create the GitHub (pre-)release on that commit, and optionally move and comment the Jira tickets. dry_run stops before anything leaves the Mac.",
      schema: obj(
        {
          app: APP,
          prerelease: bool("A pre-release (true) or the latest release (false)."),
          update_jira: bool("Move the tickets and comment the release link on them (only if the app's release config has Jira)."),
          since: str("The release to start from (default: the latest)."),
          exclude_prs: { type: "array", description: "PR numbers to leave out.", items: num("A PR number.") },
          github_notes: str("The GitHub release body (default: the template's)."),
          dry_run: bool("Make the bump commit locally and stop (default false)."),
        },
        ["app", "prerelease", "update_jira"],
      ),
    },
    async prepare(i, ctx) {
      const a = await needApp(ctx, i.app);
      const prerelease = i.prerelease === true;
      const d = await ctx.releaseDraft(a.id, sinceTag(i.since), prerelease, (i.exclude_prs as number[] | undefined) ?? []);
      const notes = typeof i.github_notes === "string" && i.github_notes.trim() ? i.github_notes : d.templates.github;
      if (notes.length > 100_000) throw new Error("the notes are too long");
      const dryRun = i.dry_run === true;
      const updateJira = i.update_jira === true && !!d.jira;
      const keys = [...new Set(d.facts.prs.flatMap((pr) => pr.tickets))];
      const moving = d.jira ? keys.filter((k) => d.facts.tickets[k]?.status === d.jira!.from) : [];
      const tag = `v${d.facts.version}`;
      return {
        title: `${dryRun ? "Dry run: " : ""}Publish ${tag} of ${a.name} as ${prerelease ? "a pre-release" : "the latest release"}`,
        details: [
          `${d.facts.prs.length} PR(s) since ${d.facts.previous?.tag ?? "the start"}: ${d.facts.prs.map((pr) => `#${pr.number}`).join(", ") || "none"}`,
          ...(dryRun
            ? [`Makes the bump commit on ${d.baseBranch} @ ${d.facts.head.sha.slice(0, 8)} in a temporary worktree, then stops: nothing is pushed, published or changed in Jira`]
            : [
                `Bump commit on ${d.baseBranch} @ ${d.facts.head.sha.slice(0, 8)}, pushed as ${d.bumpBranch} with a PR into ${d.baseBranch}`,
                `GitHub ${prerelease ? "pre-release" : "release"} ${tag} on that commit, notes ${notes === d.templates.github ? "from the template" : `as written (${notes.length} characters)`}`,
                updateJira
                  ? `Jira: moves ${moving.length} of ${keys.length} ticket(s) ${d.jira!.from} → ${d.jira!.to} and comments the release link on all ${keys.length}`
                  : "Jira is left alone",
              ]),
        ],
        run: () => ctx.publishRelease(a.id, { facts: d.facts, githubNotes: notes, prerelease, updateJira, dryRun }),
      };
    },
  },
  {
    def: {
      name: "jira_comment",
      description: "Add a comment to a Jira ticket (needs the developer's approval).",
      schema: obj({ key: str("The ticket key, e.g. PROJ-123."), text: str("The comment, plain text.") }, ["key", "text"]),
    },
    async prepare(i) {
      const t = await jiraTicket(String(i.key));
      const text = String(i.text).trim();
      if (!text) throw new Error("the comment is empty");
      if (text.length > 5000) throw new Error("the comment is too long (at most 5000 characters)");
      return {
        title: `Comment on ${t.key}`,
        details: [`${t.key}: ${t.summary ?? ""} (${t.status ?? "no status"})`, `“${text.length > 400 ? `${text.slice(0, 400)}…` : text}”`],
        async run() {
          await run("acli", ["jira", "workitem", "comment", "create", "--key", t.key, "--body", text], { timeout: 60_000 });
          return `Commented on ${t.key}.`;
        },
      };
    },
  },
  {
    def: {
      name: "jira_transition",
      description: "Move a Jira ticket to another status (needs the developer's approval). The status must be one the ticket's workflow allows next.",
      schema: obj({ key: str("The ticket key, e.g. PROJ-123."), status: str("The status to move it to, exactly as Jira names it.") }, ["key", "status"]),
    },
    async prepare(i) {
      const t = await jiraTicket(String(i.key));
      const status = String(i.status).trim();
      if (!status || status.length > 80) throw new Error("that isn't a status name");
      if (status.toLowerCase() === (t.status ?? "").toLowerCase()) throw new Error(`${t.key} is already ${t.status}`);
      return {
        title: `Move ${t.key} to ${status}`,
        details: [`${t.key}: ${t.summary ?? ""}`, `${t.status ?? "no status"} → ${status}`],
        async run() {
          await run("acli", ["jira", "workitem", "transition", "--key", t.key, "--status", status, "--yes"], { timeout: 60_000 });
          return `${t.key} is now ${status}.`;
        },
      };
    },
  },
];

export const toolDefs = (): ToolDef[] => TOOLS.map((t) => t.def);

type Schema = { type?: string; enum?: string[]; properties?: Record<string, Schema>; required?: string[]; items?: Schema };

/** Checks a model-supplied input against the tool's schema (types, enums, required, no extras), nested arrays and objects included. */
export function inputProblem(def: ToolDef, input: Record<string, unknown>): string | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "input must be an object";
  if ("__unparseable" in input) return "the tool input wasn't valid JSON";
  return valueProblem(def.schema as Schema, input, "input");
}

function valueProblem(p: Schema, v: unknown, at: string): string | null {
  if (p.type === "object") {
    if (!v || typeof v !== "object" || Array.isArray(v)) return `"${at}" must be an object`;
    const o = v as Record<string, unknown>;
    for (const r of p.required ?? []) if (!(r in o)) return `missing "${r}"`;
    for (const [k, x] of Object.entries(o)) {
      const q = p.properties?.[k];
      if (!q) return `unknown field "${k}"`;
      const problem = valueProblem(q, x, k);
      if (problem) return problem;
    }
    return null;
  }
  if (p.type === "array") {
    if (!Array.isArray(v)) return `"${at}" must be a list`;
    if (v.length > 18) return `"${at}" has too many items`;
    for (const x of v) {
      const problem = p.items && valueProblem(p.items, x, at);
      if (problem) return problem;
    }
    return null;
  }
  if (p.type === "string" && typeof v !== "string") return `"${at}" must be text`;
  if (p.type === "integer" && !Number.isInteger(v)) return `"${at}" must be a whole number`;
  if (p.type === "boolean" && typeof v !== "boolean") return `"${at}" must be true or false`;
  if (p.enum && !p.enum.includes(v as string)) return `"${at}" must be one of ${p.enum.join(", ")}`;
  return null;
}

export const isAction = (name: string) => TOOLS.some((t) => t.def.name === name && "prepare" in t);

/**
 * Runs a tool call; failures come back as error results the model can read
 * and correct. An action runs only if `approve` says yes to its description.
 */
export async function runTool(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolContext,
  approve?: Approver,
): Promise<{ content: string; isError: boolean; approval?: Approval & { approved: boolean } }> {
  const tool = TOOLS.find((t) => t.def.name === name);
  if (!tool) return { content: `there's no tool called "${name}"`, isError: true };
  const problem = inputProblem(tool.def, input);
  if (problem) return { content: `invalid input for ${name}: ${problem}`, isError: true };
  let approval: (Approval & { approved: boolean }) | undefined;
  try {
    let out: unknown;
    if ("prepare" in tool) {
      if (!approve) return { content: "actions need the developer's approval, which isn't available here", isError: true };
      const action = await tool.prepare(input, ctx);
      approval = { title: action.title, details: action.details, approved: await approve({ title: action.title, details: action.details }) };
      if (!approval.approved) {
        return { content: "The developer declined this. Don't retry it; ask what they'd like instead.", isError: true, approval };
      }
      out = await action.run();
    } else {
      out = await tool.run(input, ctx);
    }
    let content = typeof out === "string" ? out : JSON.stringify(out, null, 1);
    if (content.length > MAX_RESULT) content = `${content.slice(0, MAX_RESULT)}\n… (cut; ask for less, e.g. a smaller limit or tail)`;
    return { content: content || "(empty)", isError: false, approval };
  } catch (e) {
    return { content: (e as Error).message.split("\n")[0], isError: true, approval };
  }
}
