// Test-only in-process byte sink for the pre-existing journal state machine.
// Production always selects createPersonalFileTransport; no CLI flag can select
// this adapter. Real TLS/no-Portal-body behavior has separate integration tests.
export async function journalTransport(call,{machine,context,path,identity}){
  return {request:async({offset,final,bytes})=>(await call('files.put',{machine,...context,path,...identity,offset,final,data:bytes.toString('base64')})).result,close(){}};
}
