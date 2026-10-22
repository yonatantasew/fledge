// Deployments: a set of builds posted to a channel with their notes, in one
// of two ways:
// - together: each file is uploaded (not yet shared) as soon as its build
//   finishes, and all are shared in one message with the notes once every
//   build has built. If one fails, it's held (nothing posted), or with
//   onFailure "post-built" what built is posted with a "Not built" line.
// - as-built: the first build to finish posts the notes, its file right
//   under them; each later build, or failure, is a reply in their thread.
// The builds and Slack are given in (DeployDeps), so this file is all
// decisions, and every path is tested without either.

export type PostMode = "together" | "as-built";
export type OnFailure = "hold" | "post-built";
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
  mode?: PostMode; // missing on deploys from before there was a choice: together
  onFailure?: OnFailure;
  status: DeployStatus;
  error?: string;
  progress?: string; // while uploading: "uploading a.apk, 340 / 600 MB"
  staged?: Record<string, { id: string; name: string; at: number }>; // together: uploaded, not yet shared, by build
  thread?: string; // as-built: the notes message, whose thread the later builds reply in
  handled?: string[]; // as-built: builds already posted or reported
  createdAt: number;
  endedAt?: number;
  posted?: { at: number; files: string[]; missing: string[] };
}

/** What a deployment needs to know about one of its builds. */
export interface DeployBuild {
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  name: string; // "Staging release Android apk"
  error?: string;
  file?: { path: string; name: string; size: number };
}

export interface DeployDeps {
  build(id: string): DeployBuild | undefined;
  /** Uploads a file without sharing it; returns its upload id. */
  upload(file: { path: string; name: string; size: number }, progress: (sent: number, total: number) => void): Promise<string>;
  /** Shares uploads in the channel as one message (or a thread reply). */
  share(channel: string, files: { id: string; title: string }[], text: string, thread?: string): Promise<void>;
  /** Posts a message (or a thread reply); returns its timestamp. */
  message(channel: string, text: string, thread?: string): Promise<string>;
  cancelBuild(id: string): void;
  changed(list: Deployment[]): void; // persist and tell the page
  now?(): number;
}

/** Routes count their own deploys; one-offs count deploys to the same channel and environments. */
export function deployKey(route: string | null, channel: string, environments: string[]) {
  return route ? `route:${route}` : `once:${channel}:${[...new Set(environments)].sort().join(",")}`;
}

// Slack kept an unshared upload 15 minutes in a test; older ones are sent again before sharing.
export const STAGED_FOR = 15 * 60_000;

const mb = (n: number) => `${(n / 1048576).toFixed(n < 10 * 1048576 ? 1 : 0)} MB`;
const finished = (b: DeployBuild | undefined) => !!b && (b.status === "succeeded" || b.status === "failed" || b.status === "cancelled");
const built = (b: DeployBuild | undefined): b is DeployBuild & { file: NonNullable<DeployBuild["file"]> } => b?.status === "succeeded" && !!b.file;

export class Deployer {
  private busy = new Set<string>(); // deployments with a Slack step in flight
  private deps: DeployDeps;
  private list: Deployment[];
  constructor(deps: DeployDeps, list: Deployment[]) {
    this.deps = deps;
    this.list = list;
  }

