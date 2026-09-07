// Run inside a sandbox. Only metadata/counts are printed; tokens stay in memory.
import { readFile } from 'node:fs/promises';
import https from 'node:https';
const config = JSON.parse(await readFile(process.env.KUBECONFIG, 'utf8'));
const checks = [
  ['get', '', 'pods'], ['list', '', 'pods'], ['get', '', 'pods', 'log'], ['list', '', 'services'], ['list', 'apps', 'deployments'],
  ...['create','update','patch','delete','deletecollection'].flatMap(verb => [['pods',''], ['services',''], ['deployments','apps'], ['jobs','batch']].map(([resource,group]) => [verb,group,resource])),
  ...['get','create'].flatMap(verb => ['exec','attach','portforward','proxy'].map(sub => [verb,'','pods',sub])),
  ['get','','nodes','proxy'], ['get','','services','proxy'], ['patch','apps','deployments','scale'],
  ['get','','secrets'], ['list','','secrets'], ['get','','configmaps'], ['create','','serviceaccounts','token'],
  ['create','rbac.authorization.k8s.io','clusterroles'], ['create','rbac.authorization.k8s.io','rolebindings'], ['impersonate','','users'],
];
const report = { passed: true, contexts: [] };
for (const context of config.contexts) {
  const cluster = config.clusters.find(item => item.name === context.context.cluster).cluster;
  const user = config.users.find(item => item.name === context.context.user).user;
  if (!user.token || user['client-key-data'] || user['client-certificate-data']) throw Error('Unexpected credential type');
  const request = (path, body) => new Promise((resolve,reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const req = https.request(new URL(path, cluster.server), { method: data ? 'POST' : 'GET', ca: cluster['certificate-authority-data'] ? Buffer.from(cluster['certificate-authority-data'],'base64') : undefined, servername: cluster['tls-server-name'], headers: { Authorization: `Bearer ${user.token}`, ...(data ? {'Content-Type':'application/json'} : {}) }, timeout: 15000 }, res => {
      let output='';res.on('data',c=>{output+=c;if(output.length>8*1024*1024)req.destroy();});res.on('end',()=>{try{resolve({code:res.statusCode,data:JSON.parse(output)})}catch{reject(Error('Invalid API response'))}});
    });req.on('error',()=>reject(Error('API unavailable')));req.on('timeout',()=>req.destroy());req.end(data);
  });
  const result = { name: context.name, checks: [], deploymentRead: false };
  for (let start=0;start<checks.length;start+=6) await Promise.all(checks.slice(start,start+6).map(async ([verb,group,resource,subresource],offset) => {
    const expected = start+offset<5;
    const response = await request('/apis/authorization.k8s.io/v1/selfsubjectaccessreviews', {apiVersion:'authorization.k8s.io/v1',kind:'SelfSubjectAccessReview',spec:{resourceAttributes:{namespace:'default',verb,group,resource,...(subresource?{subresource}:{})}}});
    const allowed=response.data.status?.allowed;
    const ok=response.code===201 && allowed===expected;
    result.checks.push({verb,group,resource,...(subresource?{subresource}:{}),expected,allowed,ok});
    if(!ok)report.passed=false;
  }));
  const response=await request('/apis/apps/v1/deployments?limit=1');result.deploymentRead=response.code===200 && Array.isArray(response.data.items);
  if(!result.deploymentRead)report.passed=false;
  report.contexts.push(result);
}
console.log(JSON.stringify(report));if(!report.passed)process.exitCode=1;
