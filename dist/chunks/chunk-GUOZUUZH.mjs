import { createRequire as __fccCreateRequire } from "node:module";
import { fileURLToPath as __fccFileURLToPath } from "node:url";
const require = __fccCreateRequire(import.meta.url);
const __filename = __fccFileURLToPath(import.meta.url);
const __dirname = __fccFileURLToPath(new URL(".", import.meta.url));
import{d as n}from"./chunk-L4S3UVBN.mjs";import{a,b as i}from"./chunk-GLYJDSPF.mjs";import{f as s}from"./chunk-K36REYFE.mjs";import{existsSync as m,rmSync as d}from"node:fs";import p from"node:path";function g(t,o){let e=i(t,o);if(!e)return{ok:!1,message:"Task not found."};let r=e.recordPath;if(e.task.private=!0,delete e.recordPath,a(e),!r)return{ok:!0,message:"This task had no report in the repo; it will not get one."};let c=m(p.join(e.task.repoRoot,r));return n(e.task.repoRoot,r),{ok:!0,recordPath:r,message:c?`Removed ${r} from the working tree.`:`${r} was already gone; the task will not write it again.`}}function w(t,o){let e=g(t,o);return e.ok?(d(s(t,o),{recursive:!0,force:!0}),{...e,message:`${e.message} The task was deleted from the local cache too.`}):e}export{g as a,w as b};
