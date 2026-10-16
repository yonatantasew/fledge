import { Download04Icon, Loading03Icon, RotateClockwiseIcon, SmartPhone01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { api, type Device, type Job } from "@/api";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/** Install a finished build on a connected phone; offers Replace when the phone refuses an update. */
export function InstallMenu({ job }: { job: Job }) {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [launch, setLaunch] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const installing = job.install?.state === "installing";
  const needsReplace = job.install?.state === "needs-replace";

  async function refresh() {
    setDevices(null);
    setError(null);
    try {
      setDevices((await api.devices()).filter((d) => d.platform === job.platform));
    } catch (e) {
      setError((e as Error).message);
      setDevices([]);
    }
  }

  async function go(deviceId: string, replace = false) {
    setError(null);
    try {
      await api.install(job.id, deviceId, launch, replace);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <DropdownMenu onOpenChange={(open) => open && void refresh()}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label="Install on a device"
              disabled={installing}
              onClick={(e) => e.stopPropagation()}
            >
              <HugeiconsIcon
                icon={installing ? Loading03Icon : Download04Icon}
                className={installing ? "size-4 animate-spin" : "size-4"}
              />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>{installing ? `Installing on ${job.install?.device}…` : "Install on a device"}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-72" onClick={(e) => e.stopPropagation()}>
        <DropdownMenuLabel className="flex items-center justify-between">
          {job.platform === "ios" ? "iPhones" : "Android devices"}
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            aria-label="Refresh devices"
            onClick={(e) => {
              e.preventDefault();
              void refresh();
            }}
          >
            <HugeiconsIcon icon={RotateClockwiseIcon} className="size-3.5" />
          </Button>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {devices === null && (
          <DropdownMenuItem disabled>
            <HugeiconsIcon icon={Loading03Icon} className="size-4 animate-spin" />
            Looking for devices…
          </DropdownMenuItem>
        )}
        {devices?.length === 0 && (
          <DropdownMenuItem disabled className="whitespace-normal">
            {job.platform === "ios"
              ? "No iPhone found. Connect one by cable (or on the same Wi-Fi) and trust this Mac."
              : "No device found. Connect a phone with USB debugging on, or start an emulator."}
          </DropdownMenuItem>
        )}
        {devices?.map((d) => (
          <DropdownMenuItem key={d.id} disabled={!d.available} onSelect={() => void go(d.id)}>
            <HugeiconsIcon icon={SmartPhone01Icon} className="size-4" />
            <div className="min-w-0">
              <div className="truncate">{d.name}</div>
              <div className="truncate text-xs text-muted-foreground">{d.available ? d.detail : `${d.detail} · not connected`}</div>
            </div>
          </DropdownMenuItem>
        ))}
        {needsReplace && devices && devices.some((d) => d.available) && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs font-normal whitespace-normal text-warning">{job.install?.message}</DropdownMenuLabel>
            {devices
              .filter((d) => d.available && d.name === job.install?.device)
              .map((d) => (
                <DropdownMenuItem key={`r-${d.id}`} variant="destructive" onSelect={() => void go(d.id, true)}>
                  Replace on {d.name} (deletes app data)
                </DropdownMenuItem>
              ))}
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem checked={launch} onCheckedChange={(v) => setLaunch(v === true)} onSelect={(e) => e.preventDefault()}>
          Open the app after installing
        </DropdownMenuCheckboxItem>
        {error && <p className="px-2 py-1.5 text-xs text-destructive">{error}</p>}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
