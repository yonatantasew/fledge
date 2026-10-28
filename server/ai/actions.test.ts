import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { answerApproval, newConversation, pendingApprovals, send, type AgentEvent } from "./agent.ts";
import { inputProblem, isAction, runTool, toolDefs, type Approval, type ToolContext } from "./tools.ts";
import type { ReleaseFacts } from "../notes.ts";
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

// A fake acli: `view` answers with a ticket, anything else is recorded.
const bin = path.join(dir, "bin");
const acliLog = path.join(dir, "acli.log");
execFileSync("mkdir", [bin]);
writeFileSync(
  path.join(bin, "acli"),
  `#!/bin/sh\nif [ "$3" = "view" ]; then echo '{"key":"'$4'","fields":{"summary":"Fix the thing","status":{"name":"In Review"}}}'; else printf '%s\\n' "$*" >> "${acliLog}"; fi\n`,
);
chmodSync(path.join(bin, "acli"), 0o755);
process.env.PATH = `${bin}:${process.env.PATH}`;

const facts = {
  version: "1.4.0+2",
  previous: { tag: "v1.4.0+1" },
  head: { ref: "main", sha: "0123456789abcdef0123456789abcdef01234567" },
  prs: [
    { number: 7, title: "Fix the thing", tickets: ["PROJ-1"], dri: "A", versionBump: false },
    { number: 9, title: "Add a page", tickets: ["PROJ-2"], dri: "B", versionBump: false },
  ],
  tickets: { "PROJ-1": { status: "In Review" }, "PROJ-2": { status: "In Progress" } },
} as unknown as ReleaseFacts;
const published: unknown[] = [];
const shipped: string[] = [];
const deploys: { notes: string }[] = [];

const queued: unknown[] = [];
const resumed: string[] = [];
const cancelled: string[] = [];
const ctx: ToolContext = {
  apps: async () => [{ id: "demo", name: "demo", root, ready: true, source: "local", error: null }],
  app: async (id) =>
    id === "demo" ? { id, name: "demo", root, source: "local", config: { flavors: [], toggles: [], commands: {}, release: { baseBranch: "main" } } } : null,
  checkouts: async () => [{ path: root, branch: git(root, "branch", "--show-current"), sha: git(root, "rev-parse", "HEAD"), dirty: 0, version: "1.0.0+1" }],
  builds: () => [
    { id: "run1", project: "demo", flavor: "staging", mode: "release", platform: "android", artifact: "apk", status: "running", branch: "main", sha: "abcdef12", checkout: root, command: "x", createdAt: 1, startedAt: Date.now() },
    { id: "stopped1", project: "demo", flavor: "staging", mode: "release", platform: "ios", artifact: "ipa", status: "cancelled", branch: "main", sha: "abcdef12", checkout: root, command: "flutter build ipa --release", createdAt: 1 },
    { id: "done1", project: "demo", flavor: "staging", mode: "release", platform: "android", artifact: "apk", status: "succeeded", branch: "main", sha: "abcdef12", checkout: root, command: "x", createdAt: 1 },
  ],
  log: () => undefined,
  devices: async () => [],
  releases: async () => [],
  changes: async () => ({}),
  plan: async () => ({}),
  async prepareBuilds(_app, _checkout, targets, options, how) {
    return {
      builds: targets.map((t) => ({ ...t, label: t.flavor === "prod" ? "Prod" : "Staging", confirm: t.flavor === "prod", artifact: "apk" })),
      skipped: [],
      version: how?.auto === false ? "1.2.16+56, pubspec's" : "1.3.1+57, the next one, taken when queued",
      queue: async () => (queued.push({ targets, options, how }), { builds: ["new1"], version: "1.3.1+57" }),
    };
  },
  cancelBuild: (id) => void cancelled.push(id),
  async prepareResume(id) {
    if (id !== "stopped1") throw new Error("only a stopped or failed build can be resumed");
    return { attempt: 2, resume: () => void resumed.push(id) };
  },
  async prepareInstall(_build, device) {
    if (device !== "phone1") throw new Error("that device is not connected");
    return { device: "Pixel (Android 16)", install: async (opts) => ({ state: "installed", ...opts }) };
  },
  async deployments() {
    return deploys;
  },
  async prepareDeploy(_app, req) {
    if (req.route !== "qa" && !req.channel) throw new Error(`this app has no deploy route "${req.route}"`);
    return {
      label: req.route ? "QA: staging" : "Deploy",
      channel: req.channel ?? "#fledge-experiment",
      version: "1.3.1+4",
      branch: "main",
      sha: "7bb364f2aaaa",
      since: "1a2b3c4d5555",
      notes: "*demo* · QA: staging\n\nChanges since the last deploy (1a2b3c4d):\n1. A — PROJ-1\n   DRI: @A\n2. B — PROJ-2\n   DRI: @B",
      post: req.post ?? "together",
      onFailure: req.onFailure ?? "hold",
      builds: [{ name: "Staging release Android apk", confirm: false }, { name: "Prod release iOS ipa", confirm: true }],
      start: async (notes: string) => (deploys.push({ notes }), "d1"),
    };
  },
  async prepareShip(build, note) {
    if (build !== "done1") throw new Error("only a finished build with its file can be shipped");
    return { channel: "#deployments", text: `*demo* staging release${note ? `\n${note}` : ""}`, file: "android-staging-release.apk", size: 52428800, ship: async () => (shipped.push(note), "Shipped.") };
  },
  async releaseDraft(_app, _since, prerelease, exclude, version) {
    const f = { ...facts, prerelease, version: version ?? facts.version, prs: facts.prs.filter((pr) => !exclude.includes(pr.number)) };
    return { facts: f, templates: { slack: "slack", github: "template notes" }, baseBranch: "main", bumpBranch: "chore/bump-1.4.0-2", jira: { from: "In Review", to: "Ready for test" } };
  },
  async publishRelease(_app, req) {
    published.push(req);
    return { tag: `v${req.facts.version}` };
  },
};

