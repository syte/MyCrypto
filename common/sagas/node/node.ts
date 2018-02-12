import { delay, SagaIterator, buffers, channel, Task, Channel, takeEvery } from 'redux-saga';
import {
  call,
  fork,
  put,
  take,
  select,
  race,
  apply,
  spawn,
  flush,
  all,
  actionChannel
} from 'redux-saga/effects';
import {
  nodeCallRequested,
  NodeCall,
  workerSpawned,
  NodeCallRequestedAction,
  nodeCallSucceeded,
  workerProcessing,
  TypeKeys,
  NodeCallSucceededAction,
  NodeCallFailedAction,
  nodeOffline,
  nodeCallFailed,
  nodeCallTimeout,
  NodeCallTimeoutAction,
  NodeOfflineAction,
  nodeOnline,
  BalancerFlushAction,
  balancerFlush,
  networkSwitchRequested,
  NetworkSwitchSucceededAction,
  networkSwitchSucceeded
} from 'actions/nodeBalancer';
import {
  getNodeStatsById,
  getAllMethodsAvailable,
  getAvailableNodeId
} from 'selectors/nodeBalancer';
import {
  getOffline,
  getNodeById,
  getAllNodesOfNetworkId,
  getNetworkConfig,
  getSelectedNetwork
} from 'selectors/config';
import { toggleOffline } from 'actions/config';
import { StaticNodeConfig, CustomNodeConfig, NodeConfig } from '../../../shared/types/node';
import { INodeStats } from 'reducers/nodeBalancer/nodes';
import { IWorker } from 'reducers/nodeBalancer/workers';

// need to check this arbitary number
const MAX_NODE_CALL_TIMEOUTS = 3;

/**
 *  For now we're going to hard code the initial node configuration in,
 *  ideally on initialization, a ping call gets sent to every node in the current network
 *  to determine which nodes are offline on app start using 'NodeAdded'
 *  then spawn workers for each node from there using 'WorkerSpawned'
 *
 */

/**
 * Each channel id is a 1-1 mapping of a nodeId
 */
interface IChannels {
  [key: string]: Channel<NodeCall>;
}

const channels: IChannels = {};

function* networkSwitch(): SagaIterator {
  yield put(networkSwitchRequested());

  //flush all existing requests
  yield put(balancerFlush());

  const network: string = yield select(getSelectedNetwork);
  const nodes: {
    [x: string]: NodeConfig;
  } = yield select(getAllNodesOfNetworkId, network);

  interface Workers {
    [workerId: string]: IWorker;
  }
  /**
   *
   * @description Handles checking if a node is online or not, and adding it to the node balancer
   * @param {string} nodeId
   * @param {NodeConfig} nodeConfig
   */
  function* handleAddingNode(nodeId: string, nodeConfig: NodeConfig) {
    const startTime = new Date();
    const nodeIsOnline: boolean = yield call(checkNodeConnectivity, nodeId, false);
    const endTime = new Date();
    const avgResponseTime = +endTime - +startTime;
    const stats: INodeStats = {
      avgResponseTime,
      isOffline: !nodeIsOnline,
      isCustom: nodeConfig.isCustom,
      timeoutThresholdMs: 2000,
      currWorkersById: [],
      maxWorkers: 3,
      requestFailures: 0,
      requestFailureThreshold: 2,
      supportedMethods: {
        client: true,
        requests: true,
        ping: true,
        sendCallRequest: true,
        getBalance: true,
        estimateGas: true,
        getTokenBalance: true,
        getTokenBalances: true,
        getTransactionCount: true,
        getCurrentBlock: true,
        sendRawTx: true
      }
    };

    const nodeChannel: Channel<NodeCall> = yield call(channel, buffers.expanding(10));
    channels[nodeId] = nodeChannel;

    const workers: Workers = {};
    for (
      let workerNumber = stats.currWorkersById.length;
      workerNumber < stats.maxWorkers;
      workerNumber++
    ) {
      const workerId = `${nodeId}_worker_${workerNumber}`;
      const workerTask: Task = yield spawn(spawnWorker, workerId, nodeId, nodeChannel);
      console.log(`Worker ${workerId} spawned for ${nodeId}`);
      stats.currWorkersById.push(workerId);
      const worker: IWorker = { assignedNode: nodeId, currentPayload: null, task: workerTask };
      workers[workerId] = worker;
    }

    return { nodeId, stats, workers };
  }

  const nodeEntries = Object.entries(nodes).map(([nodeId, nodeConfig]) =>
    call(handleAddingNode, nodeId, nodeConfig)
  );

  // process adding all nodes in parallel
  const processedNodes: { nodeId: string; stats: INodeStats; workers: Workers }[] = yield all(
    nodeEntries
  );

  const networkSwitchPayload = processedNodes.reduce(
    (accu, currNode) => ({
      nodeStats: { ...accu.nodeStats, [currNode.nodeId]: currNode.stats },
      workers: { ...accu.workers, ...currNode.workers }
    }),
    {} as NetworkSwitchSucceededAction['payload']
  );

  yield put(networkSwitchSucceeded(networkSwitchPayload));
}

