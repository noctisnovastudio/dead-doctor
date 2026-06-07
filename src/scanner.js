/**
 * scanner.js — dead-doctor
 * Finds dead code, ghost pages, unused exports/imports, zombie dependencies,
 * and commented-out code blocks in TypeScript / Next.js projects.
 */

import { Project, SyntaxKind } from "ts-morph";
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Penalty constants
// ---------------------------------------------------------------------------

const PENALTY_UNUSED_EXPORT      = 5;   // per unused exported symbol
const PENALTY_UNUSED_IMPORT      = 3;   // per file with unused imports
const PENALTY_DEAD_PAGE          = 8;   // per unreferenced Next.js page
const PENALTY_EMPTY_FILE         = 3;   // per effectively-empty source file
const PENALTY_ZOMBIE_DEP         = 5;   // per package.json dep never imported
const PENALTY_COMMENT_BLOCK      = 2;   // per large commented-out code block
const PENALTY_UNREACHABLE_CODE   = 5;   // per function with unreachable code

const REPORT_FILE = "./.dead-doctor-report.json";

// ---------------------------------------------------------------------------
// Skip patterns — directories and files to exclude from scanning
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set([
  "node_modules", "dist", ".next", ".nuxt", "out", ".git",
  ".turbo", "coverage", ".nyc_output", "storybook-static",
  "__generated__", ".cache",
]);

const SKIP_FILES = /\.(d\.ts|min\.js|map)$/;

/** Files that are intentionally entry-points and may export without local consumers. */
const BARREL_FILE_PATTERN = /\/(index|main|entry|exports)\.[tj]sx?$/;

/** Files where dead exports are expected (e.g. lib entrypoints, config files). */
const ALLOWED_DEAD_EXPORT_DIRS = [
  /\/lib\//,
  /\/utils\//,
  /\/helpers\//,
  /\/hooks\//,
  /\/contexts?\//,
  /\/providers?\//,
  /\/config\//,
  /\/constants?\//,
  /\/types?\//,
];

/** Packages that are used at runtime/build without explicit import statements. */
const IMPLICIT_DEP_PATTERNS = new Set([
  // Runtime / framework
  "next", "react", "react-dom", "@types/react", "@types/react-dom",
  "@types/node", "typescript",
  // Config-only tools
  "eslint", "prettier", "jest", "vitest", "playwright", "cypress",
  "postcss", "autoprefixer", "tailwindcss",
  // Build / bundlers
  "webpack", "vite", "turbopack", "esbuild", "rollup",
  // Next.js plugins
  "@next/bundle-analyzer", "@next/eslint-plugin-next",
  // Prisma (used via CLI, not just imports)
  "prisma",
  // Patch packages
  "patch-package",
]);

/** Minimum consecutive commented lines to flag as a dead comment block. */
const COMMENT_BLOCK_MIN_LINES = 8;

// ---------------------------------------------------------------------------
// File collection
// ---------------------------------------------------------------------------

export function collectSourceFiles(rootPath) {
  const results = [];
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(full);
      } else if (e.isFile() && /\.[tj]sx?$/.test(e.name) && !SKIP_FILES.test(e.name)) {
        results.push(full);
      }
    }
  }
  walk(path.resolve(rootPath));
  return results;
}

function norm(p_) { return p_.replace(/\\/g, "/"); }

function trimSnippet(text) {
  const first = text.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  return first.length > 110 ? first.slice(0, 107) + "..." : first;
}

// ---------------------------------------------------------------------------
// Rule 1 — Unused Exports
// ---------------------------------------------------------------------------

