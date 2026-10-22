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
import { createReadStream, existsSync, statSync } from "node:fs";
import { appendFile, cp, mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { artifactPath, parseRequest, planBuild, resolveFlutter, XCARCHIVE_PATH, type PlannedBuild, type SkippedBuild } from "./commands.ts";
import { generateCommands, tokenize } from "./templates.ts";
import { cancelLogin, firebaseStatus, onFirebaseChange, startLogin } from "./firebase.ts";
import { bumpValues, templateDeploy, templateGithub, templateSlack, type ReleaseFacts } from "./notes.ts";
import { changesBetween, connections, gatherFacts, notesRequest, publish, releases, validatePublish } from "./release.ts";
import { Deployer, deployKey, type Deployment } from "./deploy.ts";
import { answerApproval, getConversation, listConversations, newConversation, pendingApprovals, send as sendToAssistant } from "./ai/agent.ts";
import { availableModels, connectorFor, listProviders, removeProvider, saveProvider, setActive } from "./ai/providers.ts";
import { MCP_CONVERSATION, mcpServer } from "./ai/mcp.ts";
import { structuredAnswer } from "./ai/structured.ts";
import type { ToolContext } from "./ai/tools.ts";
import { startable } from "./scheduler.ts";
import { fill, flavorOf, parseConfig, SLACK_CHANNEL, type FledgeConfig } from "./config.ts";
import { setSlackToken, shipFile, shipFiles, slackToken, whoAmI } from "./slack.ts";
import { detectProject } from "./detect.ts";
import {
  addProject,
  findCandidates,
  FLEDGE_HOME,
  flutterRepoRoot,
  getProject,
  listEntries,
  listProjects,
  localConfigPath,
  removeProject,
  saveLocalConfig,
  type Project,
} from "./projects.ts";
import { startupProject } from "./repo.ts";
import { fingerprint } from "./fingerprint.ts";
import { inside, listArchive } from "./archive.ts";
import { install, installBlocker, listDevices, NeedsReplace, type Device } from "./devices.ts";

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

async function worktreePaths(root: string): Promise<string[]> {
  const out = await git(root, "worktree", "list", "--porcelain").catch(() => "");
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

async function checkouts(project: Project): Promise<Checkout[]> {
  return Promise.all((await worktreePaths(project.root)).map(describe));
}

/** Only paths git lists as worktrees of the app's repository may be built. */
async function resolveCheckout(project: Project, p: unknown): Promise<string | null> {
  if (typeof p !== "string") return null;
  return (await worktreePaths(project.root)).includes(p) ? p : null;
}

/** A registered app whose config loaded, or an error to send back. */
async function usableProject(id: unknown): Promise<{ project: Project & { config: FledgeConfig } } | { error: string }> {
  const project = await getProject(id);
  if (!project) return { error: "unknown app" };
  if (!project.config) return { error: project.error ?? `${project.name} has no fledge config yet` };
  return { project: project as Project & { config: FledgeConfig } };
}

/** The command that runs Flutter in a checkout, per the app's `flutter` setting. */
function flutterFor(config: FledgeConfig, checkout: string): string[] {
  return resolveFlutter(config.flutter, projectFiles(checkout));
}

function projectFiles(checkout: string) {
  return {
    fvmConfig: existsSync(path.join(checkout, ".fvmrc")) || existsSync(path.join(checkout, ".fvm", "fvm_config.json")),
    puroConfig: existsSync(path.join(checkout, ".puro.json")),
  };
}


const installed = new Map<string, Promise<boolean>>();
function isInstalled(cmd: string): Promise<boolean> {
  if (path.isAbsolute(cmd)) return Promise.resolve(existsSync(cmd));
  if (!installed.has(cmd)) installed.set(cmd, run("which", [cmd]).then(() => true, () => false));
  return installed.get(cmd)!;
}

const versions = new Map<string, Promise<string>>();
function getFlutterVersion(command: string[], cwd: string): Promise<string> {
  const key = `${command.join(" ")}@${cwd}`;
  if (!versions.has(key)) {
    versions.set(
      key,
      run(command[0], [...command.slice(1), "--version", "--machine"], { cwd, timeout: 60_000 })
        .then(({ stdout }) => JSON.parse(stdout.slice(stdout.indexOf("{"))).frameworkVersion as string)
        .catch(() => "unknown"),
    );
  }
  return versions.get(key)!;
}

// --------------------------------------------------------------------- jobs

type Status = "queued" | "running" | "succeeded" | "failed" | "cancelled";

interface Job {
  id: string;
  project: string; // registered app id
  projectName: string;
  checkout: string;
  branch: string;
  sha: string;
  platform: PlannedBuild["platform"];
  flavor: PlannedBuild["flavor"];
  mode: PlannedBuild["mode"];
  nativeFlavor?: string | null; // missing on builds recorded before environments could skip --flavor
  pubGet?: string[] | null; // run once per checkout before the build; null when the config turns it off
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
  steps?: Step[]; // missing on builds recorded before steps were
  deployment?: string; // the deployment it was queued for
  version?: string; // the version it was queued to build (verified.version is what came out)
  argv?: string[]; // the exact command, kept so a stopped build can be resumed after a restart
  tree?: string; // fingerprint of the checkout when the build stopped or failed (see fingerprint())
  attempt?: number; // 2 and up once resumed
}

/** One stage of a build, with where its output starts and ends in the build's log. */
interface Step {
  id: string; // "pub" | "build" | "collect" | "install-<n>"
  label: string;
  state: "running" | "succeeded" | "failed" | "skipped" | "cancelled";
  detail?: string;
  logStart: number;
  logEnd?: number;
  startedAt: number;
  endedAt?: number;
}

function beginStep(job: Job, id: string, label: string) {
  (job.steps ??= []).push({ id, label, state: "running", logStart: logs.get(job.id)?.length ?? 0, startedAt: Date.now() });
  publishJobs();
}

function endStep(job: Job, id: string, state: Step["state"], detail?: string) {
  const step = job.steps?.findLast((s) => s.id === id && s.state === "running");
  if (!step) return;
  Object.assign(step, { state, detail, logEnd: logs.get(job.id)?.length ?? 0, endedAt: Date.now() });
  publishJobs();
}

// Fallback when the artifact's bundle id could not be read back (aapt2 missing).
const bundleIdOf = (job: Job, config: FledgeConfig | null) => {
  const f = config ? flavorOf(config, job.flavor) : undefined;
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
let deployer: Deployer | null = null; // set up with the deployments, further down
const publishJobs = () => {
  broadcast("jobs", jobs);
  deployer?.tick(); // a build that finished may be the last one a deployment waits for
};
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

/** Runs one step of a job; its process is the one Cancel stops. */
async function step(slot: { job: Job; child: ChildProcess | null }, argv: string[]): Promise<number | null> {
  const job = slot.job;
  const [cmd, ...args] = argv;
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
      endStep(slot.job, "pub", "skipped", "already resolved");
      return 0;
    }
    if (!slot.job.pubGet) {
      await log(slot.job, "pub get is turned off in this app's commands (commands.pubGet is null).\n\n");
      endStep(slot.job, "pub", "skipped", "turned off in the config");
      return 0;
    }
    const code = await step(slot, slot.job.pubGet);
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
  // A resumed build keeps its folder, so its log and artifacts stay together.
  job.archiveDir ??= path.join(job.checkout, ARCHIVE, `${stamp()}-${job.platform}-${job.flavor}-${job.mode}`);
  publishJobs();
  try {
    await mkdir(job.archiveDir, { recursive: true });
    if (job.attempt) await log(job, `\n— Resumed: attempt ${job.attempt}, the same command on the same files —\n`);
    await log(job, `${job.branch} @ ${job.sha} in ${job.checkout}\n\n`);

    beginStep(job, "pub", "pub get");
    const pub = await pubGet(slot);
    // Cancel flips the status from the HTTP handler while we await the child.
    const cancelled = () => (job.status as Status) === "cancelled";
    endStep(job, "pub", cancelled() ? "cancelled" : pub === 0 ? "succeeded" : "failed", pub === 0 || cancelled() ? undefined : `exited with ${pub}`);
    let code: number | null = pub;
    if (!cancelled() && pub === 0) {
      beginStep(job, "build", `flutter build ${job.artifact === "xcode" ? "ios --config-only" : job.artifact}`);
      code = await step(slot, argvs.get(job.id)!);
      endStep(job, "build", cancelled() ? "cancelled" : code === 0 ? "succeeded" : "failed", code === 0 || cancelled() ? undefined : `exited with ${code}`);
    }
    job.exitCode = code;

    if (cancelled()) {
      await log(job, "\nCancelled.\n");
    } else if (pub !== 0) {
      job.status = "failed";
      job.error = `pub get exited with ${pub}`;
    } else if (code === 0) {
      beginStep(job, "collect", job.artifact === "xcode" ? "Open Xcode" : "Archive and verify");
      try {
        await collect(job);
        job.status = "succeeded";
        endStep(job, "collect", "succeeded", job.verified?.version);
      } catch (e) {
        job.status = "failed";
        job.error = `built, but collecting the artifact failed: ${(e as Error).message}`;
        await log(job, `\n${job.error}\n`);
        endStep(job, "collect", "failed", (e as Error).message.split("\n")[0]);
      }
    } else {
      job.status = "failed";
      job.error = `flutter exited with ${code}`;
    }
  } catch (e) {
    job.status = "failed";
    job.error = (e as Error).message;
    for (const st of job.steps ?? []) if (st.state === "running") endStep(job, st.id, "failed", job.error);
  } finally {
    running.delete(job.id);
    job.endedAt = Date.now();
    // What the files were when it stopped, including what the build itself
    // changed (pubspec.lock, Podfile.lock…): resuming needs them unchanged since.
    if ((job.status as Status) === "cancelled" || job.status === "failed") job.tree = await fingerprint(job.checkout).catch(() => undefined);
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
  let src = path.join(job.checkout, artifactPath({ ...job, nativeFlavor: job.nativeFlavor === undefined ? job.flavor : job.nativeFlavor }));
  if (job.artifact === "apk" && !existsSync(src)) {
    // Gradle names APKs after the flavor as declared; if the guess is off, take the newest one.
    const dir = path.dirname(src);
    const apks = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith(".apk"));
    const times = await Promise.all(apks.map(async (f) => ({ f, t: (await stat(path.join(dir, f))).mtimeMs })));
    const newest = times.sort((a, b) => b.t - a.t)[0];
    if (newest && newest.t >= (job.startedAt ?? 0)) src = path.join(dir, newest.f);
  }
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
  const key = (await getProject(job.project))?.config?.flavorDefine ?? null;
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
  const projectConfig = (await getProject(job.project))?.config;
  const scheme = (projectConfig && flavorOf(projectConfig, job.flavor)?.xcodeScheme) ?? job.flavor;
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
  for (const project of await listProjects()) {
    for (const p of await worktreePaths(project.root)) {
      const dir = path.join(p, ARCHIVE);
      for (const name of await readdir(dir).catch(() => [] as string[])) {
        const raw = await readFile(path.join(dir, name, "job.json"), "utf8").catch(() => null);
        if (!raw) continue;
        const job = JSON.parse(raw) as Job;
        job.project ??= project.id; // builds from before fledge managed several apps
        job.projectName ??= project.name;
        if (job.install?.state === "installing") job.install = { ...job.install, state: "failed", message: "interrupted by a restart" };
        if (!jobs.some((j) => j.id === job.id)) jobs.push(job);
        logs.set(job.id, await readFile(path.join(dir, name, "build.log"), "utf8").catch(() => ""));
      }
    }
  }
  jobs.sort((a, b) => a.createdAt - b.createdAt);
}

// ------------------------------------------------------------------ assistant

/** The assistant's read-only view of fledge (see ai/tools.ts). */
const assistantContext: ToolContext = {
  async apps() {
    return (await listProjects()).map((p) => ({ id: p.id, name: p.name, root: p.root, ready: !!p.config, source: p.source, error: p.error ?? null }));
  },
  async app(id) {
    const p = await getProject(id);
    if (!p) return null;
    return {
      id: p.id,
      name: p.name,
      root: p.root,
      source: p.source,
      error: p.error,
      config: p.config && {
        flavors: p.config.flavors.map(({ name, label, flavor, target, confirm }) => ({ name, label, flavor, target, confirm })),
        toggles: p.config.toggles.map(({ id, label }) => ({ id, label })),
        commands: p.config.commands ?? generateCommands(p.config),
        release: p.config.release && {
          repo: p.config.release.github.repo,
          baseBranch: p.config.release.github.baseBranch,
          tickets: p.config.release.tickets?.project,
          jira: p.config.release.jira ? { from: p.config.release.jira.fromStatus, to: p.config.release.jira.toStatus } : null,
        },
      },
    };
  },
  async checkouts(id) {
    const p = await getProject(id);
    return p ? checkouts(p) : [];
  },
  builds: () => jobs,
  log: (id) => logs.get(id),
  devices: () => listDevices(),
  async releases(id) {
    const p = await getProject(id);
    return p?.config?.release ? releases(p) : [];
  },
  async changes(id, since) {
    const p = await getProject(id);
    if (!p?.config?.release) throw new Error("releases aren't set up for this app");
    const tag = since ?? (await releases(p))[0]?.tag ?? null;
    const f = await gatherFacts(p, tag, true);
    return {
      since: f.previous?.tag ?? "(first release)",
      range: `${f.previous?.base.slice(0, 8) ?? "start"}..${f.head.sha.slice(0, 8)}`,
      suggestedVersion: f.version,
      prs: f.prs.map((pr) => ({ number: pr.number, title: pr.title, dri: pr.dri, tickets: pr.tickets, files: pr.changedFiles, versionBump: pr.versionBump, stackedOn: pr.stackedOn })),
      tickets: Object.fromEntries(Object.entries(f.tickets).map(([k, t]) => [k, { summary: t.summary, status: t.status, assignee: t.assignee }])),
    };
  },
  async plan(id, checkout, target, output) {
    const options: Record<string, unknown> = {};
    if (output) options[target.platform === "android" ? "androidArtifact" : "iosArtifact"] = output;
    const r = await plan({ project: id, checkout, targets: [target], options });
    if ("error" in r) throw new Error(String(r.error));
    if (r.skipped.length) throw new Error(r.skipped[0].reason);
    return { command: r.builds[0].argv.join(" "), pubGetFirst: r.pubGet?.join(" ") ?? null, notes: r.builds[0].notes };
  },
  async prepareBuilds(id, checkout, targets, options) {
    const r = await plan({ project: id, checkout, targets, options });
    if ("error" in r) throw new Error(String(r.error));
    const flavors = (await getProject(id))?.config?.flavors ?? [];
    const label = (name: string) => flavors.find((f) => f.name === name);
    return {
      builds: r.builds.map((b) => ({ flavor: b.flavor, label: label(b.flavor)?.label ?? b.flavor, confirm: !!label(b.flavor)?.confirm, mode: b.mode, platform: b.platform, artifact: b.artifact })),
      skipped: r.skipped.map((s) => `${s.flavor} ${s.mode} ${s.platform}: ${s.reason}`),
      queue: () => enqueue(r).map((j) => j.id),
    };
  },
  async prepareShip(buildId, note) {
    const job = jobs.find((j) => j.id === buildId);
    if (!job) throw new Error("no build with that id");
    const plan = await shipPlan(job, note);
    if ("error" in plan) throw new Error(plan.error);
    return {
      channel: plan.channel,
      text: plan.text,
      file: plan.file.name,
      size: plan.size,
      async ship() {
        await runShip(job, plan);
        return `Shipped ${plan.file.name} to ${plan.channel}.`;
      },
    };
  },
  async releaseDraft(id, since, prerelease, exclude) {
    const p = await getProject(id);
    const r = p?.config?.release;
    if (!p || !r) throw new Error("releases aren't set up for this app");
    const all = await gatherFacts(p, since ?? (await releases(p))[0]?.tag ?? null, prerelease);
    // As the Release tab does: version-bump PRs never go in the notes.
    const facts = { ...all, prerelease, prs: all.prs.filter((pr) => !pr.versionBump && !exclude.includes(pr.number)) };
    return {
      facts,
      templates: { slack: templateSlack(facts), github: templateGithub(facts) },
      baseBranch: r.github.baseBranch,
      bumpBranch: fill(r.versionBump.branch, bumpValues(facts)),
      jira: r.jira ? { from: r.jira.fromStatus, to: r.jira.toStatus } : null,
    };
  },
  async publishRelease(id, req) {
    const p = await getProject(id);
    if (!p?.config?.release) throw new Error("releases aren't set up for this app");
    if (publishing) throw new Error("a release is already being published");
    const checked = validatePublish(req);
    if ("error" in checked) throw new Error(checked.error);
    publishing = true;
    // The Release tab shows the same live log.
    const say = (line: string) => broadcast("release", { project: p.id, line });
    try {
      return await publish(p, checked, say);
    } catch (e) {
      say(`Failed: ${(e as Error).message}`);
      throw e;
    } finally {
      publishing = false;
    }
  },
  async prepareResume(id) {
    const job = jobs.find((j) => j.id === id);
    if (!job) throw new Error("no build with that id");
    const blocked = await resumeBlocker(job);
    if (blocked) throw new Error(blocked);
    return { attempt: (job.attempt ?? 1) + 1, resume: () => resume(job) };
  },
  cancelBuild(id) {
    const job = jobs.find((j) => j.id === id);
    if (job) cancel(job);
    publishJobs();
  },
  async prepareInstall(buildId, deviceId) {
    const job = jobs.find((j) => j.id === buildId);
    if (!job) throw new Error("no build with that id");
    const ready = await installable(job, deviceId);
    if ("error" in ready) throw new Error(ready.error);
    return {
      device: `${ready.device.name} (${ready.device.detail})`,
      async install(opts) {
        await runInstall(job, ready, opts);
        return job.install;
      },
    };
  },
};

async function plan(body: unknown) {
  const u = await usableProject((body as Record<string, unknown> | null)?.project);
  if ("error" in u) return u;
  const { project } = u;
  const parsed = parseRequest(body, project.config);
  if ("error" in parsed) return { error: parsed.error };
  const checkout = await resolveCheckout(project, (body as Record<string, unknown>).checkout);
  if (!checkout) return { error: `checkout is not a worktree of ${project.name}` };
  const info = await describe(checkout);
  const flutter = flutterFor(project.config, checkout);
  const builds: PlannedBuild[] = [];
  const skipped: SkippedBuild[] = [];
  for (const t of parsed.targets) {
    const r = planBuild(t, parsed.options, info.sha, project.config, flutter);
    if ("build" in r) builds.push(r.build);
    else skipped.push(r.skipped);
  }
  const pubGetTemplate = (project.config.commands ?? generateCommands(project.config)).pubGet;
  const pubGet = pubGetTemplate ? tokenize(pubGetTemplate).flatMap((t) => (t === "{flutter}" ? flutter : [t])) : null;
  // Every program the commands start must be installed, or nothing is queued.
  for (const exe of new Set([...builds.map((b) => b.argv[0]), ...(pubGet ? [pubGet[0]] : [])])) {
    if (!(await isInstalled(exe))) {
      return { error: `${exe} isn't installed or isn't on PATH (${project.name}'s commands start with it; see "flutter" and "commands" in its config)` };
    }
  }
  // The version these builds will carry: pubspec's, with this queue's overrides.
  const [pubName, pubNumber = ""] = info.version.split("+");
  const version = `${parsed.options.buildName || pubName}+${parsed.options.buildNumber || pubNumber}`.replace(/\+$/, "");
  return { project: { id: project.id, name: project.name }, pubGet, checkout: info, version, builds, skipped };
}

/** Queues a plan's builds; returns the new jobs. */
function enqueue(p: Exclude<Awaited<ReturnType<typeof plan>>, { error: unknown }>) {
  const added: Job[] = [];
  for (const b of p.builds) {
    const job: Job = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      project: p.project.id,
      projectName: p.project.name,
      checkout: p.checkout.path,
      branch: p.checkout.branch,
      sha: p.checkout.sha,
      platform: b.platform,
      flavor: b.flavor,
      mode: b.mode,
      artifact: b.artifact,
      command: b.argv.join(" "), // exactly what runs
      pubGet: p.pubGet,
      nativeFlavor: b.nativeFlavor,
      notes: b.notes,
      status: "queued",
      createdAt: Date.now(),
    };
    job.argv = b.argv;
    job.version = p.version;
    argvs.set(job.id, b.argv);
    jobs.push(job);
    added.push(job);
  }
  publishJobs();
  pump();
  return added;
}

/** Whether a build can go on a device now, and which device. */
async function installable(job: Job, deviceId: unknown): Promise<{ device: Device; file: string } | { error: string; status: number }> {
  if (job.status !== "succeeded" || !job.artifactFile || !existsSync(job.artifactFile)) {
    return { status: 400, error: "only a finished build with its artifact can be installed" };
  }
  const blocked = installBlocker({ platform: job.platform, artifact: job.artifact, exportMethod: exportMethodOf(job) });
  if (blocked) return { status: 400, error: blocked };
  if (job.install?.state === "installing") return { status: 409, error: "already installing this build" };
  const device = (await listDevices()).find((d) => d.id === deviceId && d.platform === job.platform);
  if (!device) return { status: 404, error: "that device is not connected" };
  if (!device.available) return { status: 409, error: `${device.name} is not ready (${device.detail})` };
  return { device, file: job.artifactFile };
}

async function runInstall(job: Job, { device, file }: { device: Device; file: string }, opts: { launch: boolean; replace: boolean }) {
  job.install = { state: "installing", device: device.name, at: Date.now() };
  const stepId = `install-${(job.steps ?? []).filter((st) => st.id.startsWith("install-")).length + 1}`;
  beginStep(job, stepId, `Install on ${device.name}`);
  const target = {
    platform: job.platform,
    mode: job.mode,
    artifact: job.artifact,
    file,
    bundleId: job.verified?.bundleId ?? bundleIdOf(job, (await getProject(job.project))?.config ?? null) ?? "",
    exportMethod: exportMethodOf(job),
    arm64Only: job.command.includes("--target-platform android-arm64"),
  };
  await log(job, `\n— Install on ${device.name} (${device.detail}) —\n`);
  try {
    await install(target, device, opts, (t) => log(job, t));
    job.install = { state: "installed", device: device.name, at: Date.now() };
    await log(job, `Installed on ${device.name}.\n`);
    endStep(job, stepId, "succeeded", device.detail);
  } catch (e) {
    const replace = e instanceof NeedsReplace;
    job.install = { state: replace ? "needs-replace" : "failed", device: device.name, message: (e as Error).message, at: Date.now() };
    await log(job, `${replace ? "Needs replace" : "Install failed"}: ${(e as Error).message}\n`);
    endStep(job, stepId, "failed", replace ? "needs replace" : (e as Error).message.split("\n")[0]);
  }
  if (job.archiveDir) await writeFile(path.join(job.archiveDir, "job.json"), JSON.stringify(job, null, 2)).catch(() => {});
  publishJobs();
}

/** Why a build can't be resumed, or null when it can: stopped or failed, and nothing it builds from has changed. */
async function resumeBlocker(job: Job): Promise<string | null> {
  if (job.status !== "cancelled" && job.status !== "failed") return "only a stopped or failed build can be resumed";
  if (!job.argv && !argvs.has(job.id)) return "this build is from before fledge kept build commands; queue it again instead";
  if (!existsSync(job.checkout)) return "its checkout is gone";
  const head = (await run("git", ["-C", job.checkout, "rev-parse", "HEAD"]).catch(() => ({ stdout: "" }))).stdout.trim();
  if (!head.startsWith(job.sha)) return `the checkout moved from ${job.sha.slice(0, 8)} to ${head.slice(0, 8) || "nothing"}; queue a new build`;
  // A build stopped before it started has no fingerprint; the same commit is all it had.
  if (job.tree && job.tree !== (await fingerprint(job.checkout).catch(() => ""))) {
    return "files in the checkout changed since it stopped (uncommitted or untracked changes); queue a new build";
  }
  return null;
}

/** Runs a stopped or failed build again as the same build: same command, same folder, log continued. */
function resume(job: Job) {
  argvs.set(job.id, job.argv ?? argvs.get(job.id)!);
  job.status = "queued";
  job.attempt = (job.attempt ?? 1) + 1;
  delete job.error;
  delete job.exitCode;
  delete job.endedAt;
  publishJobs();
  pump();
}

/** What shipping a build would post, or why it can't be shipped. */
async function shipPlan(job: Job, note = ""): Promise<{ channel: string; text: string; file: { path: string; name: string }; size: number } | { error: string; needs?: "channel" | "token" }> {
  if (job.status !== "succeeded" || !job.artifactFile || !existsSync(job.artifactFile)) return { error: "only a finished build with its file can be shipped" };
  if (!["apk", "appbundle", "ipa"].includes(job.artifact)) return { error: `a ${job.artifact === "app" ? ".app (a folder)" : job.artifact} build can't be shipped; build an APK, App Bundle or IPA` };
  const config = (await getProject(job.project))?.config;
  const slack = config?.ship?.slack;
  if (!slack) return { error: "this app has no Slack channel: set ship.slack.channel in its config", needs: "channel" };
  if (!(await slackToken())) return { error: "Slack isn't connected on this Mac: paste the bot token", needs: "token" };
  const size = (await stat(job.artifactFile)).size;
  const name = path.basename(job.artifactFile);
  const values: Record<string, string> = {
    app: job.projectName,
    env: (config && flavorOf(config, job.flavor)?.label) ?? job.flavor,
    mode: job.mode,
    platform: job.platform === "ios" ? "iOS" : "Android",
    output: job.artifact,
    version: job.verified?.version ?? "?",
    bundleId: job.verified?.bundleId ?? "",
    branch: job.branch,
    sha: job.sha.slice(0, 8),
    file: name,
    size: `${(size / 1048576).toFixed(1)} MB`,
    note: note.trim(),
  };
  // A line that only held an empty placeholder (like {note}) goes.
  const text = slack.message
    .map((line) => ({ line, filled: fill(line, values) }))
    .filter(({ line, filled }) => filled.trim() || !/\{\w+\}/.test(line))
    .map(({ filled }) => filled)
    .join("\n");
  return { channel: slack.channel, text, file: { path: job.artifactFile, name }, size };
}

/** Uploads a build to Slack, as a step of the build. */
async function runShip(job: Job, plan: { channel: string; text: string; file: { path: string; name: string } }) {
  const stepId = `ship-${(job.steps ?? []).filter((st) => st.id.startsWith("ship-")).length + 1}`;
  beginStep(job, stepId, `Slack ${plan.channel}`);
  await log(job, `\n— Ship to Slack ${plan.channel} —\n`);
  try {
    const token = await slackToken();
    if (!token) throw new Error("Slack isn't connected on this Mac");
    await shipFile(token, plan.channel, plan.file, plan.text, (line) => void log(job, line));
    endStep(job, stepId, "succeeded", plan.channel);
  } catch (e) {
    const message = (e as Error).message.split("\n")[0];
    await log(job, `Ship failed: ${message}\n`);
    endStep(job, stepId, "failed", message);
    throw e;
  } finally {
    if (job.archiveDir) await writeFile(path.join(job.archiveDir, "job.json"), JSON.stringify(job, null, 2)).catch(() => {});
  }
}

// ---------------------------------------------------------------- deployments

// Builds that are posted together, with notes, once all have built (deploy.ts).
const DEPLOYMENTS = path.join(FLEDGE_HOME, "deployments.json");
const savedDeployments: Deployment[] = await readFile(DEPLOYMENTS, "utf8").then((t) => JSON.parse(t) as Deployment[], () => []);
// A restart mid-post can't know whether Slack got it.
for (const d of savedDeployments) if (d.status === "posting") ((d.status = "failed"), (d.error = "fledge restarted while posting; check the channel, then post again"));

const deployments = new Deployer(
  {
    build(id) {
      const j = jobs.find((x) => x.id === id);
      if (!j) return undefined;
      const file = j.status === "succeeded" && j.artifactFile && existsSync(j.artifactFile) ? j.artifactFile : null;
      return {
        status: j.status,
        name: `${j.flavor} ${j.mode} ${j.platform === "ios" ? "iOS" : "Android"} ${j.artifact}`,
        file: file ? { path: file, name: path.basename(file), size: statSync(file).size } : undefined,
      };
    },
    async post(channel, files, text, progress) {
      const token = await slackToken();
      if (!token) throw new Error("Slack isn't connected on this Mac: connect it from a build's Slack button");
      await shipFiles(token, channel, files, text, () => {}, progress);
    },
    cancelBuild(id) {
      const j = jobs.find((x) => x.id === id);
      if (j) cancel(j);
    },
    changed(list) {
      broadcast("deployments", list);
      void mkdir(FLEDGE_HOME, { recursive: true })
        .then(() => writeFile(`${DEPLOYMENTS}.tmp`, JSON.stringify(list, null, 2)))
        .then(() => rename(`${DEPLOYMENTS}.tmp`, DEPLOYMENTS))
        .catch(() => {});
    },
  },
  savedDeployments,
);
deployer = deployments;

/** A deploy request: a route of the app's, or the builds and channel picked by hand. */
async function deployRequest(b: Record<string, unknown>) {
  const project = await getProject(b.project);
  if (!project?.config) return { error: "unknown app, or its config doesn't load" };
  let label = "Deploy";
  let channel: string;
  let targets: unknown;
  let options: unknown;
  const route = typeof b.route === "string" ? project.config.deploy.find((r) => r.id === b.route) : undefined;
  if (b.route !== undefined && !route) return { error: `this app has no deploy route "${String(b.route)}"` };
  if (route) {
    label = route.label;
    channel = route.to.slack;
    targets = route.builds.map((x) => ({ platform: x.platform, flavor: x.environment, mode: x.mode }));
    const o = route.options;
    options = { androidArtifact: o.androidOutput, iosArtifact: o.iosOutput, exportMethod: o.exportMethod, splitDebugInfo: o.splitDebugInfo, obfuscate: o.obfuscate, arm64Only: o.arm64Only, toggles: o.toggles };
  } else {
    if (typeof b.channel !== "string" || !SLACK_CHANNEL.test(b.channel)) return { error: "a channel like #deployments is needed" };
    channel = b.channel;
    targets = b.targets;
    options = b.options;
  }
  const p = await plan({ project: project.id, checkout: b.checkout, targets, options });
  if ("error" in p) return { error: String(p.error) };
  if (!p.builds.length) return { error: `nothing can be built: ${p.skipped.map((x) => x.reason).join("; ")}` };
  if (p.builds.length > 10) return { error: "one Slack message holds 10 files; deploy at most 10 builds" };
  const head = (await run("git", ["-C", p.checkout.path, "rev-parse", "HEAD"])).stdout.trim();
  const key = deployKey(route?.id ?? null, channel, p.builds.map((x) => x.flavor));
  return { project, route: route?.id ?? null, label, channel, plan: p, head, key };
}

/** The notes a deploy would post: what changed since the last deploy under the same key. */
async function deployNotes(r: Exclude<Awaited<ReturnType<typeof deployRequest>>, { error: string }>) {
  const since = deployments.lastPosted(r.project.id, r.key);
  const changes = await changesBetween(r.project, r.plan.checkout.path, since, r.head);
  const label = (f: string) => flavorOf(r.project.config!, f)?.label ?? f;
  return {
    since,
    notes: templateDeploy({
      app: r.project.name,
      label: r.label,
      version: r.plan.version,
      builds: r.plan.builds.map((x) => ({ environment: label(x.flavor), mode: x.mode, platform: x.platform, output: x.artifact })),
      branch: r.plan.checkout.branch,
      sha: r.head,
      since,
      prs: changes.prs,
      commits: changes.commits,
    }),
  };
}

// --------------------------------------------------------------------- http

function send(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

async function readJson(req: http.IncomingMessage, limit = 64 << 10): Promise<unknown> {
  let raw = "";
  for await (const c of req) {
    raw += c;
    if (raw.length > limit) throw new Error("body too large");
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

  if (url.pathname.startsWith("/api/ai/")) return assistantApi(req, res, url);

  if (req.method === "GET" && url.pathname === "/api/info") {
    const project = await getProject(url.searchParams.get("project"));
    if (!project) return send(res, 404, { error: "unknown app" });
    const list = await checkouts(project);
    return send(res, 200, {
      project: { id: project.id, name: project.name, root: project.root },
      checkouts: list,
      flutter: project.config ? await getFlutterVersion(flutterFor(project.config, list[0]?.path ?? project.root), list[0]?.path ?? project.root) : "unknown",
      cli: project.config ? flutterFor(project.config, list[0]?.path ?? project.root).join(" ") : "",
      config: project.configFile,
      configSource: project.source,
      configError: project.error ?? null,
      flavors: project.config?.flavors.map(({ name, label, confirm }) => ({ name, label, confirm })) ?? [],
      toggles: project.config?.toggles.map(({ id, label, hint, skipFlavors }) => ({ id, label, hint, skipFlavors })) ?? [],
      releases: !!project.config?.release,
    });
  }

  // ------------------------------------------------------------- apps

  if (req.method === "GET" && url.pathname === "/api/projects") {
    return send(
      res,
      200,
      (await listProjects()).map((p) => ({
        id: p.id,
        name: p.name,
        root: p.root,
        source: p.source,
        configFile: p.configFile,
        error: p.error ?? null,
        ready: !!p.config,
      })),
    );
  }

  if (req.method === "GET" && url.pathname === "/api/projects/candidates") {
    return send(res, 200, await findCandidates((await listEntries()).map((e) => e.path)));
  }

  if (req.method === "POST" && url.pathname === "/api/projects/detect") {
    const b = (await readJson(req)) as { path?: unknown };
    const root = typeof b.path === "string" && path.isAbsolute(b.path) ? await flutterRepoRoot(b.path) : null;
    if (!root) return send(res, 400, { error: "not a Flutter project's git repository (give its full path)" });
    return send(res, 200, { root, ...(await detectProject(root)) });
  }

  if (req.method === "POST" && url.pathname === "/api/projects") {
    const b = (await readJson(req)) as { path?: unknown; name?: unknown; config?: unknown };
    if (typeof b.path !== "string" || !path.isAbsolute(b.path)) return send(res, 400, { error: "path must be a full path" });
    const name = typeof b.name === "string" && b.name.trim() ? b.name.trim().slice(0, 60) : undefined;
    try {
      const entry = await addProject(b.path, { name });
      if (b.config !== undefined) await saveLocalConfig(entry.id, b.config);
      return send(res, 200, entry);
    } catch (e) {
      return send(res, 400, { error: (e as Error).message });
    }
  }

  // "Write out commands": the config with its build commands as editable text,
  // generated from its fields (exactly what fledge runs today), and the fields
  // that now live inside the commands removed.
  const writeOut = /^\/api\/projects\/([a-z0-9-]+)\/commands$/.exec(url.pathname);
  if (writeOut && req.method === "POST") {
    if (!(await getProject(writeOut[1]))) return send(res, 404, { error: "unknown app" });
    const raw = (await readJson(req)) as { config?: unknown };
    let config: FledgeConfig;
    try {
      config = parseConfig(raw.config);
    } catch (e) {
      return send(res, 400, { error: (e as Error).message });
    }
    const out = { ...(raw.config as Record<string, unknown>) };
    for (const k of ["flavorDefine", "gitShaDefine", "defines", "defineFiles", "args"]) delete out[k];
    out.commands = config.commands ?? generateCommands(config);
    return send(res, 200, { config: out });
  }

  const projectRoute = /^\/api\/projects\/([a-z0-9-]+)(\/config)?$/.exec(url.pathname);
  if (projectRoute) {
    const project = await getProject(projectRoute[1]);
    if (!project) return send(res, 404, { error: "unknown app" });
    if (req.method === "DELETE" && !projectRoute[2]) {
      if (jobs.some((j) => j.project === project.id && (j.status === "queued" || j.status === "running"))) {
        return send(res, 409, { error: "stop this app's builds first" });
      }
      await removeProject(project.id);
      return send(res, 200, { ok: true });
    }
    if (req.method === "GET" && projectRoute[2]) {
      const text = project.source ? await readFile(project.configFile!, "utf8").catch(() => "") : "";
      return send(res, 200, { source: project.source, file: project.configFile, local: localConfigPath(project.id), text, error: project.error ?? null });
    }
    if (req.method === "PUT" && projectRoute[2]) {
      const b = (await readJson(req)) as { config?: unknown };
      try {
        return send(res, 200, { file: await saveLocalConfig(project.id, b.config) });
      } catch (e) {
        return send(res, 400, { error: (e as Error).message });
      }
    }
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

  if (url.pathname.startsWith("/api/release/")) {
    const body = req.method === "POST" ? ((await readJson(req)) as Record<string, unknown>) : {};
    const project = await getProject(req.method === "POST" ? body.project : url.searchParams.get("project"));
    if (!project) return send(res, 404, { error: "unknown app" });

    if (req.method === "GET" && url.pathname === "/api/release/config") {
      const r = project.config?.release;
      return send(res, 200, r ? {
        baseBranch: r.github.baseBranch,
        branch: r.versionBump.branch,
        prTitle: r.versionBump.prTitle,
        jira: r.jira ? { fromStatus: r.jira.fromStatus, toStatus: r.jira.toStatus } : null,
      } : null);
    }
    if (req.method === "GET" && url.pathname === "/api/release/connections") {
      // The notes are drafted by the assistant's active model.
      const ai = await listProviders();
      const active = ai.providers.find((x) => x.id === ai.active);
      const model = active ? { ok: true, name: `${active.name}${active.model ? ` · ${active.model}` : ""}` } : { ok: false, error: "no model set up — add one in the assistant's settings" };
      return send(res, 200, { ...(await connections(project)), model });
    }
    if (req.method === "GET" && url.pathname === "/api/release/tags") {
      return send(res, 200, project.config?.release ? await releases(project) : []);
    }

    if (req.method === "POST" && url.pathname === "/api/release/facts") {
      const baseTag = typeof body.baseTag === "string" && /^v[\w.+-]+$/.test(body.baseTag) ? body.baseTag : null;
      const facts = await gatherFacts(project, baseTag, body.prerelease !== false);
      return send(res, 200, { facts, templates: { slack: templateSlack(facts), github: templateGithub(facts) } });
    }

    // Re-renders the template after the UI edits the facts (excluded PRs, version, date).
    if (req.method === "POST" && url.pathname === "/api/release/template") {
      const facts = body.facts as ReleaseFacts;
      return send(res, 200, { slack: templateSlack(facts), github: templateGithub(facts) });
    }

    if (req.method === "POST" && url.pathname === "/api/release/draft") {
      const facts = body.facts as ReleaseFacts;
      // Drafted by the model that's active in the assistant's settings.
      try {
        const { connector, provider } = await connectorFor();
        const notes = await structuredAnswer(connector, notesRequest(project, facts, { slack: templateSlack(facts), github: templateGithub(facts) }));
        return send(res, 200, { ...notes, model: `${provider.name}${provider.model ? ` · ${provider.model}` : ""}` });
      } catch (e) {
        return send(res, 502, { error: (e as Error).message });
      }
    }

    if (req.method === "POST" && url.pathname === "/api/release/publish") {
      if (publishing) return send(res, 409, { error: "a release is already being published" });
      const p = validatePublish(body);
      if ("error" in p) return send(res, 400, p);
      publishing = true;
      const say = (line: string) => broadcast("release", { project: project.id, line });
      try {
        return send(res, 200, await publish(project, p, say));
      } catch (e) {
        say(`Failed: ${(e as Error).message}`);
        return send(res, 500, { error: (e as Error).message });
      } finally {
        publishing = false;
      }
    }
    return send(res, 404, { error: "not found" });
  }

  // Slack: whether this Mac has a bot token, and setting or removing it. The token never comes back.
  if (url.pathname === "/api/slack") {
    if (req.method === "GET") {
      const token = await slackToken();
      if (!token) return send(res, 200, { connected: false });
      return whoAmI(token).then((w) => send(res, 200, { connected: true, ...w }), (e: Error) => send(res, 200, { connected: false, error: e.message }));
    }
    if (req.method === "POST") {
      const b = (await readJson(req)) as { token?: unknown };
      return setSlackToken(typeof b.token === "string" ? b.token.trim() : "").then(
        (w) => send(res, 200, { connected: true, ...w }),
        (e: Error) => send(res, 400, { error: e.message }),
      );
    }
    if (req.method === "DELETE") return setSlackToken(null).then(() => send(res, 200, { connected: false }));
  }

  // Deployments: preview the notes, start one, list them, post what built, cancel.
  if (url.pathname === "/api/deployments" && req.method === "GET") return send(res, 200, deployments.all(url.searchParams.get("project") ?? undefined));
  if (url.pathname === "/api/deploy/preview" && req.method === "POST") {
    const r = await deployRequest((await readJson(req)) as Record<string, unknown>);
    if ("error" in r) return send(res, 400, r);
    const n = await deployNotes(r).catch((e: Error) => ({ error: e.message }));
    if ("error" in n) return send(res, 502, { error: `couldn't gather the changes: ${n.error}` });
    return send(res, 200, {
      label: r.label,
      channel: r.channel,
      version: r.plan.version,
      checkout: { branch: r.plan.checkout.branch, sha: r.head },
      builds: r.plan.builds.map((x) => ({ platform: x.platform, flavor: x.flavor, mode: x.mode, artifact: x.artifact })),
      skipped: r.plan.skipped,
      since: n.since,
      notes: n.notes,
    });
  }
  if (url.pathname === "/api/deploy" && req.method === "POST") {
    const b = (await readJson(req, 256 << 10)) as Record<string, unknown>;
    if (typeof b.notes !== "string" || !b.notes.trim()) return send(res, 400, { error: "the notes are empty" });
    if (b.notes.length > 30_000) return send(res, 400, { error: "the notes are too long for one Slack message" });
    const r = await deployRequest(b);
    if ("error" in r) return send(res, 400, r);
    const id = `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const queued = enqueue(r.plan);
    for (const j of queued) j.deployment = id;
    deployments.add({
      id, project: r.project.id, route: r.route, key: r.key, label: r.label, channel: r.channel,
      checkout: r.plan.checkout.path, branch: r.plan.checkout.branch, sha: r.head,
      builds: queued.map((j) => j.id), notes: b.notes, status: "building", createdAt: Date.now(),
    });
    publishJobs();
    return send(res, 200, { id, builds: queued.map((j) => j.id) });
  }
  const deployRoute = /^\/api\/deployments\/([a-z0-9]+)\/(post|cancel)$/.exec(url.pathname);
  if (deployRoute && req.method === "POST") {
    try {
      if (deployRoute[2] === "cancel") deployments.cancel(deployRoute[1]);
      else await deployments.postWhatBuilt(deployRoute[1]);
      return send(res, 200, deployments.get(deployRoute[1]));
    } catch (e) {
      return send(res, 409, { error: (e as Error).message });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/plan") return send(res, 200, await plan(await readJson(req)));

  if (req.method === "POST" && url.pathname === "/api/jobs") {
    const p = await plan(await readJson(req));
    if ("error" in p) return send(res, 400, p);
    enqueue(p);
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
    const ready = await installable(job, b.deviceId);
    if ("error" in ready) return send(res, ready.status, { error: ready.error });
    send(res, 202, { ok: true });
    await runInstall(job, ready, { launch: b.launch === true, replace: b.replace === true });
    return;
  }

  if (job && parts[3] === "resume") {
    const blocked = await resumeBlocker(job);
    if (req.method === "GET") return send(res, 200, blocked ? { error: blocked } : { ok: true });
    if (req.method === "POST") {
      if (blocked) return send(res, 409, { error: blocked });
      resume(job);
      return send(res, 200, { ok: true });
    }
  }

  // The build's folder, one level at a time (the Files layout).
  if (job && parts[3] === "files") {
    if (!job.archiveDir || !existsSync(job.archiveDir)) return send(res, 404, { error: "this build has no folder (it never started, or it was deleted)" });
    if (req.method === "GET" && !parts[4]) {
      return listArchive(job.archiveDir, url.searchParams.get("path") ?? "").then(
        (r) => send(res, 200, { root: job.archiveDir, ...r }),
        (e: Error) => send(res, 400, { error: e.message }),
      );
    }
    if (req.method === "POST" && parts[4] === "reveal") {
      const b = (await readJson(req)) as { path?: unknown };
      const target = inside(job.archiveDir, typeof b.path === "string" ? b.path : "");
      if (!target || !existsSync(target)) return send(res, 404, { error: "no such file in this build's folder" });
      spawn("open", ["-R", target], { stdio: "ignore" }).unref();
      return send(res, 200, { ok: true });
    }
  }

  if (job && parts[3] === "ship") {
    if (req.method === "GET") {
      const plan = await shipPlan(job, (url.searchParams.get("note") ?? "").slice(0, 2000));
      // The page needs what will be posted, not where the file lives.
      return send(res, 200, "error" in plan ? plan : { channel: plan.channel, text: plan.text, file: plan.file.name, size: plan.size });
    }
    if (req.method === "POST") {
      const b = (await readJson(req)) as { note?: unknown };
      const plan = await shipPlan(job, typeof b.note === "string" ? b.note.slice(0, 2000) : "");
      if ("error" in plan) return send(res, 400, plan);
      if (job.steps?.some((st) => st.id.startsWith("ship-") && st.state === "running")) return send(res, 409, { error: "already shipping this build" });
      send(res, 202, { ok: true });
      await runShip(job, plan).catch(() => {}); // the step and the log carry the failure
      return;
    }
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

async function assistantApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  const body = req.method === "POST" ? ((await readJson(req)) as Record<string, unknown>) : {};
  const fail = (e: unknown) => send(res, 400, { error: (e as Error).message });

  if (url.pathname === "/api/ai/providers") {
    if (req.method === "GET") return send(res, 200, await listProviders());
    if (req.method === "POST") return saveProvider(body).then((p) => send(res, 200, p), fail);
  }
  const providerRoute = /^\/api\/ai\/providers\/([a-z0-9-]+)(\/active)?$/.exec(url.pathname);
  if (providerRoute) {
    if (req.method === "DELETE" && !providerRoute[2]) return removeProvider(providerRoute[1]).then(() => send(res, 200, { ok: true }), fail);
    if (req.method === "POST" && providerRoute[2]) return setActive(providerRoute[1]).then(() => send(res, 200, { ok: true }), fail);
  }
  if (url.pathname === "/api/ai/models" && req.method === "POST") {
    return availableModels(body as { id?: string; preset: string; baseUrl?: string; apiKey?: string }).then((m) => send(res, 200, m), fail);
  }

  if (url.pathname === "/api/ai/conversations") {
    if (req.method === "GET") return send(res, 200, listConversations());
    if (req.method === "POST") {
      const app = typeof body.app === "string" && (await getProject(body.app)) ? body.app : null;
      const c = newConversation(app);
      return send(res, 200, { id: c.id });
    }
  }
  if (url.pathname === "/api/ai/mcp/pending" && req.method === "GET") return send(res, 200, pendingApprovals(MCP_CONVERSATION));
  // Only the page answers an action: the model has no way to reach this route.
  const approvalRoute = /^\/api\/ai\/conversations\/([a-z0-9]+)\/approvals\/([^/]{1,200})$/.exec(url.pathname);
  if (approvalRoute && req.method === "POST") {
    if (typeof body.approved !== "boolean") return send(res, 400, { error: "approved must be true or false" });
    if (!answerApproval(approvalRoute[1], decodeURIComponent(approvalRoute[2]), body.approved)) return send(res, 404, { error: "nothing is waiting for that answer" });
    return send(res, 200, { ok: true });
  }
  const convRoute = /^\/api\/ai\/conversations\/([a-z0-9]+)(\/messages)?$/.exec(url.pathname);
  if (convRoute) {
    const c = getConversation(convRoute[1]);
    if (!c) return send(res, 404, { error: "no such conversation" });
    if (req.method === "GET" && !convRoute[2]) {
      // The provider's raw replies stay on the server.
      return send(res, 200, {
        ...c,
        messages: c.messages.map((m) => (m.role === "assistant" ? { ...m, raw: undefined } : m)),
        pending: pendingApprovals(c.id),
      });
    }
    if (req.method === "POST" && convRoute[2]) {
      const text = typeof body.text === "string" ? body.text.trim().slice(0, 8000) : "";
      if (!text) return send(res, 400, { error: "empty message" });
      if (c.busy) return send(res, 409, { error: "still answering the last message" });
      send(res, 202, { ok: true });
      void sendToAssistant(c, text, assistantContext, (event) => broadcast("assistant", { conversation: c.id, event }), typeof body.provider === "string" ? body.provider : undefined);
      return;
    }
  }
  send(res, 404, { error: "not found" });
}

const mcp = mcpServer(assistantContext, (event) => broadcast("assistant", { conversation: MCP_CONVERSATION, event }), {
  version: JSON.parse(await readFile(path.join(TOOL_DIR, "package.json"), "utf8")).version,
  page: `http://localhost:${PORT}`,
});

/** /mcp: the Model Context Protocol endpoint, under the same Host and Origin checks as the API. */
async function mcpRoute(req: http.IncomingMessage, res: http.ServerResponse) {
  const session = typeof req.headers["mcp-session-id"] === "string" ? req.headers["mcp-session-id"] : undefined;
  if (req.method === "DELETE" && session) return send(res, mcp.end(session) ? 200 : 404, {});
  if (req.method !== "POST") {
    // No server-to-client stream: everything is answered on the POST.
    res.writeHead(405, { allow: "POST, DELETE" }).end();
    return;
  }
  const origin = req.headers.origin;
  if (origin && !ALLOWED_HOSTS.has(origin.replace(/^https?:\/\//, ""))) return send(res, 403, { error: "bad origin" });
  if (!req.headers["content-type"]?.startsWith("application/json")) return send(res, 415, { error: "JSON only" });
  let msg: unknown;
  try {
    msg = await readJson(req, 1 << 20);
  } catch {
    return send(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "not valid JSON" } });
  }
  const gone = new AbortController();
  res.on("close", () => !res.writableEnded && gone.abort());
  const reply = await mcp.handle(msg, session, gone.signal);
  if (reply.session) res.setHeader("mcp-session-id", reply.session);
  if (reply.body === undefined) {
    res.writeHead(reply.status).end();
    return;
  }
  send(res, reply.status, reply.body);
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
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

const first = await startupProject();
await loadHistory();

http
  .createServer(async (req, res) => {
    if (!ALLOWED_HOSTS.has(req.headers.host ?? "")) return send(res, 403, { error: "bad host" });
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    try {
      if (url.pathname === "/mcp") return await mcpRoute(req, res);
      if (url.pathname.startsWith("/api/")) return await api(req, res, url);
      if (vite) return vite.middlewares(req, res);
      return await serveStatic(res, url);
    } catch (e) {
      if (!res.headersSent) send(res, 500, { error: (e as Error).message });
    }
  })
  .listen(PORT, HOST, () => {
    const at = first ? `/?project=${first.id}  (${first.name}: ${first.path})` : "  (no app here — add one in the UI)";
    console.log(`fledge → http://localhost:${PORT}${at}${DEV ? "  [dev]" : ""}`);
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
