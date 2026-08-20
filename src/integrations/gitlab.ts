export interface GitLabMergeRequestReference {
  url: string;
  projectPath: string;
  iid: number;
}

export interface VerifiedGitLabMergeRequest extends GitLabMergeRequestReference {
  state: string;
  title?: string;
}

const URL_CANDIDATE = /https?:\/\/[^\s<>"'`]+/g;

export function findGitLabMergeRequestUrl(
  text: string,
  baseUrl?: string,
): GitLabMergeRequestReference | undefined {
  const expectedOrigin = baseUrl ? new URL(baseUrl).origin : undefined;
  for (const candidate of text.match(URL_CANDIDATE) ?? []) {
    const cleaned = candidate.replace(/[),.;:!?，。；：！？、）】》]+$/u, "");
    let url: URL;
    try {
      url = new URL(cleaned);
    } catch {
      continue;
    }
    if (expectedOrigin && url.origin !== expectedOrigin) continue;
    const match = url.pathname.match(/^\/(.+)\/-\/merge_requests\/(\d+)\/?$/);
    if (!match?.[1] || !match[2]) continue;
    return {
      url: url.toString().replace(/\/$/, ""),
      projectPath: decodeURIComponent(match[1]),
      iid: Number(match[2]),
    };
  }
  return undefined;
}

export async function verifyGitLabMergeRequest(options: {
  baseUrl: string;
  token: string;
  mergeRequestUrl: string;
  fetchImplementation?: typeof fetch;
}): Promise<VerifiedGitLabMergeRequest> {
  const reference = findGitLabMergeRequestUrl(
    options.mergeRequestUrl,
    options.baseUrl,
  );
  if (!reference) {
    throw new Error("The reported merge request URL is not from configured GitLab");
  }

  const endpoint = new URL(
    `/api/v4/projects/${encodeURIComponent(reference.projectPath)}/merge_requests/${reference.iid}`,
    options.baseUrl,
  );
  const response = await (options.fetchImplementation ?? fetch)(endpoint, {
    headers: { "PRIVATE-TOKEN": options.token },
  });
  if (!response.ok) {
    throw new Error(
      `GitLab merge request verification failed with HTTP ${response.status}`,
    );
  }
  const body = (await response.json()) as {
    state?: unknown;
    title?: unknown;
    web_url?: unknown;
  };
  if (body.state !== "opened") {
    throw new Error(`GitLab merge request is not open: ${String(body.state)}`);
  }
  if (body.web_url !== reference.url) {
    throw new Error("GitLab returned a different merge request URL");
  }
  return {
    ...reference,
    state: body.state,
    ...(typeof body.title === "string" ? { title: body.title } : {}),
  };
}
