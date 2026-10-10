// The node's configured routes are authoritative. This control-plane boundary
// never accepts file bytes or promotes a retained Tail grant to campus access.
import {validateUploadRoutes} from './dist/upload-routes.js';
const fail=()=>{throw Object.assign(Error('数据集文件仅允许校园直连；VPS 中转和 Tail 上传已停用，请保留原上传编号。'),{status:409,code:'CAMPUS_DATA_PLANE_REQUIRED'});};
export function requireCampusUpload(action,args){
  if(['manifest','chunk'].includes(action)||args.allowRelay===true)fail();
}
export function rejectWorkspaceRelay(){fail();}
export function campusUploadReply(action,value,machine){
  if(action==='routes'&&value?.available===true){
    try{validateUploadRoutes(value,machine);}catch{throw Object.assign(Error('校园上传通道身份未确认。'),{status:502});}
    return {...value,campusOnly:true,routes:value.routes.filter(route=>route.kind==='campus-direct')};
  }
  if(action==='direct-ticket'&&value?.available===true&&
    (value.kind!=='campus-direct'||value.machine!==machine))
    throw Object.assign(Error('节点未确认校园直连票据；未发送文件字节。'),{status:502});
  if(action==='begin'&&value?.uploadTransport)
    return {...value,uploadTransport:{...value.uploadTransport,campusOnly:true,relayAllowed:false,relayLimitBytes:0}};
  return value;
}
