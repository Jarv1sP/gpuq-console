// Transfers is a dataset tab. Keep its controller/page hook and legacy links.
export const roomOrder=['work','resources','datasets','community','users'];
const pages=new Set([...roomOrder,'transfers','maintenance','me','admin']);
export function pageForRoute(route){
  const value=String(route??'').replace(/^#/,'');
  if(/^admin(?:\/[a-z][a-z0-9-]{0,63})?$/.test(value))return 'admin';
  return value==='datasets/transfers'?'transfers':pages.has(value)?value:null;
}
export const roomForPage=page=>page==='transfers'?'datasets':page;
export const hashForPage=page=>page==='transfers'?'#datasets/transfers':'#'+page;
