// Loads the engine <script id="hqa-engine"> from index.html into Node (no DOM needed).
const fs=require('fs'),path=require('path'),vm=require('vm');
const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
const m=html.match(/<script id="hqa-engine">([\s\S]*?)<\/script>/);
if(!m)throw Error('engine script not found');
const ctx={};vm.createContext(ctx);vm.runInContext(m[1].replace('typeof globalThis!==\'undefined\'?globalThis:this','this'),ctx);
module.exports={HQA:ctx.HQA,html};
