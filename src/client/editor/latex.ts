/**
 * Converts a practical subset of LaTeX math to MathML, which browsers render
 * natively: scripts, fractions, roots, big operators with limits, accents,
 * fonts, delimiters, matrices and environments, Greek letters and the common
 * symbol set.
 */

const GREEK: Record<string, string> = {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ϵ", varepsilon: "ε", zeta: "ζ", eta: "η", theta: "θ",
  vartheta: "ϑ", iota: "ι", kappa: "κ", lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π", varpi: "ϖ", rho: "ρ",
  varrho: "ϱ", sigma: "σ", varsigma: "ς", tau: "τ", upsilon: "υ", phi: "ϕ", varphi: "φ", chi: "χ", psi: "ψ", omega: "ω",
  Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π", Sigma: "Σ", Upsilon: "Υ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
};

const OPERATORS: Record<string, string> = {
  pm: "±", mp: "∓", times: "×", div: "÷", cdot: "⋅", ast: "∗", star: "⋆", circ: "∘", bullet: "∙", oplus: "⊕", otimes: "⊗",
  ominus: "⊖", cap: "∩", cup: "∪", wedge: "∧", land: "∧", vee: "∨", lor: "∨", setminus: "∖", leq: "≤", le: "≤", geq: "≥",
  ge: "≥", neq: "≠", ne: "≠", approx: "≈", equiv: "≡", sim: "∼", simeq: "≃", cong: "≅", propto: "∝", ll: "≪", gg: "≫",
  in: "∈", notin: "∉", ni: "∋", subset: "⊂", supset: "⊃", subseteq: "⊆", supseteq: "⊇", perp: "⊥", parallel: "∥", mid: "∣",
  to: "→", rightarrow: "→", leftarrow: "←", gets: "←", leftrightarrow: "↔", Rightarrow: "⇒", Leftarrow: "⇐", Leftrightarrow: "⇔",
  implies: "⟹", iff: "⟺", mapsto: "↦", uparrow: "↑", downarrow: "↓", longrightarrow: "⟶", longleftarrow: "⟵",
  forall: "∀", exists: "∃", nexists: "∄", neg: "¬", lnot: "¬", infty: "∞", partial: "∂", nabla: "∇", emptyset: "∅",
  varnothing: "∅", angle: "∠", triangle: "△", ldots: "…", cdots: "⋯", vdots: "⋮", ddots: "⋱", dots: "…", prime: "′",
  hbar: "ℏ", ell: "ℓ", Re: "ℜ", Im: "ℑ", aleph: "ℵ", degree: "°", colon: ":", lvert: "|", rvert: "|", vert: "|", Vert: "‖",
  langle: "⟨", rangle: "⟩", lceil: "⌈", rceil: "⌉", lfloor: "⌊", rfloor: "⌋", backslash: "∖", therefore: "∴", because: "∵",
};

const BIG_OPS: Record<string, string> = {
  sum: "∑", prod: "∏", coprod: "∐", int: "∫", iint: "∬", iiint: "∭", oint: "∮", bigcup: "⋃", bigcap: "⋂",
  bigoplus: "⨁", bigotimes: "⨂", lim: "lim", limsup: "lim sup", liminf: "lim inf", max: "max", min: "min", sup: "sup", inf: "inf",
};

const FUNCTIONS = ["sin", "cos", "tan", "cot", "sec", "csc", "arcsin", "arccos", "arctan", "sinh", "cosh", "tanh", "log", "ln", "exp", "det", "dim", "ker", "deg", "gcd", "arg", "Pr", "mod"];

const ACCENTS: Record<string, string> = {
  hat: "^", widehat: "^", bar: "¯", overline: "¯", vec: "→", dot: "˙", ddot: "¨", tilde: "~", widetilde: "~",
  acute: "´", grave: "`", check: "ˇ", breve: "˘", overrightarrow: "→",
};

const FONTS: Record<string, string> = {
  mathbf: "bold", boldsymbol: "bold-italic", mathit: "italic", mathrm: "normal", mathsf: "sans-serif", mathtt: "monospace",
  mathbb: "double-struck", mathcal: "script", mathscr: "script", mathfrak: "fraktur", operatorname: "normal",
};

const SPACES: Record<string, string> = { ",": "0.1667em", ":": "0.2222em", ";": "0.2778em", " ": "0.25em", quad: "1em", qquad: "2em", "!": "-0.1667em" };

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

class Parser {
  i = 0;
  constructor(readonly src: string) {}

  peek() {
    return this.src[this.i];
  }

