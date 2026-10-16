import assert from "node:assert/strict";
import { test } from "node:test";
import { artifactPath, parseRequest, planBuild, type BuildOptions } from "./commands.ts";
import { parseConfig } from "./config.ts";

const cfg = parseConfig({
  flavors: [{ name: "dev" }, { name: "staging" }, { name: "prod", confirm: true }],
  defines: { BUILD_SOURCE: "local" },
  toggles: [{ id: "verbose", label: "Verbose logs", define: "VERBOSE_LOGS=true", skipFlavors: ["prod"] }],
});

const base: BuildOptions = {
  androidArtifact: "apk",
  iosArtifact: "ipa",
  exportMethod: "app-store",
  splitDebugInfo: false,
  obfuscate: false,
  toggles: [],
  arm64Only: false,
  buildName: "",
  buildNumber: "",
};

function plan(t: Parameters<typeof planBuild>[0], o: Partial<BuildOptions> = {}, c = cfg) {
  const r = planBuild(t, { ...base, ...o }, "abc1234", c);
  if (!("build" in r)) throw new Error(`skipped: ${r.skipped.reason}`);
  return r.build;
}

test("passes the flavor, the matching flavor define, the git sha and the configured defines", () => {
  const b = plan({ platform: "ios", flavor: "staging", mode: "release" });
  assert.deepEqual(b.argv.slice(0, 9), [
    "flutter", "build", "ipa", "--release", "--flavor", "staging",
    "--dart-define=FLAVOR=staging", "--dart-define=GIT_SHA=abc1234", "--dart-define=BUILD_SOURCE=local",
  ]);
});

test("the flavor and git-sha define names are configurable, or can be left out", () => {
  const custom = parseConfig({ flavors: [{ name: "dev" }], flavorDefine: "APP_ENV", gitShaDefine: null });
  const b = plan({ platform: "android", flavor: "dev", mode: "debug" }, {}, custom);
  assert.ok(b.argv.includes("--dart-define=APP_ENV=dev"));
  assert.ok(!b.argv.some((a) => a.includes("GIT_SHA")));
});

test("android artifact picks apk or appbundle", () => {
  assert.equal(plan({ platform: "android", flavor: "staging", mode: "profile" }).argv[2], "apk");
  assert.equal(
    plan({ platform: "android", flavor: "staging", mode: "release" }, { androidArtifact: "appbundle" }).argv[2],
    "appbundle",
  );
});

test("an iOS .app builds with `flutter build ios` and no export method", () => {
  const b = plan({ platform: "ios", flavor: "staging", mode: "debug" }, { iosArtifact: "app" });
  assert.equal(b.argv[2], "ios");
  assert.ok(!b.argv.some((a) => a.startsWith("--export-method")));
});

test("a debug IPA is skipped, not attempted", () => {
  const r = planBuild({ platform: "ios", flavor: "staging", mode: "debug" }, base, "abc", cfg);
  assert.ok("skipped" in r);
});

test("split debug info follows the configured layout, and never on debug", () => {
  assert.ok(
    plan({ platform: "android", flavor: "dev", mode: "release" }, { splitDebugInfo: true }).argv.includes(
      "--split-debug-info=build/symbols/dev/android",
    ),
  );
  const d = plan({ platform: "android", flavor: "dev", mode: "debug" }, { splitDebugInfo: true, obfuscate: true });
  assert.ok(!d.argv.some((a) => a.startsWith("--split-debug-info") || a === "--obfuscate"));
});

test("a toggle adds its define, except on the flavors it skips", () => {
  assert.ok(
    plan({ platform: "android", flavor: "staging", mode: "release" }, { toggles: ["verbose"] }).argv.includes(
      "--dart-define=VERBOSE_LOGS=true",
    ),
  );
  const p = plan({ platform: "android", flavor: "prod", mode: "release" }, { toggles: ["verbose"] });
  assert.ok(!p.argv.includes("--dart-define=VERBOSE_LOGS=true"));
  assert.equal(p.notes.length, 1);
});

test("parseRequest rejects anything outside the config and bad versions", () => {
  assert.ok("error" in parseRequest({ targets: [{ platform: "web", flavor: "staging", mode: "release" }] }, cfg));
  assert.ok("error" in parseRequest({ targets: [{ platform: "ios", flavor: "uat", mode: "release" }] }, cfg));
  assert.ok("error" in parseRequest({ targets: [] }, cfg));
  const ok = { platform: "ios", flavor: "staging", mode: "release" };
  assert.ok("error" in parseRequest({ targets: [ok], options: { buildName: "1.3.1; rm -rf /" } }, cfg));
  assert.ok("error" in parseRequest({ targets: [ok], options: { buildNumber: "2a" } }, cfg));
  assert.ok("error" in parseRequest({ targets: [ok], options: { obfuscate: true } }, cfg));
  assert.ok("error" in parseRequest({ targets: [ok], options: { toggles: ["nope"] } }, cfg));
  const r = parseRequest({ targets: [ok], options: { buildName: "1.3.1", buildNumber: "3", toggles: ["verbose"] } }, cfg);
  assert.ok("targets" in r && r.options.buildNumber === "3" && r.options.toggles[0] === "verbose");
});

test("artifact paths match Flutter 3.24's output layout", () => {
  assert.equal(
    artifactPath({ platform: "android", flavor: "staging", mode: "release", artifact: "apk" }),
    "build/app/outputs/flutter-apk/app-staging-release.apk",
  );
  assert.equal(
    artifactPath({ platform: "android", flavor: "dev", mode: "profile", artifact: "appbundle" }),
    "build/app/outputs/bundle/devProfile/app-dev-profile.aab",
  );
});

test("Prepare Xcode writes the flavor config only, for any build type", () => {
  const b = plan({ platform: "ios", flavor: "dev", mode: "release" }, { iosArtifact: "xcode", splitDebugInfo: true, obfuscate: true });
  assert.deepEqual(b.argv.slice(0, 8), [
    "flutter", "build", "ios", "--config-only", "--release", "--flavor", "dev", "--dart-define=FLAVOR=dev",
  ]);
  assert.ok(!b.argv.some((a) => a.startsWith("--split-debug-info") || a === "--obfuscate" || a.startsWith("--export-method")));
  assert.equal(b.symbolsDir, null);
  assert.ok("build" in planBuild({ platform: "ios", flavor: "dev", mode: "debug" }, { ...base, iosArtifact: "xcode" }, "abc", cfg));
});

test("arm64 only is Android-only and off unless asked", () => {
  const off = plan({ platform: "android", flavor: "staging", mode: "profile" });
  assert.ok(!off.argv.includes("--target-platform"));
  const on = plan({ platform: "android", flavor: "staging", mode: "profile" }, { arm64Only: true });
  assert.deepEqual(on.argv.slice(on.argv.indexOf("--target-platform"), on.argv.indexOf("--target-platform") + 2), [
    "--target-platform",
    "android-arm64",
  ]);
  assert.ok(!plan({ platform: "ios", flavor: "staging", mode: "release" }, { arm64Only: true }).argv.includes("--target-platform"));
  assert.equal(plan({ platform: "android", flavor: "staging", mode: "debug" }, { arm64Only: true }).notes.length, 1);
});

test("parseRequest leaves arm64 only and toggles off by default", () => {
  const r = parseRequest({ targets: [{ platform: "android", flavor: "dev", mode: "release" }] }, cfg);
  assert.ok("options" in r && r.options.arm64Only === false && r.options.toggles.length === 0);
});
