import { isIP } from 'node:net';
import { CoreV1Api, CustomObjectsApi, KubeConfig, ServerConfiguration, createConfiguration } from '@kubernetes/client-node';
import { HttpError } from '../../util/errors.js';

const group = 'cellbox.jingyugao.github.io';
const denied = () => new HttpError(403, '请求来源不是已确认运行的 Box');

interface RuntimeBox {
  metadata?: { uid?: string; generation?: number; deletionTimestamp?: string; labels?: Record<string, string> };
  spec?: { desiredState?: string; transitionID?: string; container?: { name?: string } };
  status?: { phase?: string; observedGeneration?: number; observedTransitionID?: string; podUID?: string;
    execution?: { podUID?: string; podIP?: string; containerID?: string } };
}

function clusterClients(kubeconfig: string) {
  const kube = new KubeConfig();
  kube.loadFromFile(kubeconfig);
  const cluster = kube.getCurrentCluster();
  if (!cluster) throw new Error('Box source kubeconfig has no active cluster');
  const config = createConfiguration({ baseServer: new ServerConfiguration(cluster.server, {}), authMethods: { default: kube },
    promiseMiddleware: [{ pre: async request => { request.setSignal(AbortSignal.timeout(4000)); return request; },
      post: async response => response }] });
  return { pods: new CoreV1Api(config), boxes: new CustomObjectsApi(config) };
}

/** Use the socket peer and current cluster state on each request. IPs can be reused after suspension. */
export function createBoxSource(kubeconfig: string | undefined, namespace: string | undefined) {
  let clients: ReturnType<typeof clusterClients> | undefined;
  return async (address: string): Promise<string> => {
    if (!kubeconfig || !namespace) throw new HttpError(503, '尚未配置 Box 来源查询');
    const ip = address.replace(/^::ffff:(?=\d+\.)/i, '');
    if (!isIP(ip)) throw denied();
    try {
      const { pods, boxes } = clients ??= clusterClients(kubeconfig);
      const page = await pods.listNamespacedPod({ namespace, fieldSelector: 'status.podIP=' + ip, limit: 2 });
      const pod = page.items[0];
      const owner = pod?.metadata?.ownerReferences?.find(ref => ref.controller);
      const uid = pod?.metadata?.uid;
      if (page.metadata?._continue || page.items.length !== 1 || !uid || pod.metadata?.deletionTimestamp || pod.spec?.hostNetwork
        || pod.status?.phase !== 'Running' || pod.status?.podIP !== ip || !owner?.uid
        || owner.kind !== 'Cellbox' || owner.apiVersion !== group + '/v1alpha1') throw denied();
      const box: RuntimeBox = await boxes.getNamespacedCustomObject({
        group, version: 'v1alpha1', namespace, plural: 'cellboxes', name: owner.name });
      const { metadata, spec, status } = box;
      const execution = status?.execution;
      const boxId = metadata?.labels?.[group + '/box-id'];
      const container = pod.status.containerStatuses?.find(item => item.name === spec?.container?.name);
      if (!boxId || metadata?.uid !== owner.uid || metadata?.deletionTimestamp || spec?.desiredState !== 'Running'
        || status?.phase !== 'Running' || metadata.generation !== status.observedGeneration
        || spec.transitionID !== status.observedTransitionID || status.podUID !== uid || execution?.podUID !== uid
        || execution.podIP !== ip || !execution.containerID || !container?.state?.running || container.restartCount !== 0
        || container.containerID?.replace(/^[^:]+:\/\//, '') !== execution.containerID) throw denied();
      return boxId;
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if ((error as { code?: number }).code === 404) throw denied();
      throw new HttpError(503, '暂时无法确认 Box 来源');
    }
  };
}
