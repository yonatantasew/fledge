import { createContext, useContext } from "react";

// What the app's fledge.json says, as the server sends it in /api/info.
export interface ProjectInfo {
  flavors: { name: string; label: string; confirm: boolean }[];
  toggles: { id: string; label: string; hint: string; skipFlavors: string[] }[];
  releases: boolean;
  deployRoutes: { id: string; label: string; channel: string; builds: { platform: "android" | "ios"; environment: string; mode: string }[] }[];
  shipChannel: string | null;
}

export const ProjectContext = createContext<ProjectInfo>({ flavors: [], toggles: [], releases: false, deployRoutes: [], shipChannel: null });

export const useProject = () => useContext(ProjectContext);

/** The flavor's label from fledge.json, or its name when it isn't (or is no longer) configured. */
export function useFlavorLabel() {
  const { flavors } = useProject();
  return (name: string) => flavors.find((f) => f.name === name)?.label ?? name;
}
