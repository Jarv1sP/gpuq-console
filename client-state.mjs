// Explicit history/queue displays and host-command capability checks retain
// their complete state. Ordinary preflight never needs the full job history.
const FULL_STATE_COMMANDS=new Set(['state','jobs','watch','queue','exec']);
export async function readCLIState(call,command){
  return (await call('state',FULL_STATE_COMMANDS.has(command)?{}:{view:'summary'})).state;
}

// A lost submit reply must never replay a mutation. Recover only the original
// owner-bound key from the existing read-only state operation, when available.
export async function submitJobWithReceipt(call,args,principal){
  try{return await call('jobs.submit',args);}
  catch(error){
    if(error.status!==undefined&&![502,503,504].includes(error.status))throw error;
    try{
      const observed=await call('state',{});
      if(observed.principal?.userId!==principal.userId)throw error;
      const matches=(observed.state?.jobs||[]).filter(job=>job.userId===principal.userId&&job.key===args.key&&
        typeof job.id==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(job.id));
      if(matches.length===1)return {result:matches[0],principal:observed.principal,receiptRecovered:true};
    }catch{}
    throw error;
  }
}