function* handleNodeCallRequests(): SagaIterator {
  const requestChan = yield actionChannel(TypeKeys.NODE_CALL_REQUESTED);
  while (true) {
    const { payload }: NodeCallRequestedAction = yield take(requestChan);
    // check if the app is offline
    if (yield select(getOffline)) {
      yield call(delay, 2000);
    }
    // wait until its back online

    // get an available nodeId to put the action to the channel
    const nodeId: string = yield select(getAvailableNodeId, payload);
    const nodeChannel = channels[nodeId];
    yield put(nodeChannel, payload);
  }
}

function* handleCallTimeouts({
  payload: { error, nodeId, ...nodeCall }
}: NodeCallTimeoutAction): SagaIterator {
  const nodeStats: Readonly<INodeStats> | undefined = yield select(getNodeStatsById, nodeId);
  if (!nodeStats) {
    throw Error('Could not find node stats');
  }
  // if the node has reached maximum failures, declare it as offline
  if (nodeStats.requestFailures >= nodeStats.requestFailureThreshold) {
    yield put(nodeOffline({ nodeId }));

    //check if all methods are still available after this node goes down
    const isAllMethodsAvailable: boolean = yield select(getAllMethodsAvailable);
    if (!isAllMethodsAvailable) {
      // if not, set app state offline and flush channels
      const appIsOffline: boolean = yield select(getOffline);
      if (!appIsOffline) {
        yield put(toggleOffline());
      }
    }
  }

  // if the payload exceeds timeout limits, return a response failure
  if (nodeCall.numOfTimeouts > MAX_NODE_CALL_TIMEOUTS) {
    yield put(nodeCallFailed({ error: error.message, nodeCall }));
  } else {
    // else consider it a timeout on the request to be retried
    // might want to make this a seperate action
    // add nodeId to min priority to avoid it if possible
    const nextNodeCall: NodeCall = {
      ...nodeCall,
      minPriorityNodeList: [...nodeCall.minPriorityNodeList, nodeId],
      numOfTimeouts: ++nodeCall.numOfTimeouts
    };
    yield put(nodeCallRequested(nextNodeCall));
  }
}

/**
 * @description polls the offline state of a node, then returns control to caller when it comes back online
 * @param {string} nodeId
 */
function* checkNodeConnectivity(nodeId: string, poll: boolean = true) {
  const nodeConfig: NodeConfig = yield select(getNodeById, nodeId);
  while (true) {
    try {
      console.log(`Polling ${nodeId} to see if its online...`);
      const { lb } = yield race({
        lb: apply(nodeConfig.pLib, nodeConfig.pLib.getCurrentBlock),
        to: call(delay, 5000)
      });
      if (lb) {
        console.log(`${nodeId} online!`);
        return true;
      }
    } catch (error) {
      if (!poll) {
        return false;
      }
      yield call(delay, 5000);
      console.info(error);
    }
    console.log(`${nodeId} still offline`);
  }
}

