// Fledge server: runs `fvm flutter build` for the selections the UI
// sends and streams the log back over SSE.
//
// Local only. It binds to 127.0.0.1, rejects foreign Host/Origin headers (DNS
// rebinding, cross-site POSTs) and only executes argv built by commands.ts.
//
// Scheduling (scheduler.ts): one Android and one iOS build may run at once;
// builds of the same platform queue. Two iOS builds would clobber each other's
// ios/Flutter/Generated.xcconfig (and archive with the wrong flavor's settings)
// and two Gradle builds contend for ~/.gradle locks. `pub get` is the one step
// both platforms share, so the runner does it itself, once per checkout at a
// time, and starts the builds with --no-pub.

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { appendFile, cp, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { artifactPath, parseRequest, planBuild, XCARCHIVE_PATH, type PlannedBuild, type SkippedBuild } from "./commands.ts";
import { cancelLogin, firebaseStatus, onFirebaseChange, startLogin } from "./firebase.ts";
import { templateGithub, templateSlack, type ReleaseFacts } from "./notes.ts";
import { connections, draftWithClaude, gatherFacts, publish, releases, validatePublish } from "./release.ts";
import { startable } from "./scheduler.ts";
import { CONFIG, CONFIG_FILE, REPO_ROOT } from "./repo.ts";
import { flavorOf } from "./config.ts";
import { install, installBlocker, listDevices, NeedsReplace } from "./devices.ts";

const run = promisify(execFile);
const PORT = Number(process.env.PORT ?? 4417);
const HOST = "127.0.0.1";
const DEV = process.argv.includes("--dev");
const TOOL_DIR = path.resolve(import.meta.dirname, "..");
const ARCHIVE = "build/fledge";
const MAX_PARALLEL = Math.max(1, Number(process.env.MAX_PARALLEL ?? 2));

// ---------------------------------------------------------------- checkouts

interface Checkout {
  path: string;
  branch: string;
  sha: string;
  dirty: number;
  version: string;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await run("git", ["-C", cwd, ...args], { maxBuffer: 8 << 20 })).stdout.trim();
}

async function worktreePaths(): Promise<string[]> {
  const out = await git(REPO_ROOT, "worktree", "list", "--porcelain");
  return out
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length))
    .filter((p) => existsSync(path.join(p, "pubspec.yaml")));
}

async function describe(p: string): Promise<Checkout> {
  const [branch, sha, status, pubspec] = await Promise.all([
    git(p, "rev-parse", "--abbrev-ref", "HEAD"),
    git(p, "rev-parse", "--short=8", "HEAD"),
    git(p, "status", "--porcelain", "--untracked-files=no"),
    readFile(path.join(p, "pubspec.yaml"), "utf8"),
  ]);
  return {
    path: p,
    branch,
    sha,
    dirty: status ? status.split("\n").length : 0,
    version: /^version:\s*(\S+)/m.exec(pubspec)?.[1] ?? "?",
  };
}

async function checkouts(): Promise<Checkout[]> {
  return Promise.all((await worktreePaths()).map(describe));
}

/** Only paths git lists as worktrees of this repo may be built. */
async function resolveCheckout(p: unknown): Promise<string | null> {
  if (typeof p !== "string") return null;
  return (await worktreePaths()).includes(p) ? p : null;
}

const FLUTTER_CMD = await run("which", ["fvm"]).then(
  () => "fvm",
  () => "flutter",
);

let flutterVersion: Promise<string> | null = null;
function getFlutterVersion(cwd: string): Promise<string> {
  flutterVersion ??= run(FLUTTER_CMD, [...(FLUTTER_CMD === "fvm" ? ["flutter"] : []), "--version", "--machine"], {
    cwd,
  })
    .then(({ stdout }) => JSON.parse(stdout.slice(stdout.indexOf("{"))).frameworkVersion as string)
    .catch(() => "unknown");
  return flutterVersion;
}

// --------------------------------------------------------------------- jobs

type Status = "queued" | "running" | "succeeded" | "failed" | "cancelled";

interface Job {
  id: string;
  checkout: string;
  branch: string;
  sha: string;
  platform: PlannedBuild["platform"];
  flavor: PlannedBuild["flavor"];
  mode: PlannedBuild["mode"];
  artifact: PlannedBuild["artifact"];
  command: string;
  notes: string[];
  status: Status;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  exitCode?: number | null;
  archiveDir?: string;
  artifactFile?: string;
  xcarchive?: string;
  verified?: Record<string, string>;
  error?: string;
  install?: { state: "installing" | "installed" | "failed" | "needs-replace"; device: string; message?: string; at: number };
}

