import assert from "node:assert/strict";
import { test } from "node:test";
import { fill, parseConfig } from "./config.ts";

test("fills defaults from the flavor name", () => {
  const c = parseConfig({ flavors: [{ name: "staging" }] });
  assert.deepEqual(c.flavors[0], {
    name: "staging",
    flavor: "staging",
    target: undefined,
    defines: {},
    defineFiles: [],
    vars: {},
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
  assert.equal(c.flutter, "auto");
  assert.deepEqual(c.defineFiles, []);
  assert.deepEqual(c.args, { all: [], android: [], ios: [] });
  assert.equal(c.commands, null);
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
    { flavors: [{ name: "a" }], flutter: "rm -rf /" },
    { flavors: [{ name: "a" }], flutter: ["fvm", "flutter; rm"] },
    { flavors: [{ name: "a", target: "../outside.dart" }] },
    { flavors: [{ name: "a", target: "/abs/main.dart" }] },
    { flavors: [{ name: "a", defineFiles: ["config/a json"] }] },
    { flavors: [{ name: "a", defines: { URL: "has space" } }] },
    { flavors: [{ name: "a" }], args: { all: ["--ok", "; rm -rf /"] } },
    { flavors: [{ name: "a" }], args: { ios: ["not-a-flag"] } },
    { flavors: [{ name: "a", flavor: "bad flavor" }] },
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

test("command, environments without flavors, define files and extra flags", () => {
  const c = parseConfig({
    flutter: "fvm",
    flavors: [
      { name: "dev", flavor: null, target: "lib/main_dev.dart", defineFiles: ["config/dev.json"], defines: { API: "https://dev.example.com/v1" } },
      { name: "prod", flavor: "production" },
    ],
    defineFiles: ["config/common.json"],
    args: { all: ["--no-tree-shake-icons"], android: ["--target-platform=android-arm,android-arm64"] },
  });
  assert.deepEqual(c.flutter, ["fvm", "flutter"]);
  assert.equal(c.flavors[0].flavor, null);
  assert.equal(c.flavors[0].xcodeScheme, "Runner");
  assert.equal(c.flavors[0].target, "lib/main_dev.dart");
  assert.equal(c.flavors[1].flavor, "production");
  assert.equal(c.flavors[1].xcodeScheme, "Production");
  assert.deepEqual(parseConfig({ flavors: [{ name: "a" }], flutter: ["puro", "-e", "stable", "flutter"] }).flutter, ["puro", "-e", "stable", "flutter"]);
});
