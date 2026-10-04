import { resolve } from 'node:path';

/** Local installation settings; explicit process environment takes precedence. */
export function loadDeployEnv() {
  try { process.loadEnvFile(resolve(import.meta.dirname, '../../deploy.env')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
