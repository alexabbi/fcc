import { Node, Project, SyntaxKind, ts, type SourceFile } from "ts-morph";
import type { EdgeKind, SymbolKind } from "./types.ts";

/**
 * A "symbol" is the unit shown as a node: a top-level declaration, or a member
 * of a top-level class. Anything nested deeper belongs to its enclosing symbol.
 * Top-level statements that are not declarations (side effects) are pooled into
 * one `(module)` symbol per file.
 */
export interface SymbolInfo {
  /** `<repo-relative path>#<name>`, e.g. `src/cart.ts#Cart.addItem`. */
  id: string;
  name: string;
  path: string;
  kind: SymbolKind;
  /** Source text used to decide whether the symbol changed. */
  text: string;
  /** 1-based start line (including JSDoc). */
  line: number;
  /** Nodes whose descendants make up the symbol's body. */
  bodies: Node[];
  /** Identifier to find references to; absent when it cannot be referenced by name. */
  nameNode?: Node;
  /** Constructors are referenced through `new Class()`, i.e. via the class name. */
  onlyNewRefs?: boolean;
}

export interface SymbolEdge {
  source: string;
  target: string;
  kind: EdgeKind;
}

const MODULE = "(module)";

/** One version (before or after) of the codebase, loaded in an in-memory TS program. */
export class CodeVersion {
  readonly symbols = new Map<string, SymbolInfo>();
  private readonly project: Project;
  private readonly files: Set<string>;
  private readonly indexed = new Set<string>();
  private readonly byNode = new Map<ts.Node, string>();

  constructor(files: Map<string, string>, compilerOptions: ts.CompilerOptions) {
    this.project = new Project({
      useInMemoryFileSystem: true,
      skipLoadingLibFiles: true,
      compilerOptions: {
        allowJs: true,
        jsx: ts.JsxEmit.Preserve,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ESNext,
        ...compilerOptions,
        noEmit: true,
        skipLibCheck: true,
        types: [],
      },
    });
    this.files = new Set(files.keys());
    for (const [path, text] of files) {
      this.project.createSourceFile("/" + path, text, { overwrite: true });
    }
  }

  hasFile(path: string): boolean {
    return this.files.has(path);
  }

  /** Symbols declared in a file (indexed lazily). */
  symbolsOf(path: string): SymbolInfo[] {
    this.indexFile(path);
    return [...this.symbols.values()].filter((s) => s.path === path);
  }

  /** Calls, instantiations, renders made from inside `id`. */
  outgoing(id: string): SymbolEdge[] {
    const info = this.symbols.get(id);
    if (!info || info.kind === "class" || info.kind === "type") return [];
    const edges: SymbolEdge[] = [];
    for (const body of info.bodies) {
      body.forEachDescendant((d) => {
        let target: Node;
        let kind: EdgeKind;
        if (Node.isCallExpression(d)) {
          target = d.getExpression();
          kind = "call";
        } else if (Node.isNewExpression(d)) {
          target = d.getExpression();
          kind = "new";
        } else if (Node.isJsxOpeningElement(d) || Node.isJsxSelfClosingElement(d)) {
          target = d.getTagNameNode();
          kind = "render";
        } else {
          return;
        }
        if (Node.isPropertyAccessExpression(target)) target = target.getNameNode();
        for (const decl of declarationsOf(target)) {
          const tid = this.symbolForDeclaration(decl, kind);
          if (tid && tid !== id && this.symbols.get(tid)?.kind !== "type") {
            edges.push({ source: id, target: tid, kind });
          }
        }
      });
    }
    return edges;
  }

