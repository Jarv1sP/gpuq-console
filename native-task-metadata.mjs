import {taskIdentity} from './dist/task-metadata.js';

// One envelope for reconciliation/priority. Execution spec and digest never
// include mutable display labels. Old nodes receive their EXACT old request.
export function nativeJobRequest(service,job,extra={}){
  const request={job:job.spec,...extra},host=service.gpuq?.hosts.find(h=>h.id===job.machine);
  if(service.gpuq?.stale===false&&host?.reachable===true&&host.gpuq?.connected===true&&Array.isArray(host.gpuq.capabilities)&&host.gpuq.capabilities.includes('console-task-display-v1'))
    // Backfill carries the original Portal labels, not a renamed native label
    // cached for presentation. The node preserves existing identity-fenced edits.
    request.metadata=taskIdentity({...job,nativeTaskDisplay:undefined},service.store.users);
  return request;
}