function* watchOfflineNode({ payload: { nodeId } }: NodeOfflineAction) {
  yield call(checkNodeConnectivity, nodeId);

  yield put(nodeOnline({ nodeId }));

  // check if all methods are available after this node is online
  const isAllMethodsAvailable: boolean = yield select(getAllMethodsAvailable);

  // if they are, put app in online state
  if (isAllMethodsAvailable) {
    const appIsOffline: boolean = yield select(getOffline);
    if (appIsOffline) {
      yield put(toggleOffline());
    }
  }
}

function* spawnWorker(thisId: string, nodeId: string, chan: IChannels[string]) {
  /**
   * @description used to differentiate between errors from worker code vs a network call error
   * @param message
   */
  const createInternalError = (message: string) => {
    const e = Error(message);
    e.name = 'InternalError';
    return e;
  };

  //select the node config on initialization to avoid re-selecting on every request handled
  const nodeConfig: StaticNodeConfig | CustomNodeConfig | undefined = yield select(
    getNodeById,
    nodeId
  );
  if (!nodeConfig) {
    throw Error(`Node ${nodeId} not found when selecting from state`);
  }

  let currentPayload: NodeCall;
  while (true) {
    try {
      // take from the assigned action channel
      const payload: NodeCall = yield take(chan);
      currentPayload = payload;
      // after taking a request, declare processing state
      yield put(workerProcessing({ currentPayload: payload, workerId: thisId }));

      const nodeStats: Readonly<INodeStats> | undefined = yield select(getNodeStatsById, nodeId);

      if (!nodeStats) {
        throw createInternalError(`Could not find stats for node ${nodeId}`);
      }

      const lib = nodeConfig.pLib;

      // make the call in the allotted timeout time
      // this will create an infinite loop
      const { result, timeout } = yield race({
        result: apply(lib, lib[payload.rpcMethod], payload.rpcArgs),
        timeout: call(delay, nodeStats.timeoutThresholdMs)
      });

      //TODO: clean this up
      if (timeout || !result) {
        throw createInternalError(`Request timed out for ${nodeId}`);
      }

      yield put(nodeCallSucceeded({ result, nodeCall: payload }));
    } catch (error) {
      const e: Error = error;
      if (!(e.name === 'InternalError')) {
        e.name = `NetworkError_${e.name}`;
      }
      yield put(nodeCallTimeout({ ...currentPayload!, nodeId, error }));
    }
  }
}

export const nodeCallRequester = (() => {
  let callId = 0;
  return (rpcMethod: string) => {
    return function*(...rpcArgs: string[]) {
      // allow all nodes for now
      const nodeCall: NodeCall = {
        callId: ++callId,
        numOfTimeouts: 0,
        rpcArgs,
        rpcMethod,
        minPriorityNodeList: []
      };

      // make the request to the load balancer
      const networkReq = nodeCallRequested(nodeCall);
      console.log(networkReq);
      yield put(networkReq);

      //wait for either a success or error response
      const response: NodeCallSucceededAction | NodeCallFailedAction = yield take(
        (action: NodeCallSucceededAction | NodeCallFailedAction) =>
          (action.type === TypeKeys.NODE_CALL_SUCCEEDED ||
            action.type === TypeKeys.NODE_CALL_FAILED) &&
          action.payload.nodeCall.callId === networkReq.payload.callId
      );

      // return the result as expected
      if (response.type === TypeKeys.NODE_CALL_SUCCEEDED) {
        return response.payload.result;
      } else {
        // or throw an error
        throw Error(response.payload.error);
      }
    };
  };
})();

function* flushHandler(_: BalancerFlushAction): SagaIterator {
  const channelValues = Object.values(channels);
  for (const chan of channelValues) {
    yield flush(chan);
  }
}

export function* nodeBalancer() {
  yield all([
    call(networkSwitch),
    takeEvery(TypeKeys.NODE_OFFLINE, watchOfflineNode),
    fork(handleNodeCallRequests),
    takeEvery(TypeKeys.NODE_CALL_TIMEOUT, handleCallTimeouts),
    takeEvery(TypeKeys.BALANCER_FLUSH, flushHandler)
  ]);
}