  skipSpace() {
    while (this.i < this.src.length && /\s/.test(this.src[this.i]!)) this.i++;
  }

  command(): string {
    const m = this.src.slice(this.i).match(/^\\([A-Za-z]+|.)/);
    if (!m) return "";
    this.i += m[0].length;
    return m[1]!;
  }

  /** Parses a sequence until `}` / end / one of the stop commands. */
  sequence(stop: (p: Parser) => boolean = () => false): string {
    const items: string[] = [];
    for (;;) {
      this.skipSpace();
      if (this.i >= this.src.length || this.peek() === "}" || stop(this)) break;
      const atom = this.scripted();
      if (atom === null) break;
      items.push(atom);
    }
    return items.length === 1 ? items[0]! : `<mrow>${items.join("")}</mrow>`;
  }

  group(): string {
    this.skipSpace();
    if (this.peek() === "{") {
      this.i++;
      const inner = this.sequence();
      if (this.peek() === "}") this.i++;
      return inner;
    }
    return this.atom() ?? "<mrow></mrow>";
  }

  rawGroup(): string {
    this.skipSpace();
    if (this.peek() !== "{") return this.src[this.i++] ?? "";
    let depth = 0;
    const start = this.i + 1;
    for (; this.i < this.src.length; this.i++) {
      if (this.src[this.i] === "{") depth++;
      else if (this.src[this.i] === "}" && --depth === 0) break;
    }
    const raw = this.src.slice(start, this.i);
    this.i++;
    return raw;
  }

  scripted(): string | null {
    const startI = this.i;
    let base = this.atom();
    if (base === null) {
      if (this.i === startI) this.i++;
      return "";
    }
    const isBigOp = /data-big/.test(base);
    let sub: string | null = null;
    let sup: string | null = null;
    for (;;) {
      this.skipSpace();
      const c = this.peek();
      if (c === "_" && sub === null) {
        this.i++;
        sub = this.group();
      } else if (c === "^" && sup === null) {
        this.i++;
        sup = this.group();
      } else if (c === "'") {
        this.i++;
        sup = (sup ?? "") + "<mo>′</mo>";
      } else break;
    }
    base = base.replace(" data-big", "");
    if (sub !== null && sup !== null) return isBigOp ? `<munderover>${base}${sub}${sup}</munderover>` : `<msubsup>${base}${sub}${sup}</msubsup>`;
    if (sub !== null) return isBigOp ? `<munder>${base}${sub}</munder>` : `<msub>${base}${sub}</msub>`;
    if (sup !== null) return isBigOp ? `<mover>${base}${sup}</mover>` : `<msup>${base}${sup}</msup>`;
    return base;
  }

  atom(): string | null {
    this.skipSpace();
    const c = this.peek();
    if (c === undefined || c === "}") return null;
    if (c === "{") {
      this.i++;
      const inner = this.sequence();
      if (this.peek() === "}") this.i++;
      return `<mrow>${inner}</mrow>`;
    }
    if (c === "\\") return this.fromCommand(this.command());
    if (c === "&" || c === "_" || c === "^") return null;
    this.i++;
    if (/[0-9.]/.test(c)) {
      let n = c;
      while (/[0-9.]/.test(this.peek() ?? "")) n += this.src[this.i++];
      return `<mn>${n}</mn>`;
    }
    if (/[A-Za-z]/.test(c)) return `<mi>${c}</mi>`;
    if (c === "~") return `<mspace width="0.25em"/>`;
    if ("()[]|".includes(c)) return `<mo stretchy="false">${esc(c)}</mo>`;
    if (c === "-") return "<mo>−</mo>";
    return `<mo>${esc(c)}</mo>`;
  }

