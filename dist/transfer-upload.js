// Shared adapter: preserve the tested upload protocol, add durable task identity.
export function transferUploadCall(call,onHandle=()=>{}){
  let id;
  return async(operation,args)=>{
    const action=operation.slice('datasets.upload.'.length);
    if(action==='begin'){
      const {machine,name,key,allowRelay,...manifest}=args;
      const row=await call('transfers.create',{kind:'upload',machine,name,key,manifest,...(allowRelay===true?{allowRelay:true}:{})});id=row.id;onHandle(row);
      // An explicit legacy upload-discard releases the old upload. Preserve
      // its existing new-key workflow, unlike permanent transfer cancellation.
      if(row.result?.state==='DISCARDED'&&!row.cancelRequested)return row.result;
      if(row.cancelRequested||row.state==='CANCELED')throw Error('这项上传已终止；请改用新名称开始新任务。');
      if(!row.uploadId||!row.result)throw Error('上传初始化未确认；重复原命令核对同一传输。编号：'+row.id);
      return row.result;
    }
    if(!id)throw Error('传输尚未初始化。');
    const {machine,uploadId,...request}=args;
    return call('transfers.io',{id,action,...request});
  };
}
