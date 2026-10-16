import { InformationCircleIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

/** What detection found and guessed, so the config is reviewed, not trusted blindly. */
export function DetectionNotes({ notes }: { notes: string[] }) {
  if (!notes.length) return null;
  return (
    <div className="rounded-lg border border-info/30 bg-info/5 p-3 text-sm">
      <p className="mb-1.5 flex items-center gap-1.5 font-medium text-info">
        <HugeiconsIcon icon={InformationCircleIcon} className="size-4" />
        What fledge found — check before saving
      </p>
      <ul className="list-disc space-y-1 pl-5 text-foreground/90">
        {notes.map((n, i) => (
          <li key={i}>{n}</li>
        ))}
      </ul>
    </div>
  );
}
