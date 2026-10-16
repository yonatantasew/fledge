import assert from "node:assert/strict";
import { test } from "node:test";
import { installBlocker, parseAdb } from "./devices.ts";

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
});

test("only directly installable builds get an install", () => {
  assert.equal(installBlocker({ platform: "android", artifact: "apk" }), null);
  assert.equal(installBlocker({ platform: "ios", artifact: "app" }), null);
  assert.equal(installBlocker({ platform: "ios", artifact: "ipa", exportMethod: "development" }), null);
  assert.match(installBlocker({ platform: "ios", artifact: "ipa", exportMethod: "app-store" })!, /TestFlight/);
  assert.match(installBlocker({ platform: "android", artifact: "appbundle" })!, /Play/);
  assert.ok(installBlocker({ platform: "ios", artifact: "xcode" }));
});
