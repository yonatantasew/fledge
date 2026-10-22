// Deployments: a set of builds that, once all have built, are posted together
// with their notes to a channel. Nothing is posted while a build is still
// running; if one fails or is stopped, the deployment is held until its
// builds are resumed, or someone posts what built, or cancels it. The builds
// and the posting are given in (DeployDeps), so this file is all decisions.

export type DeployStatus = "building" | "posting" | "posted" | "held" | "cancelled" | "failed";

export interface Deployment {
  id: string;
  project: string;
  route: string | null; // a route's id, or null for a one-off
  key: string; // which deploys count as "the last one" for the notes (see deployKey)
  label: string;
  channel: string;
  checkout: string;
  branch: string;
  sha: string; // the full commit it builds; the next deploy's notes start here
  builds: string[]; // build ids
  notes: string;
  status: DeployStatus;
  error?: string;
  createdAt: number;
  endedAt?: number;
  posted?: { at: number; files: string[]; missing: string[] };
  progress?: string; // while posting: "uploading a.apk, 340 / 600 MB"
}

/** What a deployment needs to know about one of its builds. */
export interface DeployBuild {
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  name: string; // "Staging release Android apk"
  file?: { path: string; name: string; size: number };
}

export interface DeployDeps {
  build(id: string): DeployBuild | undefined;
  post(channel: string, files: { path: string; name: string }[], text: string, progress: (file: string, sent: number, total: number) => void): Promise<void>;
  cancelBuild(id: string): void;
  changed(list: Deployment[]): void; // persist and tell the page
}

/** Routes count their own deploys; one-offs count deploys to the same channel and environments. */
export function deployKey(route: string | null, channel: string, environments: string[]) {
  return route ? `route:${route}` : `once:${channel}:${[...new Set(environments)].sort().join(",")}`;
}

const mb = (n: number) => `${(n / 1048576).toFixed(n < 10 * 1048576 ? 1 : 0)} MB`;

export class Deployer {
  private posting = new Set<string>();
  private deps: DeployDeps;
  private list: Deployment[];
  constructor(deps: DeployDeps, list: Deployment[]) {
    this.deps = deps;
    this.list = list;
  }

  all(project?: string) {
    return this.list.filter((d) => !project || d.project === project).sort((a, b) => b.createdAt - a.createdAt);
  }

  get(id: string) {
    return this.list.find((d) => d.id === id);
  }

  /** The commit of the last deploy that was posted under this key: where the next one's notes start. */
  lastPosted(project: string, key: string) {
    return this.all(project).find((d) => d.key === key && d.status === "posted")?.sha ?? null;
  }

  add(d: Deployment) {
    this.list.push(d);
    this.deps.changed(this.list);
    this.tick();
  }

  /** Called whenever builds change: moves deployments along. */
  tick() {
    let changed = false;
    for (const d of this.list) {
      if (d.status !== "building" && d.status !== "held") continue;
      const builds = d.builds.map((id) => this.deps.build(id));
      const pending = builds.some((b) => !b || b.status === "queued" || b.status === "running");
      if (pending) {
        // Held, then a build was resumed: it's building again.
        if (d.status === "held") ((d.status = "building"), delete d.error, (changed = true));
        continue;
      }
      if (builds.every((b) => b!.status === "succeeded")) {
        void this.post(d);
      } else if (d.status !== "held") {
        d.status = "held";
        d.error = `${builds.filter((b) => b!.status !== "succeeded").map((b) => `${b!.name} ${b!.status}`).join(", ")}; nothing posted`;
        changed = true;
      }
    }
    if (changed) this.deps.changed(this.list);
  }

  /** Posts the files that built, with the notes. All of them unless `partial`. */
  async post(d: Deployment, partial = false) {
    if (this.posting.has(d.id)) return;
    const builds = d.builds.map((id) => this.deps.build(id)).filter((b): b is DeployBuild => !!b);
    const built = builds.filter((b) => b.status === "succeeded" && b.file);
    const missing = builds.filter((b) => !(b.status === "succeeded" && b.file));
    if (missing.length && !partial) return;
    if (!built.length) throw new Error("nothing built, so there's nothing to post");
    this.posting.add(d.id);
    d.status = "posting";
    delete d.error;
    this.deps.changed(this.list);
    const text = [
      d.notes.trim(),
      "",
      `Files: ${built.map((b) => `${b.file!.name} (${mb(b.file!.size)})`).join(" · ")}`,
      ...(missing.length ? [`Not built: ${missing.map((b) => `${b.name} (${b.status})`).join(", ")}`] : []),
    ].join("\n");
    let shown = 0;
    const progress = (file: string, sent: number, total: number) => {
      d.progress = `uploading ${file}, ${mb(sent)} / ${mb(total)}`;
      // About once a second: every chunk would rewrite the history file thousands of times.
      if (Date.now() - shown > 1000 || sent === total) ((shown = Date.now()), this.deps.changed(this.list));
    };
    try {
      await this.deps.post(d.channel, built.map((b) => b.file!), text, progress);
      d.status = "posted";
      d.posted = { at: Date.now(), files: built.map((b) => b.file!.name), missing: missing.map((b) => b.name) };
    } catch (e) {
      d.status = "failed";
      d.error = (e as Error).message.split("\n")[0];
    } finally {
      delete d.progress;
      d.endedAt = Date.now();
      this.posting.delete(d.id);
      this.deps.changed(this.list);
    }
  }

  /** A held (or failed) deployment: post what did build. */
  async postWhatBuilt(id: string) {
    const d = this.get(id);
    if (!d) throw new Error("no such deployment");
    if (d.status !== "held" && d.status !== "failed") throw new Error(`it's ${d.status}; only a held or failed deployment can be posted by hand`);
    await this.post(d, true);
  }

  /** Stops its builds that haven't finished, and gives up on posting. */
  cancel(id: string) {
    const d = this.get(id);
    if (!d) throw new Error("no such deployment");
    if (d.status === "posted" || d.status === "posting") throw new Error(`it's already ${d.status}`);
    for (const b of d.builds) {
      const s = this.deps.build(b)?.status;
      if (s === "queued" || s === "running") this.deps.cancelBuild(b);
    }
    d.status = "cancelled";
    d.endedAt = Date.now();
    this.deps.changed(this.list);
  }
}
