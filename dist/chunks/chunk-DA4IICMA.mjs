import { createRequire as __fccCreateRequire } from "node:module";
import { fileURLToPath as __fccFileURLToPath } from "node:url";
const require = __fccCreateRequire(import.meta.url);
const __filename = __fccFileURLToPath(import.meta.url);
const __dirname = __fccFileURLToPath(new URL(".", import.meta.url));
import{d as i}from"./chunk-K36REYFE.mjs";import{appendFileSync as g,mkdirSync as a,readFileSync as u,rmSync as c,writeFileSync as d}from"node:fs";import n from"node:path";var f="current.json",s="tools.jsonl";function k(t,e){let r=i(t);a(r,{recursive:!0}),c(n.join(r,s),{force:!0}),d(n.join(r,f),JSON.stringify(e,null,2))}function m(t){try{return JSON.parse(u(n.join(i(t),f),"utf8"))}catch{return null}}function x(t,e){let r=i(t);a(r,{recursive:!0}),g(n.join(r,s),JSON.stringify(e)+`
`)}function O(t){let e;try{e=u(n.join(i(t),s),"utf8")}catch{return[]}let r=[];for(let o of e.split(`
`))if(o.trim())try{r.push(JSON.parse(o))}catch{}return r}function R(t){let e=i(t);c(n.join(e,f),{force:!0}),c(n.join(e,s),{force:!0})}var p="meta.json";function S(t){try{return JSON.parse(u(n.join(i(t),p),"utf8"))}catch{return{}}}function M(t,e){let r=i(t);a(r,{recursive:!0});let o={...S(t),...e};for(let l of Object.keys(o))o[l]===void 0&&delete o[l];return d(n.join(r,p),JSON.stringify(o,null,2)),o}export{k as a,m as b,x as c,O as d,R as e,S as f,M as g};
