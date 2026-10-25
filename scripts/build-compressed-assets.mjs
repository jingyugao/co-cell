import { brotliCompress, constants, gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const brotli = promisify(brotliCompress);
const gzipAsync = promisify(gzip);
const root = resolve('dist');
const minimumBytes = 1024;

async function* filesUnder(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* filesUnder(path);
    else if (entry.isFile()) yield path;
  }
}

let compressedCount = 0;
let sourceBytes = 0;
let compressedBytes = 0;
for await (const path of filesUnder(root)) {
  if (!/\.(?:js|css)$/i.test(path) || /\.(?:br|gz)$/i.test(path)) continue;
  const metadata = await stat(path);
  if (metadata.size < minimumBytes) continue;
  const source = await readFile(path);
  const br = await brotli(source, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } });
  const gz = await gzipAsync(source, { level: 6 });
  await Promise.all([writeFile(`${path}.br`, br), writeFile(`${path}.gz`, gz)]);
  compressedCount++;
  sourceBytes += source.length;
  compressedBytes += br.length + gz.length;
}
console.log(`Precompressed ${compressedCount} JavaScript/CSS asset(s) >= ${minimumBytes} bytes (${sourceBytes} source bytes, ${compressedBytes} combined compressed bytes).`);
