import { Apify, ACTORS, actorInput } from '../src/apify.js';
import { writeFileSync } from 'node:fs';
const api=new Apify();
const report=[];
for(const adapter of Object.keys(ACTORS)) {
  const meta=await api.inspect(adapter);
  const checks=[];
  for(const mode of ['search','seller','gig']) {
    const input=actorInput(adapter,mode,{buyer_need:'logo design',username:'example',urls:['https://www.fiverr.com/example/service'],limit:10});
    for(const key of Object.keys(input)) {
      if(!meta.input_schema.properties[key]) throw new Error(`${adapter}: unknown field ${key}`);
    }
    checks.push({mode,input});
  }
  report.push({actor:meta.actor,build:meta.build,limitations:meta.limitations,input_schema:meta.input_schema,adapter_checks:checks});
  console.log(`Schema verified: ${meta.actor} @ ${meta.build}`);
}
writeFileSync(new URL('../docs/actor-schemas.json',import.meta.url),JSON.stringify({checked_at:new Date().toISOString(),paid_runs_started:0,actors:report},null,2));
