import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bumpTemplatesFrom,
  ciBuildDefines,
  ciEnvironmentMatrix,
  environmentKey,
  environmentValuesInDart,
  environmentsFromEntryFiles,
  parseLaunchConfigs,
  fromEnvironmentKeys,
  githubRepoFromUrl,
  humanize,
  parseGhHosts,
  iosIdFor,
  parseGradleFlavors,
  parsePbxBundleIds,
  schemeFor,
  stripComments,
  ticketProjectFrom,
} from "./detect-parse.ts";

test("stripComments keeps URLs inside strings", () => {
  assert.equal(stripComments('a // x\nb /* y */ c "http://x.y" // z'), 'a \nb  c "http://x.y" ');
});

test("Groovy productFlavors with nested blocks and comments", () => {
  const gradle = `
android {
  defaultConfig { applicationId "com.example.app" }
  flavorDimensions "env"
  productFlavors {
    prod {
      dimension "env"
      // a comment with braces { }
      applicationId "com.example.app"
      manifestPlaceholders = [host: "x"]
    }
    staging {
      dimension "env"
      applicationIdSuffix ".staging"
      resValue "string", "app_name", "App Staging"
    }
  }
  buildTypes { release { minifyEnabled true } }
}`;
  assert.deepEqual(parseGradleFlavors(gradle), [
    { name: "prod", applicationId: "com.example.app" },
    { name: "staging", applicationId: "com.example.app.staging" },
  ]);
});

test("Kotlin DSL productFlavors", () => {
  const kts = `
android {
  defaultConfig { applicationId = "com.example.app" }
  productFlavors {
    create("dev") { dimension = "env"; applicationIdSuffix = ".dev" }
    create("prod") { dimension = "env" }
  }
}`;
  assert.deepEqual(parseGradleFlavors(kts), [
    { name: "dev", applicationId: "com.example.app.dev" },
    { name: "prod", applicationId: "com.example.app" },
  ]);
});

test("no productFlavors means no flavors", () => {
  assert.deepEqual(parseGradleFlavors("android { defaultConfig { } }"), []);
});

test("pbxproj bundle IDs per configuration, skipping test targets", () => {
  const pbx = `
    A /* Release-Staging */ = { isa = XCBuildConfiguration; buildSettings = { PRODUCT_BUNDLE_IDENTIFIER = com.example.app.staging; }; name = "Release-Staging"; };
    B /* Release-Staging */ = { isa = XCBuildConfiguration; buildSettings = { PRODUCT_BUNDLE_IDENTIFIER = com.example.app.RunnerTests; }; name = "Release-Staging"; };
    C /* Debug-Prod */ = { isa = XCBuildConfiguration; buildSettings = { PRODUCT_BUNDLE_IDENTIFIER = "com.example.app"; }; name = "Debug-Prod"; };`;
  const ids = parsePbxBundleIds(pbx);
  assert.deepEqual(ids, { "Release-Staging": "com.example.app.staging", "Debug-Prod": "com.example.app" });
  assert.equal(iosIdFor("staging", ids), "com.example.app.staging");
  assert.equal(iosIdFor("prod", ids), "com.example.app");
  assert.equal(schemeFor("staging", ["Prod", "Staging"]), "Staging");
});

test("fromEnvironment keys with their types", () => {
  const dart = `const f = String.fromEnvironment('FLAVOR'); const p = bool.fromEnvironment("VERBOSE_LOGS"); const again = String.fromEnvironment('FLAVOR', defaultValue: 'prod');`;
  assert.deepEqual(fromEnvironmentKeys(dart), [
    { key: "FLAVOR", type: "String" },
    { key: "VERBOSE_LOGS", type: "bool" },
  ]);
});

test("GitHub repo from https and ssh remotes", () => {
  assert.equal(githubRepoFromUrl("https://github.com/acme/my-app.git"), "acme/my-app");
  assert.equal(githubRepoFromUrl("git@github.com:acme/my-app.git"), "acme/my-app");
  assert.equal(githubRepoFromUrl("git@github-work:acme/my-app.git"), "acme/my-app");
  assert.equal(githubRepoFromUrl("https://gitlab.com/acme/my-app.git"), undefined);
});

test("ticket project is the most common key, and needs a few uses", () => {
  assert.equal(ticketProjectFrom(["PROJ-1: a", "PROJ-2: b", "fix (#3)", "PROJ-4: c", "OTHER-9: d", "PROJ-0000: bump"]), "PROJ");
  assert.equal(ticketProjectFrom(["PROJ-1: a"]), undefined);
});

