import assert from "node:assert/strict";
import { test } from "node:test";
import { Deployer, deployKey, STAGED_FOR, type DeployBuild, type Deployment, type OnFailure, type PostMode } from "./deploy.ts";

const apk = { path: "/x/app.apk", name: "android-staging-release.apk", size: 600 * 1048576 };
const ipa = { path: "/x/app.ipa", name: "ios-staging-release.ipa", size: 97 * 1048576 };

function setup(mode: PostMode = "together", onFailure: OnFailure = "hold") {
  const builds = new Map<string, DeployBuild>([
    ["a", { status: "running", name: "Staging release Android apk" }],
    ["i", { status: "running", name: "Staging release iOS ipa" }],
  ]);
  const log: string[] = []; // every Slack call, in order
  const progress: string[] = [];
  let clock = 1_000_000;
  let uploads = 0;
  let messages = 0;
  let shareFailures = 0;
  const deployer = new Deployer(
    {
      build: (id) => builds.get(id),
      upload: async (file, report) => {
        report(file.size / 2, file.size);
        const id = `U${++uploads}`;
        log.push(`upload ${file.name} → ${id}`);
        return id;
      },
      share: async (channel, files, text, thread) => {
        if (shareFailures > 0) {
          shareFailures--;
          throw new Error("Slack files.completeUploadExternal: invalid_upload");
        }
        log.push(`share ${files.map((f) => f.id).join(",")} in ${channel}${thread ? ` thread ${thread}` : ""}: ${JSON.stringify(text)}`);
      },
      message: async (channel, text, thread) => {
        const ts = `ts${++messages}`;
        log.push(`message ${ts} in ${channel}${thread ? ` thread ${thread}` : ""}: ${JSON.stringify(text)}`);
        return ts;
      },
      cancelBuild: (id) => log.push(`cancel ${id}`),
      changed: (list) => list[0]?.progress && progress.push(list[0].progress),
      now: () => clock,
    },
    [],
  );
  const d: Deployment = {
    id: "d1", project: "demo", route: "qa", key: deployKey("qa", "#x", []), label: "QA", channel: "#fledge-experiment",
    checkout: "/a", branch: "main", sha: "full-sha-1", builds: ["a", "i"], notes: "*demo* · QA\n\n1. A change", mode, onFailure,
    status: "building", createdAt: 1,
  };
  const set = async (id: string, b: Partial<DeployBuild>) => {
    builds.set(id, { ...builds.get(id)!, ...b });
    deployer.tick();
    for (let n = 0; n < 20; n++) await new Promise((r) => setTimeout(r, 0)); // let the Slack steps run
  };
  return { deployer, d, set, log, progress, later: (ms: number) => (clock += ms), failShares: (n: number) => (shareFailures = n) };
}

test("together: each file goes up as its build finishes, then all are shared once, with the notes", async () => {
  const { deployer, d, set, log, progress } = setup();
  deployer.add(d);
  await set("a", { status: "succeeded", file: apk });
  assert.deepEqual(log, ["upload android-staging-release.apk → U1"], "the APK goes up while the IPA still builds");
  assert.equal(d.status, "building");
  assert.ok(progress.includes("uploading android-staging-release.apk, 300 MB / 600 MB"));
  await set("i", { status: "succeeded", file: ipa });
  assert.deepEqual(log.slice(1), [
    "upload ios-staging-release.ipa → U2",
    'share U1,U2 in #fledge-experiment: "*demo* · QA\\n\\n1. A change\\n\\nFiles: android-staging-release.apk (600 MB) · ios-staging-release.ipa (97 MB)"',
  ]);
  assert.equal(d.status, "posted");
  assert.equal(d.staged, undefined);
  assert.equal(deployer.lastPosted("demo", d.key), "full-sha-1");
});

