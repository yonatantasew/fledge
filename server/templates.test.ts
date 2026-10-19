import assert from "node:assert/strict";
import { test } from "node:test";
import { parseConfig } from "./config.ts";
import { expand, generateCommands, templateProblems } from "./templates.ts";

const env = (o: Partial<{ name: string; flavor: string | null; target: string; vars: Record<string, string> }> = {}) => ({
  name: "dev",
  flavor: "dev",
  target: undefined as string | undefined,
  vars: {},
  ...o,
});

test("templates are checked against the environments they'll be filled for", () => {
  assert.deepEqual(templateProblems("{flutter} build apk --flavor {flavor}", [env()]), []);
  assert.match(templateProblems("{flutter} build apk --flavor {flavor}", [env({ flavor: null })]).join(), /dev has no flavor/);
  assert.match(templateProblems("x -t {target}", [env()]).join(), /dev has no target/);
  assert.match(templateProblems("x --a={options}", [env()]).join(), /separate word/);
  assert.match(templateProblems("x {NOPE}", [env()]).join(), /isn't a placeholder/);
  assert.deepEqual(templateProblems("x --url={API_URL}", [env({ vars: { API_URL: "u" } })]), []);
  assert.match(templateProblems("{flutter} pub get {mode}", [env()], ["flutter"]).join(), /can't be used here/);
  assert.deepEqual(templateProblems("   ", [env()]), ["is empty"]);
});

test("parseConfig rejects a commands section that can't be filled", () => {
  assert.throws(() => parseConfig({ flavors: [{ name: "a", flavor: null }], commands: { android: { apk: "flutter build apk --flavor {flavor}" } } }), /commands\.android\.apk/);
  assert.throws(() => parseConfig({ flavors: [{ name: "a" }], commands: { android: { exe: "x" } } }), /unknown output/);
  assert.throws(() => parseConfig({ flavors: [{ name: "a", vars: { mode: "x" } }] }), /fledge's own placeholders/);
  assert.equal(parseConfig({ flavors: [{ name: "a" }], commands: {} }).commands?.pubGet, "{flutter} pub get");
  assert.equal(parseConfig({ flavors: [{ name: "a" }], commands: { pubGet: null } }).commands?.pubGet, null);
});

test("generated commands write shared settings literally and use placeholders only where environments differ", () => {
  const c = parseConfig({
    flavors: [{ name: "staging" }, { name: "prod" }],
    defines: { BUILD_SOURCE: "local" },
    args: { all: ["--no-tree-shake-icons"] },
  });
  const g = generateCommands(c);
  assert.equal(
    g.android.apk,
    "{flutter} build apk --{mode} --flavor {flavor} --dart-define=FLAVOR={env} --dart-define=GIT_SHA={sha} --dart-define=BUILD_SOURCE=local {options} {version} --no-tree-shake-icons --no-pub",
  );
  assert.equal(
    g.ios.ipa,
    "{flutter} build ipa --{mode} --flavor {flavor} --dart-define=FLAVOR={env} --dart-define=GIT_SHA={sha} --dart-define=BUILD_SOURCE=local {options} --export-method={exportMethod} {version} --no-tree-shake-icons --no-pub",
  );
  assert.equal(g.ios.xcode?.startsWith("{flutter} build ios --config-only --{mode}"), true);
  assert.equal(g.pubGet, "{flutter} pub get");

  const mixed = generateCommands(parseConfig({ flavors: [{ name: "a" }, { name: "b", flavor: null, target: "lib/main_b.dart", defines: { X: "1" } }] }));
  assert.match(mixed.android.apk!, /\{flavorArgs\} \{targetArgs\}.*\{envDefines\}/);
});

test("expand fills inline and whole-word placeholders", () => {
  const c = parseConfig({ flavors: [{ name: "b", flavor: null, target: "lib/main_b.dart", defines: { X: "1" }, defineFiles: ["c/b.json"], vars: { U: "u" } }] });
  const argv = expand("{flutter} build apk --{mode} {flavorArgs} {targetArgs} {envDefines} {envDefineFiles} --u={U} --env={env} {options} {version}", {
    flutter: ["fvm", "flutter"],
    mode: "release",
    env: c.flavors[0],
    sha: "abc",
    exportMethod: "ad-hoc",
    options: ["--obfuscate"],
    version: [],
  });
  assert.deepEqual(argv, ["fvm", "flutter", "build", "apk", "--release", "-t", "lib/main_b.dart", "--dart-define=X=1", "--dart-define-from-file=c/b.json", "--u=u", "--env=b", "--obfuscate"]);
});
