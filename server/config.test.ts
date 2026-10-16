import assert from "node:assert/strict";
import { test } from "node:test";
import { fill, parseConfig } from "./config.ts";

test("fills defaults from the flavor name", () => {
  const c = parseConfig({ flavors: [{ name: "staging" }] });
  assert.deepEqual(c.flavors[0], {
    name: "staging",
    label: "Staging",
    androidId: undefined,
    iosId: undefined,
    xcodeScheme: "Staging",
    confirm: false,
  });
  assert.equal(c.flavorDefine, "FLAVOR");
  assert.equal(c.gitShaDefine, "GIT_SHA");
  assert.equal(c.symbolsDir, "build/symbols/{flavor}/{platform}");
  assert.equal(c.release, null);
});

test("rejects values that would reach a command line unchecked", () => {
  const bad: unknown[] = [
    {},
    { flavors: [] },
    { flavors: [{ name: "Staging" }] },
    { flavors: [{ name: "a; rm -rf /" }] },
    { flavors: [{ name: "a" }, { name: "a" }] },
    { flavors: [{ name: "a" }], defines: { "BAD KEY": "x" } },
    { flavors: [{ name: "a" }], defines: { OK: "two words" } },
    { flavors: [{ name: "a" }], toggles: [{ id: "t", label: "T", define: "NOEQUALS" }] },
    { flavors: [{ name: "a" }], toggles: [{ id: "t", label: "T", define: "X=1", skipFlavors: ["b"] }] },
    { flavors: [{ name: "a" }], symbolsDir: "../outside" },
    { flavors: [{ name: "a" }], symbolsDir: "/abs" },
    { flavors: [{ name: "a", androidId: "not an id" }] },
    { flavors: [{ name: "a" }], release: { github: { repo: "no-slash" } } },
    { flavors: [{ name: "a" }], release: { github: { repo: "o/r" }, jira: { site: "https://x.example", fromStatus: "A", toStatus: "B" } } },
  ];
  for (const b of bad) assert.throws(() => parseConfig(b), /./, JSON.stringify(b));
});

test("release defaults are neutral", () => {
  const c = parseConfig({ flavors: [{ name: "a" }], release: { github: { repo: "o/r" } } });
  assert.equal(c.release?.github.baseBranch, "main");
  assert.equal(c.release?.versionBump.branch, "release/bump-{versionSlug}");
  assert.equal(c.release?.versionBump.commitMessage, "Bump version to {tag}");
  assert.equal(c.release?.channel, "Release");
});

test("fill leaves unknown placeholders alone", () => {
  assert.equal(fill("{tag} on {branch} {nope}", { tag: "v1.0.0+1", branch: "main" }), "v1.0.0+1 on main {nope}");
});

test("fledge.example.json is a valid config", async () => {
  const { readFileSync } = await import("node:fs");
  const c = parseConfig(JSON.parse(readFileSync(new URL("../fledge.example.json", import.meta.url), "utf8")));
  assert.equal(c.flavors.length, 3);
  assert.ok(c.release?.jira);
});
