// Shared presentation lifecycle; no API calls or changes to application state.
const syncPageVisibility=()=>document.documentElement.classList.toggle('page-inactive',document.hidden);
document.addEventListener('visibilitychange',syncPageVisibility);
syncPageVisibility();
document.querySelectorAll('.copy-code').forEach(button=>{
  button.hidden=false;
  button.addEventListener('click',async()=>{
    const code=button.closest('.guide-code').querySelector('pre code'),status=document.querySelector('#guide-copy-status');
    try{await navigator.clipboard.writeText(code.textContent);button.textContent='已复制';status.textContent='命令已复制。';}
    catch{const range=document.createRange();range.selectNodeContents(code);const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);button.textContent='已选中，请复制';status.textContent='无法自动复制，已选中命令，请手动复制。';}
    setTimeout(()=>{button.textContent='复制';},2500);
  });
});