// Fallback when the artifact's bundle id could not be read back (aapt2 missing).
const bundleIdOf = (job: Job) => {
  const f = flavorOf(CONFIG, job.flavor);
  return job.platform === "ios" ? f?.iosId : f?.androidId;
};
const exportMethodOf = (job: Job) => /--export-method=(\S+)/.exec(job.command)?.[1];

const jobs: Job[] = [];
const logs = new Map<string, string>();
const argvs = new Map<string, string[]>();
// Running jobs and the process each is currently waiting on (pub get, then the build).
const running = new Map<string, { job: Job; child: ChildProcess | null }>();
// Per checkout: the pub get in flight (others wait on it), and the pubspec
// state it last succeeded for (so later builds skip it while nothing changed).
const pubLocks = new Map<string, Promise<unknown>>();
const pubDone = new Map<string, string>();
const clients = new Set<http.ServerResponse>();
let publishing = false;

function broadcast(event: string, data: unknown) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) c.write(msg);
}
const publishJobs = () => broadcast("jobs", jobs);
onFirebaseChange((s) => broadcast("firebase", s));

async function log(job: Job, chunk: string) {
  // `offset` lets a client that fetched the log mid-build drop chunks it already has.
  const offset = logs.get(job.id)?.length ?? 0;
  logs.set(job.id, (logs.get(job.id) ?? "") + chunk);
  broadcast("log", { id: job.id, chunk, offset });
  if (job.archiveDir) await appendFile(path.join(job.archiveDir, "build.log"), chunk).catch(() => {});
}