const yes = async () => true;
const no = async () => false;

test("actions are marked, and lookups aren't", () => {
  for (const name of ["create_branch", "push_branch", "start_builds", "cancel_build", "resume_build", "install_build", "ship_build", "deploy", "publish_release", "jira_comment", "jira_transition"]) {
    assert.ok(isAction(name), name);
  }
  assert.ok(!isAction("release_notes"));
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
  assert.ok(asked?.details.includes("Version 1.3.1+57, the next one, taken when queued"));
  assert.equal(queued.length, 1);
  assert.match(r.content, /"version": "1\.3\.1\+57"/);
  let off: Approval | undefined;
  await runTool("start_builds", { app: "demo", builds: [{ environment: "staging", platform: "android", mode: "debug" }], auto_version: false }, ctx, async (a) => ((off = a), false));
  assert.ok(off?.details.includes("Version 1.2.16+56, pubspec's"));
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

test("publish_release describes the whole release and publishes exactly that", async () => {
  let asked: Approval | undefined;
  const r = await runTool(
    "publish_release",
    { app: "demo", prerelease: true, update_jira: true, exclude_prs: [9], github_notes: "Rewritten notes" },
    ctx,
    async (a) => ((asked = a), true),
  );
  assert.equal(r.isError, false, r.content);
  assert.equal(asked?.title, "Publish v1.4.0+2 of demo as a pre-release");
  assert.ok(asked?.details.includes("1 PR(s) since v1.4.0+1: #7"));
  assert.ok(asked?.details.some((d) => d.includes("chore/bump-1.4.0-2") && d.includes("0123456")));
  assert.ok(asked?.details.some((d) => d.includes("as written (15 characters)")));
  assert.ok(asked?.details.includes("Jira: moves 1 of 1 ticket(s) In Review → Ready for test and comments the release link on all 1"));
  const req = published[0] as { githubNotes: string; prerelease: boolean; updateJira: boolean; dryRun: boolean; facts: ReleaseFacts };
  assert.deepEqual([req.githubNotes, req.prerelease, req.updateJira, req.dryRun], ["Rewritten notes", true, true, false]);
  assert.deepEqual(req.facts.prs.map((pr) => pr.number), [7]);

  const dry = await runTool("publish_release", { app: "demo", prerelease: false, update_jira: false, dry_run: true }, ctx, async (a) => ((asked = a), false));
  assert.equal(dry.approval?.approved, false);
  assert.equal(asked?.title, "Dry run: Publish v1.4.0+2 of demo as the latest release");
  assert.ok(asked?.details.some((d) => d.includes("then stops: nothing is pushed")));
  assert.ok(!asked?.details.some((d) => d.includes("pushed as")));
  assert.equal(published.length, 1, "declined: nothing published");
});

test("publish_release releases the version it's given instead of the next one", async () => {
  let asked: Approval | undefined;
  const before = published.length;
  const r = await runTool("publish_release", { app: "demo", prerelease: true, update_jira: false, version: "v1.5.0+3" }, ctx, async (a) => ((asked = a), true));
  assert.equal(r.isError, false, r.content);
  assert.equal(asked?.title, "Publish v1.5.0+3 of demo as a pre-release");
  assert.equal((published[before] as { facts: ReleaseFacts }).facts.version, "1.5.0+3");
  const bad = await runTool("publish_release", { app: "demo", prerelease: true, update_jira: false, version: "1.5" }, ctx, yes);
  assert.equal(bad.isError, true);
  assert.match(bad.content, /version must look like/);
  assert.equal(published.length, before + 1);
});

test("Jira actions show the ticket, then run acli with exactly what was approved", async () => {
  let asked: Approval | undefined;
  const c = await runTool("jira_comment", { key: "PROJ-1", text: "Fixed in v1.4.0+2" }, ctx, async (a) => ((asked = a), true));
  assert.equal(c.isError, false, c.content);
  assert.equal(asked?.title, "Comment on PROJ-1");
  assert.ok(asked?.details.includes("PROJ-1: Fix the thing (In Review)"));
  const t = await runTool("jira_transition", { key: "PROJ-1", status: "Ready for test" }, ctx, async (a) => ((asked = a), true));
  assert.equal(t.isError, false, t.content);
  assert.ok(asked?.details.includes("In Review → Ready for test"));
  assert.deepEqual(readFileSync(acliLog, "utf8").trim().split("\n"), [
    "jira workitem comment create --key PROJ-1 --body Fixed in v1.4.0+2",
    "jira workitem transition --key PROJ-1 --status Ready for test --yes",
  ]);

  assert.match((await runTool("jira_transition", { key: "PROJ-1", status: "in review" }, ctx, yes)).content, /already In Review/);
  assert.match((await runTool("jira_comment", { key: "proj-1; rm", text: "x" }, ctx, yes)).content, /not a ticket key/);
  assert.match((await runTool("jira_comment", { key: "PROJ-1", text: "   " }, ctx, yes)).content, /empty/);
});

test("resume_build names the attempt and the same command, and resumes only when approved", async () => {
  let asked: Approval | undefined;
  await runTool("resume_build", { build_id: "stopped1" }, ctx, async (a) => ((asked = a), false));
  assert.deepEqual(resumed, []);
  assert.equal(asked?.title, "Resume staging release ios ipa");
  assert.ok(asked?.details.some((d) => d.startsWith("Attempt 2, the same command: flutter build ipa --release")));
  assert.equal((await runTool("resume_build", { build_id: "stopped1" }, ctx, yes)).isError, false);
  assert.deepEqual(resumed, ["stopped1"]);
  assert.match((await runTool("resume_build", { build_id: "done1" }, ctx, yes)).content, /only a stopped or failed build/);
});

test("ship_build shows the channel, file and message, and ships only when approved", async () => {
  let asked: Approval | undefined;
  const declined = await runTool("ship_build", { build_id: "done1", note: "Check login" }, ctx, async (a) => ((asked = a), false));
  assert.equal(declined.approval?.approved, false);
  assert.deepEqual(shipped, []);
  assert.equal(asked?.title, "Ship staging release apk to #deployments");
  assert.ok(asked?.details.includes("android-staging-release.apk, 50.0 MB"));
  assert.ok(asked?.details.some((d) => d.includes("Check login")));
  assert.equal((await runTool("ship_build", { build_id: "done1", note: "Check login" }, ctx, yes)).isError, false);
  assert.deepEqual(shipped, ["Check login"]);
  assert.match((await runTool("ship_build", { build_id: "run1" }, ctx, yes)).content, /only a finished build/);
});

test("deploy describes the builds, the channel and the notes, and starts only when approved", async () => {
  let asked: Approval | undefined;
  await runTool("deploy", { app: "demo", route: "qa", note: "Check the feed" }, ctx, async (a) => ((asked = a), false));
  assert.equal(deploys.length, 0, "declined: nothing started");
  assert.equal(asked?.title, "Deploy QA: staging to #fledge-experiment");
  assert.ok(asked?.details.includes("Builds: Staging release Android apk, Prod release iOS ipa"));
  assert.ok(asked?.details.includes("Notes: 2 changes since the last deploy (1a2b3c4d), plus your note"));
  assert.ok(asked?.details.some((d) => d.includes("ask for confirmation: Prod release iOS ipa")));
  const r = await runTool("deploy", { app: "demo", route: "qa", note: "Check the feed" }, ctx, yes);
  assert.equal(r.isError, false, r.content);
  assert.match(deploys[0].notes, /DRI: @B\n\nCheck the feed$/);
  assert.match((await runTool("deploy", { app: "demo" }, ctx, yes)).content, /a route, or builds and a channel/);
  assert.match((await runTool("deploy", { app: "demo", route: "nope" }, ctx, yes)).content, /no deploy route "nope"/);
  assert.equal(isAction("list_deployments"), false);
  await runTool("deploy", { app: "demo", route: "qa", post: "as-built" }, ctx, async (a) => ((asked = a), false));
  assert.ok(asked?.details.includes("Posts the notes with the first build to finish; each later one replies in their thread"));
  assert.ok(!asked?.details.includes("Posts once every build has built; nothing is posted if one fails"));
});
