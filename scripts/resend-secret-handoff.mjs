/** Offline handoff. Plaintext is written only to the recipient's mode-0600 file. */
import {
  constants,
  createCipheriv,
  createDecipheriv,
  generateKeyPairSync,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
} from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const purposes = new Set(['RESEND_API_KEY', 'RESEND_WEBHOOK_SECRET']);
export function decryptHandoff(bundle, privateKey) {
  if (
    !bundle ||
    bundle.version !== 1 ||
    !['key', 'iv', 'data'].every(
      (k) =>
        typeof bundle[k] === 'string' &&
        bundle[k].length < 20000 &&
        /^[A-Za-z0-9+/]*={0,2}$/.test(bundle[k]),
    )
  )
    throw new Error('Invalid encrypted handoff');
  const key = privateDecrypt(
    { key: privateKey, oaepHash: 'sha256', padding: constants.RSA_PKCS1_OAEP_PADDING },
    Buffer.from(bundle.key, 'base64'),
  );
  const iv = Buffer.from(bundle.iv, 'base64');
  const data = Buffer.from(bundle.data, 'base64');
  if (key.length !== 32 || iv.length !== 12 || data.length < 17)
    throw new Error('Invalid encrypted handoff');
  const cipher = createDecipheriv('aes-256-gcm', key, iv);
  cipher.setAuthTag(data.subarray(-16));
  const payload = JSON.parse(
    Buffer.concat([cipher.update(data.subarray(0, -16)), cipher.final()]).toString('utf8'),
  );
  validatePayload(payload);
  return payload;
}
function validatePayload(p) {
  if (
    !p ||
    !purposes.has(p.purpose) ||
    typeof p.secret !== 'string' ||
    p.secret.length > 500 ||
    !/^[A-Za-z0-9_+/=.-]+$/.test(p.secret) ||
    !(p.purpose === 'RESEND_API_KEY' ? p.secret.startsWith('re_') : p.secret.startsWith('whsec_'))
  )
    throw new Error('Unexpected secret type');
}
export function handoffPage(publicKey) {
  const script = `const publicPem=${JSON.stringify(publicKey)};
const form=document.querySelector('form');const status=document.querySelector('output');
const base64=bytes=>btoa(String.fromCharCode(...new Uint8Array(bytes)));
form.addEventListener('submit',async e=>{e.preventDefault();const field=document.querySelector('#secret');const purpose=document.querySelector('select').value;const secret=field.value.trim();
try {if(!secret||secret.length>500||!(/^[A-Za-z0-9_+/=.-]+$/).test(secret)||!(purpose==='RESEND_API_KEY'?secret.startsWith('re_'):secret.startsWith('whsec_')))throw new Error('请检查密钥类型和内容');
const der=Uint8Array.from(atob(publicPem.replace(/-----[^-]+-----|\\s/g,'')),c=>c.charCodeAt(0));
const publicKey=await crypto.subtle.importKey('spki',der,{name:'RSA-OAEP',hash:'SHA-256'},false,['encrypt']);
const key=await crypto.subtle.generateKey({name:'AES-GCM',length:256},true,['encrypt']);const iv=crypto.getRandomValues(new Uint8Array(12));
const data=await crypto.subtle.encrypt({name:'AES-GCM',iv},key,new TextEncoder().encode(JSON.stringify({purpose,secret})));
const wrapped=await crypto.subtle.encrypt({name:'RSA-OAEP'},publicKey,await crypto.subtle.exportKey('raw',key));
const blob=new Blob([JSON.stringify({version:1,key:base64(wrapped),iv:base64(iv),data:base64(data)})],{type:'application/json'});
const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=purpose+'-encrypted.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);field.value='';status.textContent='已生成加密文件。只发送下载的 -encrypted.json 文件；不要发送原始密钥或截图。';
}catch(error){status.textContent='未生成文件：'+error.message;}});`;
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; form-action 'none'; base-uri 'none'"><title>Resend 密钥安全交接</title><style>body{max-width:620px;margin:60px auto;padding:24px;font:16px/1.7 system-ui;color:#173449}label,select,input,button,output{display:block}select,input,button{box-sizing:border-box;width:100%;padding:14px;margin:12px 0}button{background:#155e75;color:white;border:0;border-radius:8px}output{margin-top:24px}small{color:#526477}</style><h1>Resend 密钥安全交接</h1><p>在你自己的电脑打开这个文件。密钥在浏览器本机加密，页面不会联网，也不会保存输入。接收方持有独立私钥才能解密。</p><form><label for="purpose">要交接的密钥</label><select id="purpose"><option value="RESEND_API_KEY">Resend API Key（re_ 开头）</option><option value="RESEND_WEBHOOK_SECRET">Webhook 签名密钥（whsec_ 开头）</option></select><label for="secret">粘贴密钥</label><input id="secret" type="password" autocomplete="off" required maxlength="500"><button>生成加密交接文件</button></form><output aria-live="polite"></output><p><small>只使用 Sean 直接交给你的此文件。生成后把下载的 encrypted.json 发给 Sean 即可，不要发送明文、账号密码或密钥截图。不要用陌生网页代替这个文件。</small></p><script>${script}</script></html>`;
}
export function encryptTestPayload(payload, publicKey) {
  validatePayload(payload);
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([
    cipher.update(JSON.stringify(payload)),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return {
    version: 1,
    key: publicEncrypt({ key: publicKey, oaepHash: 'sha256' }, key).toString('base64'),
    iv: iv.toString('base64'),
    data: data.toString('base64'),
  };
}
async function main() {
  const [mode, a, b, c] = process.argv.slice(2);
  if (mode === 'prepare' && a && b) {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 4096,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    await mkdir(dirname(resolve(a)), { recursive: true, mode: 0o700 });
    await mkdir(dirname(resolve(b)), { recursive: true });
    await writeFile(a, privateKey, { mode: 0o600, flag: 'wx' });
    await writeFile(b, handoffPage(publicKey), { flag: 'wx' });
    console.log('Created recipient private key and owner encryption page. No secrets printed.');
  } else if (mode === 'receive' && a && b && c) {
    const raw = await readFile(a, 'utf8');
    if (raw.length > 32000) throw new Error('Encrypted file too large');
    const payload = decryptHandoff(JSON.parse(raw), await readFile(b, 'utf8'));
    await mkdir(dirname(resolve(c)), { recursive: true, mode: 0o700 });
    await writeFile(c, `${payload.purpose}=${payload.secret}\n`, { mode: 0o600, flag: 'wx' });
    console.log('Secret saved to the requested private file (0600). No plaintext printed.');
  } else
    throw new Error(
      'Usage: prepare PRIVATE_KEY OWNER_HTML | receive ENCRYPTED_JSON PRIVATE_KEY PRIVATE_ENV',
    );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => {
    console.error(
      'Handoff failed. Check paths, file permissions and encrypted-file integrity. No secret content logged.',
    );
    process.exitCode = 1;
  });
