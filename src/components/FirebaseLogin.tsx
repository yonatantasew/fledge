import { Alert02Icon, Cancel01Icon, FireIcon, LinkSquare02Icon, Loading03Icon, Login03Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { firebaseApi, useFirebase } from "@/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/** Header control: shows who the Firebase CLI is signed in as, or a button to sign in. */
export function FirebaseLogin() {
  const { status, refresh } = useFirebase();
  const [requestError, setRequestError] = useState<string | null>(null);
  const login = status.login;

  if (login?.running) {
    return (
      <div className="flex items-center gap-1">
        <Badge variant="outline" className="h-9 gap-1.5 px-3 text-xs">
          <HugeiconsIcon icon={Loading03Icon} className="size-3.5 animate-spin text-info" />
          Finish signing in in your browser…
        </Badge>
        {login.url && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" asChild aria-label="Open the Google sign-in page">
                <a href={login.url} target="_blank" rel="noreferrer">
                  <HugeiconsIcon icon={LinkSquare02Icon} className="size-4" />
                </a>
              </Button>
            </TooltipTrigger>
            <TooltipContent>Browser didn't open? Open the sign-in page</TooltipContent>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" onClick={() => void firebaseApi.cancel()} aria-label="Cancel sign-in">
              <HugeiconsIcon icon={Cancel01Icon} className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Cancel</TooltipContent>
        </Tooltip>
      </div>
    );
  }

  if (status.state === "checking") {
    return (
      <Badge variant="outline" className="h-9 gap-1.5 px-3 text-xs text-muted-foreground">
        <HugeiconsIcon icon={Loading03Icon} className="size-3.5 animate-spin" />
        Firebase
      </Badge>
    );
  }

  if (status.state === "ok") {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge variant="outline" className="h-9 cursor-pointer gap-1.5 px-3 text-xs" onClick={refresh}>
            <HugeiconsIcon icon={FireIcon} className="size-3.5 text-warning" />
            {status.email}
            <span className="size-1.5 rounded-full bg-success" />
          </Badge>
        </TooltipTrigger>
        <TooltipContent>Firebase CLI signed in · click to re-check</TooltipContent>
      </Tooltip>
    );
  }

  if (status.state === "missing") {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge variant="outline" className="h-9 gap-1.5 px-3 text-xs text-muted-foreground">
            <HugeiconsIcon icon={FireIcon} className="size-3.5" />
            Firebase CLI not installed
          </Badge>
        </TooltipTrigger>
        <TooltipContent>Install it with: npm i -g firebase-tools</TooltipContent>
      </Tooltip>
    );
  }

  const error = requestError ?? login?.error;
  return (
    <div className="flex items-center gap-2">
      {error && (
        <Tooltip>
          <TooltipTrigger asChild>
            <HugeiconsIcon icon={Alert02Icon} className="size-4 text-destructive" aria-label="Last sign-in failed" />
          </TooltipTrigger>
          <TooltipContent className="max-w-72">Last sign-in: {error}</TooltipContent>
        </Tooltip>
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="outline"
            className="h-9 border-warning/60 text-warning hover:text-warning"
            onClick={() => {
              setRequestError(null);
              firebaseApi.login().catch((e) => setRequestError((e as Error).message));
            }}
          >
            <HugeiconsIcon icon={Login03Icon} className="size-4" />
            Log in to Firebase
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {status.state === "expired"
            ? `The saved sign-in for ${status.email} has expired.`
            : "The Firebase CLI isn't signed in."}{" "}
          Opens Google sign-in in your browser.
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
