// Explicit history/queue displays and host-command capability checks retain
// their complete state. Ordinary preflight never needs the full job history.
const FULL_STATE_COMMANDS=new Set(['state','jobs','watch','queue','exec']);
export async function readCLIState(call,command){
  return (await call('state',FULL_STATE_COMMANDS.has(command)?{}:{view:'summary'})).state;
}
