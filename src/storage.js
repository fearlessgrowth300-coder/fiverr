import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, timingSafeEqual } from 'node:crypto';

export const hash = value => createHash('sha256').update(value).digest('hex');
export class Store {
  constructor(dir) {
    mkdirSync(dir, { recursive: true });
    this.path = join(dir, 'state.json');
    this.state = existsSync(this.path) ? JSON.parse(readFileSync(this.path, 'utf8')) : { jobs: {}, daily: {} };
  }
  save() {
    writeFileSync(this.path + '.tmp', JSON.stringify(this.state), { mode: 0o600 });
    renameSync(this.path + '.tmp', this.path);
  }
  get(id, owner) {
    const j = this.state.jobs[id];
    if (!j || j.owner !== owner) throw new Error('Research job not found in this workspace.');
    return j;
  }
}

export function loadWorkspaces(env = process.env) {
  const values = env.WORKSPACES_FILE ? JSON.parse(readFileSync(env.WORKSPACES_FILE, 'utf8')) : [{ key: env.WORKSPACE_KEY, apifyToken: env.APIFY_TOKEN }];
  return values.filter(v => v.key).map(v => {
    if (v.key.length < 24) throw new Error('Workspace keys must be at least 24 characters.');
    return { owner: hash(v.key), token: v.apifyToken || '' };
  });
}
export function authorize(key, workspaces) {
  const digest = hash(key);
  const match = workspaces.find(w => timingSafeEqual(Buffer.from(w.owner, 'hex'), Buffer.from(digest, 'hex')));
  if (!match) throw new Error('Workspace key is missing or invalid. Configure it locally; do not send an Apify token in chat.');
  return match;
}
