// One public metadata contract for registration/profile, job submission and
// resource displays. These fields describe a task; they are never executable.
const encoder=new TextEncoder();
const controls=/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
export function displayName(value){
  if(typeof value!=='string'||!value.isWellFormed())throw Error('姓名／显示名格式无效。');
  const name=value.trim();
  if(!name||[...name].length>32||encoder.encode(name).length>128||controls.test(name))throw Error('姓名／显示名须为 1–32 字，不能包含控制字符。');
  return name;
}
export function taskDescription(value){
  if(value===undefined)return '';
  if(typeof value!=='string'||!value.isWellFormed())throw Error('任务描述格式无效。');
  const description=value.replace(/\r\n?/g,'\n').trim();
  if([...description].length>2000||encoder.encode(description).length>6000||/[\p{Cf}\p{Zl}\p{Zp}]/u.test(description)||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(description))throw Error('任务描述最多 2000 字／6 KiB，不能包含控制字符。');
  return description;
}
export function taskIdentity(job,users=[]){
  const account=users.find(u=>u.id===job.userId),username=typeof job.username==='string'?job.username:account?.username||'未知用户';
  let name,description;
  try{name=displayName(job.submitterName??account?.name??username);}catch{name=username;}
  try{description=taskDescription(job.description);}catch{description='';}
  return {name:job.name||'train',description,submitter:{name,username}};
}