test("together: an upload older than Slack is known to keep is sent again before sharing", async () => {
  const { deployer, d, set, log, later } = setup();
  deployer.add(d);
  await set("a", { status: "succeeded", file: apk });
  later(STAGED_FOR + 1);
  await set("i", { status: "succeeded", file: ipa });
  assert.deepEqual(log.slice(0, 3), [
    "upload android-staging-release.apk → U1",
    "upload ios-staging-release.ipa → U2",
    "upload android-staging-release.apk → U3",
  ]);
  assert.match(log[3], /^share U3,U2 in #fledge-experiment: /);
});

test("together: a share Slack refuses sends every file again once; twice fails with the reason", async () => {
  const one = setup();
  one.failShares(1);
  one.deployer.add(one.d);
  await one.set("a", { status: "succeeded", file: apk });
  await one.set("i", { status: "succeeded", file: ipa });
  assert.equal(one.d.status, "posted");
  assert.equal(one.log.filter((l) => l.startsWith("upload")).length, 4);

  const two = setup();
  two.failShares(2);
  two.deployer.add(two.d);
  await two.set("a", { status: "succeeded", file: apk });
  await two.set("i", { status: "succeeded", file: ipa });
  assert.equal(two.d.status, "failed");
  assert.match(two.d.error!, /invalid_upload/);
  assert.equal(two.deployer.lastPosted("demo", two.d.key), null);
});

test("together, hold: a failed build holds it, nothing shared; resume builds again; post what built says what didn't", async () => {
  const { deployer, d, set, log } = setup();
  deployer.add(d);
  await set("a", { status: "succeeded", file: apk });
  await set("i", { status: "failed", error: "flutter exited with 1" });
  assert.equal(d.status, "held");
  assert.match(d.error!, /Staging release iOS ipa failed; nothing posted/);
  assert.ok(!log.some((l) => l.startsWith("share")));
  await set("i", { status: "queued" });
  assert.equal(d.status, "building");
  await set("i", { status: "cancelled" });
  assert.equal(d.status, "held");
  await deployer.postWhatBuilt("d1");
  assert.match(log.at(-1)!, /^share U1 in #fledge-experiment: .*Files: android-staging-release\.apk \(600 MB\)\\nNot built: Staging release iOS ipa \(cancelled\)"$/);
  assert.equal(d.status, "posted");
  assert.deepEqual(d.posted?.missing, ["Staging release iOS ipa"]);
});

test("together, post what built: a failure posts the rest by itself", async () => {
  const { deployer, d, set, log } = setup("together", "post-built");
  deployer.add(d);
  await set("i", { status: "failed" });
  assert.equal(d.status, "building", "the APK is still building");
  await set("a", { status: "succeeded", file: apk });
  assert.match(log.at(-1)!, /^share U1 .*Not built: Staging release iOS ipa \(failed\)"$/);
  assert.equal(d.status, "posted");
});

test("as-built: the first build posts the notes and its file; the next replies in their thread", async () => {
  const { deployer, d, set, log } = setup("as-built");
  deployer.add(d);
  await set("a", { status: "succeeded", file: apk });
  assert.deepEqual(log, [
    'message ts1 in #fledge-experiment: "*demo* · QA\\n\\n1. A change\\n\\nFiles follow as each build finishes; later ones in this thread."',
    "upload android-staging-release.apk → U1",
    'share U1 in #fledge-experiment: ""',
  ]);
  assert.equal(d.status, "posting");
  await set("i", { status: "succeeded", file: ipa });
  assert.deepEqual(log.slice(3), ["upload ios-staging-release.ipa → U2", 'share U2 in #fledge-experiment thread ts1: "Staging release iOS ipa is ready (97 MB)"']);
  assert.equal(d.status, "posted");
  assert.deepEqual(d.posted?.files, ["android-staging-release.apk", "ios-staging-release.ipa"]);
});

test("as-built: a failure waits for the thread; with nothing built, nothing is posted", async () => {
  const one = setup("as-built");
  one.deployer.add(one.d);
  await one.set("i", { status: "failed", error: "flutter exited with 1" });
  assert.deepEqual(one.log, [], "no thread yet");
  await one.set("a", { status: "succeeded", file: apk });
  assert.equal(one.log.at(-1), 'message ts2 in #fledge-experiment thread ts1: "Staging release iOS ipa failed: flutter exited with 1"');
  assert.equal(one.d.status, "posted");
  assert.deepEqual(one.d.posted?.missing, ["Staging release iOS ipa"]);

  const two = setup("as-built");
  two.deployer.add(two.d);
  await two.set("a", { status: "failed" });
  await two.set("i", { status: "cancelled" });
  assert.deepEqual(two.log, []);
  assert.equal(two.d.status, "held");
  await assert.rejects(two.deployer.postWhatBuilt("d1"), /nothing built/);
});

test("cancel stops what's still building and drops what was staged", async () => {
  const { deployer, d, set, log } = setup();
  deployer.add(d);
  await set("a", { status: "succeeded", file: apk });
  deployer.cancel("d1");
  assert.equal(log.at(-1), "cancel i");
  assert.equal(d.status, "cancelled");
  assert.equal(d.staged, undefined);
  await set("i", { status: "cancelled" });
  assert.ok(!log.some((l) => l.startsWith("share")));
});

test("routes count their own deploys; one-offs by channel and environments", () => {
  assert.equal(deployKey("qa", "#a", ["staging"]), "route:qa");
  assert.equal(deployKey(null, "#a", ["prod", "staging", "prod"]), deployKey(null, "#a", ["staging", "prod"]));
  assert.notEqual(deployKey(null, "#a", ["staging"]), deployKey(null, "#b", ["staging"]));
});
