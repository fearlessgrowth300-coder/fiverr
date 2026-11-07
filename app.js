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
  app.get('/api/status',(_req,res)=>res.json({ready:!!secret,tools:15}));
  app.get('/health',(_req,res)=>res.json({ok:true,service:'fiverr-gig-studio',configured:!!secret}));
  app.post('/api/connect',sameOrigin,async(req,res)=>{
    const token=req.body?.apify_token;
    if(typeof token!=='string'||!/^apify_api_[A-Za-z0-9_-]{10,200}$/.test(token))return res.status(400).json({error:'Enter a valid Apify API token.'});
    if(req.body?.consent!==true)return res.status(400).json({error:'Consent is required to connect your Apify account.'});
    try {
      const c=creds();
      const me=await apify.request('/users/me',token);
      if(!me.data?.id)throw new Error('Could not verify this Apify account.');
      const store=await apify.request('/key-value-stores?name=fiverr-gig-studio',token,{method:'POST'});
      const key=c.issue({token,userId:me.data.id,storeId:store.data.id});
      res.json({workspace_key:key,expires_in_days:90,account:me.data.username||'Connected account'});
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