  /** Every place in the program that uses `id`, attributed to the enclosing symbol. */
  incoming(id: string): SymbolEdge[] {
    const info = this.symbols.get(id);
    if (!info?.nameNode || !Node.isIdentifier(info.nameNode)) return [];
    let refs: Node[];
    try {
      refs = info.nameNode.findReferencesAsNodes();
    } catch {
      return [];
    }
    const edges: SymbolEdge[] = [];
    for (const ref of refs) {
      if (ref.getFirstAncestor((a) => Node.isImportDeclaration(a) || Node.isExportDeclaration(a))) continue;
      const kind = usageKind(ref);
      if (!kind || (info.onlyNewRefs && kind !== "new")) continue;
      const source = this.symbolAt(ref);
      if (!source || source === id || this.symbols.get(source)?.kind === "type") continue;
      edges.push({ source, target: id, kind });
    }
    return edges;
  }

  /** The symbol enclosing `node`, if it lives in a project file. */
  symbolAt(node: Node): string | undefined {
    const path = this.pathOf(node.getSourceFile());
    if (!path) return undefined;
    this.indexFile(path);
    for (let n: Node | undefined = node; n; n = n.getParent()) {
      const id = this.byNode.get(n.compilerNode);
      if (id) return id;
    }
    return undefined;
  }

  private symbolForDeclaration(decl: Node, kind: EdgeKind): string | undefined {
    const id = this.symbolAt(decl);
    if (id && kind === "new" && Node.isClassDeclaration(decl)) {
      const ctor = `${id}.constructor`;
      if (this.symbols.has(ctor)) return ctor;
    }
    return id;
  }

  private pathOf(sf: SourceFile): string | undefined {
    const path = sf.getFilePath().slice(1);
    return this.files.has(path) ? path : undefined;
  }

  private indexFile(path: string): void {
    if (this.indexed.has(path)) return;
    this.indexed.add(path);
    const sf = this.project.getSourceFile("/" + path);
    if (!sf) return;

    const add = (name: string, kind: SymbolKind, node: Node, register: Node[], nameNode?: Node, text = node.getText(true)) => {
      const id = `${path}#${name}`;
      const existing = this.symbols.get(id);
      if (existing) {
        // overloads, declaration merging, `export default` + named, …
        existing.text += "\n" + text;
        existing.bodies.push(node);
      } else {
        this.symbols.set(id, { id, name, path, kind, text, line: node.getStartLineNumber(true), bodies: [node], nameNode });
      }
      for (const r of register) this.byNode.set(r.compilerNode, id);
      return this.symbols.get(id)!;
    };

    const moduleParts: Node[] = [];
    for (const st of sf.getStatements()) {
      if (Node.isImportDeclaration(st) || Node.isExportDeclaration(st) || Node.isEmptyStatement(st)) continue;
      if (Node.isFunctionDeclaration(st)) {
        add(st.getName() ?? "default", "function", st, [st], st.getNameNode());
      } else if (Node.isClassDeclaration(st)) {
        this.indexClass(path, st, add);
      } else if (Node.isVariableStatement(st)) {
        const decls = st.getDeclarations();
        for (const decl of decls) {
          const init = decl.getInitializer();
          const kind: SymbolKind = isFunctionLike(init) ? "function" : Node.isClassExpression(init) ? "class" : "variable";
          const text = decls.length === 1 ? st.getText(true) : decl.getText();
          const nameNode = decl.getNameNode();
          add(nameNode.getText(), kind, decls.length === 1 ? st : decl, [decl], nameNode, text);
        }
      } else if (
        Node.isInterfaceDeclaration(st) ||
        Node.isTypeAliasDeclaration(st) ||
        Node.isEnumDeclaration(st) ||
        Node.isModuleDeclaration(st)
      ) {
        add(st.getName(), "type", st, [st], st.getNameNode());
      } else if (Node.isExportAssignment(st)) {
        add("default", isFunctionLike(st.getExpression()) ? "function" : "variable", st, [st]);
      } else {
        moduleParts.push(st);
      }
    }
    if (moduleParts.length > 0) {
      const id = `${path}#${MODULE}`;
      this.symbols.set(id, {
        id,
        name: MODULE,
        path,
        kind: "module",
        text: moduleParts.map((p) => p.getText(true)).join("\n"),
        line: moduleParts[0]!.getStartLineNumber(true),
        bodies: moduleParts,
      });
      for (const p of moduleParts) this.byNode.set(p.compilerNode, id);
    }
  }