function stamp(d = new Date()) {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// The last build started per lane, so the scheduler can keep Android build types together.
const lastStarted: Record<string, { checkout: string; mode: string }> = {};

function pump() {
  for (const job of startable(jobs, MAX_PARALLEL, lastStarted)) {
    lastStarted[job.platform] = { checkout: job.checkout, mode: job.mode };
    void runJob(job);
  }
}

function flutterArgv(argv: string[]) {
  return FLUTTER_CMD === "fvm" ? ["fvm", ...argv] : argv;
}

/** Runs one step of a job; its process is the one Cancel stops. */
async function step(slot: { job: Job; child: ChildProcess | null }, argv: string[]): Promise<number | null> {
  const job = slot.job;
  const [cmd, ...args] = flutterArgv(argv);
  await log(job, `$ ${[cmd, ...args].join(" ")}\n`);
  // detached: its own process group, so Cancel can stop xcodebuild/gradle too.
  const child = spawn(cmd, args, { cwd: job.checkout, detached: true });
  slot.child = child;
  child.stdout.setEncoding("utf8").on("data", (c: string) => void log(job, c));
  child.stderr.setEncoding("utf8").on("data", (c: string) => void log(job, c));
  const code = await new Promise<number | null>((resolve) => {
    child.on("error", (e) => {
      void log(job, `\n${e.message}\n`);
      resolve(-1);
    });
    child.on("close", resolve);
  });
  slot.child = null;
  return code;
}

async function pubspecState(checkout: string) {
  const m = async (f: string) => (await stat(path.join(checkout, f)).catch(() => null))?.mtimeMs ?? "missing";
  return [await m("pubspec.yaml"), await m("pubspec.lock"), await m(".dart_tool/package_config.json")].join("|");
}

/** `pub get` once per checkout at a time; skipped while pubspec is unchanged since the console last ran it. */
async function pubGet(slot: { job: Job; child: ChildProcess | null }): Promise<number | null> {
  const checkout = slot.job.checkout;
  for (;;) {
    const inflight = pubLocks.get(checkout);
    if (!inflight) break;
    await log(slot.job, "Waiting for the other build's pub get in this checkout…\n");
    await inflight;
  }
  // Take the lock before the next await, or two waiters could both get here.
  let release!: () => void;
  pubLocks.set(checkout, new Promise<void>((r) => (release = r)));
  try {
    if ((slot.job.status as Status) === "cancelled") return null;
    if (pubDone.get(checkout) === (await pubspecState(checkout))) {
      await log(slot.job, "Dependencies already resolved for this checkout; skipping pub get.\n\n");
      return 0;
    }
    const code = await step(slot, ["flutter", "pub", "get"]);
    if (code === 0) pubDone.set(checkout, await pubspecState(checkout));
    return code;
  } finally {
    pubLocks.delete(checkout);
    release();
  }
}

async function runJob(job: Job) {
  const slot = { job, child: null as ChildProcess | null };
  // Synchronously, so the scheduler sees the lane as busy before any await.
  running.set(job.id, slot);
  job.status = "running";
  job.startedAt = Date.now();
  job.archiveDir = path.join(job.checkout, ARCHIVE, `${stamp()}-${job.platform}-${job.flavor}-${job.mode}`);
  publishJobs();
  try {
    await mkdir(job.archiveDir, { recursive: true });
    await log(job, `${job.branch} @ ${job.sha} in ${job.checkout}\n\n`);

    const pub = await pubGet(slot);
    let code: number | null = pub;
    if ((job.status as Status) !== "cancelled" && pub === 0) {
      code = await step(slot, [...argvs.get(job.id)!, "--no-pub"]);
    }
    job.exitCode = code;

    // Cancel flips the status from the HTTP handler while we await the child.
    if ((job.status as Status) === "cancelled") {
      await log(job, "\nCancelled.\n");
    } else if (pub !== 0) {
      job.status = "failed";
      job.error = `pub get exited with ${pub}`;
    } else if (code === 0) {
      try {
        await collect(job);
        job.status = "succeeded";
      } catch (e) {
        job.status = "failed";
        job.error = `built, but collecting the artifact failed: ${(e as Error).message}`;
        await log(job, `\n${job.error}\n`);
      }
    } else {
      job.status = "failed";
      job.error = `flutter exited with ${code}`;
    }
  } catch (e) {
    job.status = "failed";
    job.error = (e as Error).message;
  } finally {
    running.delete(job.id);
    job.endedAt = Date.now();
    await writeFile(path.join(job.archiveDir, "job.json"), JSON.stringify(job, null, 2)).catch(() => {});
    publishJobs();
    pump();
  }
}

function cancel(job: Job) {
  if (job.status === "queued") {
    job.status = "cancelled";
    job.endedAt = Date.now();
    return;
  }
  const slot = running.get(job.id);
  if (job.status !== "running" || !slot) return;
  job.status = "cancelled";
  if (slot.child?.pid) {
    try {
      process.kill(-slot.child.pid, "SIGTERM");
    } catch {}
  }
}

/** Copies the artifact (and symbols) out of build/ before the next build overwrites them, then reads back what was actually built. */
async function collect(job: Job) {
  if (job.artifact === "xcode") return prepareXcode(job);
  let src = path.join(job.checkout, artifactPath(job));
  if (job.artifact === "ipa") {
    const ipas = (await readdir(src)).filter((f) => f.endsWith(".ipa"));
    if (ipas.length === 0) throw new Error(`no .ipa in ${src}`);
    const withTimes = await Promise.all(ipas.map(async (f) => ({ f, t: (await stat(path.join(src, f))).mtimeMs })));
    src = path.join(src, withTimes.sort((a, b) => b.t - a.t)[0].f);
  }
  const ext = path.extname(src);
  const abi = job.command.includes("--target-platform android-arm64") ? "-arm64" : "";
  const dest = path.join(job.archiveDir!, `${job.platform}-${job.flavor}-${job.mode}${abi}${ext}`);
  await cp(src, dest, { recursive: true, verbatimSymlinks: true });
  job.artifactFile = dest;

  const plan = argvs.get(job.id)!;
  const symbols = plan.find((a) => a.startsWith("--split-debug-info="))?.split("=")[1];
  if (symbols) await cp(path.join(job.checkout, symbols), path.join(job.archiveDir!, "symbols"), { recursive: true });

  if (job.artifact === "ipa") {
    // The archive `flutter build ipa` made on the way: open it in Organizer to
    // Distribute without re-archiving in Xcode (and without any config step).
    const archive = path.join(job.checkout, XCARCHIVE_PATH);
    if (existsSync(archive)) {
      job.xcarchive = path.join(job.archiveDir!, `ios-${job.flavor}-${job.mode}.xcarchive`);
      await cp(archive, job.xcarchive, { recursive: true, verbatimSymlinks: true });
    }
  }

  job.verified = await verify(job, dest).catch((e) => ({ error: String(e.message ?? e) }));
  await log(job, `\nArchived ${dest}\nVerified: ${JSON.stringify(job.verified)}\n`);
}


async function osascript(script: string) {
  return (await run("osascript", ["-e", script], { timeout: 90_000 })).stdout.trim();
}
const xcodeRunning = () => run("pgrep", ["-x", "Xcode"]).then(() => true, () => false);

/**
 * "Prepare Xcode": the config-only build has just rewritten Generated.xcconfig
 * for this flavor. Xcode keeps the old values in memory until the workspace is
 * reopened, which is how an archive ends up built with the previous flavor's
 * settings. So restart Xcode on the workspace and select the flavor's scheme.
 */
async function prepareXcode(job: Job) {
  const xcconfig = await readFile(path.join(job.checkout, "ios/Flutter/Generated.xcconfig"), "utf8");
  const read = (k: string) => new RegExp(`^${k}=(.*)$`, "m").exec(xcconfig)?.[1] ?? "";
  job.verified = { version: `${read("FLUTTER_BUILD_NAME")}+${read("FLUTTER_BUILD_NUMBER")}` };
  const key = CONFIG.flavorDefine;
  if (key) {
    const flavor = read("DART_DEFINES")
      .split(",")
      .map((e) => Buffer.from(e, "base64").toString("utf8"))
      .find((d) => d.startsWith(`${key}=`))
      ?.slice(key.length + 1);
    if (flavor !== job.flavor) throw new Error(`Generated.xcconfig says ${key}=${flavor ?? "(none)"}, expected ${job.flavor}`);
    job.verified.flavor = flavor;
  }
  await log(job, `\nGenerated.xcconfig: ${JSON.stringify(job.verified)}\n`);

  if (await xcodeRunning()) {
    await log(job, "Quitting Xcode so it re-reads the config (it will ask about unsaved changes)…\n");
    await osascript('tell application "Xcode" to quit').catch(() => "");
    for (let i = 0; i < 60 && (await xcodeRunning()); i++) await new Promise((r) => setTimeout(r, 1000));
    if (await xcodeRunning()) {
      job.notes = [...job.notes, "Xcode did not quit — quit it yourself, then reopen ios/Runner.xcworkspace"];
      await log(job, "Xcode is still running (a save prompt was probably cancelled). Quit it, then open ios/Runner.xcworkspace.\n");
      return;
    }
  }

  const workspace = path.join(job.checkout, "ios/Runner.xcworkspace");
  await run("open", ["-a", "Xcode", workspace]);
  const scheme = flavorOf(CONFIG, job.flavor)?.xcodeScheme ?? job.flavor;
  // Best effort: wait for the workspace to load, then pick the flavor's scheme.
  const picked = await osascript(`tell application "Xcode"
    repeat 60 times
      try
        set ws to first workspace document whose path is "${workspace}"
        if loaded of ws then
          set active scheme of ws to scheme "${scheme}" of ws
          return name of active scheme of ws
        end if
      end try
      delay 1
    end repeat
    return ""
  end tell`).catch(() => "");
  job.verified.scheme = picked || "(select it yourself)";
  await log(job, `Opened ${workspace}${picked ? ` with scheme ${picked}` : ""}. Archive with Product › Archive.\n`);
  job.artifactFile = workspace;
}

async function verify(job: Job, file: string): Promise<Record<string, string>> {
  if (job.platform === "ios") {
    let plist = path.join(file, "Info.plist");
    if (job.artifact === "ipa") {
      plist = path.join(job.archiveDir!, "Info.plist");
      const { stdout } = await run("zipinfo", ["-1", file]);
      const entry = stdout.split("\n").find((l) => /^Payload\/[^/]+\.app\/Info\.plist$/.test(l));
      if (!entry) throw new Error("no Info.plist in the IPA");
      const data = await run("unzip", ["-p", file, entry], { encoding: "buffer", maxBuffer: 4 << 20 });
      await writeFile(plist, data.stdout);
    }
    const read = async (k: string) => (await run("/usr/libexec/PlistBuddy", ["-c", `Print ${k}`, plist])).stdout.trim();
    return {
      version: `${await read("CFBundleShortVersionString")}+${await read("CFBundleVersion")}`,
      bundleId: await read("CFBundleIdentifier"),
    };
  }
  if (job.artifact === "apk") {
    const aapt2 = await findAapt2();
    if (!aapt2) return { note: "aapt2 not found; version not read back" };
    const { stdout } = await run(aapt2, ["dump", "badging", file], { maxBuffer: 16 << 20 });
    const m = /package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'/.exec(stdout);
    return m ? { version: `${m[3]}+${m[2]}`, bundleId: m[1] } : { note: "could not parse aapt2 output" };
  }
  return { note: "app bundles are not read back" };
}

async function findAapt2(): Promise<string | null> {
  const sdk = process.env.ANDROID_HOME ?? path.join(process.env.HOME ?? "", "Library/Android/sdk");
  const dir = path.join(sdk, "build-tools");
  const versions = await readdir(dir).catch(() => [] as string[]);
  const latest = versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
  return latest && existsSync(path.join(dir, latest, "aapt2")) ? path.join(dir, latest, "aapt2") : null;
}

/** Past builds survive a restart: each archive folder carries its job.json. */
async function loadHistory() {
  for (const p of await worktreePaths()) {
    const dir = path.join(p, ARCHIVE);
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      const raw = await readFile(path.join(dir, name, "job.json"), "utf8").catch(() => null);
      if (!raw) continue;
      const job = JSON.parse(raw) as Job;
      if (job.install?.state === "installing") job.install = { ...job.install, state: "failed", message: "interrupted by a restart" };
      if (!jobs.some((j) => j.id === job.id)) jobs.push(job);
      const l = await readFile(path.join(dir, name, "build.log"), "utf8").catch(() => "");
      logs.set(job.id, l);
    }
  }
  jobs.sort((a, b) => a.createdAt - b.createdAt);
}

