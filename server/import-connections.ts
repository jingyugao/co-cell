import { ConnectionStore } from './connections.js';
try {
  console.log(JSON.stringify(await new ConnectionStore().importLocal(), null, 2));
} catch {
  console.error('凭据导入失败；请检查本机 glab、MySQL 与 Git 登录配置。');
  process.exitCode = 1;
}
