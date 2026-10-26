// Deciding whether what a build left in build/ is really what it built.
// `flutter build ipa` exits 0 even when exporting the IPA fails, so the
// newest file in build/ios/ipa can be an earlier build's — another flavor's.

export interface Written {
  name: string;
  mtime: number; // ms
}

/** The newest file written at or after `since`, or null when the build wrote none. */
export function freshest(files: Written[], since: number): string | null {
  const fresh = files.filter((f) => f.mtime >= since).sort((a, b) => b.mtime - a.mtime);
  return fresh[0]?.name ?? null;
}

/** Xcode's IPA export errors in a build log, each once, in the order they first appear. */
export function exportErrors(log: string): string[] {
  const seen = new Set<string>();
  for (const m of log.matchAll(/^error: exportArchive (.+)$/gm)) seen.add(m[1].trim());
  return [...seen];
}
