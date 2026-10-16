import { useCallback, useEffect, useRef, useState } from "react";
import type { BuildOptions, Flavor, Mode, Platform, PlannedBuild, SkippedBuild, Target } from "../server/commands.ts";
import type { MergedPr, ReleaseFacts, Ticket } from "../server/notes.ts";
import type { ProjectInfo } from "./project";

export type { BuildOptions, Flavor, Mode, Platform, PlannedBuild, SkippedBuild, Target };

export interface Checkout {
  path: string;
  branch: string;
  sha: string;
  dirty: number;
  version: string;
}

export interface Info {
  project: { id: string; name: string; root: string };
  configSource: "explicit" | "local" | "repo" | null;
  configError: string | null;
  checkouts: Checkout[];
  flutter: string;
  cli: string;
  config: string;
  flavors: ProjectInfo["flavors"];
  toggles: ProjectInfo["toggles"];
  releases: boolean;
}

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface Job {
  id: string;
  project: string;
  projectName: string;
  checkout: string;
  branch: string;
  sha: string;
  platform: Platform;
  flavor: Flavor;
  mode: Mode;
  artifact: string;
  command: string;
  notes: string[];
  status: JobStatus;
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

export interface Device {
  platform: Platform;
  id: string;
  name: string;
  detail: string;
  available: boolean;
}

export interface PlanResult {
  checkout: Checkout;
  builds: PlannedBuild[];
  skipped: SkippedBuild[];
  error?: string;
}

export interface BuildRequest {
  project: string;
  checkout: string;
  targets: Target[];
  options: BuildOptions;
}

async function post<T>(url: string, body: unknown = {}): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data as T;
}

export const api = {
  info: async (project: string): Promise<Info> => {
    const res = await fetch(`/api/info?project=${encodeURIComponent(project)}`);
    if (!res.ok) throw new Error((await res.json()).error ?? res.statusText);
    return res.json();
  },
  plan: (req: BuildRequest) => post<PlanResult>("/api/plan", req),
  queue: (req: BuildRequest) => post<{ queued: number; skipped: SkippedBuild[] }>("/api/jobs", req),
  cancel: (id: string) => post(`/api/jobs/${id}/cancel`),
  reveal: (id: string) => post(`/api/jobs/${id}/reveal`),
  organizer: (id: string) => post(`/api/jobs/${id}/organizer`),
  devices: async (): Promise<Device[]> => (await fetch("/api/devices")).json(),
  install: (id: string, deviceId: string, launch: boolean, replace: boolean) =>
    post(`/api/jobs/${id}/install`, { deviceId, launch, replace }),
  clear: () => post("/api/jobs/clear"),
  stopAll: () => post<{ cancelled: number; stopped: number }>("/api/jobs/stop"),
  log: async (id: string): Promise<string> => (await fetch(`/api/jobs/${id}/log`)).text(),
};

/**
 * Live job list plus the logs of whichever jobs we have loaded. Chunks carry
 * the offset they start at, so a chunk that overlaps a fetched log is trimmed
 * and a gap (missed chunk) triggers a refetch instead of a corrupted log.
 */
export function useJobs() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [connected, setConnected] = useState(false);
  const [logs, setLogs] = useState<Record<string, string>>({});
  const logsRef = useRef(logs);
  logsRef.current = logs;

  const loadLog = useCallback(async (id: string) => {
    const text = await api.log(id);
    setLogs((l) => (l[id] !== undefined && l[id].length > text.length ? l : { ...l, [id]: text }));
  }, []);

  useEffect(() => {
    const es = new EventSource("/api/events");
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.addEventListener("jobs", (e) => setJobs(JSON.parse((e as MessageEvent).data)));
    es.addEventListener("log", (e) => {
      const { id, chunk, offset } = JSON.parse((e as MessageEvent).data) as { id: string; chunk: string; offset: number };
      const have = logsRef.current[id];
      if (have === undefined) {
        if (offset === 0) setLogs((l) => ({ ...l, [id]: (l[id] ?? "") + chunk }));
        return;
      }
      if (offset > have.length) return void loadLog(id);
      setLogs((l) => {
        const cur = l[id] ?? "";
        const end = offset + chunk.length;
        return end <= cur.length ? l : { ...l, [id]: cur + chunk.slice(cur.length - offset) };
      });
    });
    return () => es.close();
  }, [loadLog]);

  return { jobs, logs, loadLog, connected };
}

/** Ticks once a second while `active`, for live durations. */
export function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

