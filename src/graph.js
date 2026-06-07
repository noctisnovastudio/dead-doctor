/**
 * graph.js — dead-doctor
 *
 * The advanced reachability engine. Builds a real import graph (resolving
 * relative imports, tsconfig path aliases, and baseUrl), tracks which named
 * symbols cross each edge, then proves what's actually dead:
 *
 *   • dead-file        — file UNREACHABLE from any entry point (whole dead islands,
 *                        not just files with zero importers)
 *   • unused-export    — a SPECIFIC exported symbol no resolved importer consumes
 *                        (precise per-symbol, not a global name guess)
 *   • duplicate-file   — byte-for-byte (whitespace-normalised) identical modules
 *
 * Entry points (pages, routes, layouts, middleware, config, tests, package.json
 * main/bin) seed a reachability walk. Anything the walk can't reach is dead.
 *
 * No third-party parser — fast, tolerant regex extraction + disk-truth resolution.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Penalties + thresholds
// ---------------------------------------------------------------------------

const PENALTY_DEAD_FILE      = 6;
const PENALTY_UNUSED_EXPORT  = 5;
const PENALTY_DUPLICATE_FILE = 4;

const DUPLICATE_MIN_CHARS = 160;   // ignore tiny files for dup detection
const EMPTY_CONTENT_CHARS = 30;    // below this → treated as empty (handled elsewhere)
const MAX_DEAD_FILES_REPORTED = 60;

const SKIP_DIRS = new Set([
  "node_modules", ".next", ".nuxt", ".git", "dist", "out", ".turbo",
  "coverage", ".nyc_output", "storybook-static", ".cache",
  "__generated__", ".vercel", ".husky",
]);

const SOURCE_EXT  = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const RESOLVE_EXT = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".d.ts"];

const norm = (p) => p.replace(/\\/g, "/");

// ---------------------------------------------------------------------------
// Entry-point detection (reachability roots)
// ---------------------------------------------------------------------------

// Next.js App Router special files (within app/)
const APP_SPECIAL = new Set([
  "page", "layout", "loading", "error", "not-found", "template", "default",
  "global-error", "route", "sitemap", "robots", "manifest", "head",
  "opengraph-image", "twitter-image", "icon", "apple-icon", "favicon",
]);

// Root-level convention files (anywhere)
const ROOT_ENTRY_BASENAMES = new Set([
  "middleware", "instrumentation", "_app", "_document", "_error",
]);

const CONFIG_FILE_RE = /\.config\.[mc]?[jt]sx?$|(^|\/)(next|tailwind|postcss|jest|vitest|playwright|cypress|eslint|prettier|vite|drizzle|svelte|astro|remix|babel|rollup|webpack)\.config\./;
const TEST_FILE_RE   = /\.(test|spec|stories|story|bench)\.[tj]sx?$/;
const ENTRY_DIR_RE   = /(^|\/)(pages|scripts|bin)\//;

function basenameNoExt(rel) {
  return path.basename(rel).replace(/\.(d\.ts|[tj]sx?|mjs|cjs)$/, "");
}

function isEntryRoot(rel) {
  const r = "/" + rel;
  const base = basenameNoExt(rel);

  if (ROOT_ENTRY_BASENAMES.has(base)) return true;
  if (CONFIG_FILE_RE.test(rel)) return true;
  if (TEST_FILE_RE.test(rel)) return true;
  if (ENTRY_DIR_RE.test(r)) return true;                 // pages/**, scripts/**, bin/**
  // App Router special files only (not every file under app/)
  if (/(^|\/)app\//.test(r) && APP_SPECIAL.has(base)) return true;
  if (/(^|\/)src\/app\//.test(r) && APP_SPECIAL.has(base)) return true;
  return false;
}

const HTML_SKIP = new Set(["node_modules", ".git", "dist", "out", ".next"]);
const VITE_INTERNAL_RE = /^\/@|^https?:\/\/|^\/\/|^\{/; // @vite/client, CDN, %PUBLIC_URL%

/**
 * Resolve a <script src="..."> from an HTML file to a source file on disk.
 * Handles Vite-style absolute paths (/app.jsx) and public/ assets (/config.js → public/config.js).
 */
