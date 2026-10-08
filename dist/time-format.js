// Display timestamps only; validation does not change lifecycle or clock units.
export function formatTimestamp(value,{seconds=true,clock=false,format={hour12:false}}={}){
  if(typeof value==='number'){
    if(!Number.isFinite(value)||value<=0)return '—';
    value*=seconds?1000:1;
  }else if(typeof value==='string'){
    value=value.trim();
    if(!value||Number.isFinite(Number(value))&&Number(value)<=0)return '—';
  }else return '—';
  const date=new Date(value);
  if(!Number.isFinite(date.getTime())||date.getTime()<=0)return '—';
  return date[clock?'toLocaleTimeString':'toLocaleString']('zh-CN',format);
}
