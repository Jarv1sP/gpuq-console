import {createPersonalFileTransport} from './client-personal-file-campus.mjs';

// Only metadata uses the existing transfer API. All fixed manifest and file
// bytes use the existing authenticated campus personal-file listener.
export function createCampusDownloadSnapshot(call,{machine,downloadId,manifestSha256,transportFactory=createPersonalFileTransport}){
  let current=null,currentKey=null,route=null;
  return {
    async call(operation,args){
      const action=operation.slice('datasets.snapshot.'.length);
      if(action==='info')return call('transfers.io',{id:downloadId,action:'info'});
      if(!['manifest','get'].includes(action)||!Number.isSafeInteger(args.offset)||args.offset<0)throw Error('Invalid original campus snapshot read');
      const path=action==='manifest'?'@manifest':args.path,key=JSON.stringify([action,path]);
      if(currentKey!==key){
        if(current){const previous=current;current=null;currentKey=null;await previous.close();}
        const opened=await transportFactory(call,{machine,context:{area:'snapshot',downloadId,snapshotAction:action},path,action:'get'});
        const {endpoint,pin,revision,machine:routeMachine,chunkBytes}=opened.routeIdentity;
        const identity=JSON.stringify({endpoint,pin,revision,machine:routeMachine,chunkBytes});
        if(opened.file.manifestSha256!==manifestSha256||route!==null&&identity!==route){
          await opened.close();throw Error('Original campus snapshot manifest or route changed');
        }
        route=identity;current=opened;currentKey=key;
      }
      const result=await current.request({offset:args.offset}),bytes=Buffer.from(result.data,'base64');
      if(result.manifestSha256!==manifestSha256||result.offset!==args.offset||bytes.length>1048576)throw Error('Campus snapshot response changed; original partial files retained');
      return {result:{...result,offset:result.offset+bytes.length}};
    },
    async close(){const previous=current;current=null;currentKey=null;if(previous)await previous.close();}
  };
}
