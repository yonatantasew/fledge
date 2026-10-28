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
    commands: { android: {}, ios: {} },
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

test("a team entry can carry a Slack member ID", () => {
  const release = (team: object) => ({ flavors: [{ name: "a" }], release: { github: { repo: "o/r" }, team } });
  const c = parseConfig(release({ alice: "Alice", bob: { name: "Bob B", slack: "U012ABCDE" }, carol: { name: "Carol" } }));
  assert.deepEqual(c.release?.team, { alice: "Alice", bob: "Bob B", carol: "Carol" });
  assert.deepEqual(c.release?.slack, { bob: "U012ABCDE" });
  assert.throws(() => parseConfig(release({ bob: { name: "Bob", slack: "@bob" } })), /release\.team\.bob\.slack/);
  assert.throws(() => parseConfig(release({ bob: { slack: "U012ABCDE" } })), /release\.team\.bob\.name/);
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

test("ship.slack takes a channel and checks the message's placeholders", () => {
  const base = { flavors: [{ name: "staging" }] };
  assert.equal(parseConfig(base).ship, null);
  const c = parseConfig({ ...base, ship: { slack: { channel: "#deployments" } } });
  assert.equal(c.ship?.slack?.channel, "#deployments");
  assert.ok(c.ship?.slack?.message.some((l) => l.includes("{version}")), "a default message");
  assert.equal(parseConfig({ ...base, ship: { slack: { channel: "C0123ABCD", message: ["{app} {version}"] } } }).ship?.slack?.channel, "C0123ABCD");
  assert.throws(() => parseConfig({ ...base, ship: { slack: { channel: "deployments" } } }), /ship\.slack\.channel/);
  assert.throws(() => parseConfig({ ...base, ship: { slack: { channel: "#d", message: ["{nope}"] } } }), /unknown placeholder \{nope\}/);
});

test("deploy.routes: builds by environment, options and a channel, all checked", () => {
  const base = { flavors: [{ name: "staging" }, { name: "prod" }], toggles: [{ id: "probe", label: "Probe", define: "PROBE=true" }] };
  assert.deepEqual(parseConfig(base).deploy, []);
  const c = parseConfig({
    ...base,
    deploy: {
      routes: [
        {
          id: "qa",
          label: "QA: staging",
          builds: [
            { platform: "android", environment: "staging", mode: "release" },
            { platform: "ios", environment: "staging", mode: "release" },
          ],
          options: { androidOutput: "apk", exportMethod: "ad-hoc", splitDebugInfo: true, toggles: ["probe"] },
          to: { slack: "#fledge-experiment" },
        },
      ],
    },
  });
  assert.equal(c.deploy[0].label, "QA: staging");
  assert.deepEqual(c.deploy[0].options, { androidOutput: "apk", iosOutput: undefined, exportMethod: "ad-hoc", splitDebugInfo: true, toggles: ["probe"] });
  const route = (over: object) => ({ ...base, deploy: { routes: [{ id: "qa", builds: [{ platform: "android", environment: "staging", mode: "release" }], to: { slack: "#x" }, ...over }] } });
  assert.deepEqual([c.deploy[0].post, c.deploy[0].onFailure], ["together", "hold"], "post together, hold on failure, unless set");
  assert.deepEqual([parseConfig(route({ post: "as-built", onFailure: "post-built" })).deploy[0].post, parseConfig(route({ onFailure: "post-built" })).deploy[0].onFailure], ["as-built", "post-built"]);
  assert.throws(() => parseConfig(route({ post: "each" })), /\.post/);
  assert.throws(() => parseConfig(route({ builds: [{ platform: "android", environment: "uat", mode: "release" }] })), /unknown environment "uat"/);
  assert.throws(() => parseConfig(route({ to: { slack: "deployments" } })), /to\.slack/);
  assert.throws(() => parseConfig(route({ options: { toggles: ["nope"] } })), /switch ids/);
  assert.throws(() => parseConfig(route({ builds: Array(11).fill({ platform: "android", environment: "staging", mode: "release" }) })), /at most 10/);
  const simulator = (mode: string) => route({ builds: [{ platform: "ios", environment: "staging", mode }], options: { iosOutput: "simulator" } });
  assert.equal(parseConfig(simulator("debug")).deploy[0].options.iosOutput, "simulator");
  assert.throws(() => parseConfig(simulator("release")), /simulator builds are debug only, but an iOS build here is release/);
  assert.throws(() => parseConfig(route({ options: { iosOutput: "zip" } })), /iosOutput/);
  assert.throws(() => parseConfig({ ...base, deploy: { routes: [route({}).deploy.routes[0], route({}).deploy.routes[0]] } }), /unique/);
});

test("versions: based on the highest seen, switches off, unless set; checked", () => {
  const base = { flavors: [{ name: "staging" }] };
  assert.deepEqual(parseConfig(base).versions, { basedOn: "highest", autoIncrement: false, writePubspec: false });
  assert.deepEqual(parseConfig({ ...base, versions: { basedOn: "releases", autoIncrement: true } }).versions, { basedOn: "releases", autoIncrement: true, writePubspec: false });
  assert.throws(() => parseConfig({ ...base, versions: { basedOn: "tags" } }), /versions\.basedOn/);
  assert.throws(() => parseConfig({ ...base, versions: { writePubspec: "yes" } }), /versions\.writePubspec/);
});
