import { HugeiconsIcon } from "@hugeicons/react";
import { PlugSocketIcon } from "@hugeicons/core-free-icons";
import { useEffect, useState } from "react";
import { aiApi, useAssistantEvents, type AiPendingApproval } from "@/api";
import { Button } from "@/components/ui/button";

const MCP = "mcp";

/** Actions other agents asked for through /mcp, waiting for an answer here. Shown on every page, panel open or not. */
export function OutsideApprovals() {
  const [waiting, setWaiting] = useState<AiPendingApproval[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void aiApi.mcpPending().then(setWaiting, () => {});
  }, []);
  useAssistantEvents(MCP, (e) => {
    if (e.type === "approval") setWaiting((w) => [...w.filter((a) => a.id !== e.id), { id: e.id, title: e.title, details: e.details }]);
    if (e.type === "approval_result") setWaiting((w) => w.filter((a) => a.id !== e.id));
  });

  async function answer(id: string, approved: boolean) {
    setError(null);
    try {
      await aiApi.answer(MCP, id, approved);
    } catch (e) {
      // Usually: the client hung up or the wait ran out.
      setError((e as Error).message);
    }
    setWaiting((w) => w.filter((a) => a.id !== id));
  }

  if (!waiting.length && !error) return null;
  return (
    <div className="fixed bottom-4 left-4 z-40 flex w-[min(400px,calc(100vw-2rem))] flex-col gap-2">
      {error && <p className="rounded-md border bg-background px-3 py-2 text-xs text-destructive shadow">{error}</p>}
      {waiting.map((a) => (
        <div key={a.id} className="rounded-lg border border-primary/50 bg-background text-sm shadow-lg">
          <div className="space-y-1.5 px-3 py-2">
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <HugeiconsIcon icon={PlugSocketIcon} className="size-3.5" />
              {a.details[0]}, through MCP
            </p>
            <p className="font-medium">{a.title}</p>
            <ul className="list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
              {a.details.slice(1).map((d, i) => (
                <li key={i}>{d}</li>
              ))}
            </ul>
          </div>
          <div className="flex justify-end gap-2 border-t px-3 py-2">
            <Button size="sm" variant="ghost" onClick={() => void answer(a.id, false)}>
              Decline
            </Button>
            <Button size="sm" onClick={() => void answer(a.id, true)}>
              Approve
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