  private indexClass(
    path: string,
    cls: import("ts-morph").ClassDeclaration,
    add: (name: string, kind: SymbolKind, node: Node, register: Node[], nameNode?: Node, text?: string) => SymbolInfo,
  ): void {
    const className = cls.getName() ?? "default";
    const brace = cls.getFirstChildByKind(SyntaxKind.OpenBraceToken);
    const fullText = cls.getSourceFile().getFullText();
    const header = fullText.slice(cls.getStart(true), brace ? brace.getEnd() : cls.getEnd());
    const shellParts = [header];

    for (const member of cls.getMembers()) {
      const memberName = memberNameOf(member);
      if (memberName) {
        const isCtor = Node.isConstructorDeclaration(member);
        const nameNode = isCtor ? cls.getNameNode() : (member as { getNameNode?: () => Node }).getNameNode?.();
        const info = add(`${className}.${memberName}`, "method", member, [member], nameNode);
        if (isCtor) info.onlyNewRefs = true;
      } else {
        shellParts.push(member.getText(true));
      }
    }
    add(className, "class", cls, [cls], cls.getNameNode(), shellParts.join("\n"));
  }
}

function memberNameOf(member: Node): string | undefined {
  if (Node.isConstructorDeclaration(member)) return "constructor";
  if (Node.isMethodDeclaration(member)) return member.getName();
  if (Node.isGetAccessorDeclaration(member)) return `get ${member.getName()}`;
  if (Node.isSetAccessorDeclaration(member)) return `set ${member.getName()}`;
  if (Node.isPropertyDeclaration(member) && isFunctionLike(member.getInitializer())) return member.getName();
  return undefined;
}

/** Arrow/function expressions, also when wrapped: `memo(forwardRef(() => …))`, `(… ) as X`. */
function isFunctionLike(expr: Node | undefined): boolean {
  let e = expr;
  for (let depth = 0; e && depth < 6; depth++) {
    if (Node.isArrowFunction(e) || Node.isFunctionExpression(e)) return true;
    if (Node.isParenthesizedExpression(e) || Node.isAsExpression(e) || Node.isSatisfiesExpression(e)) {
      e = e.getExpression();
    } else if (Node.isCallExpression(e)) {
      e = e.getArguments()[0];
    } else {
      return false;
    }
  }
  return false;
}

function declarationsOf(node: Node): Node[] {
  let symbol = node.getSymbol();
  if (!symbol) return [];
  if (symbol.isAlias()) {
    try {
      symbol = symbol.getAliasedSymbol() ?? symbol;
    } catch {
      // unresolved alias
    }
  }
  return symbol.getDeclarations();
}

/** How a reference identifier is used at its site; undefined to skip it. */
function usageKind(ref: Node): EdgeKind | undefined {
  const parent = ref.getParent();
  if (!parent) return undefined;
  if (Node.isJsxClosingElement(parent)) return undefined;
  // the declaration's own name
  if ((parent as { getNameNode?: () => Node }).getNameNode?.() === ref && !Node.isPropertyAccessExpression(parent)) {
    return undefined;
  }
  const callee = Node.isPropertyAccessExpression(parent) && parent.getNameNode() === ref ? parent : ref;
  const site = callee.getParent();
  if (Node.isCallExpression(site) && site.getExpression() === callee) return "call";
  if (Node.isNewExpression(site) && site.getExpression() === callee) return "new";
  if ((Node.isJsxOpeningElement(site) || Node.isJsxSelfClosingElement(site)) && site.getTagNameNode() === callee) {
    return "render";
  }
  return "ref";
}
