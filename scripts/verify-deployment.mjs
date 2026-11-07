import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const base=process.argv[2];
if(!base||new URL(base).protocol!=='https:')throw new Error('Supply the public HTTPS deployment origin.');
const health=await fetch(new URL('/health',base)).then(r=>{if(!r.ok)throw new Error(`Health HTTP ${r.status}`);return r.json();});
if(!health.ok||!health.configured)throw new Error('Server is not fully configured.');
const page=await fetch(base).then(r=>r.text());
if(!page.includes('Create my workspace'))throw new Error('Setup page not served.');
const client=new Client({name:'gig-studio-deployment-check',version:'1'});
try {
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp',base)));
  const {tools}=await client.listTools();
  if(tools.length!==16)throw new Error(`Expected 16 tools, received ${tools.length}.`);
  const brief=await client.callTool({name:'prepare_gig_brief',arguments:{service:'Coffee shop logo design'}});
  if(brief.structuredContent?.result?.rules?.title?.exact!==78)throw new Error('Workflow validation failed.');
  const bad=await client.callTool({name:'find_freelancers',arguments:{workspace_key:'invalid-workspace-key-for-live-check',buyer_need:'coffee shop logo'}});
  if(bad.isError!==true)throw new Error('Unauthenticated research was not rejected.');
  console.log(JSON.stringify({origin:base,health:'passed',homepage:'passed',mcp_initialize:'passed',tools:tools.length,workflow:'passed',invalid_key_rejected:true,paid_runs_started:0},null,2));
} finally {await client.close();}
