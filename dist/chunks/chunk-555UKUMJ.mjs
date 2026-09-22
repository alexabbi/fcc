import { createRequire as __fccCreateRequire } from "node:module";
import { fileURLToPath as __fccFileURLToPath } from "node:url";
const require = __fccCreateRequire(import.meta.url);
const __filename = __fccFileURLToPath(import.meta.url);
const __dirname = __fccFileURLToPath(new URL(".", import.meta.url));
import{f as n}from"./chunk-PSS23ID7.mjs";import{readFileSync as c}from"node:fs";import{setTimeout as f}from"node:timers/promises";import{spawn as a}from"node:child_process";function o(e){a(process.execPath,[process.argv[1],...e],{detached:!0,stdio:"ignore"}).unref()}function i(){try{return JSON.parse(c(n(),"utf8"))}catch{return null}}async function s(e){try{return(await fetch(`http://127.0.0.1:${e.port}/health`,{headers:{"x-fcc-token":e.token},signal:AbortSignal.timeout(500)})).ok}catch{return!1}}async function v(){let e=i();if(e&&await s(e))return e;o(["serve"]);for(let r=0;r<30;r++){await f(100);let t=i();if(t&&t.pid!==e?.pid&&await s(t))return t}return null}function S(e,r,t){return`http://127.0.0.1:${e.port}/?t=${e.token}#/${encodeURIComponent(r)}/${encodeURIComponent(t)}`}export{o as a,i as b,v as c,S as d};
