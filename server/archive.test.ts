import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { inside, listArchive } from "./archive.ts";

const root = mkdtempSync(path.join(tmpdir(), "fledge-archive-"));
after(() => rmSync(root, { recursive: true, force: true }));
writeFileSync(path.join(root, "android-prod-release.apk"), "x".repeat(1234));
writeFileSync(path.join(root, "build.log"), "log");
writeFileSync(path.join(root, ".DS_Store"), "");
mkdirSync(path.join(root, "symbols", "app.android-arm64.symbols"), { recursive: true });
mkdirSync(path.join(root, "Runner.xcarchive", "Products"), { recursive: true });
symlinkSync("/etc", path.join(root, "outside"));

test("a build's folder: folders first, sizes for files, item counts for folders, no dot-files", async () => {
  const { entries, truncated } = await listArchive(root);
  assert.equal(truncated, false);
  assert.deepEqual(
    entries.map((e) => [e.name, e.kind, e.size ?? e.items ?? null]),
    [
      ["Runner.xcarchive", "package", 1],
      ["symbols", "dir", 1],
      ["android-prod-release.apk", "file", 1234],
      ["build.log", "file", 3],
      ["outside", "link", null],
    ],
  );
});

test("subfolders list by their path inside the build's folder", async () => {
  const { entries } = await listArchive(root, "symbols");
  assert.deepEqual(entries.map((e) => [e.path, e.kind]), [[path.join("symbols", "app.android-arm64.symbols"), "dir"]]);
});

test("nothing outside the build's folder: not by .., not by an absolute path, not through a link", async () => {
  assert.equal(inside(root, "../.."), null);
  assert.equal(inside(root, "/etc"), null);
  assert.equal(inside(root, "symbols/../.."), null);
  assert.equal(inside(root, "symbols/.."), path.resolve(root));
  await assert.rejects(listArchive(root, "../"), /outside the build's folder/);
  await assert.rejects(listArchive(root, "outside"), /outside the build's folder/); // listed as a link, never followed
});
