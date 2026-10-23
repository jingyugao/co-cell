import type { ProjectStatus } from './types.js';

/** A project file location; content is resolved when opened. */
export interface FileFavorite {
  id: string;
  projectId: string;
  path: string;
  createdAt: string;
  projectName: string;
  workingDirectory: string;
  projectStatus: ProjectStatus;
}