export function duration(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  return m ? `${m}m ${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}

export type FirebaseState = "ok" | "expired" | "logged-out" | "missing" | "checking";

export interface FirebaseStatus {
  state: FirebaseState;
  email?: string;
  checkedAt: number;
  login?: { running: boolean; url?: string; output: string; error?: string };
}

export const firebaseApi = {
  status: async (refresh = false): Promise<FirebaseStatus> =>
    (await fetch(`/api/firebase${refresh ? "?refresh" : ""}`)).json(),
  login: () => post<FirebaseStatus>("/api/firebase/login"),
  cancel: () => post("/api/firebase/login/cancel"),
};

/** Firebase CLI sign-in state; the server pushes changes while a login runs. */
export function useFirebase() {
  const [status, setStatus] = useState<FirebaseStatus>({ state: "checking", checkedAt: 0 });
  useEffect(() => {
    void firebaseApi.status().then(setStatus);
    const es = new EventSource("/api/events");
    es.addEventListener("firebase", (e) => setStatus(JSON.parse((e as MessageEvent).data)));
    return () => es.close();
  }, []);
  const refresh = useCallback(() => {
    setStatus((s) => ({ ...s, state: "checking" }));
    void firebaseApi.status(true).then(setStatus);
  }, []);
  return { status, refresh };
}

// ------------------------------------------------------------------ release

export type { MergedPr, ReleaseFacts, Ticket };

export interface Connections {
  github: { ok: boolean; login?: string; error?: string };
  jira: { ok: boolean; email?: string; error?: string };
  claude: { ok: boolean; version?: string; error?: string };
}

export interface ReleaseTag {
  tag: string;
  prerelease: boolean;
  createdAt: string;
}

export interface Notes {
  slack: string;
  github: string;
}

export interface PublishResult {
  tag: string;
  branch: string;
  bumpSha: string;
  prUrl?: string;
  releaseUrl?: string;
  jira: { key: string; result: string }[];
}

export interface ReleaseSettings {
  baseBranch: string;
  branch: string; // template, e.g. "release/bump-{versionSlug}"
  prTitle: string;
  jira: { fromStatus: string; toStatus: string } | null;
}

const q = (project: string) => `project=${encodeURIComponent(project)}`;

export const releaseApi = {
  settings: async (project: string): Promise<ReleaseSettings | null> => (await fetch(`/api/release/config?${q(project)}`)).json(),
  connections: async (project: string): Promise<Connections> => (await fetch(`/api/release/connections?${q(project)}`)).json(),
  tags: async (project: string): Promise<ReleaseTag[]> => (await fetch(`/api/release/tags?${q(project)}`)).json(),
  facts: (project: string, baseTag: string | null, prerelease: boolean) =>
    post<{ facts: ReleaseFacts; templates: Notes }>("/api/release/facts", { project, baseTag, prerelease }),
  template: (project: string, facts: ReleaseFacts) => post<Notes>("/api/release/template", { project, facts }),
  draft: (project: string, facts: ReleaseFacts) =>
    post<Notes & { warnings: string[]; costUsd: number }>("/api/release/draft", { project, facts }),
  publish: (project: string, facts: ReleaseFacts, githubNotes: string, prerelease: boolean, updateJira: boolean, dryRun = false) =>
    post<PublishResult>("/api/release/publish", { project, facts, githubNotes, prerelease, updateJira, dryRun }),
};

// --------------------------------------------------------------------- apps

export interface ProjectSummary {
  id: string;
  name: string;
  root: string;
  source: "explicit" | "local" | "repo" | null;
  configFile: string | null;
  error: string | null;
  ready: boolean;
}

export interface Detected {
  root: string;
  config: Record<string, unknown>;
  notes: string[];
}

export interface ConfigFile {
  source: ProjectSummary["source"];
  file: string | null;
  local: string;
  text: string;
  error: string | null;
}

async function send<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data as T;
}

export const projectsApi = {
  list: () => send<ProjectSummary[]>("GET", "/api/projects"),
  candidates: () => send<string[]>("GET", "/api/projects/candidates"),
  detect: (path: string) => post<Detected>("/api/projects/detect", { path }),
  add: (path: string, name: string, config: unknown) => post<{ id: string }>("/api/projects", { path, name, config }),
  remove: (id: string) => send<{ ok: true }>("DELETE", `/api/projects/${id}`),
  config: (id: string) => send<ConfigFile>("GET", `/api/projects/${id}/config`),
  saveConfig: (id: string, config: unknown) => send<{ file: string }>("PUT", `/api/projects/${id}/config`, { config }),
};

/** Lines the server streams while a release is being published. */
export function useReleaseLog(project: string) {
  const [lines, setLines] = useState<string[]>([]);
  useEffect(() => {
    const es = new EventSource("/api/events");
    es.addEventListener("release", (e) => {
      const msg = JSON.parse((e as MessageEvent).data) as { project: string; line: string };
      if (msg.project === project) setLines((l) => [...l, msg.line]);
    });
    return () => es.close();
  }, [project]);
  return { lines, clear: () => setLines([]) };
}
