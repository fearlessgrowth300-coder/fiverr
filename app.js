import express from 'express';
import { fileURLToPath } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Apify } from './src/apify.js';
import { Credentials } from './src/credentials.js';
import { HostedResearch } from './src/hosted-research.js';
import { createServer } from './src/server.js';

export function makeApp({apify=new Apify(),secret=process.env.WORKSPACE_ENCRYPTION_KEY}={}) {
  const app=express();app.disable('x-powered-by');
  app.use((req,res,next)=>{
    res.set({'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"});
    if(req.path!=='/'&&!req.path.endsWith('.css')&&!req.path.endsWith('.js'))res.set('Cache-Control','no-store');
    next();
  });
  app.use(express.json({limit:'192kb'}));
  const creds=()=>new Credentials(secret);
  const research=new HostedResearch(apify);
  const sameOrigin=(req,res,next)=>{
    const origin=req.get('origin');
    if(!origin)return res.status(403).json({error:'Open the website to connect your account.'});
    try {if(new URL(origin).host!==req.get('host'))return res.status(403).json({error:'Origin not allowed'});}catch{return res.status(403).json({error:'Invalid origin'});}
    next();
  };
  app.get('/api/status',(_req,res)=>res.json({ready:!!secret,tools:19}));
  app.get('/health',(_req,res)=>res.json({ok:true,service:'fiverr-gig-studio',configured:!!secret}));
  app.post('/api/connect',sameOrigin,async(req,res)=>{
    const raw=req.body?.apify_tokens??[req.body?.apify_token];
    const tokens=[...new Set(Array.isArray(raw)?raw.map(t=>typeof t==='string'?t.trim():t).filter(Boolean):[])];
    if(!tokens.length||tokens.length>10||!tokens.every(t=>typeof t==='string'&&/^apify_api_[A-Za-z0-9_-]{10,200}$/.test(t)))return res.status(400).json({error:'Enter 1-10 valid Apify API tokens, one per line.'});
    if(req.body?.consent!==true)return res.status(400).json({error:'Consent is required to connect your Apify account.'});
    try {
      const c=creds();
      const accounts=[];
      for(const [i,token] of tokens.entries()) {
        const me=await apify.request('/users/me',token).catch(e=>{throw Object.assign(new Error(`Apify key ${i+1} could not be verified (HTTP ${e.status||'network'}).`),{status:e.status});});
        if(!me.data?.id)throw new Error(`Could not verify Apify key ${i+1}.`);
        accounts.push({token,userId:me.data.id,username:me.data.username});
      }
      // Research history is stored on the first key's account; the others are used for runs when earlier keys run out.
      const store=await apify.request('/key-value-stores?name=fiverr-gig-studio',accounts[0].token,{method:'POST'});
      const key=c.issue({token:accounts[0].token,userId:accounts[0].userId,storeId:store.data.id,accounts:accounts.map(({token,userId})=>({token,userId}))});
      res.json({workspace_key:key,expires_in_days:90,account:accounts.map(a=>a.username||'account').join(', '),keys:accounts.length});
    }catch(e){res.status(e.status===401?401:400).json({error:e.message.startsWith('WORKSPACE_')?'Workspace setup is not enabled yet. Contact the site owner.':e.message});}
  });
  app.post('/mcp',async(req,res)=>{
    const origin=req.get('origin');
    if(origin&&!['https://chatgpt.com','https://claude.ai',`https://${req.get('host')}`,`http://${req.get('host')}`].includes(origin))return res.status(403).json({error:'Origin not allowed'});
    const server=createServer({research,apify,authenticate:key=>creds().read(key)});
    const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
    res.on('close',()=>{void transport.close();void server.close();});
    try {await server.connect(transport);await transport.handleRequest(req,res,req.body);}
    catch {if(!res.headersSent)res.status(500).json({jsonrpc:'2.0',id:null,error:{code:-32603,message:'MCP request failed'}});}
  });
  app.all('/mcp',(_req,res)=>res.status(405).set('Allow','POST').end());
  app.use(express.static(fileURLToPath(new URL('./public',import.meta.url))));
  app.use((error,_req,res,_next)=>res.status(error.type==='entity.too.large'?413:400).json({error:'Request could not be processed.'}));
  return app;
}
export default makeApp();
