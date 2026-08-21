export type MainSection =
  | "import"
  | "projects"
  | "instance"
  | "runs"
  | "events"
  | "specs";

export interface WorkbenchRoute {
  section: MainSection;
  projectId: string | null;
  agentInstanceId: string | null;
}

const sections = new Set<MainSection>([
  "import",
  "projects",
  "instance",
  "runs",
  "events",
  "specs",
]);

function decodeSegment(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export function readWorkbenchRoute(url: URL): WorkbenchRoute {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length === 2 && segments[0] === "projects" && segments[1] === "import") {
    return { section: "import", projectId: null, agentInstanceId: null };
  }
  if (segments.length === 1 && segments[0] === "projects") {
    return { section: "projects", projectId: null, agentInstanceId: null };
  }
  if (segments.length === 2 && segments[0] === "projects") {
    const projectId = decodeSegment(segments[1]!);
    if (projectId) return { section: "projects", projectId, agentInstanceId: null };
  }
  if (
    segments.length === 4 &&
    segments[0] === "projects" &&
    segments[2] === "agents"
  ) {
    const projectId = decodeSegment(segments[1]!);
    const agentInstanceId = decodeSegment(segments[3]!);
    if (projectId && agentInstanceId) {
      return { section: "instance", projectId, agentInstanceId };
    }
  }
  if (segments.length === 1 && sections.has(segments[0] as MainSection)) {
    const section = segments[0] as MainSection;
    if (section !== "projects" && section !== "instance") {
      return { section, projectId: null, agentInstanceId: null };
    }
  }
  if (segments.length === 1 && segments[0] === "agent-specs") {
    return { section: "specs", projectId: null, agentInstanceId: null };
  }

  // Migrate links produced by the first workbench prototype.
  if (segments.length === 0) {
    const legacyPage = url.searchParams.get("page");
    const projectId = url.searchParams.get("projectId");
    const agentInstanceId = url.searchParams.get("agentInstanceId");
    if (legacyPage === "instance" && projectId && agentInstanceId) {
      return { section: "instance", projectId, agentInstanceId };
    }
    if (legacyPage === "requirements" || projectId) {
      return { section: "projects", projectId, agentInstanceId: null };
    }
    if (legacyPage === "runs" || legacyPage === "events" || legacyPage === "specs") {
      return { section: legacyPage, projectId: null, agentInstanceId: null };
    }
  }
  return { section: "import", projectId: null, agentInstanceId: null };
}

export function createWorkbenchUrl(currentUrl: URL, route: WorkbenchRoute): URL {
  const url = new URL(currentUrl);
  url.searchParams.delete("page");
  url.searchParams.delete("projectId");
  url.searchParams.delete("agentInstanceId");
  switch (route.section) {
    case "import":
      url.pathname = "/projects/import";
      break;
    case "projects":
      url.pathname = route.projectId
        ? `/projects/${encodeURIComponent(route.projectId)}`
        : "/projects";
      break;
    case "instance":
      url.pathname = route.projectId && route.agentInstanceId
        ? `/projects/${encodeURIComponent(route.projectId)}/agents/${encodeURIComponent(route.agentInstanceId)}`
        : "/projects";
      break;
    case "specs":
      url.pathname = "/agent-specs";
      break;
    default:
      url.pathname = `/${route.section}`;
  }
  return url;
}
