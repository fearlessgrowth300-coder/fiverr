import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
export class Credentials {
  constructor(secret) {
    if (!secret || !/^[a-f0-9]{64}$/i.test(secret)) throw new Error('WORKSPACE_ENCRYPTION_KEY must be configured as 64 hex characters.');
    this.key=Buffer.from(secret,'hex');
  }
  issue(payload, now=Date.now()) {
    const iv=randomBytes(12), cipher=createCipheriv('aes-256-gcm',this.key,iv);
    cipher.setAAD(Buffer.from('fiverr-gig-studio:v1'));
    const body=Buffer.concat([cipher.update(JSON.stringify({...payload,exp:now+90*86400000}),'utf8'),cipher.final()]);
    return 'fgs1.'+Buffer.concat([iv,cipher.getAuthTag(),body]).toString('base64url');
  }
  read(value, now=Date.now()) {
    try {
      if(!value.startsWith('fgs1.')||value.length>8192) throw new Error();
      const buf=Buffer.from(value.slice(5),'base64url');
      const decipher=createDecipheriv('aes-256-gcm',this.key,buf.subarray(0,12));
      decipher.setAAD(Buffer.from('fiverr-gig-studio:v1'));decipher.setAuthTag(buf.subarray(12,28));
      const p=JSON.parse(Buffer.concat([decipher.update(buf.subarray(28)),decipher.final()]).toString('utf8'));
      if(!p.token || !p.userId || !p.storeId || !Number.isFinite(p.exp) || p.exp<=now) throw new Error();
      return {...p,owner:createHash('sha256').update(p.userId).digest('hex')};
    } catch {throw new Error('Workspace key is invalid or expired. Reconnect your Apify account on the website.');}
  }
}
