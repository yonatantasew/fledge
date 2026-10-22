import assert from "node:assert/strict";
import { test } from "node:test";
import { Deployer, deployKey, type DeployBuild, type Deployment } from "./deploy.ts";

function setup() {
  const builds = new Map<string, DeployBuild>([
    ["a", { status: "running", name: "Staging release Android apk" }],
    ["i", { status: "queued", name: "Staging release iOS ipa" }],
  ]);
  const posts: { channel: string; files: string[]; text: string }[] = [];
  const cancelled: string[] = [];
  let fail: string | null = null;
  const seen: (string | null)[] = [];
  const deployer = new Deployer(
    {
      build: (id) => builds.get(id),
      post: async (channel, files, text, progress) => {
        if (fail) throw new Error(fail);
        for (const f of files) progress(f.name, 1048576, 2 * 1048576);
        posts.push({ channel, files: files.map((f) => f.name), text });
      },
      cancelBuild: (id) => cancelled.push(id),
      changed: (list) => seen.push(list[0]?.progress ?? null),
    },
    [],
  );
  const d: Deployment = {
    id: "d1", project: "demo", route: "qa", key: deployKey("qa", "#x", []), label: "QA", channel: "#fledge-experiment",
    checkout: "/a", branch: "main", sha: "full-sha-1", builds: ["a", "i"], notes: "*demo* · QA\n\n1. A change", status: "building", createdAt: 1,
  };
  const set = (id: string, b: Partial<DeployBuild>) => builds.set(id, { ...builds.get(id)!, ...b });
  const settle = () => new Promise((r) => setTimeout(r, 0));
  return { deployer, d, set, posts, cancelled, settle, seen, failWith: (m: string | null) => (fail = m) };
}

const apk = { path: "/x/app.apk", name: "android-staging-release.apk", size: 52 * 1048576 };
const ipa = { path: "/x/app.ipa", name: "ios-staging-release.ipa", size: 97 * 1048576 };

test("nothing posts while a build runs; when all have built, one post with every file", async () => {
  const { deployer, d, set, posts, settle } = setup();
  deployer.add(d);
  set("a", { status: "succeeded", file: apk });
  deployer.tick();
  await settle();
  assert.equal(posts.length, 0);
  assert.equal(d.status, "building");
  set("i", { status: "succeeded", file: ipa });
  deployer.tick();
  deployer.tick(); // a second tick while posting doesn't post twice
  await settle();
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].files, ["android-staging-release.apk", "ios-staging-release.ipa"]);
  assert.equal(posts[0].channel, "#fledge-experiment");
  assert.match(posts[0].text, /1\. A change\n\nFiles: android-staging-release\.apk \(52 MB\) · ios-staging-release\.ipa \(97 MB\)$/);
  assert.equal(d.status, "posted");
  assert.equal(deployer.lastPosted("demo", d.key), "full-sha-1");
});

test("a failed build holds it; resuming builds again; or post what built, saying what didn't", async () => {
  const { deployer, d, set, posts, settle } = setup();
  deployer.add(d);
  set("a", { status: "succeeded", file: apk });
  set("i", { status: "failed" });
  deployer.tick();
  assert.equal(d.status, "held");
  assert.match(d.error!, /Staging release iOS ipa failed; nothing posted/);
  assert.equal(posts.length, 0);

  set("i", { status: "queued" }); // resumed
  deployer.tick();
  assert.equal(d.status, "building");
  set("i", { status: "cancelled" });
  deployer.tick();
  assert.equal(d.status, "held");

  await deployer.postWhatBuilt("d1");
  await settle();
  assert.deepEqual(posts[0].files, ["android-staging-release.apk"]);
  assert.match(posts[0].text, /Not built: Staging release iOS ipa \(cancelled\)$/);
  assert.deepEqual(d.posted?.missing, ["Staging release iOS ipa"]);
  await assert.rejects(deployer.postWhatBuilt("d1"), /only a held or failed/);
});

test("a post Slack refuses is failed with the reason, and can be posted again", async () => {
  const { deployer, d, set, posts, settle, failWith } = setup();
  failWith("Slack files.completeUploadExternal: not_in_channel");
  deployer.add(d);
  set("a", { status: "succeeded", file: apk });
  set("i", { status: "succeeded", file: ipa });
  deployer.tick();
  await settle();
  assert.equal(d.status, "failed");
  assert.match(d.error!, /not_in_channel/);
  assert.equal(deployer.lastPosted("demo", d.key), null, "a failed post isn't a deploy to count from");
  failWith(null);
  await deployer.postWhatBuilt("d1");
  assert.equal(d.status, "posted");
  assert.equal(posts.length, 1);
});

test("cancel stops what's still building and never posts", async () => {
  const { deployer, d, set, posts, cancelled, settle } = setup();
  deployer.add(d);
  set("a", { status: "succeeded", file: apk });
  deployer.cancel("d1");
  assert.deepEqual(cancelled, ["i"]);
  assert.equal(d.status, "cancelled");
  set("i", { status: "cancelled" });
  deployer.tick();
  await settle();
  assert.equal(posts.length, 0);
});

test("routes count their own deploys; one-offs by channel and environments", () => {
  assert.equal(deployKey("qa", "#a", ["staging"]), "route:qa");
  assert.equal(deployKey(null, "#a", ["prod", "staging", "prod"]), deployKey(null, "#a", ["staging", "prod"]));
  assert.notEqual(deployKey(null, "#a", ["staging"]), deployKey(null, "#b", ["staging"]));
});

test("while posting, the deployment says how far the upload is; after, it doesn't", async () => {
  const { deployer, d, set, settle, seen } = setup();
  deployer.add(d);
  set("a", { status: "succeeded", file: apk });
  set("i", { status: "succeeded", file: ipa });
  deployer.tick();
  await settle();
  assert.ok(seen.includes("uploading android-staging-release.apk, 1.0 MB / 2.0 MB"), JSON.stringify(seen));
  assert.equal(d.progress, undefined);
  assert.equal(d.status, "posted");
});
