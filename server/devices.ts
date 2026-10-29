// Connected phones, emulators and simulators, and installing a finished build
// onto one.
//
// Android goes through adb, which lists emulators like phones. iOS phones go
// through `xcrun devicectl` (which takes a .app, so an IPA is unpacked first),
// iOS simulators through `xcrun simctl`. A device id from the request is only
// used if it matches a device the tools list right now, so nothing typed in
// the page reaches a command line.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface Device {
  platform: "android" | "ios";
  id: string;
  name: string;
  detail: string; // model / OS version
  available: boolean;
  virtual: boolean; // an Android emulator or an iOS simulator
  booted?: boolean; // iOS simulators: false means installing boots it first
}

const ADB = [process.env.ANDROID_HOME, path.join(process.env.HOME ?? "", "Library/Android/sdk")]
  .filter(Boolean)
  .map((sdk) => path.join(sdk!, "platform-tools/adb"))
  .find((p) => existsSync(p)) ?? "adb";

export async function listDevices(): Promise<Device[]> {
  const [android, ios, sims] = await Promise.all([
    androidDevices().catch(() => []),
    iosDevices().catch(() => []),
    iosSimulators().catch(() => []),
  ]);
  return [...android, ...ios, ...sims];
}

/** `adb devices -l` lines: "<serial>  device usb:… model:RT6 …". */
export function parseAdb(out: string): Device[] {
  return out
    .split("\n")
    .slice(1)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [id, state] = l.split(/\s+/);
      const model = /model:(\S+)/.exec(l)?.[1]?.replace(/_/g, " ");
      const virtual = id.startsWith("emulator-");
      const where = virtual ? `Emulator · ${id}` : id;
      return {
        platform: "android" as const,
        id,
        name: model ?? id,
        detail: state === "device" ? where : `${where} · ${state}`, // "unauthorized" = accept the prompt on the phone
        available: state === "device",
        virtual,
      };
    });
}

async function androidDevices() {
  const devices = parseAdb((await run(ADB, ["devices", "-l"], { timeout: 15_000 })).stdout);
  // An emulator's model is the system image ("sdk gphone64 arm64"); its AVD name says which one it is.
  await Promise.all(
    devices
      .filter((d) => d.virtual && d.available)
      .map(async (d) => {
        const out = await run(ADB, ["-s", d.id, "emu", "avd", "name"], { timeout: 5_000 }).then((r) => r.stdout, () => "");
        const avd = out.split("\n")[0]?.trim();
        if (avd && avd !== "OK") d.name = avd.replace(/_/g, " ");
      }),
  );
  return devices;
}

/** `xcrun simctl list devices available -j`: the iOS simulators, booted ones first. */
export function parseSimctl(json: string): Device[] {
  const data = JSON.parse(json) as { devices: Record<string, { udid: string; name: string; state: string; isAvailable?: boolean }[]> };
  const sims: Device[] = [];
  for (const [runtime, list] of Object.entries(data.devices)) {
    const os = /SimRuntime\.iOS-(\d+)-(\d+)/.exec(runtime);
    if (!os) continue; // watchOS, tvOS, visionOS
    for (const d of list) {
      if (d.isAvailable === false) continue;
      const booted = d.state === "Booted";
      sims.push({
        platform: "ios",
        id: d.udid,
        name: d.name,
        detail: `Simulator · iOS ${os[1]}.${os[2]}${booted ? " · running" : ""}`,
        available: true, // a shut-down simulator is booted on install
        virtual: true,
        booted,
      });
    }
  }
  return sims.sort((a, b) => Number(b.booted) - Number(a.booted));
}

async function iosSimulators() {
  return parseSimctl((await run("xcrun", ["simctl", "list", "devices", "available", "-j"], { timeout: 30_000, maxBuffer: 16 << 20 })).stdout);
}

