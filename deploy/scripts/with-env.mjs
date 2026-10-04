import { spawn } from 'node:child_process';
import { loadDeployEnv } from '../../scripts/config/deploy-env.mjs';

loadDeployEnv();
const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error('Expected a deployment command');
const child = spawn(command, args, { stdio: 'inherit', env: process.env });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 130 : 1); });
