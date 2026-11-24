/**
 * markdown.js — response renderer
 *
 * Dependency-light Markdown for chat replies:
 *   - headings, emphasis, lists, tables, blockquotes, links, rules
 *   - fenced code with language labels, copy buttons and syntax highlighting
 *   - inline ($…$) and block ($$…$$, \[…\]) LaTeX through vendored KaTeX
 *   - tolerant parsing so half-arrived streaming text still renders sanely
 *   - dir="auto" on text blocks so Arabic and Hebrew read right-to-left
 *
 * Everything is escaped before any HTML is produced, and link URLs are
 * restricted to http(s), mailto and relative targets.
 */

/* ------------------------------------------------------------------ */
/* Escaping                                                            */
/* ------------------------------------------------------------------ */

const ESCAPES = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

function escapeRe(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* ------------------------------------------------------------------ */
/* Language metadata + syntax highlighting                             */
/* ------------------------------------------------------------------ */

export const LANG_LABELS = {
  javascript: "JavaScript",
  js: "JavaScript",
  jsx: "JSX",
  typescript: "TypeScript",
  ts: "TypeScript",
  tsx: "TSX",
  python: "Python",
  py: "Python",
  java: "Java",
  c: "C",
  cpp: "C++",
  "c++": "C++",
  csharp: "C#",
  cs: "C#",
  go: "Go",
  golang: "Go",
  rust: "Rust",
  rs: "Rust",
  ruby: "Ruby",
  rb: "Ruby",
  php: "PHP",
  swift: "Swift",
  kotlin: "Kotlin",
  kt: "Kotlin",
  dart: "Dart",
  sql: "SQL",
  bash: "Bash",
  sh: "Shell",
  shell: "Shell",
  zsh: "Shell",
  console: "Console",
  html: "HTML",
  xml: "XML",
  svg: "SVG",
  vue: "Vue",
  css: "CSS",
  scss: "SCSS",
  less: "Less",
  json: "JSON",
  jsonc: "JSON",
  yaml: "YAML",
  yml: "YAML",
  toml: "TOML",
  ini: "INI",
  markdown: "Markdown",
  md: "Markdown",
  text: "Text",
  plain: "Text",
};

const ALIASES = {
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  tsx: "typescript",
  py: "python",
  python3: "python",
  rb: "ruby",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  console: "bash",
  yml: "yaml",
  rs: "rust",
  golang: "go",
  kt: "kotlin",
  cs: "csharp",
  "c++": "cpp",
  h: "c",
  hpp: "cpp",
  xml: "html",
  svg: "html",
  vue: "html",
  md: "markdown",
  jsonc: "json",
  scss: "css",
  less: "css",
  toml: "yaml",
  ini: "yaml",
};

const KEYWORDS = {
  javascript:
    "await async break case catch class const continue debugger default delete do else export extends finally for from function get if import in instanceof let new of package private protected public return set static super switch this throw try typeof var void while with yield true false null undefined",
  typescript:
    "abstract as async await break case catch class const continue debugger declare default delete do else enum export extends finally for from function get if implements import in infer interface is keyof let namespace never new of package private protected public readonly return satisfies set static super switch this throw try type typeof unknown var void while with yield true false null undefined any string number boolean object symbol bigint",
  python:
    "and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield True False None match case self",
  java:
    "abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for if implements import instanceof int interface long native new package private protected public record return sealed short static strictfp super switch synchronized this throw throws transient try void volatile while var true false null",
  c: "auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while true false NULL size_t",
  cpp:
    "alignas auto bool break case catch char class const constexpr continue default delete do double else enum explicit export extern false float for friend goto if inline int long namespace new noexcept nullptr operator override private protected public return short signed sizeof static struct switch template this throw true try typedef typename union unsigned using virtual void volatile while",
  csharp:
    "abstract as async await base bool break byte case catch char class const continue default delegate do double else enum event explicit extern false finally fixed float for foreach get if implicit in int interface internal is lock long namespace new null object out override params private protected public readonly record return sealed set short sizeof static string struct switch this throw true try typeof uint using var virtual void while",
  go: "break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var nil true false iota",
  rust:
    "as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while",
  ruby:
    "alias and begin break case class def defined do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield require attr_accessor puts",
  php:
    "abstract and array as break callable case catch class clone const continue declare default do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile enum eval exit extends final finally fn for foreach function global goto if implements include include_once instanceof insteadof interface isset list match namespace new null or print private protected public readonly require require_once return static switch throw trait try unset use var while xor yield true false",
  swift:
    "associatedtype class deinit enum extension fileprivate func import init inout internal let open operator private protocol public rethrows static struct subscript typealias var break case continue default defer do else fallthrough for guard if in repeat return switch where while async await throws try true false nil self",
  kotlin:
    "as break class continue do else false for fun if in interface is null object package return super this throw true try typealias typeof val var when while by catch constructor delegate dynamic field file finally get import init param property receiver set setparam where actual abstract annotation companion const data enum expect external final infix inline inner internal lateinit noinline open operator out override private protected public reified sealed suspend tailrec vararg",
  sql:
    "select from where group by order having insert update delete into values set create table alter drop index view join left right inner outer full on as and or not null is in like between distinct union all case when then else end limit offset count sum avg min max primary key foreign references default unique check exists asc desc with returning truncate database schema begin commit rollback",
  bash:
    "if then else elif fi for while do done case esac function in select until return break continue local export readonly declare set unset shift source echo cd ls mkdir rm cp mv cat grep sed awk touch chmod chown sudo exit",
  yaml: "true false null yes no on off",
};

const CONFIG = {
  javascript: { line: "//", block: true, template: true, keywords: KEYWORDS.javascript },
  typescript: { line: "//", block: true, template: true, keywords: KEYWORDS.typescript },
  python: { hash: true, triple: true, keywords: KEYWORDS.python },
  java: { line: "//", block: true, keywords: KEYWORDS.java },
  c: { line: "//", block: true, keywords: KEYWORDS.c },
  cpp: { line: "//", block: true, keywords: KEYWORDS.cpp },
  csharp: { line: "//", block: true, keywords: KEYWORDS.csharp },
  go: { line: "//", block: true, keywords: KEYWORDS.go },
  rust: { line: "//", block: true, keywords: KEYWORDS.rust },
  ruby: { hash: true, keywords: KEYWORDS.ruby },
  php: { line: "//", block: true, hash: true, keywords: KEYWORDS.php },
  swift: { line: "//", block: true, keywords: KEYWORDS.swift },
  kotlin: { line: "//", block: true, keywords: KEYWORDS.kotlin },
  dart: { line: "//", block: true, keywords: KEYWORDS.kotlin },
  sql: { dash: true, block: true, icase: true, keywords: KEYWORDS.sql },
  bash: { hash: true, keywords: KEYWORDS.bash },
  yaml: { hash: true, keywords: KEYWORDS.yaml, props: true },
  css: { block: true, props: true, keywords: "" },
};

function buildPattern(cfg) {
  const comments = [];
  if (cfg.line) comments.push(`${escapeRe(cfg.line)}[^\\n]*`);
  if (cfg.hash) comments.push("#[^\\n]*");
  if (cfg.dash) comments.push("--[^\\n]*");
  if (cfg.block) comments.push("/\\*[\\s\\S]*?\\*/");

  const strings = [];
  if (cfg.triple) strings.push('"""[\\s\\S]*?"""');
  strings.push('"(?:\\\\[\\s\\S]|[^"\\\\\\n])*"');
  strings.push("'(?:\\\\[\\s\\S]|[^'\\\\\\n])*'");
  if (cfg.template) strings.push("`(?:\\\\[\\s\\S]|[^`\\\\])*`");

  return new RegExp(
    [
      comments.length ? `(${comments.join("|")})` : "()",
      `(${strings.join("|")})`,
      "(\\b0[xX][\\da-fA-F]+\\b|\\b\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b)",
      "([A-Za-z_$][\\w$]*)",
    ].join("|"),
    "g"
  );
}

function keywordSet(raw, icase) {
  const set = new Set(String(raw || "").split(/\s+/).filter(Boolean));
  return icase ? new Set([...set].map((k) => k.toLowerCase())) : set;
}

function genericHighlight(code, lang) {
  const cfg = CONFIG[lang];
  if (!cfg) return escapeHtml(code);

  const keywords = keywordSet(cfg.keywords, cfg.icase);
  const re = buildPattern(cfg);
  let out = "";
  let last = 0;
  let match;

  while ((match = re.exec(code))) {
    if (match.index > last) out += escapeHtml(code.slice(last, match.index));

    const token = match[0];
    const after = code.slice(re.lastIndex);
    const classFor = () => {
      if (match[1]) return "tok-com";
      if (match[2]) return cfg.props && /^\s*:/.test(after) ? "tok-prop" : "tok-str";
      if (match[3]) return "tok-num";
      if (cfg.icase ? keywords.has(token.toLowerCase()) : keywords.has(token)) return "tok-kw";
      if (/^(true|false|null|None|True|False|nil|undefined)$/.test(token)) return "tok-const";
      if (cfg.props && /^\s*:/.test(after)) return "tok-prop";
      if (/^\s*\(/.test(after)) return "tok-fn";
      if (/^[A-Z][A-Za-z0-9_$]*$/.test(token) && token.length > 1) return "tok-cls";
      return "";
    };

    const cls = classFor();
    out += cls ? `<span class="${cls}">${escapeHtml(token)}</span>` : escapeHtml(token);
    last = re.lastIndex;
  }

  out += escapeHtml(code.slice(last));
  return out;
}

function highlightJson(code) {
  let out = "";
  let last = 0;
  const re = /("(?:\\.|[^"\\\n])*")(\s*:)?|(\b-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|\b(true|false|null)\b/g;
  let m;
  while ((m = re.exec(code))) {
    if (m.index > last) out += escapeHtml(code.slice(last, m.index));
    if (m[1]) {
      const cls = m[2] ? "tok-prop" : "tok-str";
      out += `<span class="${cls}">${escapeHtml(m[1])}</span>`;
      if (m[2]) out += escapeHtml(m[2]);
    } else if (m[3]) {
      out += `<span class="tok-num">${escapeHtml(m[3])}</span>`;
    } else {
      out += `<span class="tok-const">${escapeHtml(m[4])}</span>`;
    }
    last = re.lastIndex;
  }
  out += escapeHtml(code.slice(last));
  return out;
}

function highlightHtml(code) {
  let out = "";
  let last = 0;
  const re = /<!--[\s\S]*?-->|<!DOCTYPE[^>]*>|(<\/?)([A-Za-z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?>)/gi;
  let m;

  while ((m = re.exec(code))) {
    if (m.index > last) out += escapeHtml(code.slice(last, m.index));
    if (!m[1]) {
      out += `<span class="tok-com">${escapeHtml(m[0])}</span>`;
    } else {
      out += `<span class="tok-punct">${escapeHtml(m[1])}</span>`;
      out += `<span class="tok-tag">${escapeHtml(m[2])}</span>`;
      const attrs = m[3] || "";
      const attrRe = /([A-Za-z_:@#][\w:.-]*)(\s*=\s*)("[^"]*"|'[^']*'|[^\s>]+)?|(\s+)/g;
      let a;
      let attrLast = 0;
      while ((a = attrRe.exec(attrs))) {
        if (a.index > attrLast) out += escapeHtml(attrs.slice(attrLast, a.index));
        if (a[4]) out += escapeHtml(a[4]);
        else {
          out += `<span class="tok-attr">${escapeHtml(a[1])}</span>`;
          if (a[2]) out += escapeHtml(a[2]);
          if (a[3]) out += `<span class="tok-str">${escapeHtml(a[3])}</span>`;
        }
        attrLast = attrRe.lastIndex;
      }
      out += escapeHtml(attrs.slice(attrLast));
      out += `<span class="tok-punct">${escapeHtml(m[4])}</span>`;
    }
    last = re.lastIndex;
  }

  out += escapeHtml(code.slice(last));
  return out;
}

/** Highlights code and returns HTML with only escaped text inside spans. */
export function highlightCode(code, lang) {
  const source = String(code ?? "");
  const key = ALIASES[String(lang || "").toLowerCase()] || String(lang || "").toLowerCase();

  try {
    if (key === "json") return highlightJson(source);
    if (key === "html") return highlightHtml(source);
    if (key === "markdown") return escapeHtml(source);
    return genericHighlight(source, key);
  } catch {
    return escapeHtml(source);
  }
}

/* ------------------------------------------------------------------ */
/* Math                                                                */
/* ------------------------------------------------------------------ */

/**
 * Renders TeX through the vendored KaTeX bundle. Invalid or incomplete TeX
 * falls back to readable monospace text instead of disappearing.
 */
export function mathHtml(tex, display = false) {
  const source = String(tex ?? "").trim();
  if (!source) return "";
  const katex = globalThis.katex;
  if (katex && typeof katex.renderToString === "function") {
    try {
      return katex.renderToString(source, {
        displayMode: !!display,
        throwOnError: true,
        strict: false,
        trust: false,
        output: "html",
      });
    } catch {
      /* invalid or half-streamed TeX — fall through to raw text */
    }
  }
  return `<code class="math-raw" dir="ltr">${escapeHtml(source)}</code>`;
}

/** Keeps "$5 and $10" prose from being parsed as math. */
function looksLikeMath(tex) {
  const source = String(tex || "");
  if (!source || /^\s|\s$/.test(source)) return false;
  if (/\\[a-zA-Z]+/.test(source)) return true;
  if (/[=+\-*/^_{}<>≤≥×÷√π∑∫∂∞≠≈]/.test(source)) return true;
  if (/[A-Za-z]{3,}/.test(source)) return false;
  return /[A-Za-z0-9]/.test(source);
}

/* ------------------------------------------------------------------ */
/* Inline formatting                                                   */
/* ------------------------------------------------------------------ */

function safeUrl(raw) {
  const url = String(raw || "").trim();
  if (/^(https?:|mailto:)/i.test(url)) return url;
  if (/^[./#]/.test(url)) return url;
  return "";
}

function normalizeUrl(url) {
  return /^www\./i.test(url) ? `https://${url}` : url;
}

export function renderInline(text) {
  const stash = [];
  const hold = (html) => `\u0000${stash.push(html) - 1}\u0000`;
  let s = String(text ?? "");

  // Literal dollar signs, code spans and math are protected before escaping.
  s = s.replace(/\\\$/g, () => hold("$"));

  s = s.replace(/(`+)([\s\S]*?)\1/g, (m, ticks, code) => {
    const body = String(code).replace(/^ /, "").replace(/ $/, "");
    return hold(`<code class="inline-code">${escapeHtml(body)}</code>`);
  });

  s = s.replace(/\$([^$\n]+?)\$/g, (m, tex) =>
    looksLikeMath(tex) ? hold(mathHtml(tex, false)) : m
  );
  s = s.replace(/\\\(([\s\S]+?)\\\)/g, (m, tex) => hold(mathHtml(tex, false)));

  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (m, label, href, title) => {
    const url = safeUrl(href);
    if (!url) return m;
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
    return hold(
      `<a href="${escapeHtml(url)}"${titleAttr} target="_blank" rel="noopener noreferrer">${renderInline(label)}</a>`
    );
  });

  s = s.replace(/(^|[\s(])((?:https?:\/\/|www\.)[^\s<"')]+)/g, (m, pre, url) => {
    const trimmed = url.replace(/[.,;:!?]+$/, "");
    const tail = url.slice(trimmed.length);
    const href = safeUrl(normalizeUrl(trimmed));
    if (!href) return m;
    return `${pre}${hold(
      `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(trimmed)}</a>`
    )}${tail}`;
  });

  s = escapeHtml(s);

  s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__(?=\S)([\s\S]*?\S)__/g, "<strong>$1</strong>");
  s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<del>$1</del>");
  s = s.replace(/(^|[\s(])\*(?=\S)([^*\n]*?\S)\*(?![*\w])/g, "$1<em>$2</em>");
  s = s.replace(/(^|[\s(])_(?=\S)([^_\n]*?\S)_(?![_\w])/g, "$1<em>$2</em>");

  return s.replace(/\u0000(\d+)\u0000/g, (m, index) => stash[Number(index)] ?? "");
}

/* ------------------------------------------------------------------ */
/* Block helpers                                                       */
/* ------------------------------------------------------------------ */

function codeBlockHtml(code, lang, streaming) {
  const clean = String(code).replace(/\n+$/, "");
  const key = String(lang || "").toLowerCase();
  const label = LANG_LABELS[key] || (key ? key.toUpperCase() : "Code");
  const safeLang = escapeHtml(key || "text");

  return [
    `<div class="code-block"${streaming ? ' data-streaming="true"' : ""}>`,
    `<div class="code-head"><span class="code-lang">${escapeHtml(label)}</span>`,
    `<button class="code-copy" type="button" aria-label="Copy code" title="Copy code">Copy</button></div>`,
    `<pre class="code-pre"><code class="language-${safeLang}">${highlightCode(clean, key)}</code></pre>`,
    `</div>`,
  ].join("");
}

function splitRow(line) {
  let s = String(line).trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  const cells = [];
  let current = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && s[i + 1] === "|") {
      current += "|";
      i++;
      continue;
    }
    if (ch === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  cells.push(current.trim());
  return cells;
}

function isTableDelimiter(line) {
  const s = String(line || "").trim();
  if (!s.includes("|") || !s.includes("-")) return false;
  const cells = splitRow(s);
  return cells.length > 0 && cells.every((cell) => /^:?-{2,}:?$/.test(cell.replace(/\s+/g, "")));
}

function alignmentsFrom(line) {
  return splitRow(line).map((cell) => {
    const c = cell.replace(/\s+/g, "");
    const left = c.startsWith(":");
    const right = c.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    return left ? "left" : "";
  });
}

function tableHtml(lines, start) {
  const header = splitRow(lines[start]);
  const aligns = alignmentsFrom(lines[start + 1]);
  let i = start + 2;
  const rows = [];
  while (i < lines.length && lines[i].trim() && lines[i].includes("|")) {
    rows.push(splitRow(lines[i]));
    i++;
  }

  const cell = (tag, value, index) => {
    const align = aligns[index] ? ` style="text-align:${aligns[index]}"` : "";
    return `<${tag} dir="auto"${align}>${renderInline(value || "")}</${tag}>`;
  };

  const head = `<thead><tr>${header.map((c, index) => cell("th", c, index)).join("")}</tr></thead>`;
  const body = rows.length
    ? `<tbody>${rows
        .map(
          (row) =>
            `<tr>${header
              .map((_, index) => cell("td", row[index] ?? "", index))
              .join("")}</tr>`
        )
        .join("")}</tbody>`
    : "";

  return {
    html: `<div class="table-wrap"><table dir="auto">${head}${body}</table></div>`,
    next: i,
  };
}

function listHtml(items) {
  const ordered = items[0].ordered;
  let html = ordered ? `<ol${items[0].start !== 1 ? ` start="${items[0].start}"` : ""}>` : "<ul>";
  let i = 0;

  while (i < items.length) {
    const item = items[i];
    let nested = "";
    let j = i + 1;
    if (j < items.length && items[j].indent > item.indent) {
      const deeper = [];
      const level = items[j].indent;
      while (j < items.length && items[j].indent >= level) {
        deeper.push(items[j]);
        j++;
      }
      nested = listHtml(deeper);
    }
    html += `<li dir="auto">${renderInline(item.text)}${nested}</li>`;
    i = j > i + 1 ? j : i + 1;
  }

  return html + (ordered ? "</ol>" : "</ul>");
}

const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;

function startsBlock(line) {
  return (
    /^ {0,3}(`{3,}|~{3,})/.test(line) ||
    /^ {0,3}\$\$/.test(line) ||
    /^ {0,3}\\\[/.test(line) ||
    /^ {0,3}#{1,6}\s/.test(line) ||
    /^ {0,3}>/.test(line) ||
    /^ {0,3}([-*_])(\s*\1){2,}\s*$/.test(line) ||
    LIST_ITEM.test(line)
  );
}

/* ------------------------------------------------------------------ */
/* Block renderer                                                      */
/* ------------------------------------------------------------------ */

/**
 * @param {string} source markdown from a model or from stored history
 * @param {{streaming?: boolean}} options tolerate half-written constructs
 * @returns {string} safe HTML
 */
export function renderMarkdown(source, { streaming = false } = {}) {
  const text = String(source ?? "").replace(/\r\n?/g, "\n").replace(/\t/g, "  ");
  const lines = text.split("\n");
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i++;
      continue;
    }

    /* fenced code --------------------------------------------------- */
    const fence = /^ {0,3}(`{3,}|~{3,})\s*([^\s`~]*)\s*$/.exec(line);
    if (fence) {
      const marker = fence[1][0];
      const length = fence[1].length;
      const lang = (fence[2] || "").trim();
      const buffer = [];
      i++;
      while (i < lines.length) {
        const closing = new RegExp(`^ {0,3}${escapeRe(marker)}{${length},}\\s*$`).test(lines[i]);
        if (closing) {
          i++;
          break;
        }
        buffer.push(lines[i]);
        i++;
      }
      out.push(codeBlockHtml(buffer.join("\n"), lang, streaming));
      continue;
    }

    /* block math: $$ … $$ ------------------------------------------- */
    if (/^ {0,3}\$\$/.test(line)) {
      const rest = line.trim().replace(/^\$\$/, "");
      const sameLine = /^\s*(.+?)\s*\$\$\s*$/.exec(rest);
      if (sameLine) {
        out.push(`<div class="math-block" dir="ltr">${mathHtml(sameLine[1], true)}</div>`);
        i++;
        continue;
      }
      const buffer = rest.trim() ? [rest] : [];
      i++;
      while (i < lines.length) {
        const at = lines[i].indexOf("$$");
        if (at >= 0) {
          buffer.push(lines[i].slice(0, at));
          i++;
          break;
        }
        buffer.push(lines[i]);
        i++;
      }
      out.push(`<div class="math-block" dir="ltr">${mathHtml(buffer.join("\n"), true)}</div>`);
      continue;
    }

    /* block math: \[ … \] ------------------------------------------- */
    if (/^ {0,3}\\\[/.test(line)) {
      const rest = line.replace(/^ {0,3}\\\[/, "");
      const buffer = [];
      const sameLine = /(.+?)\\\]\s*$/.exec(rest);
      if (sameLine) {
        out.push(`<div class="math-block" dir="ltr">${mathHtml(sameLine[1], true)}</div>`);
        i++;
        continue;
      }
      if (rest.trim()) buffer.push(rest);
      i++;
      while (i < lines.length) {
        const at = lines[i].indexOf("\\]");
        if (at >= 0) {
          buffer.push(lines[i].slice(0, at));
          i++;
          break;
        }
        buffer.push(lines[i]);
        i++;
      }
      out.push(`<div class="math-block" dir="ltr">${mathHtml(buffer.join("\n"), true)}</div>`);
      continue;
    }

    /* heading -------------------------------------------------------- */
    const heading = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      out.push(`<h${level} dir="auto">${renderInline(heading[2])}</h${level}>`);
      i++;
      continue;
    }

    /* horizontal rule ------------------------------------------------ */
    if (/^ {0,3}((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})$/.test(line)) {
      out.push("<hr />");
      i++;
      continue;
    }

    /* blockquote ----------------------------------------------------- */
    if (/^ {0,3}>/.test(line)) {
      const buffer = [];
      while (i < lines.length && /^ {0,3}>/.test(lines[i])) {
        buffer.push(lines[i].replace(/^ {0,3}>\s?/, ""));
        i++;
      }
      out.push(`<blockquote dir="auto">${renderMarkdown(buffer.join("\n"), { streaming })}</blockquote>`);
      continue;
    }

    /* table ---------------------------------------------------------- */
    if (line.includes("|") && i + 1 < lines.length && isTableDelimiter(lines[i + 1])) {
      const table = tableHtml(lines, i);
      out.push(table.html);
      i = table.next;
      continue;
    }

    /* list ----------------------------------------------------------- */
    if (LIST_ITEM.test(line)) {
      const items = [];
      while (i < lines.length) {
        const match = LIST_ITEM.exec(lines[i]);
        if (!match) break;
        items.push({
          indent: match[1].length,
          ordered: /\d/.test(match[2]),
          start: parseInt(match[2], 10) || 1,
          text: match[3],
        });
        i++;
      }
      out.push(listHtml(items));
      continue;
    }

    /* paragraph ------------------------------------------------------ */
    const paragraph = [];
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i])) {
      paragraph.push(lines[i]);
      i++;
    }
    if (!paragraph.length) {
      // Defensive: never loop forever on an empty paragraph.
      out.push(`<p dir="auto">${renderInline(lines[i] || "")}</p>`);
      i++;
      continue;
    }

    const joined = paragraph
      .map((l, index) => (index < paragraph.length - 1 && / {2}$/.test(l) ? `${l}<br />` : l))
      .join(" ");
    out.push(`<p dir="auto">${renderInline(joined)}</p>`);
  }

  return out.join("");
}

/* ------------------------------------------------------------------ */
/* Plain text (read aloud, copy fallbacks)                             */
/* ------------------------------------------------------------------ */

export function plainText(markdown) {
  return String(markdown ?? "")
    .replace(/```[\s\S]*?```/g, (block) =>
      block.replace(/^```[^\n]*\n?/, "").replace(/```$/, "")
    )
    .replace(/\$\$([\s\S]*?)\$\$/g, "$1")
    .replace(/\\\[([\s\S]*?)\\\]/g, "$1")
    .replace(/\\\(([\s\S]*?)\\\)/g, "$1")
    .replace(/\$([^$\n]+?)\$/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/[*_]([^*_]+)[*_]/g, "$1")
    .replace(/^\s*\|.*\|\s*$/gm, (row) =>
      row.includes("---")
        ? ""
        : row
            .replace(/^\s*\|/, "")
            .replace(/\|\s*$/, "")
            .replace(/\s*\|\s*/g, " — ")
    )
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, "")
    .replace(/^[ \t]*>[ \t]?/gm, "")
    .replace(/^[ \t]*[-*+][ \t]+/gm, "")
    .replace(/^[ \t]*\d+[.)][ \t]+/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
