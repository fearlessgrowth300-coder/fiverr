import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import express from 'express';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Apify } from './apify.js';
import { Store, loadWorkspaces } from './storage.js';
import { Research } from './research.js';
import { createServer } from './server.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspaces = loadWorkspaces();
const apify = new Apify();
const positive = (v,d) => { const n=Number(v || d); if(!Number.isFinite(n)||n<=0) throw new Error('Run limits must be positive numbers.'); return n; };
const research = new Research(new Store(resolve(process.env.DATA_DIR || resolve(root,'data'))), apify, { maxCharge:positive(process.env.MAX_RUN_CHARGE_USD,0.5), maxDaily:positive(process.env.MAX_RUNS_PER_DAY,10), maxConcurrent:positive(process.env.MAX_CONCURRENT_RUNS,2) });
const factory = () => createServer({workspaces,research,apify});
if (process.argv.includes('--stdio')) {
  await factory().connect(new StdioServerTransport());
} else {
  const host = process.env.HOST || '127.0.0.1';
  const publicHost = process.env.PUBLIC_HOST;
  if (host === '0.0.0.0' && (!publicHost || !workspaces.length)) throw new Error('Public mode requires PUBLIC_HOST and a configured WORKSPACE_KEY.');
  const app = createMcpExpressApp({host,allowedHosts:['127.0.0.1','localhost',...(publicHost ? [publicHost] : [])]});
  app.disable('x-powered-by');
  app.use(express.json({limit:'256kb'}));
  app.get('/health', (_req,res)=>res.json({ok:true,service:'fiverr-gig-mcp'}));
  app.post('/mcp',async(req,res)=>{
    const origin=req.get('origin');
    if(origin && !['https://chatgpt.com','https://claude.ai',...(publicHost ? [`https://${publicHost}`] : [])].includes(origin)) return res.status(403).json({error:'Origin not allowed'});
    const server=factory();
    const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
    res.on('close',()=>{void transport.close();void server.close();});
    try { await server.connect(transport); await transport.handleRequest(req,res,req.body); }
    catch { if(!res.headersSent) res.status(500).json({jsonrpc:'2.0',error:{code:-32603,message:'MCP request failed'},id:null}); }
  });
  app.all('/mcp',(_req,res)=>res.status(405).set('Allow','POST').end());
  const listener=app.listen(Number(process.env.PORT || 8787),host,()=>console.error(`Fiverr Gig MCP ready on ${host}:${process.env.PORT || 8787}/mcp`));
  for(const signal of ['SIGTERM','SIGINT']) process.on(signal,()=>listener.close(()=>process.exit(0)));
}
