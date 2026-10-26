import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { flutterRoot, marksAllowedFailures, profileIpaBlocked, xcodeMajor } from "./toolchain.ts";

// The two shapes of xcode_backend.dart's runSync, before and after the fix.
const before = `
    if (resultStderr.isNotEmpty) {
      final StringBuffer errorOutput = StringBuffer();
      if (result.exitCode != 0) {
        // "error:" prefix makes this show up as an Xcode compilation error.
        errorOutput.write('error: ');
      }`;
const after = `
      final StringBuffer errorOutput = StringBuffer();
      if (!allowFail && result.exitCode != 0) {
        // "error:" prefix makes this show up as an Xcode compilation error.
        errorOutput.write('error: ');
      }`;

test("tells the old error prefixing from the fixed one", () => {
  assert.equal(marksAllowedFailures(before), true);
  assert.equal(marksAllowedFailures(after), false);
  assert.equal(marksAllowedFailures("void main() {}"), null);
});

test("reads Xcode's major version", () => {
  assert.equal(xcodeMajor("Xcode 26.3\nBuild version 17C529\n"), 26);
  assert.equal(xcodeMajor("xcode-select: error: tool 'xcodebuild' requires Xcode"), null);
});

test("blocks a profile IPA only for the old script on Xcode 26 and later", () => {
  assert.match(profileIpaBlocked(before, 26, "3.24.5")!, /^Flutter 3\.24\.5 can't archive a profile IPA with Xcode 26/);
  assert.equal(profileIpaBlocked(before, 16, "3.24.5"), null);
  assert.equal(profileIpaBlocked(after, 26, "3.38.0"), null);
});

test("doesn't block what it can't tell", () => {
  assert.equal(profileIpaBlocked(null, 26, null), null);
  assert.equal(profileIpaBlocked(before, null, "3.24.5"), null);
  assert.equal(profileIpaBlocked("void main() {}", 26, null), null);
});

async function sdk(root: string) {
  await mkdir(path.join(root, "bin"), { recursive: true });
  await mkdir(path.join(root, "packages/flutter_tools/bin"), { recursive: true });
  await writeFile(path.join(root, "packages/flutter_tools/bin/xcode_backend.dart"), before);
  await writeFile(path.join(root, "bin/flutter"), "");
  return root;
}

test("finds an fvm checkout's SDK through its link, else through .fvmrc", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "fledge-sdk-"));
  const root = await sdk(path.join(tmp, "fvm/versions/3.24.5"));
  const linked = path.join(tmp, "linked");
  await mkdir(path.join(linked, ".fvm"), { recursive: true });
  await symlink(root, path.join(linked, ".fvm/flutter_sdk"));
  assert.equal(await flutterRoot(["fvm", "flutter"], linked, {}), await realpath(root));

  const pinned = path.join(tmp, "pinned");
  await mkdir(pinned);
  await writeFile(path.join(pinned, ".fvmrc"), JSON.stringify({ flutter: "3.24.5" }));
  assert.equal(await flutterRoot(["fvm", "flutter"], pinned, { FVM_CACHE_PATH: path.join(tmp, "fvm") }), root);
  assert.equal(await flutterRoot(["fvm", "flutter"], pinned, { FVM_CACHE_PATH: path.join(tmp, "nowhere") }), null);
});

test("finds a plain flutter on PATH; doesn't guess for other launchers", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "fledge-sdk-"));
  const root = await sdk(path.join(tmp, "flutter"));
  const found = await flutterRoot(["flutter"], tmp, { PATH: ["/nonexistent", path.join(root, "bin")].join(path.delimiter) });
  assert.equal(found, await realpath(root));
  assert.equal(await flutterRoot(["puro", "flutter"], tmp, { PATH: path.join(root, "bin") }), null);
});