/**
 * Finds exported symbols that are never imported anywhere else in the project.
 *
 * Algorithm:
 *  1. Build a map: filePath → [ exportedName, ... ]
 *  2. Build a flat set of every imported binding name across all files
 *  3. Flag exported names missing from the import set
 *
 * False-positive mitigations:
 *  - Barrel files (index.ts) are skipped — they exist to re-export
 *  - Default exports are skipped — too many valid patterns (Next.js pages, etc.)
 *  - Type-only exports are skipped — used by the compiler, not at runtime
 *  - Files in known library dirs (lib/, utils/, hooks/) are skipped
 *  - Names starting with underscore are conventionally "intentionally unused"
 *
 * @param {string} projectPath
 * @returns {Promise<object[]>}
 */
export async function scanUnusedExports(projectPath) {
  const issues = [];
  const resolvedPath = path.resolve(projectPath);
  const files = collectSourceFiles(resolvedPath);

  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    compilerOptions: { allowJs: true, noEmit: true },
  });

  // Phase 1: collect all exports and all imports
  const exportMap  = new Map(); // filePath → [{ name, line }]
  const importedNames = new Set();

  for (const filePath of files) {
    let sf;
    try { sf = project.addSourceFileAtPath(filePath); } catch { continue; }

    // Collect all imported binding names
    for (const imp of sf.getImportDeclarations()) {
      for (const spec of imp.getNamedImports()) {
        importedNames.add(spec.getName());
        // Also add the alias if present
        const alias = spec.getAliasNode();
        if (alias) importedNames.add(alias.getText());
      }
      const defImport = imp.getDefaultImport();
      if (defImport) importedNames.add(defImport.getText());
      const nsImport = imp.getNamespaceImport();
      if (nsImport) importedNames.add(nsImport.getText());
    }

    // Collect all named exports (skip defaults + barrels + lib dirs)
    const relFile = norm(path.relative(resolvedPath, filePath));
    if (BARREL_FILE_PATTERN.test(norm(filePath))) continue;
    if (ALLOWED_DEAD_EXPORT_DIRS.some((r) => r.test(norm(filePath)))) continue;

    const fileExports = [];

    for (const decl of sf.getExportedDeclarations()) {
      const name = decl[0];
      if (name === "default") continue;
      if (name.startsWith("_")) continue;
      // Skip type aliases and interfaces — consumed by TypeScript compiler, not always imported at runtime
      const declNodes = decl[1];
      if (declNodes.some((n) =>
        n.getKind() === SyntaxKind.TypeAliasDeclaration ||
        n.getKind() === SyntaxKind.InterfaceDeclaration
      )) continue;

      const line = declNodes[0]?.getStartLineNumber?.() ?? 0;
      fileExports.push({ name, line });
    }

    if (fileExports.length > 0) {
      exportMap.set(filePath, { relFile, exports: fileExports });
    }

    project.removeSourceFile(sf);
  }

  // Phase 2: cross-reference — flag exports with no matching import
  for (const [filePath, { relFile, exports: fileExports }] of exportMap) {
    for (const { name, line } of fileExports) {
      if (!importedNames.has(name)) {
        issues.push({
          type: "Unused Export",
          rule: "unused-export",
          severity: "warning",
          file: relFile,
          line,
          snippet: `export { ${name} }`,
          message: `\`${name}\` is exported but never imported anywhere in the project — remove it or it will bloat your bundle.`,
          docs: "https://noctisnova.com/tools/dead-doctor/dead-code-guide",
          penalty: PENALTY_UNUSED_EXPORT,
        });
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Rule 2 — Unused Imports
// ---------------------------------------------------------------------------

/**
 * Finds import statements where the imported binding is never referenced in
 * the file body. Uses a simple text-search heuristic (fast, low false-positives).
 *
 * @param {string} projectPath
 * @returns {Promise<object[]>}
 */
export async function scanUnusedImports(projectPath) {
  const issues = [];
  const resolvedPath = path.resolve(projectPath);
  const files = collectSourceFiles(resolvedPath);

  for (const filePath of files) {
    let source;
    try { source = fs.readFileSync(filePath, "utf-8"); } catch { continue; }

    const lines = source.split("\n");
    const relFile = norm(path.relative(resolvedPath, filePath));
    const unusedNames = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Only look at import lines
      if (!/^\s*import\s/.test(line) && !(i > 0 && /^\s*(from\s+['"`]|{|\w)/.test(line) && /^\s*import\s/.test(lines[i - 1]))) continue;

      // Extract named imports: import { Foo, Bar as Baz } from '...'
      const namedMatch = line.match(/\{\s*([^}]+)\s*\}/);
      if (!namedMatch) continue;

      const specifiers = namedMatch[1].split(",").map((s) => s.trim());

      for (const spec of specifiers) {
        if (!spec) continue;
        // "Bar as Baz" → local binding is Baz
        const parts = spec.split(/\s+as\s+/);
        const localName = (parts[1] ?? parts[0]).trim();
        if (!localName || localName.startsWith("_")) continue;

        // Count occurrences of localName in the entire file outside the import line
        const bodyWithoutImportLine = lines
          .filter((_, idx) => idx !== i)
          .join("\n");

        // Word-boundary check to avoid partial matches
        const usageRe = new RegExp(`(?<![a-zA-Z0-9_$])${localName}(?![a-zA-Z0-9_$])`, "g");
        const usages = [...bodyWithoutImportLine.matchAll(usageRe)];

        // If 0 usages in the rest of the file, it's unused
        if (usages.length === 0) {
          unusedNames.push({ name: localName, line: i + 1 });
        }
      }
    }

    if (unusedNames.length > 0) {
      // Report the first unused import per file to avoid noise
      const first = unusedNames[0];
      issues.push({
        type: "Unused Import",
        rule: "unused-import",
        severity: "info",
        file: relFile,
        line: first.line,
        snippet: `import { ${unusedNames.map((u) => u.name).join(", ")} } from '...'`,
        message:
          `${unusedNames.length} unused import${unusedNames.length !== 1 ? "s" : ""}: ${unusedNames.map((u) => `\`${u.name}\``).join(", ")}. ` +
          "Unused imports increase bundle parse time and make the file harder to read.",
        docs: "https://noctisnova.com/tools/dead-doctor/dead-code-guide",
        penalty: PENALTY_UNUSED_IMPORT,
        extra: unusedNames,
      });
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Rule 3 — Dead / Ghost Pages (Next.js App Router)
// ---------------------------------------------------------------------------

/**
 * Finds Next.js App Router pages (app/[**]/page.tsx) that are never linked to
 * anywhere in the codebase via <Link href="...">, router.push(), redirect(), or
 * plain href attributes.
 *
 * Routes with dynamic segments ([param]) are excluded — their links are
 * typically built at runtime and can't be statically detected.
 *
 * @param {string} projectPath
 * @returns {Promise<object[]>}
 */
export async function scanDeadPages(projectPath) {
  const issues = [];
  const resolvedPath = path.resolve(projectPath);
  const files = collectSourceFiles(resolvedPath);

  // Collect all page files and derive their route paths
  const PAGE_RE = /\/app(\/[^/]+)*\/page\.[tj]sx?$/;
  const pageFiles = files.filter((f) => PAGE_RE.test(norm(f)));

  if (pageFiles.length === 0) return issues;

  // Derive the route path from the file path
  // e.g. app/about/page.tsx → /about
  //      app/blog/[slug]/page.tsx → /blog/[slug]  (dynamic — skip)
  //      app/page.tsx → /
  function deriveRoute(filePath) {
    const rel = norm(path.relative(resolvedPath, filePath));
    // Strip leading app/ and trailing /page.ext
    const stripped = rel
      .replace(/^(src\/)?app\//, "")
      .replace(/\/page\.[tj]sx?$/, "")
      .replace(/\/\(.*?\)\//g, "/") // strip route groups like (marketing)
      .replace(/^$/, "/");
    return "/" + stripped.replace(/\/$/, "");
  }

  // Build the set of all referenced href strings in the codebase
  const allSource = files
    .filter((f) => !PAGE_RE.test(norm(f))) // exclude the page files themselves
    .map((f) => { try { return fs.readFileSync(f, "utf-8"); } catch { return ""; } })
    .join("\n");

  // Extract all string literals that look like route paths from href/push/redirect
  const hrefPattern = /(?:href|push|replace|redirect|to)\s*[=:]\s*['"`]([^'"`\n]+)['"`]/g;
  const referencedRoutes = new Set();
  for (const m of allSource.matchAll(hrefPattern)) {
    // Normalize: strip query strings and hash
    const route = m[1].split("?")[0].split("#")[0];
    referencedRoutes.add(route.endsWith("/") && route !== "/" ? route.slice(0, -1) : route);
  }

  for (const filePath of pageFiles) {
    const route = deriveRoute(filePath);
    const relFile = norm(path.relative(resolvedPath, filePath));

    // Skip dynamic routes — [param] or [...param] — too many false positives
    if (/\[/.test(route)) continue;

    // The root page / is always reachable
    if (route === "/" || route === "") continue;

    if (!referencedRoutes.has(route)) {
      issues.push({
        type: "Dead Page",
        rule: "dead-page",
        severity: "warning",
        file: relFile,
        line: 1,
        snippet: `Route: ${route}`,
        message:
          `The page at \`${route}\` exists but is never linked to from anywhere in the codebase. ` +
          "It's either forgotten, replaced, or an orphan left from a refactor.",
        docs: "https://noctisnova.com/tools/dead-doctor/dead-code-guide",
        penalty: PENALTY_DEAD_PAGE,
      });
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Rule 4 — Empty / Hollow Files
// ---------------------------------------------------------------------------

/**
 * Finds source files that are effectively empty:
 *  - File has no exports, no class declarations, no side-effect calls
 *  - Only contains import statements with nothing else
 *  - Literally blank or near-blank
 *
 * @param {string} projectPath
 * @returns {Promise<object[]>}
 */
export async function scanEmptyFiles(projectPath) {
  const issues = [];
  const resolvedPath = path.resolve(projectPath);
  const files = collectSourceFiles(resolvedPath);

  for (const filePath of files) {
    let source;
    try { source = fs.readFileSync(filePath, "utf-8"); } catch { continue; }
    const relFile = norm(path.relative(resolvedPath, filePath));

    // Strip all comments and whitespace
    const stripped = source
      .replace(/\/\/[^\n]*/g, "")    // single-line comments
      .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
      .replace(/\s+/g, " ")
      .trim();

    // Under 30 meaningful characters — likely empty
    if (stripped.length < 30) {
      issues.push({
        type: "Empty File",
        rule: "empty-file",
        severity: "info",
        file: relFile,
        line: 1,
        snippet: source.slice(0, 80).trim() || "(empty)",
        message:
          `\`${path.basename(filePath)}\` is effectively empty (${stripped.length} chars of real code). ` +
          "It's dead weight — remove it or add the missing implementation.",
        docs: "https://noctisnova.com/tools/dead-doctor/dead-code-guide",
        penalty: PENALTY_EMPTY_FILE,
      });
      continue;
    }

    // File has only import statements and nothing else (no exports, no expressions)
    const linesArr = source.split("\n").map((l) => l.trim()).filter((l) => l.length > 0 && !l.startsWith("//"));
    const nonImportLines = linesArr.filter(
      (l) => !l.startsWith("import ") && !l.startsWith("import{") && !l.startsWith("from ") && l !== "{"  && l !== "}"
    );

    if (nonImportLines.length === 0 && linesArr.length > 0) {
      issues.push({
        type: "Empty File",
        rule: "empty-file",
        severity: "info",
        file: relFile,
        line: 1,
        snippet: `${linesArr.length} import statement${linesArr.length !== 1 ? "s" : ""} — no exports, no code`,
        message:
          `\`${path.basename(filePath)}\` only contains import statements — no exports, no logic, no side effects. ` +
          "It does nothing and can be removed.",
        docs: "https://noctisnova.com/tools/dead-doctor/dead-code-guide",
        penalty: PENALTY_EMPTY_FILE,
      });
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Rule 5 — Zombie Dependencies (package.json deps never imported)
// ---------------------------------------------------------------------------

/**
 * Reads package.json and finds dependencies in `dependencies` (not devDependencies)
 * that are never imported in any source file in the project.
 *
 * Packages in IMPLICIT_DEP_PATTERNS are excluded (Next.js, TypeScript, ESLint, etc.)
 * which are used via config or CLI rather than import statements.
 *
 * @param {string} projectPath
 * @returns {Promise<object[]>}
 */
export async function scanZombieDependencies(projectPath) {
  const issues = [];
  const resolvedPath = path.resolve(projectPath);

  // Read package.json
  const pkgPath = path.join(resolvedPath, "package.json");
  if (!fs.existsSync(pkgPath)) return issues;

  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")); } catch { return issues; }

  const deps = Object.keys(pkg.dependencies ?? {});
  if (deps.length === 0) return issues;

  // Collect all source text in one pass
  const files = collectSourceFiles(resolvedPath);
  const allImports = [];

  for (const filePath of files) {
    let src;
    try { src = fs.readFileSync(filePath, "utf-8"); } catch { continue; }

    // Extract all import/require sources
    const importMatches = [
      ...src.matchAll(/from\s+['"`]([^'"`\n]+)['"`]/g),
      ...src.matchAll(/require\s*\(\s*['"`]([^'"`\n]+)['"`]\s*\)/g),
      ...src.matchAll(/import\s*\(\s*['"`]([^'"`\n]+)['"`]\s*\)/g),
    ];

    for (const m of importMatches) {
      const importPath = m[1];
      // Extract the package name (strip subpath: '@scope/pkg/deep' → '@scope/pkg', 'pkg/sub' → 'pkg')
      const pkg_ = importPath.startsWith("@")
        ? importPath.split("/").slice(0, 2).join("/")
        : importPath.split("/")[0];
      allImports.push(pkg_);
    }
  }

  const importedSet = new Set(allImports);

  for (const dep of deps) {
    // Skip implicit deps (framework, build tools, type packages)
    if (IMPLICIT_DEP_PATTERNS.has(dep)) continue;
    if (dep.startsWith("@types/")) continue;

    if (!importedSet.has(dep)) {
      issues.push({
        type: "Zombie Dependency",
        rule: "zombie-dep",
        severity: "warning",
        file: "package.json",
        line: 1,
        snippet: `"${dep}": "${pkg.dependencies[dep]}"`,
        message:
          `\`${dep}\` is in your dependencies but never imported in any source file. ` +
          "Remove it to reduce install size, audit surface, and CI time.",
        docs: "https://noctisnova.com/tools/dead-doctor/advanced-reachability-and-cleanup",
        penalty: PENALTY_ZOMBIE_DEP,
      });
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Rule 6 — Large Commented-Out Code Blocks
// ---------------------------------------------------------------------------

/**
 * Finds blocks of consecutive comment lines that likely represent commented-out
 * code rather than documentation. Flags blocks of COMMENT_BLOCK_MIN_LINES or more.
 *
 * Heuristics for "looks like code, not a doc comment":
 *  - Contains `{`, `}`, `(`, `)`, `=>`, `const `, `return `, `await `, etc.
 *  - NOT a JSDoc block (starts with /**, used for function docs)
 *
 * @param {string} projectPath
 * @returns {Promise<object[]>}
 */
export async function scanCommentedCodeBlocks(projectPath) {
  const issues = [];
  const resolvedPath = path.resolve(projectPath);
  const files = collectSourceFiles(resolvedPath);

  /** True when a stripped comment line looks like commented-out code, not setup/docs prose. */
  function commentLineLooksLikeCode(body) {
    const t = body.trim();
    if (!t) return false;
    // Deployment / documentation prose (common in public/ config templates)
    if (/^(this file|in |then |under |note:|todo:|fixme:|see |environment variables)/i.test(t)) return false;
    if (/^[-*•]\s/.test(t)) return false;
    if (/^(amplify|vercel|netlify|docker|kubernetes)\b/i.test(t)) return false;

    if (/^(const|let|var|return|await|async|if|else|for|while|function|class|import|export)\b/.test(t)) return true;
    if (/^\w+\s*\([^)]*\)\s*\{/.test(t)) return true;
    if (/=>/.test(t) && !/\becho\b/i.test(t)) return true;
    if (/;\s*$/.test(t) && /=/.test(t) && !/\becho\b/i.test(t)) return true;
    return false;
  }

  function blockLooksLikeCommentedCode(blockLines) {
    return blockLines.some((line) => commentLineLooksLikeCode(line));
  }

  for (const filePath of files) {
    let source;
    try { source = fs.readFileSync(filePath, "utf-8"); } catch { continue; }
    const relFile = norm(path.relative(resolvedPath, filePath));
    const lines = source.split("\n");

    let blockStart = -1;
    let blockLines = [];
    let inJsDoc = false;

    function flushBlock(endLine) {
      if (blockLines.length < COMMENT_BLOCK_MIN_LINES) {
        blockStart = -1; blockLines = []; return;
      }
      const isCode = blockLooksLikeCommentedCode(blockLines);
      if (isCode && !inJsDoc) {
        issues.push({
          type: "Commented Code Block",
          rule: "comment-block",
          severity: "info",
          file: relFile,
          line: blockStart + 1,
          snippet: trimSnippet(blockLines[0]),
          message:
            `${blockLines.length}-line block of commented-out code starting at line ${blockStart + 1}. ` +
            "Commented-out code is never run, confuses readers, and adds noise to diffs. Delete it — git has the history.",
          docs: "https://noctisnova.com/tools/dead-doctor/dead-code-guide",
          penalty: PENALTY_COMMENT_BLOCK,
        });
      }
      blockStart = -1; blockLines = []; inJsDoc = false;
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      const isSingleLineComment = line.startsWith("//");
      const isBlockCommentStart = line.startsWith("/*");
      const isBlockCommentEnd   = line.endsWith("*/");
      const isJsDocStart        = line.startsWith("/**");

      if (isSingleLineComment || isBlockCommentStart) {
        if (blockStart === -1) {
          blockStart = i;
          inJsDoc = isJsDocStart;
        }
        blockLines.push(line.replace(/^\/\/\s?|^\/\*+\s?|\s?\*+\/$|^\*\s?/g, ""));
        if (isBlockCommentEnd && isBlockCommentStart && !isSingleLineComment) {
          flushBlock(i);
        }
      } else if (line.startsWith("*")) {
        // Inside a block comment
        if (blockStart !== -1) {
          blockLines.push(line.replace(/^\*+\s?/g, ""));
          if (isBlockCommentEnd) flushBlock(i);
        }
      } else {
        flushBlock(i);
      }
    }
    flushBlock(lines.length);
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Rule 7 — Unreachable Code
// ---------------------------------------------------------------------------

/**
 * Finds statements that appear after an unconditional return, throw,
 * continue, or break in a function body.
 *
 * @param {string} projectPath
 * @returns {Promise<object[]>}
 */
export async function scanUnreachableCode(projectPath) {
  const issues = [];
  const resolvedPath = path.resolve(projectPath);
  const files = collectSourceFiles(resolvedPath);

  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    compilerOptions: { allowJs: true, noEmit: true },
  });

  const TERMINAL_KINDS = new Set([
    SyntaxKind.ReturnStatement,
    SyntaxKind.ThrowStatement,
    SyntaxKind.BreakStatement,
    SyntaxKind.ContinueStatement,
  ]);

  for (const filePath of files) {
    let sf;
    try { sf = project.addSourceFileAtPath(filePath); } catch { continue; }

    const relFile = norm(path.relative(resolvedPath, filePath));

    // Walk all function-like nodes
    const fnNodes = [
      ...sf.getFunctions(),
      ...sf.getDescendantsOfKind(SyntaxKind.ArrowFunction),
      ...sf.getDescendantsOfKind(SyntaxKind.MethodDeclaration),
      ...sf.getDescendantsOfKind(SyntaxKind.FunctionExpression),
    ];

    for (const fn of fnNodes) {
      const body = fn.getBody?.();
      if (!body) continue;

      const stmts = body.getKind?.() === SyntaxKind.Block
        ? body.getStatements?.() ?? []
        : [];

      for (let i = 0; i < stmts.length - 1; i++) {
        const stmt = stmts[i];
        if (!TERMINAL_KINDS.has(stmt.getKind())) continue;

        // There's at least one statement after a terminal
        const deadStmt = stmts[i + 1];
        const line = sf.getLineAndColumnAtPos(deadStmt.getStart()).line;
        const snippet = trimSnippet(deadStmt.getText());

        issues.push({
          type: "Unreachable Code",
          rule: "unreachable-code",
          severity: "warning",
          file: relFile,
          line,
          snippet,
          message:
            `Code after \`${stmt.getKindName().replace("Statement", "").toLowerCase()}\` — ` +
            `\`${snippet}\` and everything below it in this block will never execute.`,
          docs: "https://noctisnova.com/tools/dead-doctor/advanced-reachability-and-cleanup",
          penalty: PENALTY_UNREACHABLE_CODE,
        });

        break; // one flag per function — avoid flooding
      }
    }

    project.removeSourceFile(sf);
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Helpers — size analysis
// ---------------------------------------------------------------------------

/**
 * Computes total project source size in KB (excluding node_modules and .next).
 */
export function computeProjectSize(projectPath) {
  const files = collectSourceFiles(path.resolve(projectPath));
  let totalBytes = 0;
  for (const f of files) {
    try { totalBytes += fs.statSync(f).size; } catch { /* skip */ }
  }
  return { files: files.length, kb: Math.round(totalBytes / 1024) };
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

/**
 * Runs all dead-code scanners and writes the report file.
 *
 * @param {object} opts
 * @param {string} opts.projectPath
 * @returns {Promise<{ issues, totalPenalty, score, stats }>}
 */
export async function runAllScans({ projectPath }) {
  const [
    unusedExportIssues,
    unusedImportIssues,
    deadPageIssues,
    emptyFileIssues,
    zombieDepIssues,
    commentBlockIssues,
    unreachableIssues,
  ] = await Promise.all([
    scanUnusedExports(projectPath),
    scanUnusedImports(projectPath),
    scanDeadPages(projectPath),
    scanEmptyFiles(projectPath),
    scanZombieDependencies(projectPath),
    scanCommentedCodeBlocks(projectPath),
    scanUnreachableCode(projectPath),
  ]);

  const issues = [
    ...unusedExportIssues,
    ...unusedImportIssues,
    ...deadPageIssues,
    ...emptyFileIssues,
    ...zombieDepIssues,
    ...commentBlockIssues,
    ...unreachableIssues,
  ];

  const totalPenalty = issues.reduce((s, i) => s + i.penalty, 0);
  const score = Math.max(0, 100 - totalPenalty);
  const stats = computeProjectSize(projectPath);

  const report = {
    generatedAt: new Date().toISOString(),
    projectPath: path.resolve(projectPath),
    score,
    totalPenalty,
    issueCount: issues.length,
    stats,
    issues,
  };

  try {
    fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2), "utf-8");
  } catch { /* non-fatal */ }

  return { issues, totalPenalty, score, stats };
}
