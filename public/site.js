const $=id=>document.getElementById(id);
const status=$('status');
$('mcp-url').value=location.origin+'/mcp';
function message(text,error=false){status.textContent=text;status.classList.toggle('error',error);}
async function copy(text,button){try{await navigator.clipboard.writeText(text);const old=button.textContent;button.textContent='Copied';setTimeout(()=>button.textContent=old,1800);}catch{message('Copy was blocked. Select the text and copy it manually.',true);}}
$('copy-url').onclick=e=>copy($('mcp-url').value,e.currentTarget);
$('copy-key').onclick=e=>copy($('workspace-key').value,e.currentTarget);
$('copy-prompt').onclick=e=>copy(document.querySelector('.prompt').textContent,e.currentTarget);
$('show-key').onclick=()=>{const showing=$('api-key').classList.toggle('masked');$('show-key').textContent=showing?'Show':'Hide';$('show-key').setAttribute('aria-label',showing?'Show API key':'Hide API key');};
for(const platform of ['chatgpt','claude'])$(platform+'-tab').onclick=()=>{for(const p of ['chatgpt','claude']){$(p+'-tab').setAttribute('aria-selected',String(p===platform));$(p+'-panel').hidden=p!==platform;}};
$('clear-key').onclick=()=>{$('workspace-key').value='';$('connected').hidden=true;$('connect-form').hidden=false;$('consent').checked=false;message('Key cleared from this page. Revoke your Apify token to disconnect research access.');};
$('connect-form').onsubmit=async event=>{
  event.preventDefault();const button=$('connect-button');button.disabled=true;message('Verifying your account and creating your workspace…');
  try {
    const response=await fetch('/api/connect',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({apify_tokens:$('api-key').value.split(/\s+/).filter(Boolean),dataforseo_login:$('dfs-login').value.trim(),dataforseo_password:$('dfs-password').value.trim(),consent:$('consent').checked})});
    const data=await response.json();if(!response.ok)throw new Error(data.error||'Connection failed. Try again.');
    $('api-key').value='';$('dfs-login').value='';$('dfs-password').value='';$('workspace-key').value=data.workspace_key;$('account-label').textContent='Connected '+data.keys+' Apify key(s): '+data.account+(data.dataforseo?' + DataForSEO':'');$('connected').hidden=false;$('connect-form').hidden=true;message('Connected. Copy your workspace key, then add the connector below.');$('workspace-key').focus();
  }catch(error){message(error.message,true);}finally{button.disabled=false;}
};
fetch('/api/status').then(r=>r.json()).then(s=>{if(s.ready)message('Ready. Connecting your account does not start a paid scrape.');else{$('connect-button').disabled=true;message('Account setup is being configured. Please check back shortly.');}}).catch(()=>message('Unable to check availability. Please refresh.',true));