test("bump conventions from earlier bump commits and branches", () => {
  assert.deepEqual(
    bumpTemplatesFrom(
      ["PROJ-12: add things", "PROJ-0000: bump version to v1.3.1+2"],
      ["  origin/main", "  origin/hotfix/PROJ-0000-version-bump-v1-3-1-2"],
    ),
    { commitMessage: "PROJ-0000: bump version to {tag}", branch: "hotfix/PROJ-0000-version-bump-v{versionSlug}" },
  );
  assert.deepEqual(bumpTemplatesFrom(["Bump version to 2.0.0+5"], []), { commitMessage: "Bump version to {version}", branch: undefined });
  assert.deepEqual(bumpTemplatesFrom(["nothing here"], ["origin/main"]), { commitMessage: undefined, branch: undefined });
});

test("humanize", () => {
  assert.equal(humanize("VERBOSE_LOGS"), "Verbose logs");
});

test("gh hosts.yml: logged-in accounts and the active one", () => {
  const yml = "github.com:\n    git_protocol: https\n    users:\n        work-login:\n            oauth_token: x\n        me:\n    user: me\nghe.example.com:\n    user: other\n";
  assert.deepEqual(parseGhHosts(yml), { accounts: ["work-login", "me"], active: "me" });
  assert.deepEqual(parseGhHosts(""), { accounts: [], active: undefined });
});

test("launch.json: flavor, entry file, defines and define files, with comments and trailing commas", () => {
  const jsonc = `{
    // run configs
    "configurations": [
      { "name": "Staging", "type": "dart", "request": "launch", "program": "lib/main_staging.dart",
        "args": ["--flavor", "staging", "--dart-define-from-file=config/staging.json", "--dart-define", "API=https://s.example.com",], },
      { "name": "Prod", "type": "dart", "args": ["--flavor=prod", "-t", "\${workspaceFolder}/lib/main_prod.dart"] },
      { "name": "Attach", "type": "dart", "request": "attach" },
      { "name": "Chrome", "type": "pwa-chrome", "args": ["--flavor", "x"] },
    ],
  }`;
  assert.deepEqual(parseLaunchConfigs(jsonc), [
    { name: "Staging", flavor: "staging", target: "lib/main_staging.dart", defines: { API: "https://s.example.com" }, defineFiles: ["config/staging.json"] },
    { name: "Prod", flavor: "prod", target: "lib/main_prod.dart", defines: {}, defineFiles: [] },
  ]);
  assert.deepEqual(parseLaunchConfigs("not json"), []);
});

test("environments from lib/main_<env>.dart", () => {
  assert.deepEqual(environmentsFromEntryFiles(["main.dart", "main_dev.dart", "main_prod.dart", "app.dart"]), [
    { name: "dev", target: "lib/main_dev.dart" },
    { name: "prod", target: "lib/main_prod.dart" },
  ]);
});

test("environment key, values from Dart comparisons and from a CI matrix", () => {
  assert.equal(environmentKey(["GIT_SHA", "APP_ENVIRONMENT"]), "APP_ENVIRONMENT");
  assert.equal(environmentKey(["BASE_URL", "MY_APP_ENV"]), "MY_APP_ENV");
  assert.equal(environmentKey(["BASE_URL"]), undefined);
  const dart = ["if (environment == 'production') {}", "switch (env) { case 'staging': break; case 'sandbox': break; case 'blue': break; }"];
  assert.deepEqual(environmentValuesInDart(dart), ["production", "staging", "sandbox"]);
  assert.deepEqual(ciEnvironmentMatrix("    strategy:\n      matrix:\n        environment: [ sandbox, staging, production ]\n"), ["sandbox", "staging", "production"]);
  assert.deepEqual(ciEnvironmentMatrix("matrix:\n  os: [ubuntu]\n"), []);
});

test("dart-defines on CI build lines, marking ones that come from variables", () => {
  const yml = "run: flutter build apk --release --dart-define=BASE_URL=$BASE_URL --dart-define=APP_ENVIRONMENT=staging --dart-define=V=${{ env.TAG }}\nrun: echo --dart-define=NOT=me";
  assert.deepEqual(ciBuildDefines(yml), [
    { key: "BASE_URL", value: "$BASE_URL", variable: true },
    { key: "APP_ENVIRONMENT", value: "staging", variable: false },
    { key: "V", value: "${{", variable: true },
  ]);
});
