import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { answerApproval, newConversation, pendingApprovals, send, type AgentEvent } from "./agent.ts";
import { inputProblem, isAction, runTool, toolDefs, type Approval, type ToolContext } from "./tools.ts";
import type { Connector, TurnResult } from "./types.ts";

// A real repository with a bare "origin", so branches and pushes run real git.
const dir = mkdtempSync(path.join(tmpdir(), "fledge-actions-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const origin = path.join(dir, "origin.git");
const root = path.join(dir, "app");
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
execFileSync("git", ["init", "-q", "-b", "main", root]);
git(root, "config", "user.email", "t@example.com");
git(root, "config", "user.name", "t");
writeFileSync(path.join(root, "a.txt"), "a");
git(root, "add", ".");
git(root, "commit", "-qm", "first");
git(root, "remote", "add", "origin", origin);
git(root, "push", "-q", "origin", "main");
git(root, "fetch", "-q", "origin");

const queued: unknown[] = [];
const cancelled: string[] = [];
const ctx: ToolContext = {
  apps: async () => [{ id: "demo", name: "demo", root, ready: true, source: "local", error: null }],
  app: async (id) =>
    id === "demo" ? { id, name: "demo", root, source: "local", config: { flavors: [], toggles: [], commands: {}, release: { baseBranch: "main" } } } : null,
  checkouts: async () => [{ path: root, branch: git(root, "branch", "--show-current"), sha: git(root, "rev-parse", "HEAD"), dirty: 0, version: "1.0.0+1" }],
  builds: () => [
    { id: "run1", project: "demo", flavor: "staging", mode: "release", platform: "android", artifact: "apk", status: "running", branch: "main", sha: "abcdef12", checkout: root, command: "x", createdAt: 1, startedAt: Date.now() },
    { id: "done1", project: "demo", flavor: "staging", mode: "release", platform: "android", artifact: "apk", status: "succeeded", branch: "main", sha: "abcdef12", checkout: root, command: "x", createdAt: 1 },
  ],
  log: () => undefined,
  devices: async () => [],
  releases: async () => [],
  changes: async () => ({}),
  plan: async () => ({}),
  async prepareBuilds(_app, _checkout, targets, options) {
    return {
      builds: targets.map((t) => ({ ...t, label: t.flavor === "prod" ? "Prod" : "Staging", confirm: t.flavor === "prod", artifact: "apk" })),
      skipped: [],
      queue: () => (queued.push({ targets, options }), ["new1"]),
    };
  },
  cancelBuild: (id) => void cancelled.push(id),
  async prepareInstall(_build, device) {
    if (device !== "phone1") throw new Error("that device is not connected");
    return { device: "Pixel (Android 16)", install: async (opts) => ({ state: "installed", ...opts }) };
  },
};

const yes = async () => true;
const no = async () => false;

test("actions are marked, and lookups aren't", () => {
  for (const name of ["create_branch", "push_branch", "start_builds", "cancel_build", "install_build"]) assert.ok(isAction(name), name);
  assert.ok(!isAction("git_log"));
});

test("an action never runs without an approver, or when declined", async () => {
  const none = await runTool("create_branch", { app: "demo", name: "feature/none" }, ctx);
  assert.match(none.content, /approval/);
  const declined = await runTool("create_branch", { app: "demo", name: "feature/declined" }, ctx, no);
  assert.ok(declined.isError);
  assert.equal(declined.approval?.approved, false);
  assert.equal(git(root, "branch", "--list", "feature/*"), "");
});

test("create_branch shows what it will do, then branches from origin without tracking it", async () => {
  let asked: Approval | undefined;
  const r = await runTool("create_branch", { app: "demo", name: "feature/X-1-thing" }, ctx, async (a) => ((asked = a), true));
  assert.equal(r.isError, false, r.content);
  assert.equal(asked?.title, "Create branch feature/X-1-thing");
  assert.ok(asked?.details.some((d) => d.startsWith("Fetch origin/main")));
  assert.ok(asked?.details.includes("Local only: nothing is pushed"));
  assert.equal(git(root, "rev-parse", "feature/X-1-thing"), git(root, "rev-parse", "origin/main"));
  assert.throws(() => git(root, "config", "--get", "branch.feature/X-1-thing.merge"), "must not track origin/main");
  assert.equal(git(origin, "branch", "--list", "feature/*"), "", "nothing pushed");
});

test("create_branch refuses bad names, existing branches and option-like refs before asking", async () => {
  let asked = false;
  const ask = async () => ((asked = true), true);
  assert.match((await runTool("create_branch", { app: "demo", name: "--force" }, ctx, ask)).content, /isn't a valid branch name/);
  assert.match((await runTool("create_branch", { app: "demo", name: "bad..name" }, ctx, ask)).content, /isn't a valid branch name/);
  assert.match((await runTool("create_branch", { app: "demo", name: "main" }, ctx, ask)).content, /already exists/);
  assert.match((await runTool("create_branch", { app: "demo", name: "ok", from: "--upload-pack=x" }, ctx, ask)).content, /isn't a valid/);
  assert.match((await runTool("create_branch", { app: "demo", name: "ok", from: "nope" }, ctx, ask)).content, /no "nope"/);
  assert.equal(asked, false);
});

test("create_branch can switch a clean checkout to the new branch", async () => {
  const r = await runTool("create_branch", { app: "demo", name: "feature/switched", from: "main", switch_checkout: root }, ctx, yes);
  assert.equal(r.isError, false, r.content);
  assert.equal(git(root, "branch", "--show-current"), "feature/switched");
  git(root, "switch", "-q", "main");
});

test("push_branch pushes a branch with upstream, and refuses the base branch", async () => {
  git(root, "branch", "feature/push-me", "main");
  let asked: Approval | undefined;
  const r = await runTool("push_branch", { app: "demo", branch: "feature/push-me" }, ctx, async (a) => ((asked = a), true));
  assert.equal(r.isError, false, r.content);
  assert.ok(asked?.details.includes("Creates origin/feature/push-me"));
  assert.equal(git(origin, "rev-parse", "feature/push-me"), git(root, "rev-parse", "main"));
  assert.equal(git(root, "config", "--get", "branch.feature/push-me.remote"), "origin");
  assert.match((await runTool("push_branch", { app: "demo", branch: "main" }, ctx, yes)).content, /doesn't push main/);
  assert.match((await runTool("push_branch", { app: "demo", branch: "feature/missing" }, ctx, yes)).content, /no local branch/);
});

test("start_builds validates nested input, flags confirm environments, and queues the approved plan", async () => {
  const def = toolDefs().find((t) => t.name === "start_builds")!;
  assert.match(inputProblem(def, { app: "demo", builds: [{ environment: "x", platform: "web", mode: "debug" }] })!, /one of/);
  assert.match(inputProblem(def, { app: "demo", builds: [{ environment: "x", platform: "android" }] })!, /missing "mode"/);
  assert.match(inputProblem(def, { app: "demo", builds: "all" })!, /must be a list/);
  assert.match(inputProblem(def, { app: "demo", builds: [], obfuscate: "yes" })!, /true or false/);

  let asked: Approval | undefined;
  const r = await runTool(
    "start_builds",
    { app: "demo", builds: [{ environment: "prod", platform: "android", mode: "release" }], split_debug_info: true },
    ctx,
    async (a) => ((asked = a), true),
  );
  assert.equal(r.isError, false, r.content);
  assert.equal(asked?.title, "Queue 1 build of demo");
  assert.ok(asked?.details.some((d) => d.includes("Prod") && d.includes("asks for confirmation")));
  assert.ok(asked?.details.includes("Options: split debug info"));
  assert.equal(queued.length, 1);
});

test("cancel_build only takes live builds; install_build reports the device and erasing", async () => {
  assert.match((await runTool("cancel_build", { build_id: "done1" }, ctx, yes)).content, /already succeeded/);
  assert.equal((await runTool("cancel_build", { build_id: "run1" }, ctx, yes)).isError, false);
  assert.deepEqual(cancelled, ["run1"]);

  assert.match((await runTool("install_build", { build_id: "done1", device_id: "gone" }, ctx, yes)).content, /not connected/);
  let asked: Approval | undefined;
  const r = await runTool("install_build", { build_id: "done1", device_id: "phone1", replace: true }, ctx, async (a) => ((asked = a), true));
  assert.match(r.content, /installed/);
  assert.equal(asked?.title, "Install staging release apk on Pixel (Android 16)");
  assert.ok(asked?.details.some((d) => d.includes("data on the phone is erased")));
});

test("the loop waits for the page's answer, and only the right conversation can give it", async () => {
  const turns: TurnResult[] = [
    { text: "", toolCalls: [{ id: "call-1", name: "cancel_build", input: { build_id: "run1" } }], stop: "tools" },
    { text: "Not cancelled.", toolCalls: [], stop: "end" },
  ];
  const connector: Connector = { turn: async () => turns.shift()! };
  const c = newConversation("demo");
  const events: AgentEvent[] = [];
  const done = send(c, "stop it", ctx, (e) => events.push(e), undefined, { connector, provider: { name: "fake", model: "m" } });
  while (!pendingApprovals(c.id).length) await new Promise((r) => setTimeout(r, 5));
  assert.equal(pendingApprovals(c.id)[0].title, "Stop staging release android apk");
  assert.equal(answerApproval("someone-else", "call-1", true), false);
  assert.equal(answerApproval(c.id, "call-1", false), true);
  await done;
  assert.deepEqual(
    events.filter((e) => e.type.startsWith("approval")).map((e) => e.type),
    ["approval", "approval_result"],
  );
  const tool = c.messages.find((m) => m.role === "tool");
  assert.equal(tool?.role === "tool" && tool.results[0].approval?.approved, false);
  assert.equal(pendingApprovals(c.id).length, 0);
});
