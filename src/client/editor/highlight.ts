/**
 * A small syntax highlighter: per-language keyword lists over a shared
 * tokenizer for strings, comments and numbers. It aims for readable colouring
 * of common languages, not full grammars.
 */

interface Lang {
  keywords: string[];
  literals?: string[];
  types?: string[];
  lineComment?: string[];
  blockComment?: [string, string][];
  strings?: string[];
  /** Characters allowed to start identifiers besides letters and `_`. */
  identStart?: string;
  caseInsensitive?: boolean;
}

const C_LIKE = ["if", "else", "for", "while", "do", "switch", "case", "default", "break", "continue", "return", "goto"];

const LANGS: Record<string, Lang> = {
  javascript: {
    keywords: [...C_LIKE, "var", "let", "const", "function", "class", "extends", "new", "this", "super", "import", "export", "from", "as", "async", "await", "yield", "try", "catch", "finally", "throw", "typeof", "instanceof", "in", "of", "delete", "void", "static", "get", "set"],
    literals: ["true", "false", "null", "undefined", "NaN", "Infinity"],
    lineComment: ["//"],
    blockComment: [["/*", "*/"]],
    strings: ['"', "'", "`"],
    identStart: "$",
  },
  python: {
    keywords: ["def", "class", "return", "if", "elif", "else", "for", "while", "break", "continue", "pass", "import", "from", "as", "with", "try", "except", "finally", "raise", "lambda", "yield", "global", "nonlocal", "assert", "del", "in", "is", "not", "and", "or", "async", "await", "match", "case"],
    literals: ["True", "False", "None"],
    types: ["int", "str", "float", "bool", "list", "dict", "set", "tuple", "bytes", "object"],
    lineComment: ["#"],
    strings: ['"""', "'''", '"', "'"],
  },
  go: {
    keywords: [...C_LIKE, "func", "package", "import", "var", "const", "type", "struct", "interface", "map", "chan", "go", "defer", "select", "range", "fallthrough"],
    literals: ["true", "false", "nil", "iota"],
    types: ["int", "int64", "int32", "uint", "string", "bool", "byte", "rune", "float64", "error", "any"],
    lineComment: ["//"],
    blockComment: [["/*", "*/"]],
    strings: ['"', "'", "`"],
  },
  rust: {
    keywords: [...C_LIKE, "fn", "let", "mut", "pub", "use", "mod", "struct", "enum", "impl", "trait", "match", "loop", "where", "as", "ref", "move", "async", "await", "dyn", "crate", "self", "Self", "super", "unsafe", "extern", "type", "const", "static", "in"],
    literals: ["true", "false", "None", "Some", "Ok", "Err"],
    types: ["i32", "i64", "u8", "u32", "u64", "usize", "f64", "bool", "str", "String", "Vec", "Option", "Result", "Box"],
    lineComment: ["//"],
    blockComment: [["/*", "*/"]],
    strings: ['"'],
  },
  java: {
    keywords: [...C_LIKE, "class", "interface", "enum", "extends", "implements", "new", "this", "super", "import", "package", "public", "private", "protected", "static", "final", "abstract", "void", "try", "catch", "finally", "throw", "throws", "instanceof", "synchronized", "record", "var"],
    literals: ["true", "false", "null"],
    types: ["int", "long", "double", "float", "boolean", "char", "byte", "short", "String", "Object"],
    lineComment: ["//"],
    blockComment: [["/*", "*/"]],
    strings: ['"', "'"],
  },
  c: {
    keywords: [...C_LIKE, "struct", "union", "enum", "typedef", "sizeof", "static", "extern", "const", "volatile", "inline", "#include", "#define", "#if", "#ifdef", "#ifndef", "#endif", "#else", "class", "namespace", "template", "typename", "public", "private", "protected", "virtual", "override", "new", "delete", "this", "using", "auto", "constexpr", "nullptr"],
    literals: ["true", "false", "NULL"],
    types: ["int", "long", "short", "char", "float", "double", "void", "unsigned", "signed", "bool", "size_t"],
    lineComment: ["//"],
    blockComment: [["/*", "*/"]],
    strings: ['"', "'"],
    identStart: "#",
  },
  sql: {
    keywords: ["select", "from", "where", "and", "or", "not", "insert", "into", "values", "update", "set", "delete", "create", "table", "index", "drop", "alter", "add", "join", "left", "right", "inner", "outer", "on", "as", "group", "by", "order", "having", "limit", "offset", "union", "all", "distinct", "case", "when", "then", "else", "end", "in", "is", "like", "exists", "primary", "key", "references", "default", "returning", "with", "begin", "commit", "rollback"],
    literals: ["null", "true", "false"],
    types: ["int", "integer", "bigint", "text", "varchar", "boolean", "uuid", "jsonb", "json", "timestamp", "timestamptz", "date", "numeric"],
    lineComment: ["--"],
    blockComment: [["/*", "*/"]],
    strings: ["'", '"'],
    caseInsensitive: true,
  },
  shell: {
    keywords: ["if", "then", "else", "elif", "fi", "for", "while", "do", "done", "case", "esac", "in", "function", "return", "export", "local", "echo", "cd", "exit", "set", "unset", "source"],
    literals: ["true", "false"],
    lineComment: ["#"],
    strings: ['"', "'"],
    identStart: "$-",
  },
  css: {
    keywords: ["@media", "@import", "@keyframes", "@font-face", "!important"],
    lineComment: [],
    blockComment: [["/*", "*/"]],
    strings: ['"', "'"],
    identStart: "@-!#.",
  },
  json: { keywords: [], literals: ["true", "false", "null"], strings: ['"'] },
  yaml: { keywords: [], literals: ["true", "false", "null", "yes", "no"], lineComment: ["#"], strings: ['"', "'"] },
  ruby: {
    keywords: ["def", "end", "class", "module", "if", "elsif", "else", "unless", "while", "until", "for", "in", "do", "return", "yield", "begin", "rescue", "ensure", "raise", "require", "include", "attr_accessor", "self", "then", "case", "when"],
    literals: ["true", "false", "nil"],
    lineComment: ["#"],
    strings: ['"', "'"],
  },
  php: {
    keywords: [...C_LIKE, "function", "class", "public", "private", "protected", "static", "new", "echo", "return", "namespace", "use", "extends", "implements", "foreach", "as", "try", "catch", "throw", "fn"],
    literals: ["true", "false", "null"],
    lineComment: ["//", "#"],
    blockComment: [["/*", "*/"]],
    strings: ['"', "'"],
    identStart: "$",
  },
  swift: {
    keywords: [...C_LIKE, "func", "let", "var", "class", "struct", "enum", "protocol", "extension", "import", "guard", "in", "init", "self", "Self", "super", "throws", "throw", "try", "catch", "async", "await", "public", "private", "static", "override", "some", "any"],
    literals: ["true", "false", "nil"],
    types: ["Int", "String", "Bool", "Double", "Float", "Array", "Dictionary", "Void"],
    lineComment: ["//"],
    blockComment: [["/*", "*/"]],
    strings: ['"'],
  },
  kotlin: {
    keywords: [...C_LIKE, "fun", "val", "var", "class", "object", "interface", "when", "is", "in", "import", "package", "override", "private", "public", "data", "sealed", "suspend", "companion", "this", "super", "try", "catch", "throw"],
    literals: ["true", "false", "null"],
    lineComment: ["//"],
    blockComment: [["/*", "*/"]],
    strings: ['"', "'"],
  },
  html: { keywords: [], lineComment: [], blockComment: [["<!--", "-->"]], strings: ['"', "'"] },
  markdown: { keywords: [], strings: ["`"] },
  dockerfile: {
    keywords: ["from", "run", "cmd", "copy", "add", "env", "expose", "workdir", "user", "entrypoint", "arg", "label", "volume", "healthcheck", "as"],
    lineComment: ["#"],
    strings: ['"', "'"],
    caseInsensitive: true,
  },
};

