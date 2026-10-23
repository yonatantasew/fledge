import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { releasesSeen, suggestNext, versionHistory, withVersion, type SeenVersion } from "./versions.ts";

const seen = (version: string, from: SeenVersion["from"] = "build"): SeenVersion => ({ version, from, label: `${from} ${version}` });

test("the number goes above every one seen; the name is the highest seen", () => {
  // This app's real mess: pubspec 1.2.16+56, tags v1.3.1+3, origin pubspec 1.3.0+29.
  const n = suggestNext([seen("1.2.16+56", "pubspec"), seen("1.3.1+3", "release"), seen("1.3.0+29", "pubspec"), seen("1.3.1+3")], "highest");
  assert.deepEqual([n.version, n.name, n.number], ["1.3.1+57", "1.3.1", "57"]);
  assert.equal(n.after?.version, "1.2.16+56", "it follows the highest number");
});

test("based on releases: only tags count, unless there are none", () => {
  const all = [seen("1.2.16+56", "pubspec"), seen("1.3.1+3", "release"), seen("1.3.1+2", "release"), seen("1.4.0+80")];
  assert.equal(suggestNext(all, "releases").version, "1.3.1+4");
  assert.equal(suggestNext(all, "highest").version, "1.4.0+81");
  assert.equal(suggestNext([seen("2.0.0+9", "pubspec")], "releases").version, "2.0.0+10");
  assert.equal(suggestNext([], "highest").version, "1.0.0+1");
  assert.equal(suggestNext([seen("not-a-version")], "highest").version, "1.0.0+1");
});

test("names compare by number, not text: 1.10.0 is above 1.9.9", () => {
  assert.equal(suggestNext([seen("1.9.9+5"), seen("1.10.0+3")], "highest").version, "1.10.0+6");
});

test("release tags become versions; others are left out", () => {
  assert.deepEqual(releasesSeen([{ tag: "v1.3.1+3" }, { tag: "nightly" }, { tag: "v1.2" }]).map((s) => [s.version, s.label]), [["1.3.1+3", "release v1.3.1+3"]]);
});

test("pubspec's version line is replaced; none, null", () => {
  assert.equal(withVersion("name: app\nversion: 1.2.16+56\nenv: x\n", "1.3.1+57"), "name: app\nversion: 1.3.1+57\nenv: x\n");
  assert.equal(withVersion("name: app\n", "1.0.0+1"), null);
});

const dir = mkdtempSync(path.join(tmpdir(), "fledge-versions-"));
after(() => rmSync(dir, { recursive: true, force: true }));

test("the history is kept per app, in order", async () => {
  const h = versionHistory(dir);
  const record = (version: string) => ({ version, at: 1, branch: "main", sha: "abc", how: "auto" as const, builds: [] });
  await h.add("demo", record("1.3.1+57"));
  await h.add("demo", record("1.3.1+58"));
  await h.add("other", record("2.0.0+1"));
  assert.deepEqual((await versionHistory(dir).list("demo")).map((r) => r.version), ["1.3.1+57", "1.3.1+58"]);
  assert.deepEqual(await h.list("none"), []);
});
