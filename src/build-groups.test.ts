import assert from "node:assert/strict";
import { test } from "node:test";
import type { Job } from "./api";
import { compareVersionsDesc, dayLabel, groupBuilds, versionOf } from "./build-groups.ts";

const day = 86_400_000;
const now = new Date(2026, 9, 22, 15, 0).getTime();
const job = (id: string, over: Partial<Job>): Job =>
  ({ id, project: "a", projectName: "a", checkout: "/a", branch: "main", sha: "abc", platform: "android", flavor: "staging", mode: "release", artifact: "apk", command: "flutter build apk", notes: [], status: "succeeded", createdAt: now, ...over }) as Job;

test("a build's version: read back, else as queued, else from its command", () => {
  assert.equal(versionOf(job("1", { verified: { version: "1.3.1+3" }, version: "9.9.9+9" })), "1.3.1+3");
  assert.equal(versionOf(job("2", { status: "failed", version: "1.3.1+4" })), "1.3.1+4");
  assert.equal(versionOf(job("3", { command: "flutter build apk --build-name=1.2.0 --build-number=7" })), "1.2.0+7");
  assert.equal(versionOf(job("4", {})), null);
});

test("versions sort newest first, numerically", () => {
  assert.deepEqual(["1.3.9+40", "1.3.10+2", "1.3.10+11", "1.2.16+56"].sort(compareVersionsDesc), ["1.3.10+11", "1.3.10+2", "1.3.9+40", "1.2.16+56"]);
});

test("grouped by version: newest first, unknown last, order kept inside", () => {
  const builds = [job("a", { version: "1.3.1+3" }), job("b", {}), job("c", { verified: { version: "1.3.1+4" } }), job("d", { version: "1.3.1+3", platform: "ios" })];
  const g = groupBuilds(builds, "version");
  assert.deepEqual(g.map((x) => [x.label, x.builds.map((b) => b.id)]), [["1.3.1+4", ["c"]], ["1.3.1+3", ["a", "d"]], ["Version unknown", ["b"]]]);
});

test("grouped by day: Today, Yesterday, then dates, newest first", () => {
  const g = groupBuilds([job("old", { createdAt: now - 3 * day }), job("t", {}), job("y", { createdAt: now - day })], "date", undefined, now);
  assert.deepEqual(g.map((x) => x.builds[0].id), ["t", "y", "old"]);
  assert.deepEqual(g.slice(0, 2).map((x) => x.label), ["Today", "Yesterday"]);
  assert.equal(dayLabel(now - 3 * day, now), new Date(now - 3 * day).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }));
});

test("grouped by branch or environment: by their newest build, with labels", () => {
  const builds = [job("1", { branch: "main", createdAt: now - day }), job("2", { branch: "feature/x", flavor: "prod", createdAt: now })];
  assert.deepEqual(groupBuilds(builds, "branch").map((x) => x.key), ["feature/x", "main"]);
  assert.deepEqual(groupBuilds(builds, "env", (f) => f.toUpperCase()).map((x) => x.label), ["PROD", "STAGING"]);
  assert.deepEqual(groupBuilds(builds, "none")[0].builds.map((b) => b.id), ["1", "2"]);
});

test("a build with no version borrows one from the same commit, unless versions were overridden", () => {
  const builds = [
    job("apk", { sha: "7bb364f2", verified: { version: "1.2.16+56" } }),
    job("ipa", { sha: "7bb364f2", status: "cancelled" }),
    job("other", { sha: "0000aaaa", status: "cancelled" }),
    job("custom", { sha: "7bb364f2", status: "cancelled", command: "flutter build ipa --build-number=99" }),
  ];
  const g = groupBuilds(builds, "version");
  assert.deepEqual(g.map((x) => [x.label, x.builds.map((b) => b.id)]), [["1.2.16+56", ["apk", "ipa"]], ["Version unknown", ["other", "custom"]]]);
});

test("grouped by status: in the order the work flows", () => {
  const builds = [job("f", { status: "failed" }), job("r", { status: "running" }), job("s", {}), job("q", { status: "queued" })];
  assert.deepEqual(groupBuilds(builds, "status").map((g) => g.label), ["Building", "Queued", "Built", "Failed"]);
});
