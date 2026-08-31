export type MainSection =
  | "import"
  | "projects"
  | "seat"
  | "runs"
  | "events"
  | "specs";

export interface WorkbenchRoute {
  section: MainSection;
  projectId: string | null;
  agentSeatId: string | null;
}

const sections = new Set<MainSection>([
  "import",
  "projects",
  "seat",
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
    return { section: "import", projectId: null, agentSeatId: null };
  }
  if (segments.length === 1 && segments[0] === "projects") {
    return { section: "projects", projectId: null, agentSeatId: null };
  }
  if (segments.length === 2 && segments[0] === "projects") {
    const projectId = decodeSegment(segments[1]!);
    if (projectId) return { section: "projects", projectId, agentSeatId: null };
  }
  if (
    segments.length === 4 &&
    segments[0] === "projects" &&
    segments[2] === "agent-seats"
  ) {
    const projectId = decodeSegment(segments[1]!);
    const agentSeatId = decodeSegment(segments[3]!);
    if (projectId && agentSeatId) {
      return { section: "seat", projectId, agentSeatId };
    }
  }
  if (segments.length === 1 && sections.has(segments[0] as MainSection)) {
    const section = segments[0] as MainSection;
    if (section !== "projects" && section !== "seat") {
      return { section, projectId: null, agentSeatId: null };
    }
  }
  if (segments.length === 1 && segments[0] === "agent-specs") {
    return { section: "specs", projectId: null, agentSeatId: null };
  }
  return { section: "import", projectId: null, agentSeatId: null };
}

export function createWorkbenchUrl(currentUrl: URL, route: WorkbenchRoute): URL {
  const url = new URL(currentUrl);
  url.search = "";
  switch (route.section) {
    case "import":
      url.pathname = "/projects/import";
      break;
    case "projects":
      url.pathname = route.projectId
        ? `/projects/${encodeURIComponent(route.projectId)}`
        : "/projects";
      break;
    case "seat":
      url.pathname = route.projectId && route.agentSeatId
        ? `/projects/${encodeURIComponent(route.projectId)}/agent-seats/${encodeURIComponent(route.agentSeatId)}`
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
