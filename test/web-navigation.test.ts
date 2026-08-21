import { describe, expect, it } from "vitest";

import {
  createWorkbenchUrl,
  readWorkbenchRoute,
} from "../web/src/navigation.js";

describe("workbench URL navigation", () => {
  it("restores a Project detail from its path", () => {
    const route = readWorkbenchRoute(
      new URL("http://localhost:3000/projects/project-1"),
    );

    expect(route).toEqual({
      section: "projects",
      projectId: "project-1",
      agentInstanceId: null,
    });
  });

  it("restores an agent instance nested under its Project", () => {
    const route = readWorkbenchRoute(
      new URL(
        "http://localhost:3000/projects/project-1/agents/agent-1",
      ),
    );

    expect(route).toEqual({
      section: "instance",
      projectId: "project-1",
      agentInstanceId: "agent-1",
    });
  });

  it("writes a canonical Project URL and preserves filter parameters", () => {
    const url = createWorkbenchUrl(
      new URL("http://localhost:3000/?debug=true&page=import"),
      {
        section: "projects",
        projectId: "project-1",
        agentInstanceId: null,
      },
    );

    expect(url.pathname).toBe("/projects/project-1");
    expect(url.searchParams.get("page")).toBeNull();
    expect(url.searchParams.get("projectId")).toBeNull();
    expect(url.searchParams.get("agentInstanceId")).toBeNull();
    expect(url.searchParams.get("debug")).toBe("true");
  });

  it("uses dedicated paths for top-level pages", () => {
    expect(
      createWorkbenchUrl(new URL("http://localhost:3000/"), {
        section: "specs",
        projectId: null,
        agentInstanceId: null,
      }).pathname,
    ).toBe("/agent-specs");
    expect(
      readWorkbenchRoute(new URL("http://localhost:3000/projects/import")),
    ).toEqual({
      section: "import",
      projectId: null,
      agentInstanceId: null,
    });
  });

  it("migrates legacy query links to the Project route model", () => {
    expect(
      readWorkbenchRoute(
        new URL("http://localhost:3000/?page=requirements&projectId=project-1"),
      ),
    ).toEqual({
      section: "projects",
      projectId: "project-1",
      agentInstanceId: null,
    });
  });
});
