import {randomUUID} from 'node:crypto';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const fail=message=>{throw Error(message);};
export async function runCloudFiles({positionals,options,machine,call,stderr=process.stderr}){
  const action=positionals[2]||'list',expected={info:3,list:3,status:4,cancel:4,upload:4,verify:4,download:5};
  if(!Object.hasOwn(expected,action)||positionals.length!==expected[action])fail('Usage: data cloud info|list | upload PATH | verify FILE_ID | download FILE_ID PATH | status|cancel OPERATION_ID');
  if(options.datasets?.length||Object.keys(options).some(k=>!['machines','datasets','url','session-file','json','key'].includes(k)))fail('Cloud files do not accept project, root or training options');
  const args={machine};
  if(['upload','verify','download'].includes(action)){
    args.key=options.key||randomUUID();if(!UUID.test(args.key))fail('Use a complete UUID --key');
    stderr.write(`Cloud operation: ${args.key}. A lost response is not permission to repeat an upload with a new key.\n`);
  }else if(options.key)fail('--key is only valid for upload, verify or download');
  if(['verify','download'].includes(action)){if(!UUID.test(positionals[3]))fail('Use the complete cloud file UUID');args.fileId=positionals[3];}
  if(['status','cancel'].includes(action)){if(!UUID.test(positionals[3]))fail('Use the complete cloud operation UUID');args.operationId=positionals[3];}
  if(action==='upload'||action==='download'){
    args.path=positionals[action==='upload'?3:4];
    if(!args.path||/[\\\x00-\x1f\x7f]/.test(args.path)||args.path.split('/').some(p=>!p||p==='.'||p==='..'||Buffer.byteLength(p)>255)||Buffer.byteLength(args.path)>1024)fail('Use a relative filename within your personal /data2');
  }
  return {...(await call('cloud.files.'+action,args)).result,machine};
}
