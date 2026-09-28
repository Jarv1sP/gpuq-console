export class DemoClient{
  static async create(){const client=new DemoClient();client.remote=globalThis.GPUQ_LOCAL_API===true;client.production=globalThis.GPUQ_PRODUCTION===true;if(!client.remote){const {DemoService,DEMO_ADMIN}=await import('./service.js');client.service=await DemoService.create();await client.login(DEMO_ADMIN.username,DEMO_ADMIN.password);}else if(client.production){try{await client.refresh();}catch(e){if(e.status!==401)throw e;}}return client;}
  async transport(path,body){const response=await fetch(`/api/${path}`,{method:'POST',headers:{'Content-Type':'application/json',...(this.token?{Authorization:`Bearer ${this.token}`}:{})},body:JSON.stringify(body)});const data=await response.json();if(!response.ok){const e=Error(data.error||'请求失败');e.status=response.status;throw e;}return data;}
  async login(username,password){const data=this.remote?await this.transport('login',{username,password,...(this.production?{client:'browser'}:{})}):await this.service.login(username,password);this.token=data.token;this.principal=data.principal;this.data=data.state;return data.principal;}
  register(username,password,invite){if(!this.production)throw Error('邀请码注册仅在正式后台开放。');return this.transport('register',{username,password,invite});}
  async call(operation,args={}){const data=this.remote?await this.transport('call',{operation,args}):await this.service.invoke(this.token,operation,args);if(data.state)this.data=data.state;if(data.principal)this.principal=data.principal;return data.result;}
  async logout(){try{await this.call('logout');}finally{this.token=null;this.principal=null;this.data=null;}}
  async refresh(){await this.call('state');}
  get users(){return this.data?.users||[];}
  get jobs(){return this.data?.jobs||[];}
  get(id){const user=this.users.find(u=>u.id===id);if(!user)throw Error('找不到用户。');return structuredClone(user);}
  snapshot(){return structuredClone(this.data);}
  usage(id,machine){return this.jobs.filter(j=>j.userId===id&&!['SUCCEEDED','FAILED','CANCELED'].includes(j.state)&&(!machine||j.machine===machine)).reduce((n,j)=>n+j.cards,0);}
  create(username,password,role='member'){return this.call('users.create',{username,password,role});}
  setRole(id,role){return this.call('users.role',{userId:id,role});}
  reset(id,password){return this.call('users.reset',{userId:id,password});}
  save(id,policy){return this.call('policy.save',{...policy,userId:id});}
  setEnabled(id,enabled){return this.call('users.enabled',{userId:id,enabled});}
  request(id,machine,cards){return this.call('request',{userId:id,machine,cards});}
  release(jobId,userId){return this.call('release',{jobId,userId});}
}