function resolveHtmlScriptSrc(spec, htmlPath, projectRoot, fileSet) {
  if (!spec || VITE_INTERNAL_RE.test(spec)) return null;

  const candidates = [];
  if (spec.startsWith("/")) {
    const rootRel = spec.slice(1);
    candidates.push(path.join(projectRoot, rootRel));
    candidates.push(path.join(projectRoot, "public", rootRel));
  } else {
    candidates.push(path.resolve(path.dirname(htmlPath), spec));
  }

  for (const cand of candidates) {
    const hit = tryResolveFile(cand, fileSet);
    if (hit) return hit;
  }
  return null;
}

/**
 * Parse <script src> tags in HTML files and return resolved module/script entry points.
 */
function discoverHtmlEntries(projectRoot, fileSet) {
  const entries = new Set();
  const htmlFiles = [];

  function walkHtml(dir) {
    let list;
    try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!HTML_SKIP.has(e.name)) walkHtml(full);
      } else if (e.isFile() && e.name.endsWith(".html")) {
        htmlFiles.push(full);
      }
    }
  }
  walkHtml(projectRoot);

  for (const htmlPath of htmlFiles) {
    let content = "";
    try { content = fs.readFileSync(htmlPath, "utf-8"); } catch { continue; }

    for (const m of content.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
      const hit = resolveHtmlScriptSrc(m[1], htmlPath, projectRoot, fileSet);
      if (hit) entries.add(hit);
    }
  }
  return entries;
}

/**
 * Read vite.config.* rollup input entries (and recurse into index.html inputs).
 */