  private now() {
    return this.deps.now?.() ?? Date.now();
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

  /** Called whenever builds change: moves deployments along, one Slack step at a time each. */
  tick() {
    let changed = false;
    for (const d of this.list) {
      if (d.status !== "building" && d.status !== "held" && d.status !== "posting") continue;
      if (this.busy.has(d.id)) continue; // the step in flight ticks again when it's done
      const builds = d.builds.map((id) => ({ id, b: this.deps.build(id) }));
      const pending = builds.some(({ b }) => !finished(b));
      if (d.status === "held" && pending) ((d.status = "building"), delete d.error, (changed = true)); // a build was resumed

      if ((d.mode ?? "together") === "together") {
        const unstaged = builds.find(({ id, b }) => built(b) && !d.staged?.[id]);
        if (unstaged) {
          this.step(d, () => this.stage(d, unstaged.id, unstaged.b!));
          continue;
        }
        if (pending) continue;
        const succeeded = builds.filter(({ b }) => built(b));
        if (succeeded.length === builds.length) this.step(d, () => this.shareTogether(d));
        else if (d.onFailure === "post-built" && succeeded.length) this.step(d, () => this.shareTogether(d));
        else if (d.status !== "held") ((d.status = "held"), (d.error = this.why(builds.map(({ b }) => b))), (changed = true));
      } else {
        const handled = new Set(d.handled ?? []);
        // Failures wait for the thread, which the first build that succeeds starts.
        const next = builds.find(({ id, b }) => !handled.has(id) && finished(b) && (built(b) || d.thread));
        if (next) {
          this.step(d, () => this.postAsBuilt(d, next.id, next.b!));
          continue;
        }
        if (pending) continue;
        if (!d.thread) {
          if (d.status !== "held") ((d.status = "held"), (d.error = this.why(builds.map(({ b }) => b))), (changed = true));
        } else {
          d.status = "posted";
          d.endedAt = this.now();
          d.posted = { at: this.now(), files: builds.filter(({ b }) => built(b)).map(({ b }) => b!.file!.name), missing: builds.filter(({ b }) => !built(b)).map(({ b }) => b!.name) };
          changed = true;
        }
      }
    }
    if (changed) this.deps.changed(this.list);
  }

  private why(builds: (DeployBuild | undefined)[]) {
    const bad = builds.filter((b) => !built(b));
    return `${bad.map((b) => `${b?.name ?? "a build"} ${b?.status ?? "cleared"}`).join(", ")}; nothing posted`;
  }

  /** Runs one Slack step for a deployment; a failure fails the deployment with Slack's reason. */
  private step(d: Deployment, run: () => Promise<void>) {
    this.busy.add(d.id);
    void run()
      .catch((e: Error) => {
        d.status = "failed";
        d.error = e.message.split("\n")[0];
        d.endedAt = this.now();
      })
      .finally(() => {
        delete d.progress;
        this.busy.delete(d.id);
        this.deps.changed(this.list);
        this.tick();
      });
  }

  private progress(d: Deployment) {
    let shown = 0;
    return (name: string) => (sent: number, total: number) => {
      d.progress = `uploading ${name}, ${mb(sent)} / ${mb(total)}`;
      // About once a second: every chunk would rewrite the history file thousands of times.
      if (this.now() - shown > 1000 || sent === total) ((shown = this.now()), this.deps.changed(this.list));
    };
  }

  /** together: one build's file goes up as soon as it's built, not shared yet. */
  private async stage(d: Deployment, id: string, b: DeployBuild) {
    const file = b.file!;
    const uploadId = await this.deps.upload(file, this.progress(d)(file.name));
    (d.staged ??= {})[id] = { id: uploadId, name: file.name, at: this.now() };
  }

  /** together: shares every staged file in one message with the notes, sending stale ones again first. */
  private async shareTogether(d: Deployment) {
    const builds = d.builds.map((id) => ({ id, b: this.deps.build(id) }));
    const ok = builds.filter(({ b }) => built(b));
    if (!ok.length) throw new Error("nothing built, so there's nothing to post");
    d.status = "posting";
    this.deps.changed(this.list);
    for (const { id, b } of ok) {
      const s = d.staged?.[id];
      if (!s || this.now() - s.at > STAGED_FOR) await this.stage(d, id, b!);
    }
    const missing = builds.filter(({ b }) => !built(b));
    const text = [
      d.notes.trim(),
      "",
      `Files: ${ok.map(({ b }) => `${b!.file!.name} (${mb(b!.file!.size)})`).join(" · ")}`,
      ...(missing.length ? [`Not built: ${missing.map(({ b }) => `${b?.name ?? "a build"} (${b?.status ?? "cleared"})`).join(", ")}`] : []),
    ].join("\n");
    const files = () => ok.map(({ id }) => ({ id: d.staged![id].id, title: d.staged![id].name }));
    try {
      await this.deps.share(d.channel, files(), text);
    } catch {
      // Uploads Slack let go of: send them all again, once.
      for (const { id, b } of ok) await this.stage(d, id, b!);
      await this.deps.share(d.channel, files(), text);
    }
    d.status = "posted";
    d.endedAt = this.now();
    d.posted = { at: this.now(), files: ok.map(({ b }) => b!.file!.name), missing: missing.map(({ b }) => b?.name ?? "a build") };
    delete d.staged;
  }

  /** as-built: the first build posts the notes and its file; the rest reply in their thread. */
  private async postAsBuilt(d: Deployment, id: string, b: DeployBuild) {
    if (d.status !== "posting") ((d.status = "posting"), this.deps.changed(this.list));
    if (built(b)) {
      const first = !d.thread;
      if (first) d.thread = await this.deps.message(d.channel, `${d.notes.trim()}\n\nFiles follow as each build finishes; later ones in this thread.`);
      const uploadId = await this.deps.upload(b.file, this.progress(d)(b.file.name));
      await this.deps.share(d.channel, [{ id: uploadId, title: b.file.name }], first ? "" : `${b.name} is ready (${mb(b.file.size)})`, first ? undefined : d.thread);
    } else {
      await this.deps.message(d.channel, `${b.name} ${b.status}${b.error ? `: ${b.error}` : ""}`, d.thread);
    }
    (d.handled ??= []).push(id);
  }

  /** A held (or failed) deployment: post what did build. */
  async postWhatBuilt(id: string) {
    const d = this.get(id);
    if (!d) throw new Error("no such deployment");
    if (d.status !== "held" && d.status !== "failed") throw new Error(`it's ${d.status}; only a held or failed deployment can be posted by hand`);
    if (this.busy.has(d.id)) throw new Error("it's already posting");
    if ((d.mode ?? "together") === "as-built") {
      if (!d.builds.some((b) => built(this.deps.build(b)))) throw new Error("nothing built, so there's nothing to post");
      // Failed mid-thread: carry on from where it stopped.
      d.status = "posting";
      delete d.error;
      this.tick();
      return;
    }
    await new Promise<void>((resolve, reject) => {
      this.busy.add(d.id);
      delete d.error;
      this.shareTogether(d)
        .then(resolve, (e: Error) => {
          d.status = "failed";
          d.error = e.message.split("\n")[0];
          reject(e);
        })
        .finally(() => {
          delete d.progress;
          this.busy.delete(d.id);
          this.deps.changed(this.list);
        });
    });
  }

  /** Stops its builds that haven't finished, and gives up on posting. */
  cancel(id: string) {
    const d = this.get(id);
    if (!d) throw new Error("no such deployment");
    if (d.status === "posted" || this.busy.has(d.id)) throw new Error(`it's already ${d.status}`);
    for (const b of d.builds) {
      const s = this.deps.build(b)?.status;
      if (s === "queued" || s === "running") this.deps.cancelBuild(b);
    }
    d.status = "cancelled";
    d.endedAt = this.now();
    delete d.staged;
    this.deps.changed(this.list);
  }
}