  fromCommand(name: string): string | null {
    if (name in GREEK) return `<mi>${GREEK[name]}</mi>`;
    if (name in OPERATORS) return `<mo>${OPERATORS[name]}</mo>`;
    if (name in BIG_OPS) {
      const symbol = BIG_OPS[name]!;
      const limitsBelow = !["int", "iint", "iiint", "oint"].includes(name);
      return limitsBelow ? `<mo data-big movablelimits="true">${symbol}</mo>` : `<mo largeop="true">${symbol}</mo>`;
    }
    if (FUNCTIONS.includes(name)) return `<mi mathvariant="normal">${name}</mi><mo>&#x2061;</mo>`;
    if (name in SPACES) return `<mspace width="${SPACES[name]}"/>`;
    if (name in ACCENTS) return `<mover accent="true">${this.group()}<mo>${ACCENTS[name]}</mo></mover>`;
    if (name in FONTS) {
      if (name === "operatorname") return `<mi mathvariant="normal">${esc(this.rawGroup())}</mi>`;
      return `<mstyle mathvariant="${FONTS[name]}">${this.group()}</mstyle>`;
    }
    switch (name) {
      case "frac":
      case "dfrac":
      case "tfrac":
        return `<mfrac>${this.group()}${this.group()}</mfrac>`;
      case "binom":
        return `<mrow><mo>(</mo><mfrac linethickness="0">${this.group()}${this.group()}</mfrac><mo>)</mo></mrow>`;
      case "sqrt": {
        this.skipSpace();
        if (this.peek() === "[") {
          const close = this.src.indexOf("]", this.i);
          const index = new Parser(this.src.slice(this.i + 1, close)).sequence();
          this.i = close + 1;
          return `<mroot>${this.group()}${index}</mroot>`;
        }
        return `<msqrt>${this.group()}</msqrt>`;
      }
      case "text":
      case "textrm":
      case "mbox":
      case "textit":
      case "textbf":
        return `<mtext>${esc(this.rawGroup())}</mtext>`;
      case "underline":
        return `<munder>${this.group()}<mo>_</mo></munder>`;
      case "overbrace":
        return `<mover>${this.group()}<mo>⏞</mo></mover>`;
      case "underbrace":
        return `<munder>${this.group()}<mo>⏟</mo></munder>`;
      case "left":
      case "right":
      case "big":
      case "Big":
      case "bigg":
      case "Bigg": {
        this.skipSpace();
        let d = this.src[this.i++] ?? "";
        if (d === "\\") {
          this.i--;
          const cmd = this.command();
          d = OPERATORS[cmd] ?? (cmd === "{" ? "{" : cmd === "}" ? "}" : cmd === "|" ? "‖" : "");
        }
        if (d === ".") return "";
        if (name !== "left") return `<mo stretchy="true">${esc(d)}</mo>`;
        const inner = this.sequence((p) => p.src.startsWith("\\right", p.i));
        let right = "";
        if (this.src.startsWith("\\right", this.i)) {
          this.command();
          right = this.fromCommand("right") ?? "";
        }
        return `<mrow><mo stretchy="true">${esc(d)}</mo>${inner}${right}</mrow>`;
      }
      case "begin":
        return this.environment(this.rawGroup());
      case "{":
        return "<mo>{</mo>";
      case "}":
        return "<mo>}</mo>";
      case "\\":
        return null;
      case "|":
        return "<mo>‖</mo>";
      case "displaystyle":
      case "textstyle":
      case "limits":
      case "nolimits":
        return "";
      default:
        return `<mi mathcolor="#c00">\\${esc(name)}</mi>`;
    }
  }

  environment(env: string): string {
    const rows: string[][] = [[]];
    for (;;) {
      this.skipSpace();
      if (this.i >= this.src.length) break;
      if (this.src.startsWith("\\end", this.i)) {
        this.command();
        this.rawGroup();
        break;
      }
      if (this.src.startsWith("\\\\", this.i)) {
        this.i += 2;
        rows.push([]);
        continue;
      }
      if (this.peek() === "&") {
        this.i++;
        rows[rows.length - 1]!.push("");
        continue;
      }
      const cell = this.sequence((p) => p.peek() === "&" || p.src.startsWith("\\\\", p.i) || p.src.startsWith("\\end", p.i));
      const row = rows[rows.length - 1]!;
      if (row.length && row[row.length - 1] === "") row[row.length - 1] = cell;
      else row.push(cell);
    }
    const table = `<mtable>${rows
      .filter((r) => r.length)
      .map((r) => `<mtr>${r.map((c) => `<mtd>${c}</mtd>`).join("")}</mtr>`)
      .join("")}</mtable>`;
    const wrap: Record<string, [string, string]> = {
      pmatrix: ["(", ")"], bmatrix: ["[", "]"], Bmatrix: ["{", "}"], vmatrix: ["|", "|"], Vmatrix: ["‖", "‖"], cases: ["{", ""],
    };
    const w = wrap[env];
    if (!w) return table;
    return `<mrow><mo>${w[0]}</mo>${table}${w[1] ? `<mo>${w[1]}</mo>` : ""}</mrow>`;
  }
}

export const latexToMathML = (latex: string, display: boolean): string => {
  try {
    const parser = new Parser(latex);
    const body = parser.sequence();
    return `<math xmlns="http://www.w3.org/1998/Math/MathML"${display ? ' display="block"' : ""}>${body}</math>`;
  } catch {
    return `<math><mtext>${esc(latex)}</mtext></math>`;
  }
};