function discoverViteConfigEntries(projectRoot, fileSet) {
  const entries = new Set();
  const names = ["vite.config.ts", "vite.config.js", "vite.config.mts", "vite.config.mjs", "vite.config.cts", "vite.config.cjs"];

  const addSpec = (spec) => {
    if (!spec || VITE_INTERNAL_RE.test(spec)) return;
    const cleaned = spec.replace(/^\.\//, "");
    const abs = path.resolve(projectRoot, cleaned);

    if (cleaned.endsWith(".html") || abs.endsWith(".html")) {
      let content = "";
      try { content = fs.readFileSync(abs, "utf-8"); } catch { return; }
      for (const m of content.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
        const hit = resolveHtmlScriptSrc(m[1], abs, projectRoot, fileSet);
        if (hit) entries.add(hit);
      }
      return;
    }

    const hit = tryResolveFile(abs, fileSet);
    if (hit) entries.add(hit);
  };

  for (const name of names) {
    const file = path.join(projectRoot, name);
    if (!fs.existsSync(file)) continue;
    let src = "";
    try { src = fs.readFileSync(file, "utf-8"); } catch { continue; }

    for (const m of src.matchAll(/\binput\s*:\s*['"`]([^'"`]+)['"`]/g)) addSpec(m[1]);
    for (const m of src.matchAll(/\binput\s*:\s*\{([\s\S]*?)\}/g)) {
      for (const sm of m[1].matchAll(/['"`]([^'"`]+)['"`]/g)) addSpec(sm[1]);
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// File collection
// ---------------------------------------------------------------------------

export function collectSourceFiles(rootPath) {
  const out = [];
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(full);
      } else if (SOURCE_EXT.some((ext) => e.name.endsWith(ext)) && !e.name.endsWith(".d.ts")) {
        out.push(norm(full));
      }
    }
  }
  walk(path.resolve(rootPath));
  return out;
}

// ---------------------------------------------------------------------------
// tsconfig alias loading
// ---------------------------------------------------------------------------

function parseJsonc(text) {
  const noBlock = text.replace(/\/\*[\s\S]*?\*\//g, "");
  const noLine  = noBlock.replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  const noTrail = noLine.replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(noTrail);
}

function loadAliases(projectRoot) {
  for (const name of ["tsconfig.json", "jsconfig.json"]) {
    const file = path.join(projectRoot, name);
    if (!fs.existsSync(file)) continue;
    try {
      const cfg = parseJsonc(fs.readFileSync(file, "utf-8"));
      const co = cfg.compilerOptions ?? {};
      const baseUrl = norm(path.resolve(projectRoot, co.baseUrl ?? "."));
      const paths = [];
      for (const [pattern, targets] of Object.entries(co.paths ?? {})) {
        const star = pattern.indexOf("*");
        const prefix = star === -1 ? pattern : pattern.slice(0, star);
        const suffix = star === -1 ? "" : pattern.slice(star + 1);
        const absTargets = (targets ?? []).map((t) => norm(path.resolve(baseUrl, t.replace("*", "\u0000"))));
        paths.push({ prefix, suffix, hasStar: star !== -1, targets: absTargets });
      }
      return { baseUrl, paths, configFile: name };
    } catch { /* fall through */ }
  }
  return { baseUrl: path.resolve(projectRoot), paths: [], configFile: null };
}

// ---------------------------------------------------------------------------
// Import / export extraction
// ---------------------------------------------------------------------------

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
}

/**
 * Returns the dependency edges of a module:
 *   [{ spec, consumeAll:boolean, names:string[], deep:number }]
 * consumeAll = namespace import / dynamic import / require / `export *` (can't
 * track which symbols are used → mark the whole target as consumed).
 */
export function extractEdges(source) {
  const clean = stripComments(source);
  const bySpec = new Map();

  const add = (spec, { consumeAll = false, names = [] } = {}) => {
    const deepMatch = spec.match(/^(?:\.\.\/)+/);
    const deep = deepMatch ? (deepMatch[0].match(/\.\.\//g) || []).length : 0;
    const cur = bySpec.get(spec) ?? { spec, consumeAll: false, names: new Set(), deep };
    if (consumeAll) cur.consumeAll = true;
    for (const n of names) cur.names.add(n);
    bySpec.set(spec, cur);
  };

  const parseClause = (clause) => {
    const names = [];
    let consumeAll = false;
    if (/\*\s*as\s+\w+/.test(clause)) consumeAll = true;
    const named = clause.match(/\{([^}]*)\}/);
    if (named) {
      for (const part of named[1].split(",")) {
        const t = part.trim().replace(/^type\s+/, "");
        if (!t) continue;
        const orig = t.split(/\s+as\s+/)[0].trim();   // exported name = left of `as`
        if (orig) names.push(orig);
      }
    }
    // default import: a bare identifier before `,{` or `from`
    const def = clause.replace(/\{[^}]*\}/, "").replace(/\*\s*as\s+\w+/, "").split(",")[0].trim();
    if (def && /^[A-Za-z_$][\w$]*$/.test(def)) names.push("default");
    return { names, consumeAll };
  };

  // import ... from 'x'
  for (const m of clean.matchAll(/import\s+(type\s+)?([\s\S]*?)\s+from\s*['"`]([^'"`]+)['"`]/g)) {
    add(m[3], parseClause(m[2]));
  }
  // side-effect import 'x'
  for (const m of clean.matchAll(/(?:^|[\n;])\s*import\s*['"`]([^'"`]+)['"`]/g)) {
    add(m[1], {});
  }
  // dynamic import('x') / require('x')  → consume all
  for (const m of clean.matchAll(/(?:import|require)\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g)) {
    add(m[1], { consumeAll: true });
  }
  // export * from 'x'  → consume all
  for (const m of clean.matchAll(/export\s+(?:type\s+)?\*\s*(?:as\s+\w+\s*)?from\s*['"`]([^'"`]+)['"`]/g)) {
    add(m[1], { consumeAll: true });
  }
  // export { a, b as c } from 'x'  → consume those names
  for (const m of clean.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"`]([^'"`]+)['"`]/g)) {
    const names = m[1].split(",").map((s) => s.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim()).filter(Boolean);
    add(m[2], { names });
  }

  return [...bySpec.values()].map((e) => ({ ...e, names: [...e.names] }));
}

/**
 * Returns this module's OWN exported runtime symbols (excludes types, default,
 * and `export ... from` re-exports), with line numbers.
 * { names:[{name,line}], hasDefault, hasWildcard }
 */
export function extractOwnExports(source) {
  const names = [];
  let hasDefault = false, hasWildcard = false;
  const lines = source.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/^\s*export\b/.test(line)) continue;
    if (/^\s*export\s+default\b/.test(line)) { hasDefault = true; continue; }
    if (/^\s*export\s+(?:type\s+)?\*/.test(line)) { hasWildcard = true; continue; }
    if (/^\s*export\s+(?:type|interface|enum)\b/.test(line)) continue; // type-only
    if (/\bfrom\s*['"`]/.test(line) && /^\s*export\s+(?:type\s+)?\{/.test(line)) continue; // re-export (edge)

    let m;
    if ((m = line.match(/^\s*export\s+(?:async\s+)?function\s+(\w+)/))) { names.push({ name: m[1], line: i + 1 }); continue; }
    if ((m = line.match(/^\s*export\s+(?:abstract\s+)?class\s+(\w+)/)))  { names.push({ name: m[1], line: i + 1 }); continue; }
    if ((m = line.match(/^\s*export\s+(?:const|let|var)\s+(\w+)/)))      { names.push({ name: m[1], line: i + 1 }); continue; }
    if ((m = line.match(/^\s*export\s+\{([^}]*)\}\s*;?\s*$/))) {
      for (const part of m[1].split(",")) {
        const t = part.trim().replace(/^type\s+/, "");
        if (!t) continue;
        const exported = (t.split(/\s+as\s+/)[1] ?? t).trim();
        if (exported && exported !== "default") names.push({ name: exported, line: i + 1 });
      }
    }
  }
  return { names, hasDefault, hasWildcard };
}

// ---------------------------------------------------------------------------
// Import resolution
// ---------------------------------------------------------------------------

function tryResolveFile(candidateNoExt, fileSet) {
  const base = norm(candidateNoExt);
  if (fileSet.has(base)) return base;
  for (const ext of RESOLVE_EXT) if (fileSet.has(base + ext)) return base + ext;
  for (const ext of RESOLVE_EXT) if (fileSet.has(base + "/index" + ext)) return base + "/index" + ext;
  return null;
}

function resolveImport(spec, fromFile, aliases, fileSet) {
  if (spec.startsWith(".")) {
    return tryResolveFile(path.resolve(path.dirname(fromFile), spec), fileSet);
  }
  for (const a of aliases.paths) {
    if (a.hasStar) {
      if (spec.startsWith(a.prefix) && spec.endsWith(a.suffix)) {
        const middle = spec.slice(a.prefix.length, spec.length - a.suffix.length || undefined);
        for (const target of a.targets) {
          const hit = tryResolveFile(target.replace("\u0000", middle), fileSet);
          if (hit) return hit;
        }
      }
    } else if (spec === a.prefix) {
      for (const target of a.targets) { const hit = tryResolveFile(target, fileSet); if (hit) return hit; }
    }
  }
  if (aliases.baseUrl) {
    const hit = tryResolveFile(path.resolve(aliases.baseUrl, spec), fileSet);
    if (hit) return hit;
  }
  return null;
}

// ---------------------------------------------------------------------------
// package.json entry resolution
// ---------------------------------------------------------------------------

function packageEntries(projectRoot, aliases, fileSet) {
  const entries = new Set();
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf-8"));
    const specs = [];
    for (const key of ["main", "module", "browser", "types"]) if (typeof pkg[key] === "string") specs.push(pkg[key]);
    if (typeof pkg.bin === "string") specs.push(pkg.bin);
    else if (pkg.bin && typeof pkg.bin === "object") specs.push(...Object.values(pkg.bin));
    if (pkg.exports) {
      const walk = (v) => {
        if (typeof v === "string") specs.push(v);
        else if (v && typeof v === "object") Object.values(v).forEach(walk);
      };
      walk(pkg.exports);
    }
    for (const s of specs) {
      const cand = tryResolveFile(path.resolve(projectRoot, s.replace(/^\.\//, "")), fileSet);
      if (cand) entries.add(cand);
    }
  } catch { /* no package.json */ }
  return entries;
}

// ---------------------------------------------------------------------------
// Graph construction
// ---------------------------------------------------------------------------

export function buildGraph(projectPath) {
  const projectRoot = path.resolve(projectPath);
  const aliases = loadAliases(projectRoot);
  const files = collectSourceFiles(projectRoot);
  const fileSet = new Set(files);

  const nodes = new Map();

  for (const abs of files) {
    let source = "";
    try { source = fs.readFileSync(abs, "utf-8"); } catch { /* */ }
    let bytes = 0; try { bytes = fs.statSync(abs).size; } catch { /* */ }
    const rel = norm(path.relative(projectRoot, abs));
    const meaningful = source.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, "").length;
    const own = extractOwnExports(source);

    nodes.set(abs, {
      abs, rel, bytes,
      loc: source ? source.split("\n").length : 0,
      meaningful,
      isEntry: isEntryRoot(rel),
      ownExports: own.names,          // [{name,line}]
      hasWildcardReExport: own.hasWildcard,
      _source: source,
      imports: new Set(),             // resolved abs targets
      importedBy: new Set(),
      consumedNames: new Set(),       // names other modules import FROM this file
      consumedAll: false,             // someone does `import *` / dynamic / `export *`
    });
  }

  let edgeCount = 0;
  for (const node of nodes.values()) {
    for (const edge of extractEdges(node._source)) {
      const target = resolveImport(edge.spec, node.abs, aliases, fileSet);
      if (!target || target === node.abs || !nodes.has(target)) continue;
      node.imports.add(target);
      const tn = nodes.get(target);
      tn.importedBy.add(node.abs);
      if (edge.consumeAll) tn.consumedAll = true;
      for (const n of edge.names) tn.consumedNames.add(n);
      edgeCount++;
    }
  }
  for (const node of nodes.values()) delete node._source;

  // Entry set = convention entries + package.json + HTML/Vite SPA roots
  const entries = new Set();
  for (const node of nodes.values()) if (node.isEntry) entries.add(node.abs);
  for (const e of packageEntries(projectRoot, aliases, fileSet)) entries.add(e);
  for (const e of discoverHtmlEntries(projectRoot, fileSet)) entries.add(e);
  for (const e of discoverViteConfigEntries(projectRoot, fileSet)) entries.add(e);

  return { projectRoot, nodes, aliases, edgeCount, fileCount: files.length, entries };
}

// ---------------------------------------------------------------------------
// Reachability walk from entries
// ---------------------------------------------------------------------------

function computeReachable(graph) {
  const reachable = new Set();
  const queue = [...graph.entries];
  for (const e of queue) reachable.add(e);
  while (queue.length) {
    const abs = queue.shift();
    const node = graph.nodes.get(abs);
    if (!node) continue;
    for (const dep of node.imports) {
      if (!reachable.has(dep)) { reachable.add(dep); queue.push(dep); }
    }
  }
  return reachable;
}

// ---------------------------------------------------------------------------
// Rule: dead files (unreachable from any entry)
// ---------------------------------------------------------------------------

export function findDeadFiles(graph, reachable) {
  const issues = [];
  // Safety: with no detectable entries, reachability is meaningless — fall back
  // to "zero importers" orphan semantics so we never nuke a whole library.
  const noEntries = graph.entries.size === 0;

  const dead = [];
  for (const node of graph.nodes.values()) {
    if (node.isEntry) continue;
    if (node.meaningful < EMPTY_CONTENT_CHARS) continue; // empty → empty-file rule
    const isDead = noEntries
      ? (node.importedBy.size === 0 && node.ownExports.length > 0)
      : !reachable.has(node.abs);
    if (isDead) dead.push(node);
  }

  dead.sort((a, b) => b.bytes - a.bytes); // biggest space wins first

  for (const node of dead.slice(0, MAX_DEAD_FILES_REPORTED)) {
    const kb = Math.max(1, Math.round(node.bytes / 1024));
    issues.push({
      type: "Dead File",
      rule: "dead-file",
      severity: "warning",
      file: node.rel,
      line: 1,
      snippet: `${node.loc} lines · ~${kb} KB · unreachable from any entry point`,
      message:
        `\`${node.rel}\` can't be reached from any entry point (page, route, layout, index.html script, config, test, or package main) ` +
        "by following imports — nothing the app actually runs depends on it, directly or transitively. " +
        "It's dead weight that still ships, builds, and gets maintained. Confirm it's not loaded dynamically, then delete it.",
      docs: "https://noctisnova.com/tools/dead-doctor/dead-code-guide",
      penalty: PENALTY_DEAD_FILE,
      bytes: node.bytes,
    });
  }
  return { issues, deadSet: new Set(dead.map((d) => d.abs)) };
}

// ---------------------------------------------------------------------------
// Rule: precise unused exports (per-symbol, via resolved edges)
// ---------------------------------------------------------------------------

const BARREL_RE = /(^|\/)(index|main|entry|exports)\.[tj]sx?$/;

export function findUnusedExports(graph, deadSet) {
  const issues = [];
  for (const node of graph.nodes.values()) {
    if (node.isEntry) continue;            // entry exports are the public surface
    if (deadSet.has(node.abs)) continue;   // already reported as a dead file
    if (BARREL_RE.test(node.rel)) continue;// barrels exist to re-export
    if (node.consumedAll) continue;        // namespace/dynamic import — can't prove unused
    if (node.ownExports.length === 0) continue;

    for (const { name, line } of node.ownExports) {
      if (name.startsWith("_")) continue;
      if (node.consumedNames.has(name)) continue; // some resolved importer uses it

      issues.push({
        type: "Unused Export",
        rule: "unused-export",
        severity: "warning",
        file: node.rel,
        line,
        snippet: `export ${name}`,
        message:
          `\`${name}\` is exported from \`${node.rel}\` but no file that imports this module actually uses it. ` +
          "Dead exports defeat tree-shaking and bloat the bundle. Remove the export (or the whole symbol if it has no internal use).",
        docs: "https://noctisnova.com/tools/dead-doctor/dead-code-guide",
        penalty: PENALTY_UNUSED_EXPORT,
      });
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Rule: duplicate files (copy-paste modules)
// ---------------------------------------------------------------------------

export function findDuplicateFiles(graph) {
  const issues = [];
  const byHash = new Map();

  for (const node of graph.nodes.values()) {
    let src = ""; try { src = fs.readFileSync(node.abs, "utf-8"); } catch { continue; }
    const normalized = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, "");
    if (normalized.length < DUPLICATE_MIN_CHARS) continue;
    const hash = crypto.createHash("sha1").update(normalized).digest("hex");
    let arr = byHash.get(hash);
    if (!arr) { arr = []; byHash.set(hash, arr); }
    arr.push(node);
  }

  for (const group of byHash.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => a.rel.localeCompare(b.rel));
    const redundantBytes = group.slice(1).reduce((s, n) => s + n.bytes, 0);
    const others = group.slice(1).map((n) => n.rel);

    issues.push({
      type: "Duplicate File",
      rule: "duplicate-file",
      severity: "warning",
      file: group[0].rel,
      line: 1,
      snippet: `${group.length} identical copies · ~${Math.max(1, Math.round(redundantBytes / 1024))} KB redundant`,
      message:
        `\`${group[0].rel}\` is byte-for-byte identical to ${group.length - 1} other file${group.length - 1 !== 1 ? "s" : ""}: ` +
        `${others.join(", ")}. Copy-pasted modules drift out of sync and double the maintenance. ` +
        "Keep one canonical copy and import it from the others.",
      docs: "https://noctisnova.com/tools/dead-doctor/advanced-reachability-and-cleanup",
      penalty: PENALTY_DUPLICATE_FILE,
      duplicates: group.map((n) => n.rel),
      redundantBytes,
    });
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Aggregate stats + runner
// ---------------------------------------------------------------------------

export function runGraphScans(projectPath) {
  const graph = buildGraph(projectPath);
  const reachable = computeReachable(graph);

  const { issues: deadIssues, deadSet } = findDeadFiles(graph, reachable);
  const unusedExportIssues = findUnusedExports(graph, deadSet);
  const duplicateIssues = findDuplicateFiles(graph);

  // Reclaimable space: dead files + redundant duplicate copies
  let reclaimableBytes = 0;
  for (const i of deadIssues) reclaimableBytes += i.bytes ?? 0;
  for (const i of duplicateIssues) reclaimableBytes += i.redundantBytes ?? 0;

  const graphStats = {
    edges: graph.edgeCount,
    entryPoints: graph.entries.size,
    deadFiles: deadIssues.length,
    reachable: reachable.size,
    aliasConfig: graph.aliases.configFile,
    reclaimableKb: Math.round(reclaimableBytes / 1024),
  };

  return {
    issues: [...deadIssues, ...unusedExportIssues, ...duplicateIssues],
    graphStats,
  };
}
