import sharp from 'sharp';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=fileURLToPath(new URL('../../',import.meta.url));
const source=process.argv[2]||path.join(root,'public/assets/sbaa-logo.png');
const output=path.join(root,'public');
const original=await readFile(source);
const metadata=await sharp(original).metadata();
if(metadata.format!=='png'||!metadata.width||!metadata.height)throw new Error('Supply the original SBAA PNG logo.');

async function icon(size){
  const inset=Math.round(size*0.94);
  return sharp(original).resize(inset,inset,{fit:'contain',kernel:'lanczos3',background:'#fff'})
    .extend({top:Math.floor((size-inset)/2),bottom:Math.ceil((size-inset)/2),left:Math.floor((size-inset)/2),right:Math.ceil((size-inset)/2),background:'#fff'})
    .png({compressionLevel:9}).toBuffer();
}
for(const [name,size] of [['favicon-16.png',16],['favicon-32.png',32],['apple-touch-icon.png',180],['icon-192.png',192],['icon-512.png',512]]){
  await writeFile(path.join(output,name),await icon(size));
}
const entries=await Promise.all([16,32,48].map(icon));
const header=Buffer.alloc(6+16*entries.length);
header.writeUInt16LE(1,2);header.writeUInt16LE(entries.length,4);
let offset=header.length;
entries.forEach((data,index)=>{
  const item=6+index*16,size=[16,32,48][index];
  header.writeUInt8(size,item);header.writeUInt8(size,item+1);header.writeUInt16LE(1,item+4);header.writeUInt16LE(32,item+6);
  header.writeUInt32LE(data.length,item+8);header.writeUInt32LE(offset,item+12);offset+=data.length;
});
await writeFile(path.join(output,'favicon.ico'),Buffer.concat([header,...entries]));
console.log('SBAA icons generated from',source);