async function iosDevices(): Promise<Device[]> {
  const dir = await mkdtemp(path.join(tmpdir(), "fledge-devicectl-"));
  try {
    const out = path.join(dir, "devices.json");
    await run("xcrun", ["devicectl", "list", "devices", "--json-output", out], { timeout: 30_000 });
    const data = JSON.parse(await readFile(out, "utf8")) as {
      result: {
        devices: {
          identifier: string;
          deviceProperties: { name?: string; osVersionNumber?: string };
          hardwareProperties: { platform?: string; reality?: string; marketingName?: string };
          connectionProperties: { tunnelState?: string; pairingState?: string };
        }[];
      };
    };
    return data.result.devices
      .filter((d) => d.hardwareProperties.platform === "iOS" && d.hardwareProperties.reality === "physical")
      .map((d) => ({
        platform: "ios" as const,
        id: d.identifier,
        name: d.deviceProperties.name ?? "iPhone",
        detail: [d.hardwareProperties.marketingName, d.deviceProperties.osVersionNumber && `iOS ${d.deviceProperties.osVersionNumber}`]
          .filter(Boolean)
          .join(" · "),
        // "unavailable" = not reachable now; "disconnected" = known transport, devicectl reconnects on demand.
        available: d.connectionProperties.pairingState === "paired" && d.connectionProperties.tunnelState !== "unavailable",
        virtual: false,
      }));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export interface InstallTarget {
  platform: "android" | "ios";
  mode: string;
  artifact: string;
  file: string; // archived artifact
  bundleId: string;
  exportMethod?: string;
  arm64Only?: boolean;
}

export class NeedsReplace extends Error {}

/** Why a build can't be installed directly, or null when it can. With a device, also whether it can go on that one. */
export function installBlocker(
  t: Pick<InstallTarget, "platform" | "artifact" | "exportMethod">,
  device?: Pick<Device, "platform" | "virtual" | "name">,
): string | null {
  if (t.artifact === "appbundle") return "App Bundles only install through Play; build an APK";
  if (t.artifact === "xcode") return "Prepare Xcode doesn't produce an app";
  if (t.platform === "ios" && t.artifact === "ipa" && t.exportMethod === "app-store")
    return "App Store IPAs only install through TestFlight; use Development or Ad hoc, or a .app";
  if (device && device.platform === "ios") {
    if (t.artifact === "simulator" && !device.virtual) return `a simulator app doesn't run on ${device.name}; build an IPA or a .app for a phone`;
    if (t.artifact !== "simulator" && device.virtual) return `${device.name} is a simulator; it only runs the Simulator output`;
  }
  return null;
}

export async function install(
  t: InstallTarget,
  device: Device,
  opts: { launch: boolean; replace: boolean },
  log: (s: string) => Promise<void>,
) {
  const blocked = installBlocker(t, device);
  if (blocked) throw new Error(blocked);
  if (t.platform === "android") return installAndroid(t, device, opts, log);
  if (device.virtual) return installSimulator(t, device, opts, log);
  return installIos(t, device, opts, log);
}

async function step(log: (s: string) => Promise<void>, cmd: string, args: string[], timeout = 300_000) {
  await log(`$ ${path.basename(cmd)} ${args.join(" ")}\n`);
  try {
    const { stdout, stderr } = await run(cmd, args, { timeout, maxBuffer: 16 << 20 });
    if (stdout.trim() || stderr.trim()) await log(`${[stdout, stderr].filter((s) => s.trim()).join("\n").trim()}\n`);
    return stdout;
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message: string };
    const text = [err.stdout, err.stderr].filter(Boolean).join("\n").trim() || err.message;
    await log(`${text}\n`);
    throw new Error(text.split("\n").find((l) => /fail|error/i.test(l))?.trim() ?? text.split("\n")[0]);
  }
}

async function installAndroid(t: InstallTarget, d: Device, opts: { launch: boolean; replace: boolean }, log: (s: string) => Promise<void>) {
  const s = ["-s", d.id];
  if (t.arm64Only) {
    // The APK still carries plugin code for 32-bit ARM, so Android would install
    // it on a 32-bit-only phone and it would crash on launch. Refuse up front.
    const abis = (await run(ADB, [...s, "shell", "getprop", "ro.product.cpu.abilist"], { timeout: 15_000 })).stdout.trim();
    await log(`Phone supports: ${abis || "(unknown)"}\n`);
    if (!abis.split(",").includes("arm64-v8a")) {
      throw new Error(`${d.name} doesn't support 64-bit ARM (${abis || "unknown"}); this build was made for arm64 only`);
    }
  }
  if (opts.replace) {
    await step(log, ADB, [...s, "uninstall", t.bundleId]).catch(() => {}); // not installed is fine
  }
  try {
    // -r keeps data on update; -d lets a debuggable build go over a higher versionCode.
    await step(log, ADB, [...s, "install", "-r", "-d", t.file]);
  } catch (e) {
    const msg = (e as Error).message;
    if (/INSTALL_FAILED_(UPDATE_INCOMPATIBLE|VERSION_DOWNGRADE)/.test(msg)) {
      throw new NeedsReplace(
        /VERSION_DOWNGRADE/.test(msg)
          ? "The phone has a newer build of this app. Replace it (deletes the app's data)?"
          : "The installed app is signed with a different key. Replace it (deletes the app's data)?",
      );
    }
    throw e;
  }
  if (opts.launch) {
    await step(log, ADB, [...s, "shell", "monkey", "-p", t.bundleId, "-c", "android.intent.category.LAUNCHER", "1"]);
  }
}

async function installIos(t: InstallTarget, d: Device, opts: { launch: boolean; replace: boolean }, log: (s: string) => Promise<void>) {
  let app = t.file;
  let tmp: string | null = null;
  try {
    if (t.artifact === "ipa") {
      tmp = await mkdtemp(path.join(tmpdir(), "fledge-ipa-"));
      await log("Unpacking the IPA…\n");
      await run("ditto", ["-x", "-k", t.file, tmp], { timeout: 300_000 });
      const name = (await readdir(path.join(tmp, "Payload"))).find((f) => f.endsWith(".app"));
      if (!name) throw new Error("no .app inside the IPA's Payload");
      app = path.join(tmp, "Payload", name);
    }
    if (opts.replace) {
      await step(log, "xcrun", ["devicectl", "device", "uninstall", "app", "--device", d.id, t.bundleId]).catch(() => {});
    }
    await step(log, "xcrun", ["devicectl", "device", "install", "app", "--device", d.id, app]);
    if (opts.launch) {
      if (t.mode === "debug") {
        await log("Not launching: an iOS debug build only runs with a debugger attached. Use Profile or Release.\n");
      } else {
        await step(log, "xcrun", ["devicectl", "device", "process", "launch", "--terminate-existing", "--device", d.id, t.bundleId], 60_000);
      }
    }
  } finally {
    if (tmp) await rm(tmp, { recursive: true, force: true });
  }
}

async function installSimulator(t: InstallTarget, d: Device, opts: { launch: boolean; replace: boolean }, log: (s: string) => Promise<void>) {
  const tmp = await mkdtemp(path.join(tmpdir(), "fledge-sim-"));
  try {
    // The simulator app is shipped as a zip with the .app at its top.
    await log("Unpacking the simulator app…\n");
    await run("ditto", ["-x", "-k", t.file, tmp], { timeout: 300_000 });
    const name = (await readdir(tmp)).find((f) => f.endsWith(".app"));
    if (!name) throw new Error("no .app inside the simulator zip");
    const app = path.join(tmp, name);
    if (!d.booted) {
      // bootstatus -b boots it and waits until it can take an install.
      await step(log, "xcrun", ["simctl", "bootstatus", d.id, "-b"], 300_000);
    }
    await run("open", ["-a", "Simulator"], { timeout: 30_000 }).catch(() => {}); // show it; the install works without
    if (opts.replace) {
      await step(log, "xcrun", ["simctl", "uninstall", d.id, t.bundleId]).catch(() => {});
    }
    await step(log, "xcrun", ["simctl", "install", d.id, app]);
    if (opts.launch) {
      // Unlike a phone, the simulator runs a debug build without a debugger.
      await step(log, "xcrun", ["simctl", "launch", "--terminate-running-process", d.id, t.bundleId], 60_000);
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
