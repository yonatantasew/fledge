import assert from "node:assert/strict";
import { test } from "node:test";
import { exportErrors, freshest, mismatch, pinnedVersion } from "./collect.ts";

test("picks the newest file written since the build started", () => {
  const files = [
    { name: "App UAT.ipa", mtime: 2_000 },
    { name: "App Staging.ipa", mtime: 1_000 },
  ];
  assert.equal(freshest(files, 1_500), "App UAT.ipa");
});

test("an older build's file is never taken, however new it is among the rest", () => {
  const files = [
    { name: "App Staging.ipa", mtime: 1_000 },
    { name: "App.ipa", mtime: 900 },
  ];
  assert.equal(freshest(files, 1_500), null);
  assert.equal(freshest([], 0), null);
});

test("a file written in the build's first millisecond counts", () => {
  assert.equal(freshest([{ name: "a.ipa", mtime: 1_500 }], 1_500), "a.ipa");
});

test("reads Xcode's export errors once each, in order", () => {
  const log = [
    "Building release-testing IPA...",
    "Encountered error while creating the IPA:",
    "error: exportArchive No Accounts",
    'error: exportArchive No signing certificate "iOS Distribution" found',
    "error: exportArchive No Accounts",
    'error: exportArchive No signing certificate "iOS Distribution" found',
  ].join("\n");
  assert.deepEqual(exportErrors(log), ["No Accounts", 'No signing certificate "iOS Distribution" found']);
  assert.deepEqual(exportErrors("Built build/ios/ipa/App.ipa"), []);
});

test("a version counts as pinned only when the command gives both halves", () => {
  assert.equal(pinnedVersion(["flutter", "build", "ipa", "--build-name=1.3.1", "--build-number=57"]), "1.3.1+57");
  assert.equal(pinnedVersion(["flutter", "build", "ipa", "--build-name=1.3.1"]), undefined);
  assert.equal(pinnedVersion(["flutter", "build", "ipa"]), undefined);
});

test("another flavor's app is caught by its bundle id, a stale one by its version", () => {
  assert.equal(
    mismatch({ bundleId: "com.example.app", version: "1.2.16+56" }, { bundleId: "com.example.app.uat", version: "1.3.1+57" }),
    "the artifact is com.example.app 1.2.16+56, but this build is com.example.app.uat 1.3.1+57",
  );
  assert.equal(
    mismatch({ bundleId: "com.example.app", version: "1.2.16+56" }, { bundleId: "com.example.app" }),
    null,
  );
});

test("what the config or the read-back doesn't say is not held against the build", () => {
  assert.equal(mismatch({ bundleId: "com.example.app", version: "1.3.1+57" }, { bundleId: "com.example.app", version: "1.3.1+57" }), null);
  assert.equal(mismatch({}, { bundleId: "com.example.app" }), null);
  assert.equal(mismatch({ bundleId: "com.example.app" }, {}), null);
});
