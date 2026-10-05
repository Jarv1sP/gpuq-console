// Retry only explicitly read-only operations. A lost mutation response is not
// proof of failure and must never cause an implicit second submission.
const READS=new Set(['state','datasets.list','datasets.status','datasets.catalog','projects.list','projects.status','projects.verify','jobs.logs','jobs.watch','jobs.diagnostics','transfers.list','transfers.status','community.posts.list','community.posts.get','community.comments.list']);
const TRANSIENT=new Set([502,503,504]);
const safe=value=>String(value).replace(/[\p{Cc}\p{Cf}]/gu,' ').slice(0,600);
const error=(message,status)=>Object.assign(Error(message),{status});

export async function apiPost(base,path,body,{token,signal,fetchImpl=fetch,sleep=(ms,s)=>new Promise((resolve,reject)=>{
  if(s.aborted)return reject(s.reason);
  const done=()=>{clearTimeout(timer);s.removeEventListener('abort',abort);resolve();};
  const abort=()=>{clearTimeout(timer);s.removeEventListener('abort',abort);reject(s.reason);};
  const timer=setTimeout(done,ms);s.addEventListener('abort',abort,{once:true});
})}={}){
  const target=new URL(`/api/${path}`,base),operation=path==='call'?body?.operation:path;
  const read=path==='call'&&READS.has(operation);
  const deadline=AbortSignal.timeout(40000),combined=signal?AbortSignal.any([signal,deadline]):deadline;
  for(let attempt=0;;attempt++){
    let response,data,decoded=false;
    try{
      response=await fetchImpl(target,{method:'POST',redirect:'error',signal:combined,
        headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify(body)});
      // Gateways may return an empty or HTML error page. Do not display that
      // untrusted body or misdiagnose every JSON parse failure as a demo URL.
      try{data=await response.json();decoded=!!data&&typeof data==='object'&&!Array.isArray(data);}
      catch(cause){if(!(cause instanceof SyntaxError))throw cause;}
    }catch{
      if(read&&attempt<2&&!combined.aborted){await sleep((attempt+1)*500,combined);continue;}
      throw error(`${safe(operation)}：${combined.aborted?'请求已取消或超时':'网络连接中断'}。${read?'稍后重试查询。':'操作结果尚未确认，请先查询状态；不要更换提交键重复提交。'}`);
    }
    if(read&&TRANSIENT.has(response.status)&&attempt<2&&!combined.aborted){await sleep((attempt+1)*500,combined);continue;}
    if(!response.ok){
      const detail=decoded&&typeof data.error==='string'?safe(data.error):TRANSIENT.has(response.status)?'服务暂时不可用或正在更新':response.status===404?'API 路径不存在，请检查服务地址':'服务返回了非 JSON 错误响应';
      throw error(`${safe(operation)}：HTTP ${response.status} — ${detail}${!read&&TRANSIENT.has(response.status)?'；操作结果尚未确认，请先查询状态，不要更换提交键重复提交。':''}`,response.status);
    }
    if(!decoded)throw error(`${safe(operation)}：HTTP ${response.status}，API 未返回有效 JSON。请检查服务地址或网关；不能据此判定数据或操作失败。`,response.status);
    return data;
  }
}
