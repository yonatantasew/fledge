import assert from "node:assert/strict";
import { test } from "node:test";
import { startable } from "./scheduler.ts";

const j = (id: string, platform: string, status = "queued") => ({ id, platform, status });
const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

test("starts one Android and one iOS job side by side", () => {
  assert.deepEqual(ids(startable([j("a1", "android"), j("a2", "android"), j("i1", "ios")], 2)), ["a1", "i1"]);
});

test("a busy lane holds its own queue but not the other lane's", () => {
  const jobs = [j("a1", "android", "running"), j("a2", "android"), j("i1", "ios")];
  assert.deepEqual(ids(startable(jobs, 2)), ["i1"]);
});

test("never more than maxParallel at once", () => {
  assert.deepEqual(ids(startable([j("a1", "android"), j("i1", "ios")], 1)), ["a1"]);
  assert.deepEqual(ids(startable([j("a1", "android", "running"), j("i1", "ios")], 1)), []);
});

test("finished and cancelled jobs are ignored", () => {
  const jobs = [j("a0", "android", "succeeded"), j("i0", "ios", "cancelled"), j("i1", "ios")];
  assert.deepEqual(ids(startable(jobs, 2)), ["i1"]);
});

const a = (id: string, mode: string, status = "queued", checkout = "c1") => ({ id, platform: "android", status, mode, checkout });

test("Android runs the same build type as the last Android build next", () => {
  const jobs = [a("d1", "debug"), a("r2", "release"), a("d3", "debug")];
  assert.deepEqual(ids(startable(jobs, 2, { android: { checkout: "c1", mode: "release" } })), ["r2"]);
  assert.deepEqual(ids(startable(jobs, 2, { android: { checkout: "c1", mode: "debug" } })), ["d1"]);
});

test("grouping is per checkout, and plain FIFO when nothing matches", () => {
  const jobs = [a("d1", "debug"), a("r2", "release", "queued", "c2")];
  assert.deepEqual(ids(startable(jobs, 2, { android: { checkout: "c1", mode: "release" } })), ["d1"]);
  assert.deepEqual(ids(startable(jobs, 2)), ["d1"]);
});

test("iOS stays strictly FIFO", () => {
  const jobs = [
    { id: "i1", platform: "ios", status: "queued", mode: "debug", checkout: "c1" },
    { id: "i2", platform: "ios", status: "queued", mode: "release", checkout: "c1" },
  ];
  assert.deepEqual(ids(startable(jobs, 2, { ios: { checkout: "c1", mode: "release" } })), ["i1"]);
});
