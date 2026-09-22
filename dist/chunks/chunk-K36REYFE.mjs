import { createRequire as __fccCreateRequire } from "node:module";
import { fileURLToPath as __fccFileURLToPath } from "node:url";
const require = __fccCreateRequire(import.meta.url);
const __filename = __fccFileURLToPath(import.meta.url);
const __dirname = __fccFileURLToPath(new URL(".", import.meta.url));
import{createHash as i}from"node:crypto";import{homedir as o}from"node:os";import n from"node:path";function e(){return process.env.FCC_HOME??n.join(o(),".claude","flow")}function m(r){let t=i("sha1").update(r).digest("hex").slice(0,8);return`${n.basename(r).replace(/[^\w.-]/g,"_")}-${t}`}function a(r){return n.join(e(),"repos",s(r))}function x(r){return n.join(e(),"sessions",s(r))}function c(r){return n.join(a(r),"tasks")}function h(r,t){return n.join(c(r),s(t))}function j(){return n.join(e(),"server.json")}function s(r){return r.replace(/[^\w.-]/g,"_").replace(/^\.+/,"_")}export{e as a,m as b,a as c,x as d,c as e,h as f,j as g};
