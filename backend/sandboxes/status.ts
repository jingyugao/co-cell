import type { SandboxState } from '../../protocol/sandbox-types.js';
import type { SandboxRuntime } from '../execution/container-runtime.js';
import { HttpError } from '../../util/errors.js';

/** A query result belongs to this request, never to the project's durable metadata. */
export async function querySandbox(runtime: SandboxRuntime | undefined, sandbox: SandboxState,
  allowUnknown = false): Promise<SandboxState> {
  try {
    if (!runtime?.querySandbox) throw new HttpError(503, 'Sandbox 状态查询未配置');
    const observation = await runtime.querySandbox(sandbox);
    if (observation.status === 'unknown' && !allowUnknown) throw new HttpError(503, 'Sandbox 状态未知');
    return observation;
  } catch (error) {
    if (allowUnknown) return { ...sandbox, status: 'unknown' };
    throw Object.assign(new HttpError(503, '暂时无法查询 Sandbox 状态，请稍后重试'), { cause: error });
  }
}
