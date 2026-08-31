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
      agentSeatId: null,
    });
  });

  it("restores an Agent Seat nested under its Project", () => {
    const route = readWorkbenchRoute(
      new URL(
        "http://localhost:3000/projects/project-1/agent-seats/seat-1",
      ),
    );

    expect(route).toEqual({
      section: "seat",
      projectId: "project-1",
      agentSeatId: "seat-1",
    });
  });

  it("writes a canonical Project URL without legacy query state", () => {
    const url = createWorkbenchUrl(
      new URL("http://localhost:3000/?debug=true&page=import"),
      {
        section: "projects",
        projectId: "project-1",
        agentSeatId: null,
      },
    );

    expect(url.pathname).toBe("/projects/project-1");
    expect(url.searchParams.get("page")).toBeNull();
    expect(url.searchParams.get("projectId")).toBeNull();
    expect(url.searchParams.get("agentSeatId")).toBeNull();
    expect(url.search).toBe("");
  });

  it("uses dedicated paths for top-level pages", () => {
    expect(
      createWorkbenchUrl(new URL("http://localhost:3000/"), {
        section: "specs",
        projectId: null,
        agentSeatId: null,
      }).pathname,
    ).toBe("/agent-specs");
    expect(
      readWorkbenchRoute(new URL("http://localhost:3000/projects/import")),
    ).toEqual({
      section: "import",
      projectId: null,
      agentSeatId: null,
    });
  });

  it("does not retain the retired query-string route model", () => {
    expect(
      readWorkbenchRoute(
        new URL("http://localhost:3000/?page=requirements&projectId=project-1"),
      ),
    ).toEqual({
      section: "import",
      projectId: null,
      agentSeatId: null,
    });
  });
});
