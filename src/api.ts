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
  pubGet?: string[] | null;
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
  model: { ok: boolean; name?: string; error?: string };
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
    post<Notes & { warnings: string[]; model: string }>("/api/release/draft", { project, facts }),
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
  writeCommands: (id: string, config: unknown) => post<{ config: Record<string, unknown> }>(`/api/projects/${id}/commands`, { config }),
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

// ---------------------------------------------------------------- assistant

export interface AiPreset {
  label: string;
  kind: "claude-cli" | "anthropic" | "openai";
  baseUrl?: string;
  needsKey: boolean;
  modelHint: string;
}

export interface AiProvider {
  id: string;
  preset: string;
  name: string;
  kind: AiPreset["kind"];
  baseUrl?: string;
  model: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  fallbacks?: boolean;
  hasKey: boolean;
}

export type AiEvent =
  | { type: "start"; provider: string; model: string }
  | { type: "text"; delta: string }
  | { type: "tool"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; name: string; isError: boolean; preview: string }
  | { type: "approval"; id: string; title: string; details: string[] }
  | { type: "approval_result"; id: string; approved: boolean }
  | { type: "note"; text: string }
  | { type: "done" }
  | { type: "error"; message: string };

export type AiServerMessage =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; toolCalls: { id: string; name: string; input: unknown }[] }
  | {
      role: "tool";
      results: { id: string; name: string; content: string; isError?: boolean; approval?: { title: string; details: string[]; approved: boolean } }[];
    };

export type AiPendingApproval = { id: string; title: string; details: string[] };

export const aiApi = {
  providers: () => send<{ active: string | null; presets: Record<string, AiPreset>; providers: AiProvider[] }>("GET", "/api/ai/providers"),
  saveProvider: (p: Record<string, unknown>) => post<AiProvider>("/api/ai/providers", p),
  removeProvider: (id: string) => send<{ ok: true }>("DELETE", `/api/ai/providers/${id}`),
  setActive: (id: string) => post<{ ok: true }>(`/api/ai/providers/${id}/active`),
  models: (q: { id?: string; preset: string; baseUrl?: string; apiKey?: string }) => post<string[]>("/api/ai/models", q),
  conversations: () => send<{ id: string; app: string | null; title: string; busy: boolean; updatedAt: number }[]>("GET", "/api/ai/conversations"),
  newConversation: (app: string | null) => post<{ id: string }>("/api/ai/conversations", { app }),
  conversation: (id: string) =>
    send<{ id: string; app: string | null; title: string; busy: boolean; messages: AiServerMessage[]; pending: AiPendingApproval[] }>("GET", `/api/ai/conversations/${id}`),
  send: (id: string, text: string) => post<{ ok: true }>(`/api/ai/conversations/${id}/messages`, { text }),
  answer: (id: string, callId: string, approved: boolean) =>
    post<{ ok: true }>(`/api/ai/conversations/${id}/approvals/${encodeURIComponent(callId)}`, { approved }),
};

/** Live assistant events for one conversation. */
export function useAssistantEvents(conversation: string | null, onEvent: (e: AiEvent) => void) {
  const handler = useRef(onEvent);
  handler.current = onEvent;
  useEffect(() => {
    if (!conversation) return;
    const es = new EventSource("/api/events");
    es.addEventListener("assistant", (e) => {
      const msg = JSON.parse((e as MessageEvent).data) as { conversation: string; event: AiEvent };
      if (msg.conversation === conversation) handler.current(msg.event);
    });
    return () => es.close();
  }, [conversation]);
}
