/** GET /proxy lists the resources granted to the Sandbox project's current role.
 * /proxy/{name}/{path} forwards the method, path, query and body to that resource. */
export const RESOURCE_NAME = /^[a-z0-9][a-z0-9_\-]{0,63}$/;

export interface ApiResource {
  name: string;
  description: string;
}

export interface ApiResourceSettings extends ApiResource {
  endpoint: string;
  authHeader: string;
  authScheme: string;
}

export interface ManagedApiResource extends ApiResourceSettings {
  revision: string;
  /** Extra header names only. Stored values are write-only through the management API. */
  headerNames: string[];
}

export interface ApiResourceHeader {
  name: string;
  /** Omit to keep the stored value for this header at the same endpoint. */
  value?: string;
}

/** POST /api/proxy-resources creates a resource. PUT /:name and DELETE /:name
 * require the last observed revision. Omitting apiKey on update preserves it. */
export interface ApiResourceInput extends Partial<ApiResourceSettings> {
  name: string;
  endpoint: string;
  apiKey?: string;
  /** Omit to retain the set on update. An empty list clears it. */
  headers?: ApiResourceHeader[];
}
export interface ApiResourceList { resources: ApiResource[] }
