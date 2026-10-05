// Operator-controlled origins only. Never turn a user URL, wildcard, HTTP
// address or an entire LAN range into browser connect-src permissions.
export function directUploadConnectSources(raw='[]'){
  let values;
  try{values=typeof raw==='string'?JSON.parse(raw):raw;}catch{throw Error('GPUQ_DIRECT_UPLOAD_ORIGINS must be a JSON array of HTTPS origins');}
  if(!Array.isArray(values)||values.length>32)throw Error('Invalid direct upload origin list');
  return [...new Set(values.map(value=>{
    if(typeof value!=='string'||/[\s*'";\\]/.test(value))throw Error('Invalid direct upload origin');
    let url;try{url=new URL(value);}catch{throw Error('Invalid direct upload origin');}
    if(url.protocol!=='https:'||!url.hostname||url.username||url.password||url.pathname!=='/'||url.search||url.hash||value!==url.origin)throw Error('Direct upload entries must be exact HTTPS origins');
    return url.origin;
  }))].join(' ');
}
