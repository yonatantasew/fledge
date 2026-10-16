// Which queued jobs may start now.
//
// One lane per platform, shared by every checkout: an Android build and an iOS
// build can run side by side (they write build/app/** and build/ios/** and only
// iOS rewrites Generated.xcconfig), but two Gradle builds fight over the
// ~/.gradle cache locks and two Xcode builds just split the CPU. "Prepare
// Xcode" jobs ride the iOS lane because they rewrite Generated.xcconfig too.
//
// The queue is first-in-first-out within a lane, with one exception: in the
// Android lane, a queued build of the same checkout and build type as the last
// Android build goes next. Gradle compiles plugins and libraries per build type
// (debug/profile/release), not per flavor, so staging/uat/prod release builds in
// a row reuse each other's outputs, while interleaving a debug build throws the
// warm release outputs away. A job only overtakes jobs from the other lane or,
// on Android, jobs of a different build type.

export interface Schedulable {
  id: string;
  platform: string;
  status: string;
  checkout?: string;
  mode?: string;
}

export const GROUPED_LANES = new Set(["android"]);

export function startable<T extends Schedulable>(
  jobs: T[],
  maxParallel: number,
  last: Partial<Record<string, { checkout?: string; mode?: string }>> = {},
): T[] {
  const busy = new Set(jobs.filter((j) => j.status === "running").map((j) => j.platform));
  let slots = maxParallel - jobs.filter((j) => j.status === "running").length;
  const out: T[] = [];
  const queued = jobs.filter((j) => j.status === "queued");
  for (const j of queued) {
    if (slots <= 0) break;
    if (busy.has(j.platform)) continue;
    const prev = last[j.platform];
    const pick =
      (GROUPED_LANES.has(j.platform) &&
        prev &&
        queued.find((q) => q.platform === j.platform && q.checkout === prev.checkout && q.mode === prev.mode)) ||
      j;
    out.push(pick);
    busy.add(j.platform);
    slots--;
  }
  return out;
}
