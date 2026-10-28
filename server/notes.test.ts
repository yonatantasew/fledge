import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bumpValues,
  cleanTitle,
  nextVersion,
  parseMerges,
  templateDeploy,
  templateGithub,
  templateSlack,
  templateRegex,
  ticketKeys,
  type MergedPr,
  type ReleaseFacts,
} from "./notes.ts";

test("parseMerges reads merge and squash commits, oldest first", () => {
  const log = [
    "da6b68c3\tMerge pull request #923 from acme/feature/PROJ-3975-platform-header",
    "aaaa0000\tSome direct commit",
    "bbbb1111\tPROJ-3606: remove duplicate API calls (#917)",
  ].join("\n");
  assert.deepEqual(parseMerges(log), [
    { number: 917, sha: "bbbb1111" },
    { number: 923, sha: "da6b68c3", branch: "feature/PROJ-3975-platform-header" },
  ]);
});

test("ticketKeys dedupes, keeps order and ignores PROJ-0000", () => {
  assert.deepEqual(ticketKeys("PROJ", "PROJ-3975: send platform", "feature/PROJ-3975-x PROJ-0000 PROJ-12"), ["PROJ-3975", "PROJ-12"]);
  assert.deepEqual(ticketKeys("PROJ", "XPROJ-12 PROJX-3"), []);
});

test("nextVersion bumps the build of the last tag, unless pubspec is already ahead", () => {
  assert.equal(nextVersion("v1.3.1+2", "1.3.0+29"), "1.3.1+3");
  assert.equal(nextVersion("v1.3.1+2", "1.4.0+1"), "1.4.0+1");
  assert.equal(nextVersion(null, "1.3.0+29"), "1.3.0+29");
});

test("bumpValues gives a dot-free slug and the release kind", () => {
  const v = bumpValues({ version: "1.3.1+3", date: "Oct 16, 2026", head: { ref: "main", sha: "571bd41fabcd" }, prerelease: true }, "88c32f9b0000");
  assert.equal(v.versionSlug, "1-3-1-3");
  assert.equal(v.tag, "v1.3.1+3");
  assert.equal(v.bumpShort, "88c32f9b");
  assert.equal(v.releaseKind, "pre-release");
});

test("templateRegex recognises any filled-in version of a template", () => {
  const r = templateRegex("release/bump-{versionSlug}");
  assert.ok(r.test("release/bump-1-3-1-2"));
  assert.ok(!r.test("feature/PROJ-1-x"));
  assert.ok(templateRegex("Bump version to {tag}").test("Bump version to v1.3.1+2"));
});

test("cleanTitle drops the key prefix and keeps iOS", () => {
  assert.equal(cleanTitle("PROJ-3283: iOS buffering guard", ["PROJ-3283"]), "iOS buffering guard");
  assert.equal(cleanTitle("PROJ-3975: send the platform header", ["PROJ-3975"]), "Send the platform header");
  assert.equal(cleanTitle("PROJ-0000: tidy the readme", []), "Tidy the readme");
});

const pr = (n: number, title: string, extra: Partial<MergedPr> = {}): MergedPr => ({
  number: n,
  title,
  author: "octocat",
  dri: "Mona",
  branch: "feature/x",
  mergeSha: `${n}`.padEnd(8, "0"),
  url: "",
  additions: 1,
  deletions: 1,
  changedFiles: 1,
  tickets: ticketKeys("PROJ", title),
  versionBump: false,
  stackedOn: [],
  ...extra,
});

const facts: ReleaseFacts = {
  repo: "o/r",
  channel: "Staging releases",
  previous: { tag: "v1.3.1+2", sha: "7340a0597144", base: "da6b68c3aaaa", version: "1.3.1+2", date: "Oct 13, 2026" },
  head: { ref: "main", sha: "571bd41fabcd" },
  version: "1.3.1+3",
  date: "Oct 16, 2026",
  prerelease: true,
  prs: [
    pr(930, "PROJ-4001: show the plan card"),
    pr(924, "PROJ-0000: bump version to v1.3.1+2", { versionBump: true }),
    pr(931, "PROJ-4002: badge", { stackedOn: [930] }),
  ],
  tickets: {},
  jiraSite: "",
};

test("templateSlack matches the team format and skips version bumps", () => {
  const s = templateSlack(facts);
  assert.match(s, /^Staging releases\n\n1\. Show the plan card — PROJ-4001\n   DRI: @Mona\n2\. Badge — PROJ-4002/);
  assert.match(s, /Tickets: 2\n/);
  assert.match(s, /Build: main @ 571bd41f, version 1\.3\.1\+3/);
  assert.match(s, /Commit range: da6b68c3 → main @ 571bd41f \(PRs #930, #931\)\./);
  assert.ok(!s.includes("#924"));
  assert.match(s, /#931 builds on #930/);
});

test("templateGithub carries tickets and rollback", () => {
  const g = templateGithub(facts);
  assert.match(g, /^Release 1\.3\.1\+3 for the Oct 16, 2026 deployment\./);
  assert.match(g, /## Tickets\n1\. Show the plan card — PROJ-4001/);
  assert.match(g, /## Rollback\n- Full rollback: redeploy the previous staging build \(1\.3\.1\+2/);
});

test("a deploy note: the builds, then each PR since the last deploy with its tickets and DRI", () => {
  const pr = (number: number, title: string, tickets: string[], dri: string) => ({ number, title, tickets, dri }) as unknown as MergedPr;
  const text = templateDeploy({
    app: "demo",
    label: "QA: staging",
    version: "1.3.1+4",
    builds: [
      { environment: "Staging", mode: "release", platform: "android", output: "apk" },
      { environment: "Staging", mode: "release", platform: "ios", output: "ipa" },
    ],
    branch: "main",
    sha: "7bb364f2aaaa",
    since: "1a2b3c4d5555",
    prs: [pr(931, "PROJ-3438: Cache the feed tabs", ["PROJ-3438"], "Ana"), pr(940, "Fix a typo", [], "Bo")],
    commits: [],
  });
  assert.equal(
    text,
    [
      "*demo* · QA: staging · 1.3.1+4",
      "Staging release (Android apk, iOS ipa) · main @ 7bb364f2",
      "",
      "Changes since the last deploy (1a2b3c4d):",
      "1. Cache the feed tabs — PROJ-3438",
      "   DRI: @Ana",
      "2. Fix a typo — PR #940",
      "   DRI: @Bo",
    ].join("\n"),
  );
});

test("a deploy note mentions a DRI by Slack member ID when the team config has one", () => {
  const pr = { number: 7, title: "Fix a typo", tickets: [], dri: "Bo", slack: "U012ABCDE" } as unknown as MergedPr;
  const text = templateDeploy({ app: "demo", label: "QA", version: "1.0.0+2", builds: [], branch: "main", sha: "7bb364f2aaaa", since: null, prs: [pr], commits: [] });
  assert.match(text, /\n   DRI: <@U012ABCDE>$/);
});

test("a deploy note without PRs lists commits, or says nothing changed", () => {
  const base = { app: "demo", label: "Deploy", version: "1.0.0+1", builds: [{ environment: "Prod", mode: "release", platform: "android" as const, output: "aab" }], branch: "feature/x", sha: "abcdef1234", prs: [] };
  assert.match(templateDeploy({ ...base, since: null, commits: ["Add login", "Fix crash"] }), /Commits since the last release:\n• Add login\n• Fix crash$/);
  assert.match(templateDeploy({ ...base, since: "1111111122", commits: [] }), /No changes since the last deploy \(11111111\)\.$/);
});