const ALIASES: Record<string, string> = {
  js: "javascript", jsx: "javascript", ts: "javascript", tsx: "javascript", typescript: "javascript", mjs: "javascript",
  py: "python", golang: "go", rs: "rust", cpp: "c", "c++": "c", h: "c", hpp: "c", csharp: "java", cs: "java", "c#": "java",
  scala: "java", dart: "java", sh: "shell", bash: "shell", zsh: "shell", console: "shell", powershell: "shell", ps1: "shell",
  postgres: "sql", postgresql: "sql", mysql: "sql", scss: "css", less: "css", yml: "yaml", rb: "ruby", kt: "kotlin",
  xml: "html", svg: "html", vue: "html", md: "markdown", docker: "dockerfile", jsonc: "json",
};

export const LANGUAGES = [
  "plaintext", "bash", "c", "cpp", "csharp", "css", "dart", "dockerfile", "go", "html", "java", "javascript", "json",
  "kotlin", "markdown", "mermaid", "php", "powershell", "python", "ruby", "rust", "scala", "scss", "shell", "sql",
  "swift", "typescript", "xml", "yaml",
];

export interface Token {
  text: string;
  cls?: string;
}

const lookup = (language: string | null | undefined): Lang | null => {
  if (!language) return null;
  const key = language.toLowerCase();
  return LANGS[key] ?? LANGS[ALIASES[key] ?? ""] ?? null;
};

