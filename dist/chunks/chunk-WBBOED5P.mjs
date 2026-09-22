import { createRequire as __fccCreateRequire } from "node:module";
import { fileURLToPath as __fccFileURLToPath } from "node:url";
const require = __fccCreateRequire(import.meta.url);
const __filename = __fccFileURLToPath(import.meta.url);
const __dirname = __fccFileURLToPath(new URL(".", import.meta.url));
import{createHash as a}from"node:crypto";var f=2e3;function d(r){let n=r.trim();return n.replace(/[\s{}()[\];,<>/]/g,"").length<3?null:a("sha1").update(n).digest("hex").slice(0,10)}function g(r){let n={},t,s=!1,l=e=>n[e]??={add:[],del:[]};for(let e of r.split(`
`))if(e.startsWith("diff --git"))s=!0,t=void 0;else if(s)e.startsWith("--- ")&&e!=="--- /dev/null"?t=l(e.slice(4).replace(/^a\//,"")):e.startsWith("+++ ")&&e!=="+++ /dev/null"?t=l(e.slice(4).replace(/^b\//,"")):e.startsWith("@@")&&(s=!1);else if(t&&e.startsWith("+")){let i=d(e.slice(1));i&&t.add.length<f&&t.add.push(i)}else if(t&&e.startsWith("-")){let i=d(e.slice(1));i&&t.del.length<f&&t.del.push(i)}for(let[e,i]of Object.entries(n))!i.add.length&&!i.del.length&&delete n[e];return n}export{d as a,g as b};
