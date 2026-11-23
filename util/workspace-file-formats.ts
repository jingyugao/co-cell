// File links, HTTP responses and the preview panel share the same extension list.
const formats = {
  'image/svg+xml': 'svg', 'image/png': 'png', 'image/apng': 'apng', 'image/jpeg': 'jpg jpeg jfif',
  'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif', 'image/bmp': 'bmp',
  'image/x-icon': 'ico', 'image/tiff': 'tif tiff',
  'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/wav': 'wav', 'audio/ogg': 'ogg oga opus',
  'audio/flac': 'flac', 'audio/aac': 'aac', 'audio/webm': 'weba',
  'video/mp4': 'mp4 m4v', 'video/webm': 'webm', 'video/ogg': 'ogv', 'video/quicktime': 'mov',
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.openxmlformats-officedocument.presentationml.slideshow': 'ppsx',
  'application/vnd.ms-word.document.macroenabled.12': 'docm',
  'application/vnd.ms-excel.sheet.macroenabled.12': 'xlsm',
  'application/vnd.ms-powerpoint.presentation.macroenabled.12': 'pptm',
  'text/csv': 'csv', 'text/tab-separated-values': 'tsv',
};
const byExtension = new Map(Object.entries(formats).flatMap(([mime, extensions]) =>
  extensions.split(' ').map(extension => [extension, mime] as const)));
const textExtension = /\.(?:md|markdown|mdx|txt|log|json|jsonl|ndjson|yaml|yml|toml|ini|cfg|conf|sql|go|rs|py|js|jsx|ts|tsx|mjs|cjs|css|scss|less|html?|xml|sh|bash|zsh|c|h|cc|cpp|hpp|java|rb|php|cs|vue|svelte|proto|lock|ipynb)$/i;
const extensionMime = (path: string) => byExtension.get(/\.([a-z0-9]+)$/i.exec(path)?.[1].toLowerCase() ?? '');
export const isWorkspaceFileName = (path: string) => Boolean(extensionMime(path)) || textExtension.test(path) || /\.(?:zip|gz|tar|wasm)$/i.test(path);
export const isDelimitedText = (mime: string) => mime === 'text/csv' || mime === 'text/tab-separated-values';

export function workspaceContentType(path: string, header: string | null) {
  const mime = header?.split(';')[0].trim().toLowerCase() || 'application/octet-stream';
  const named = extensionMime(path);
  if (mime.startsWith('multipart/')) return mime;
  if (mime === 'text/html' || mime === 'application/xhtml+xml' || textExtension.test(path)) return 'text/plain';
  if (named === 'image/svg+xml' && ['text/plain', 'text/xml', 'application/xml'].includes(mime)) return named;
  if (named && (mime === 'application/octet-stream' || isDelimitedText(named))) return named;
  // OOXML files are ZIP containers. Some storage backends only report that outer type.
  if (mime === 'application/zip' && named?.startsWith('application/vnd.')) return named;
  if (isDelimitedText(mime) || mime === 'image/svg+xml') return mime;
  if (mime.startsWith('text/') || /^(?:application\/(?:json|xml|javascript|yaml)|.+\+(?:json|xml))$/.test(mime)) return 'text/plain';
  return mime;
}

export function workspacePreviewKind(mime: string) {
  if (mime === 'image/tiff' || (Object.hasOwn(formats, mime) && mime.startsWith('application/'))) return 'document';
  if (mime === 'image/vnd.microsoft.icon' || (Object.hasOwn(formats, mime) && mime.startsWith('image/'))) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('text/')) return 'text';
  return 'binary';
}
