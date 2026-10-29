import assert from "node:assert/strict";
import { test } from "node:test";
import { installBlocker, parseAdb, parseSimctl } from "./devices.ts";

test("parseAdb reads ready, unauthorized and offline devices", () => {
  const out = [
    "List of devices attached",
    "OUKITELRT631366        device usb:0-1 product:RT6_NFC_EEA model:RT6 device:RT6 transport_id:1",
    "emulator-5554          unauthorized transport_id:2",
    "",
  ].join("\n");
  const d = parseAdb(out);
  assert.equal(d.length, 2);
  assert.deepEqual(
    { id: d[0].id, name: d[0].name, available: d[0].available },
    { id: "OUKITELRT631366", name: "RT6", available: true },
  );
  assert.equal(d[1].available, false);
  assert.match(d[1].detail, /unauthorized/);
  assert.equal(d[0].virtual, false);
  assert.equal(d[1].virtual, true);
  assert.match(d[1].detail, /^Emulator · emulator-5554/);
});

test("parseSimctl lists available iOS simulators, running ones first", () => {
  const json = JSON.stringify({
    devices: {
      "com.apple.CoreSimulator.SimRuntime.watchOS-26-2": [{ udid: "W1", name: "Apple Watch", state: "Shutdown", isAvailable: true }],
      "com.apple.CoreSimulator.SimRuntime.iOS-26-3": [
        { udid: "A1", name: "iPhone 17 Pro", state: "Shutdown", isAvailable: true },
        { udid: "B2", name: "iPhone 17", state: "Booted", isAvailable: true },
        { udid: "C3", name: "iPhone Old", state: "Shutdown", isAvailable: false },
      ],
    },
  });
  const sims = parseSimctl(json);
  assert.deepEqual(sims.map((s) => s.id), ["B2", "A1"]);
  assert.ok(sims.every((s) => s.platform === "ios" && s.virtual && s.available));
  assert.equal(sims[0].detail, "Simulator · iOS 26.3 · running");
  assert.equal(sims[1].booted, false);
});

test("only directly installable builds get an install", () => {
  assert.equal(installBlocker({ platform: "android", artifact: "apk" }), null);
  assert.equal(installBlocker({ platform: "ios", artifact: "app" }), null);
  assert.equal(installBlocker({ platform: "ios", artifact: "ipa", exportMethod: "development" }), null);
  assert.match(installBlocker({ platform: "ios", artifact: "ipa", exportMethod: "app-store" })!, /TestFlight/);
  assert.match(installBlocker({ platform: "android", artifact: "appbundle" })!, /Play/);
  assert.ok(installBlocker({ platform: "ios", artifact: "xcode" }));
  assert.equal(installBlocker({ platform: "ios", artifact: "simulator" }), null);
});

test("the simulator app only goes on simulators, and phone builds only on phones", () => {
  const phone = { platform: "ios" as const, virtual: false, name: "iPhone 12" };
  const sim = { platform: "ios" as const, virtual: true, name: "iPhone 17" };
  const emulator = { platform: "android" as const, virtual: true, name: "Pixel 8" };
  assert.equal(installBlocker({ platform: "ios", artifact: "simulator" }, sim), null);
  assert.match(installBlocker({ platform: "ios", artifact: "simulator" }, phone)!, /doesn't run on iPhone 12/);
  assert.match(installBlocker({ platform: "ios", artifact: "app" }, sim)!, /is a simulator/);
  assert.match(installBlocker({ platform: "ios", artifact: "ipa", exportMethod: "ad-hoc" }, sim)!, /is a simulator/);
  assert.equal(installBlocker({ platform: "ios", artifact: "app" }, phone), null);
  assert.equal(installBlocker({ platform: "android", artifact: "apk" }, emulator), null);
});
