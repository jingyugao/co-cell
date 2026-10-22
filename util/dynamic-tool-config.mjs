const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED_ENV = /^(?:HOME|PATH|PWD|CODEX_HOME|NODE_OPTIONS|XDG_.*|LD_.*|DYLD_.*|CELLBOX_.*|COCELL_.*)$/;
const COMMAND_EXECUTABLE = /^[A-Za-z][A-Za-z0-9_.+-]{0,254}$/;
const NATIVE_EXECUTABLE = /^\/(?:opt\/cellbox\/debug-bin|usr\/bin|usr\/local\/bin)\/[A-Za-z0-9._+-]+$/;
const PACKAGE_EXECUTABLE = /^\/var\/lib\/cellbox\/shared\/tools\/packages\/[a-f0-9]{64}\/(?:[A-Za-z0-9._+-]+\/)*[A-Za-z0-9._+-]+$/;

function validExecutable(path) {
  if (typeof path !== 'string' || path.length > 4096 || path === 'cocell' || path === '/usr/local/bin/cocell' || path.includes('\\') ||
      /[\u0000-\u001f\u007f]/.test(path) || path.split('/').some(part => part === '.' || part === '..')) return false;
  return COMMAND_EXECUTABLE.test(path) || NATIVE_EXECUTABLE.test(path) || PACKAGE_EXECUTABLE.test(path);
}

/** Validate broker-selected dynamic execution data before it reaches spawn(). */
export function validateDynamicToolExecution(value, { credentialAvailable } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !['executable', 'args', 'env', 'timeoutMs'].includes(key)) ||
      !validExecutable(value.executable) || !Array.isArray(value.args) || value.args.length > 32 ||
      value.args.some(arg => typeof arg !== 'string' || arg.includes('\0')) ||
      value.args.reduce((size, arg) => size + Buffer.byteLength(arg), 0) > 8192 ||
      !value.env || typeof value.env !== 'object' || Array.isArray(value.env) || Object.keys(value.env).length > 64 ||
      !Number.isInteger(value.timeoutMs) || value.timeoutMs < 100 || value.timeoutMs > 20000)
    throw new Error('Invalid dynamic tool execution');
  let environmentBytes = 0;
  for (const [key, template] of Object.entries(value.env)) {
    if (!ENV_NAME.test(key) || RESERVED_ENV.test(key) || typeof template !== 'string' ||
        template.includes('\0') || /\$\{(?!HOME\}|CREDENTIAL\})/.test(template))
      throw new Error('Invalid dynamic tool environment');
    if (credentialAvailable === false && template.includes('${CREDENTIAL}'))
      throw new Error('Dynamic tool requires a configured credential');
    environmentBytes += Buffer.byteLength(key) + Buffer.byteLength(template);
  }
  if (environmentBytes > 64 * 1024) throw new Error('Dynamic tool environment is too large');
  return value;
}
