import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';import {createHash} from 'node:crypto';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const table=Array.from({length:256},(_,n)=>{let c=n;for(let k=0;k<8;k++)c=(c&1)?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
function crc32(bytes){let c=0xffffffff;for(const b of bytes)c=table[(c^b)&255]^(c>>>8);return(c^0xffffffff)>>>0;}
export function releaseFiles(root=ROOT){
 const files=JSON.parse(fs.readFileSync(path.join(root,'release-manifest.json'),'utf8')).files;
 if(!Array.isArray(files)||new Set(files).size!==files.length)throw Error('Invalid release manifest');
 for(const name of files){if(typeof name!=='string'||name.includes('\\')||name.split('/').includes('..')||path.isAbsolute(name)||/^(data|dist|node_modules|\.git)\//.test(name)||/(config\.local\.json|\.dpapi|\.pth|\.onnx|\.index|\.ckpt|\.wav|\.mp3|\.flac|\.env)$/i.test(name))throw Error(`Private/binary path is not allowed: ${name}`);const f=path.join(root,name);if(!fs.lstatSync(f).isFile()||fs.lstatSync(f).isSymbolicLink())throw Error(`Release file must be a regular file: ${name}`);const rel=path.relative(fs.realpathSync(root),fs.realpathSync(f));if(rel.startsWith('..')||path.isAbsolute(rel))throw Error('Release file escaped project root');const text=fs.readFileSync(f,'utf8');if(/(?:github_pat_[A-Za-z0-9_]{40,}|gh[pousr]_[A-Za-z0-9]{25,}|MUSIC_U=[A-Za-z0-9%+/_-]{25,}|AQAAANCMnd8BFdER[A-Za-z0-9+/=]{60,})/.test(text))throw Error(`Credential-like content detected: ${name}`);}
 return files;
}
export function buildPackage(root=ROOT){
 const files=releaseFiles(root),version=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version;
 if(!/^\d+\.\d+\.\d+$/.test(version))throw Error('Invalid release version');
 const local=[],central=[];let offset=0;
 for(const file of files){const name=Buffer.from(`qq-bridge-cover/${file}`),data=fs.readFileSync(path.join(root,file)),crc=crc32(data);const h=Buffer.alloc(30);h.writeUInt32LE(0x04034b50);h.writeUInt16LE(20,4);h.writeUInt16LE(0x800,6);h.writeUInt16LE(0x21,12);h.writeUInt32LE(crc,14);h.writeUInt32LE(data.length,18);h.writeUInt32LE(data.length,22);h.writeUInt16LE(name.length,26);local.push(h,name,data);
  const c=Buffer.alloc(46);c.writeUInt32LE(0x02014b50);c.writeUInt16LE(20,4);c.writeUInt16LE(20,6);c.writeUInt16LE(0x800,8);c.writeUInt16LE(0x21,14);c.writeUInt32LE(crc,16);c.writeUInt32LE(data.length,20);c.writeUInt32LE(data.length,24);c.writeUInt16LE(name.length,28);c.writeUInt32LE(offset,42);central.push(c,name);offset+=h.length+name.length+data.length;
 }
 const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
 const bytes=Buffer.concat([...local,directory,end]);const dist=path.join(root,'dist');fs.mkdirSync(dist,{recursive:true});const out=path.join(dist,`qq-bridge-cover-v${version}.zip`);fs.writeFileSync(out,bytes);
 const sha256=createHash('sha256').update(bytes).digest('hex');fs.writeFileSync(out+'.sha256',`${sha256}  ${path.basename(out)}\n`);
 fs.writeFileSync(path.join(dist,'release-files.json'),JSON.stringify({version,files,sha256,bytes:bytes.length},null,2));return{out,sha256,files:files.length,bytes:bytes.length};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){try{console.log(JSON.stringify(buildPackage()));}catch(e){console.error(e.message);process.exitCode=1;}}
