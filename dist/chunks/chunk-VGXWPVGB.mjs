import { createRequire as __fccCreateRequire } from "node:module";
import { fileURLToPath as __fccFileURLToPath } from "node:url";
const require = __fccCreateRequire(import.meta.url);
const __filename = __fccFileURLToPath(import.meta.url);
const __dirname = __fccFileURLToPath(new URL(".", import.meta.url));
import{a as n}from"./chunk-K36REYFE.mjs";import{appendFileSync as c,mkdirSync as i}from"node:fs";import m from"node:path";function f(t,o){try{i(n(),{recursive:!0});let r=o instanceof Error?o.stack??o.message:String(o);c(m.join(n(),"fcc.log"),`${new Date().toISOString()} [${t}] ${r}
`)}catch{}}export{f as a};
