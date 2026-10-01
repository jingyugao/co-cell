/** Legacy bounded file preview used by internal readers. */
export interface WorkspaceFile {
  path: string;
  name: string;
  size: number;
  kind: 'text' | 'image' | 'binary';
  mimeType: string;
  text?: string;
}

/** Public file content is a GET/HEAD HTTP resource, never a JSON envelope.
 * Supports byte ranges (206/416), Last-Modified and conditional requests (304).
 * Content-Length on HEAD describes the full file; on 206 it describes the range.
 */
export interface WorkspaceFilePreview extends WorkspaceFile {
  truncated?: boolean;
}
