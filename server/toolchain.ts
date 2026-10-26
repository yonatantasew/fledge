// Flutter + Xcode pairs that can't archive a profile IPA.
//
// Until flutter/flutter#172913 (in 3.38), xcode_backend.dart put "error:" in
// front of a failing helper command's output even when that command was
// allowed to fail, such as the Info.plist lookups for NSBonjourServices and
// NSLocalNetworkUsageDescription. From Xcode 26 those lookups fail when the
// key is absent, and Xcode treats the lines as errors, so `flutter build ipa
// --profile` archives for minutes and then stops with "Encountered error
// while archiving for device". Release builds don't run the lookups.

import { existsSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const BACKEND = "packages/flutter_tools/bin/xcode_backend.dart";

/** Whether xcode_backend.dart marks allowed failures as errors; null when it can't be told. */
export function marksAllowedFailures(source: string): boolean | null {
  const m = /if \((!allowFail && )?result\.exitCode != 0\) \{\s*(?:\/\/[^\n]*\s*)*errorOutput\.write\('error: '\)/.exec(source);
  return m ? !m[1] : null;
}

/** The major version in `xcodebuild -version` output. */
export function xcodeMajor(output: string): number | null {
  const m = /^Xcode (\d+)/m.exec(output);
  return m ? Number(m[1]) : null;
}

/** Why a profile IPA can't be archived with this toolchain, or null when it can (or it can't be told). */
export function profileIpaBlocked(backend: string | null, xcode: number | null, flutterVersion: string | null): string | null {
  if (!backend || xcode === null || xcode < 26 || marksAllowedFailures(backend) !== true) return null;
  const flutter = flutterVersion ? `Flutter ${flutterVersion}` : "This Flutter";
  return `${flutter} can't archive a profile IPA with Xcode ${xcode} (fixed in Flutter 3.38): choose .app (device) to install it, or a release IPA to hand it out`;
}

/**
 * The Flutter SDK a checkout builds with, found from files only: running
 * `flutter --version` can wait on the lock a running build holds.
 */
export async function flutterRoot(flutter: string[], checkout: string, env = process.env): Promise<string | null> {
  const isSdk = (dir: string) => existsSync(path.join(dir, BACKEND));
  if (flutter[0] === "fvm") {
    const linked = await realpath(path.join(checkout, ".fvm", "flutter_sdk")).catch(() => null);
    if (linked && isSdk(linked)) return linked;
    const pinned = await readFile(path.join(checkout, ".fvmrc"), "utf8").then((t) => JSON.parse(t).flutter as unknown, () => null);
    if (typeof pinned !== "string") return null;
    const dir = path.join(env.FVM_CACHE_PATH ?? path.join(os.homedir(), "fvm"), "versions", pinned);
    return isSdk(dir) ? dir : null;
  }
  if (path.basename(flutter[0]) !== "flutter") return null; // puro and wrappers: not told
  for (const dir of path.isAbsolute(flutter[0]) ? [path.dirname(flutter[0])] : (env.PATH ?? "").split(path.delimiter)) {
    const exe = await realpath(path.join(dir, "flutter")).catch(() => null);
    const root = exe && path.dirname(path.dirname(exe)); // <root>/bin/flutter
    if (root && isSdk(root)) return root;
  }
  return null;
}

/** The SDK's xcode_backend.dart and version, read from its folder. */
export async function readSdk(root: string): Promise<{ backend: string | null; version: string | null }> {
  const backend = await readFile(path.join(root, BACKEND), "utf8").catch(() => null);
  const version = await readFile(path.join(root, "version"), "utf8").then((v) => v.trim() || null, () => null);
  return { backend, version };
}
