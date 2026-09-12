export interface WorkspaceFile {
  path: string;
  name: string;
  size: number;
  kind: 'text' | 'image' | 'binary';
  mimeType: string;
  text?: string;
}
