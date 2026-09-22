import { createRequire as __fccCreateRequire } from "node:module";
import { fileURLToPath as __fccFileURLToPath } from "node:url";
const require = __fccCreateRequire(import.meta.url);
const __filename = __fccFileURLToPath(import.meta.url);
const __dirname = __fccFileURLToPath(new URL(".", import.meta.url));
import{a as p,d as c,e as a}from"./chunk-PSS23ID7.mjs";import{mkdirSync as m,readdirSync as u,readFileSync as f,renameSync as k,writeFileSync as l}from"node:fs";import e from"node:path";var i="graph.json";function G(t){let r=a(t.task.repoId,t.task.id);m(r,{recursive:!0});let o=e.join(r,`${i}.${process.pid}.tmp`);l(o,JSON.stringify(t)),k(o,e.join(r,i))}function y(t,r){try{return JSON.parse(f(e.join(a(t,r),i),"utf8"))}catch{return null}}function w(){let t=e.join(p(),"repos"),r=[];for(let o of d(t))for(let n of d(c(o))){let s=y(o,n);s&&r.push({repoId:o,repoRoot:s.task.repoRoot,id:s.task.id,prompt:s.task.prompt,endedAt:s.task.endedAt,status:s.status,stats:s.stats})}return r.sort((o,n)=>n.endedAt.localeCompare(o.endedAt))}function d(t){try{return u(t)}catch{return[]}}export{G as a,y as b,w as c};
