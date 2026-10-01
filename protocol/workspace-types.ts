/** Preview of a workspace file read through Cellbox; transfers are limited to 16 MiB. */
export interface WorkspaceFile {
  path: string;
  name: string;
  size: number;
  kind: 'text' | 'image' | 'binary';
  mimeType: string;
  text?: string;
}