async function plan(body: unknown) {
  const parsed = parseRequest(body, CONFIG);
  if ("error" in parsed) return { error: parsed.error };
  const checkout = await resolveCheckout((body as Record<string, unknown>).checkout);
  if (!checkout) return { error: "checkout is not a worktree of this repository" };
  const info = await describe(checkout);
  const builds: PlannedBuild[] = [];
  const skipped: SkippedBuild[] = [];
  for (const t of parsed.targets) {
    const r = planBuild(t, parsed.options, info.sha, CONFIG);
    if ("build" in r) builds.push(r.build);
    else skipped.push(r.skipped);
  }
  return { checkout: info, builds, skipped };
}

// --------------------------------------------------------------------- http

function send(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  let raw = "";
  for await (const c of req) {
    raw += c;
    if (raw.length > 64 << 10) throw new Error("body too large");
  }
  return raw ? JSON.parse(raw) : {};
}

const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

async function api(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  if (req.method === "POST") {
    if (!req.headers["content-type"]?.startsWith("application/json")) return send(res, 415, { error: "JSON only" });
    const origin = req.headers.origin;
    if (origin && !ALLOWED_HOSTS.has(origin.replace(/^https?:\/\//, ""))) return send(res, 403, { error: "bad origin" });
  }
  const parts = url.pathname.split("/").filter(Boolean); // ["api", ...]

  if (req.method === "GET" && url.pathname === "/api/devices") return send(res, 200, await listDevices());

  if (req.method === "GET" && url.pathname === "/api/info") {
    const list = await checkouts();
    const main = list[0]?.path;
    return send(res, 200, {
      checkouts: list,
      flutter: await getFlutterVersion(main),
      cli: FLUTTER_CMD,
      config: CONFIG_FILE,
      flavors: CONFIG.flavors.map(({ name, label, confirm }) => ({ name, label, confirm })),
      toggles: CONFIG.toggles.map(({ id, label, hint, skipFlavors }) => ({ id, label, hint, skipFlavors })),
      releases: CONFIG.release !== null,
    });
  }

  if (req.method === "GET" && url.pathname === "/api/events") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(`event: jobs\ndata: ${JSON.stringify(jobs)}\n\n`);
    clients.add(res);
    const ping = setInterval(() => res.write(": ping\n\n"), 15000);
    req.on("close", () => {
      clearInterval(ping);
      clients.delete(res);
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/firebase") {
    return send(res, 200, await firebaseStatus(url.searchParams.has("refresh") ? 0 : 60_000));
  }
  if (req.method === "POST" && url.pathname === "/api/firebase/login") return send(res, 200, startLogin());
  if (req.method === "POST" && url.pathname === "/api/firebase/login/cancel") {
    cancelLogin();
    return send(res, 200, { ok: true });
  }

  if (req.method === "GET" && url.pathname === "/api/release/config") {
    const r = CONFIG.release;
    return send(res, 200, r && {
      baseBranch: r.github.baseBranch,
      branch: r.versionBump.branch,
      prTitle: r.versionBump.prTitle,
      jira: r.jira ? { fromStatus: r.jira.fromStatus, toStatus: r.jira.toStatus } : null,
    });
  }

  if (req.method === "GET" && url.pathname === "/api/release/connections") return send(res, 200, await connections());
  if (req.method === "GET" && url.pathname === "/api/release/tags") return send(res, 200, await releases());

  if (req.method === "POST" && url.pathname === "/api/release/facts") {
    const b = (await readJson(req)) as { baseTag?: unknown; prerelease?: unknown };
    const baseTag = typeof b.baseTag === "string" && /^v[\w.+-]+$/.test(b.baseTag) ? b.baseTag : null;
    const facts = await gatherFacts(baseTag, b.prerelease !== false);
    return send(res, 200, { facts, templates: { slack: templateSlack(facts), github: templateGithub(facts) } });
  }

  // Re-renders the template after the UI edits the facts (excluded PRs, version, date).
  if (req.method === "POST" && url.pathname === "/api/release/template") {
    const { facts } = (await readJson(req)) as { facts: ReleaseFacts };
    return send(res, 200, { slack: templateSlack(facts), github: templateGithub(facts) });
  }

  if (req.method === "POST" && url.pathname === "/api/release/draft") {
    const { facts } = (await readJson(req)) as { facts: ReleaseFacts };
    try {
      return send(res, 200, await draftWithClaude(facts, { slack: templateSlack(facts), github: templateGithub(facts) }));
    } catch (e) {
      return send(res, 502, { error: `Claude: ${(e as Error).message}` });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/release/publish") {
    if (publishing) return send(res, 409, { error: "a release is already being published" });
    const p = validatePublish(await readJson(req));
    if ("error" in p) return send(res, 400, p);
    publishing = true;
    const say = (line: string) => broadcast("release", { line });
    try {
      return send(res, 200, await publish(p, say));
    } catch (e) {
      say(`Failed: ${(e as Error).message}`);
      return send(res, 500, { error: (e as Error).message });
    } finally {
      publishing = false;
    }
  }

  if (req.method === "POST" && url.pathname === "/api/plan") return send(res, 200, await plan(await readJson(req)));

  if (req.method === "POST" && url.pathname === "/api/jobs") {
    const p = await plan(await readJson(req));
    if ("error" in p) return send(res, 400, p);
    for (const b of p.builds) {
      const job: Job = {
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        checkout: p.checkout.path,
        branch: p.checkout.branch,
        sha: p.checkout.sha,
        platform: b.platform,
        flavor: b.flavor,
        mode: b.mode,
        artifact: b.artifact,
        command: (FLUTTER_CMD === "fvm" ? ["fvm", ...b.argv] : b.argv).join(" "),
        notes: b.notes,
        status: "queued",
        createdAt: Date.now(),
      };
      argvs.set(job.id, b.argv);
      jobs.push(job);
    }
    publishJobs();
    pump();
    return send(res, 200, { queued: p.builds.length, skipped: p.skipped });
  }

  if (req.method === "POST" && url.pathname === "/api/jobs/stop") {
    // Queued first, so nothing new starts when a running job's exit calls pump().
    const queued = jobs.filter((j) => j.status === "queued");
    const live = jobs.filter((j) => j.status === "running");
    for (const j of [...queued, ...live]) cancel(j);
    publishJobs();
    return send(res, 200, { cancelled: queued.length, stopped: live.length });
  }

  if (req.method === "POST" && url.pathname === "/api/jobs/clear") {
    for (let i = jobs.length - 1; i >= 0; i--) if (jobs[i].status !== "queued" && jobs[i].status !== "running") jobs.splice(i, 1);
    publishJobs();
    return send(res, 200, { ok: true });
  }

  const job = parts[1] === "jobs" && parts[2] ? jobs.find((j) => j.id === parts[2]) : undefined;
  if (parts[1] === "jobs" && parts[2] && !job) return send(res, 404, { error: "no such job" });

  if (job && req.method === "GET" && parts[3] === "log") {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end(logs.get(job.id) ?? "");
    return;
  }

  if (job && req.method === "POST" && parts[3] === "cancel") {
    cancel(job);
    publishJobs();
    return send(res, 200, { ok: true });
  }

  if (job && req.method === "POST" && parts[3] === "install") {
    const b = (await readJson(req)) as { deviceId?: unknown; launch?: unknown; replace?: unknown };
    if (job.status !== "succeeded" || !job.artifactFile || !existsSync(job.artifactFile)) {
      return send(res, 400, { error: "only a finished build with its artifact can be installed" });
    }
    const blocked = installBlocker({ platform: job.platform, artifact: job.artifact, exportMethod: exportMethodOf(job) });
    if (blocked) return send(res, 400, { error: blocked });
    if (job.install?.state === "installing") return send(res, 409, { error: "already installing this build" });
    const device = (await listDevices()).find((d) => d.id === b.deviceId && d.platform === job.platform);
    if (!device) return send(res, 404, { error: "that device is not connected" });
    if (!device.available) return send(res, 409, { error: `${device.name} is not ready (${device.detail})` });

    job.install = { state: "installing", device: device.name, at: Date.now() };
    publishJobs();
    send(res, 202, { ok: true });

    const target = {
      platform: job.platform,
      mode: job.mode,
      artifact: job.artifact,
      file: job.artifactFile,
      bundleId: job.verified?.bundleId ?? bundleIdOf(job) ?? "",
      exportMethod: exportMethodOf(job),
      arm64Only: job.command.includes("--target-platform android-arm64"),
    };
    await log(job, `\n— Install on ${device.name} (${device.detail}) —\n`);
    try {
      await install(target, device, { launch: b.launch === true, replace: b.replace === true }, (t) => log(job, t));
      job.install = { state: "installed", device: device.name, at: Date.now() };
      await log(job, `Installed on ${device.name}.\n`);
    } catch (e) {
      const replace = e instanceof NeedsReplace;
      job.install = { state: replace ? "needs-replace" : "failed", device: device.name, message: (e as Error).message, at: Date.now() };
      await log(job, `${replace ? "Needs replace" : "Install failed"}: ${(e as Error).message}\n`);
    }
    if (job.archiveDir) await writeFile(path.join(job.archiveDir, "job.json"), JSON.stringify(job, null, 2)).catch(() => {});
    publishJobs();
    return;
  }

  if (job && req.method === "POST" && parts[3] === "organizer") {
    // Opening an .xcarchive imports it into Xcode's Organizer, ready to Distribute.
    if (!job.xcarchive || !existsSync(job.xcarchive)) return send(res, 404, { error: "this build has no archive" });
    spawn("open", [job.xcarchive], { stdio: "ignore" }).unref();
    return send(res, 200, { ok: true });
  }

  if (job && req.method === "POST" && parts[3] === "reveal") {
    // The path comes from the job record, never from the request.
    const target = job.artifactFile ?? job.archiveDir;
    if (!target || !existsSync(target)) return send(res, 404, { error: "nothing to show" });
    spawn("open", ["-R", target], { stdio: "ignore" }).unref();
    return send(res, 200, { ok: true });
  }

  send(res, 404, { error: "not found" });
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

async function serveStatic(res: http.ServerResponse, url: URL) {
  const dist = path.join(TOOL_DIR, "dist");
  let file = path.normalize(path.join(dist, decodeURIComponent(url.pathname)));
  if (!file.startsWith(dist + path.sep) || !existsSync(file) || (await stat(file)).isDirectory()) {
    file = path.join(dist, "index.html");
  }
  if (!existsSync(file)) return send(res, 503, { error: "UI not built: run `npm start` (or `npm run dev`)" });
  res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
}

const vite = DEV
  ? await (await import("vite")).createServer({
      root: TOOL_DIR,
      server: { middlewareMode: true, hmr: { port: PORT + 1 } },
      appType: "spa",
    })
  : null;

await loadHistory();

http
  .createServer(async (req, res) => {
    if (!ALLOWED_HOSTS.has(req.headers.host ?? "")) return send(res, 403, { error: "bad host" });
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    try {
      if (url.pathname.startsWith("/api/")) return await api(req, res, url);
      if (vite) return vite.middlewares(req, res);
      return await serveStatic(res, url);
    } catch (e) {
      if (!res.headersSent) send(res, 500, { error: (e as Error).message });
    }
  })
  .listen(PORT, HOST, () => {
    console.log(`fledge → http://localhost:${PORT}  (${REPO_ROOT})${DEV ? "  [dev]" : ""}`);
  });

process.on("SIGINT", () => {
  for (const { child } of running.values()) {
    if (child?.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {}
    }
  }
  process.exit(0);
});