export const highlight = (code: string, language: string | null | undefined): Token[] => {
  const lang = lookup(language);
  if (!lang) return [{ text: code }];
  const norm = (w: string) => (lang.caseInsensitive ? w.toLowerCase() : w);
  const keywords = new Set(lang.keywords.map(norm));
  const literals = new Set((lang.literals ?? []).map(norm));
  const types = new Set((lang.types ?? []).map(norm));
  const tokens: Token[] = [];
  let plain = "";
  const push = (text: string, cls?: string) => {
    if (!cls) {
      plain += text;
      return;
    }
    if (plain) tokens.push({ text: plain });
    plain = "";
    tokens.push({ text, cls });
  };
  const isHtml = lang === LANGS.html;
  let i = 0;
  while (i < code.length) {
    const rest = code.slice(i);
    const block = lang.blockComment?.find(([open]) => rest.startsWith(open));
    if (block) {
      const end = code.indexOf(block[1], i + block[0].length);
      const stop = end < 0 ? code.length : end + block[1].length;
      push(code.slice(i, stop), "hl-comment");
      i = stop;
      continue;
    }
    const line = lang.lineComment?.find((open) => rest.startsWith(open) && (open !== "#" || i === 0 || /\s/.test(code[i - 1]!)));
    if (line) {
      const end = code.indexOf("\n", i);
      const stop = end < 0 ? code.length : end;
      push(code.slice(i, stop), "hl-comment");
      i = stop;
      continue;
    }
    const quote = lang.strings?.find((q) => rest.startsWith(q));
    if (quote) {
      let j = i + quote.length;
      while (j < code.length && !code.startsWith(quote, j)) {
        if (code[j] === "\\") j++;
        else if (code[j] === "\n" && quote.length === 1 && quote !== "`") break;
        j++;
      }
      const stop = Math.min(code.length, j + quote.length);
      push(code.slice(i, stop), "hl-string");
      i = stop;
      continue;
    }
    if (isHtml) {
      const tag = rest.match(/^<\/?[A-Za-z][\w:-]*/);
      if (tag) {
        push(tag[0], "hl-title");
        i += tag[0].length;
        continue;
      }
      const attr = rest.match(/^\s[\w:-]+(?==)/);
      if (attr) {
        push(attr[0], "hl-attr");
        i += attr[0].length;
        continue;
      }
    }
    const num = rest.match(/^(0x[\da-fA-F_]+|\d[\d_]*(\.\d+)?([eE][+-]?\d+)?)\b/);
    if (num && !/[\w$]/.test(code[i - 1] ?? "")) {
      push(num[0], "hl-number");
      i += num[0].length;
      continue;
    }
    const identStart = `[A-Za-z_${(lang.identStart ?? "").replace(/[-\\\]^]/g, "\\$&")}]`;
    const word = rest.match(new RegExp(`^${identStart}[\\w$-]*`));
    if (word && !/[\w$]/.test(code[i - 1] ?? "")) {
      let w = word[0];
      if (!lang.identStart?.includes("-")) w = w.replace(/-.*$/, "");
      const n = norm(w);
      if (keywords.has(n)) push(w, "hl-keyword");
      else if (literals.has(n)) push(w, "hl-number");
      else if (types.has(n)) push(w, "hl-title");
      else if (code[i + w.length] === "(") push(w, "hl-title");
      else push(w);
      i += w.length;
      continue;
    }
    push(code[i]!);
    i++;
  }
  if (plain) tokens.push({ text: plain });
  return tokens;
};
