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

/** The version a command pins with --build-name and --build-number, if it pins both. */
export function pinnedVersion(argv: string[]): string | undefined {
  const arg = (k: string) => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
  const name = arg("build-name");
  const number = arg("build-number");
  return name && number ? `${name}+${number}` : undefined;
}

type Identity = { bundleId?: string; version?: string };

/** Why the artifact read back isn't the app the build was for, or null when it is or can't be told. */
export function mismatch(got: Identity, want: Identity): string | null {
  const wrong = (["bundleId", "version"] as const).filter((k) => got[k] && want[k] && got[k] !== want[k]);
  if (wrong.length === 0) return null;
  const show = (i: Identity) => wrong.map((k) => i[k]).join(" ");
  return `the artifact is ${show(got)}, but this build is ${show(want)}`;
}
