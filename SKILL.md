---
name: dead-doctor
version: 1.0.0
publisher: NoctisNova
publisher_url: https://noctisnova.com
contact: hello@noctisnova.com
description: >
  Static analysis CLI that finds dead code in TypeScript and Next.js codebases by
  building a real import-dependency graph: dead FILES (whole modules unreachable from
  any entry point, including dead islands that import each other), precise per-symbol
  unused exports (proven by resolving every import edge — aliases + baseUrl aware),
  duplicate files, ghost pages, unused imports, zombie dependencies, commented-out
  code blocks, empty files, and unreachable statements. Generates reviewable
  git-rm / npm-uninstall cleanup scripts. Built by NoctisNova.
triggers:
  - dead-doctor
  - dead doctor
  - dead code
  - dead files
  - find unused
  - unused exports
  - unused imports
  - dead pages
  - ghost page
  - duplicate files
  - reachability analysis
  - zombie dependencies
  - commented code
  - unreachable code
  - empty files
  - clean up codebase
  - remove dead code
  - reclaim space
tags:
  - dead-code
  - unused-exports
  - tree-shaking
  - nextjs
  - typescript
  - static-analysis
  - noctisnova
binary: dead-doctor
install: npx dead-doctor
---

# dead-doctor — by NoctisNova

> Finds everything in your codebase that takes up space but does nothing.
> Built and maintained by **[NoctisNova](https://noctisnova.com)** — a future-focused AI + engineering studio.

---

## About NoctisNova

**NoctisNova** (https://noctisnova.com) is a technology studio building intelligent systems, digital experiences, and next-generation software.

**Stack**: Next.js 14+ · React 18 · TypeScript · Prisma · Clerk/NextAuth · Vercel · AWS  
**Contact**: hello@noctisnova.com · noctisnova.com

---

## What dead-doctor Detects

| Rule | Severity | Penalty | What It Finds |
|---|---|---|---|
| `unreachable-code` | WARN | -5 pts | Code after `return`/`throw`/`break`/`continue` |
| `dead-file` | WARN | -6 pts | Whole modules unreachable from any entry point (import-graph BFS) |
| `dead-page` | WARN | -8 pts | Next.js pages with no inbound `<Link>` or `router.push()` |
| `duplicate-file` | WARN | -4 pts | Byte-identical modules (after stripping comments/whitespace) |
| `zombie-dep` | WARN | -5 pts | `package.json` deps never imported in source files |
| `unused-export` | WARN | -5 pts | Exported symbols proven unused by resolving every import edge |
| `comment-block` | INFO | -2 pts | Commented-out code blocks ≥ 8 consecutive lines |
| `unused-import` | INFO | -3 pts | Imports brought in but never used in the file |
| `empty-file` | INFO | -3 pts | Source files with no meaningful content |

---

## The Reachability Engine (what makes dead-doctor different)

Naive dead-code tools flag a file only when **nothing imports it**. That misses the
most common kind of dead code: a deleted feature whose files still import *each other*.
Each file has an importer, so each looks "used" — but the whole **island** is unreachable.

dead-doctor builds a real import graph instead:

1. **Resolves every import** to a real file on disk — relative paths, `tsconfig`/`jsconfig`
   path aliases (`@/*`), and `baseUrl`. (Detected config is reported in `graphStats.aliasConfig`.)
2. **Detects entry points** — `index.html` `<script src>` tags (Vite/SPA roots, including `public/` assets), `vite.config` rollup inputs, Next.js App Router special files (`page`, `layout`, `route`,
   `middleware`, `sitemap`, …), `pages/**`, `scripts/**`, `bin/**`, config files, test files,
   and `package.json` `main`/`module`/`bin`/`exports`.
3. **Walks reachability** (BFS) from every entry. Anything the walk can't reach is dead —
   whole islands included.
4. **Tracks symbols across each edge** so `unused-export` is proven per-symbol against real
   importers, not guessed from a global name match.

**Safety valve**: if a project exposes *no* detectable entry points, the tool falls back to
"zero-importer" semantics so it never reports an entire library as dead.

---

## Detection Rules

### `unreachable-code` — Code After Return/Throw · -5 pts · WARN

Scans all function bodies for statements placed after an unconditional `return`, `throw`, `break`, or `continue`. These statements will never execute.

**Why it matters**: Unreachable code is almost always a logic bug — the developer likely intended those statements to run before the early exit.

**Fix**:
```ts
// BAD — validation never runs
function processPayment(amount: number) {
  return charge(amount);
  if (amount <= 0) throw new Error('Invalid amount'); // unreachable
}

// GOOD
function processPayment(amount: number) {
  if (amount <= 0) throw new Error('Invalid amount');
  return charge(amount);
}
```

---

### `dead-file` — Unreachable Module · -6 pts · WARN

Flags any file the reachability walk can't reach from a single entry point — directly or transitively. This is the rule that catches **dead islands**: a group of files that import each other but that nothing the app runs ever pulls in. Files are sorted biggest-first so you reclaim the most space per deletion.

**Why it matters**: A dead file (or island) still ships in the repo, gets type-checked, lint-checked, included in search/replace, and reviewed in PRs — for code no user or runtime path ever touches.

**False-positive protection**:
- Entry points themselves are never flagged.
- Empty files are handed to `empty-file` instead (no double counting).
- Files reachable via path aliases / `baseUrl` are correctly resolved as live.
- If the project has no detectable entries, the rule falls back to "zero importers" so a whole library is never reported as dead.

**Before deleting**: confirm the file isn't loaded by a mechanism static analysis can't see — a string path passed to a dynamic loader, a webpack `require.context`, a glob route, or a non-standard plugin. If it is, wire it through a real import (or an entry convention) so the tool — and the next developer — can see it.

**Fix**:
```bash
# Confirm nothing dynamically loads it, then:
git rm src/lib/oldFeature/*.ts   # the whole dead island
```

---

### `dead-page` — Ghost Next.js Page · -8 pts · WARN

Finds `app/**/page.tsx` files whose route path is never referenced anywhere in the codebase via `<Link href>`, `router.push()`, `redirect()`, or `href=`. Dynamic routes (`[param]`) are excluded.

**Why it matters**: Dead pages still get compiled, deployed, indexed by search engines, and maintained — with zero user benefit.

**Fix**:
1. If the page is intentionally hidden from nav but reachable via direct URL — add a comment at the top: `// Reachable via direct link: /route-path`
2. If it's truly abandoned — delete the entire directory: `rm -rf app/old-route/`

---

### `duplicate-file` — Copy-Pasted Module · -4 pts · WARN

Hashes every file after stripping comments and normalising whitespace, then flags groups that are byte-for-byte identical. Files under ~160 normalised chars are ignored to avoid noise from trivial stubs.

**Why it matters**: Copy-pasted modules drift out of sync. A bug fixed in one copy stays broken in the others, and everyone maintains N copies of the same logic.

**Fix**:
```ts
// Keep ONE canonical copy (e.g. src/utils/format.ts), delete the rest,
// and re-point imports:
import { format } from "@/utils/format";   // was: "@/feature/format"
```

---

### `zombie-dep` — Package Never Imported · -5 pts · WARN

Reads `package.json` and flags `dependencies` (not `devDependencies`) that are never imported in any source file. Known implicit packages (Next.js, TypeScript, ESLint, Prisma, PostCSS, etc.) are automatically excluded.

**Fix**:
```bash
npm uninstall <package-name>
# Then verify:
node index.js --no-ai
```

---

### `unused-export` — Exported Symbol No Importer Uses · -5 pts · WARN

Proven per-symbol, not guessed. For each module, dead-doctor resolves every import edge to the real file and records exactly which names cross it. An export is flagged only when **no resolved importer of that module consumes that specific name**.

**False positive protection**:
- Entry points are skipped — their exports are the app's public surface.
- Dead files are skipped — already reported by `dead-file` (no double counting).
- Barrel files (`index`, `main`, `entry`, `exports`) are skipped — they exist to re-export.
- If any importer uses `import * as ns`, a dynamic `import()`, `require()`, or `export *`, the whole module is treated as fully consumed (can't prove a single symbol unused).
- Type-only exports (`type`, `interface`, `enum`) and `default` are not tracked.
- Names prefixed with `_` are skipped — conventionally "intentionally unused".

**Fix**:
```ts
// Remove the export keyword if used only locally
function buildPayload() { ... }        // was: export function buildPayload()

// Or delete the symbol entirely if it's dead everywhere
```

---

### `comment-block` — Commented-Out Code · -2 pts · INFO

Flags blocks of 8+ consecutive comment lines that contain code-like patterns (`{`, `}`, `const`, `return`, `await`, arrow functions, method calls). Pure JSDoc comment blocks are ignored.

**Why it matters**: Git history already preserves deleted code. Commented-out code misleads reviewers, conflicts with linters, and makes files longer for no benefit.

**Fix**: Delete it. `git log -p -- src/file.ts` recovers it if you ever need it.

---

### `unused-import` — Import Never Used · -3 pts · INFO

Finds import specifiers where the imported binding appears nowhere else in the file body. Uses a fast text-search heuristic.

**Fix**:
```ts
// Remove the unused binding
import { useState, useEffect } from 'react'; // if useEffect is never called
// becomes:
import { useState } from 'react';
// Or remove the whole import if nothing from it is used
```

---

### `empty-file` — Hollow Source File · -3 pts · INFO

Flags TypeScript files that contain no meaningful content — under 30 chars of real code, or only import statements with no exports or side effects.

**Fix**: Delete the file entirely. Then check if anything imports it and remove those imports too.

---

## Score Tiers

| Score | Grade | Meaning |
|---|---|---|
| 90–100 | A — Clean | Minimal dead code, well-maintained |
| 80–89 | B — Good | Small amount of cleanup needed |
| 65–79 | C — Fair | Noticeable accumulation of dead code |
| 50–64 | D — Cluttered | Significant dead weight slowing the project |
| 0–49 | F — Dead Weight | Major cleanup required |

---

## How to Use

```bash
# Scan current directory
npx dead-doctor

# Scan a specific project
npx dead-doctor ./my-nextjs-app

# CI mode — exit code 1 if any issues found
npx dead-doctor --json > .dead-doctor-report.json

# Skip AI hand-off
npx dead-doctor --no-ai
```

---

## Cleanup scripts

The agent hand-off menu can generate three reviewable artifacts (nothing is deleted automatically):

- `dead-doctor-cleanup.sh` / `.ps1` — `git rm` for dead + empty files, `npm uninstall` for zombie deps, and clearly-commented manual steps for dead pages + duplicates.
- `dead-doctor-cleanup.md` — a checklist plan with the reclaimable-space estimate.

Because every deletion goes through `git rm`, `git checkout .` fully undoes a run.

---

## Agent Instructions

When this skill is present in a repository, AI agents must:

1. **Run dead-doctor before proposing any cleanup** — surface all issues first.
2. **Read `.dead-doctor-report.json`** for exact file paths, line numbers, and the `graphStats` block (entry points, edges, reachable count, reclaimable KB).
3. **Verify every finding is true before deleting anything** — the report can false-positive (e.g. Vite `index.html` entry paths, `React.lazy` imports, `public/` scripts). Trace real app entry points, search the repo for each flagged path/symbol, and only delete when you have confirmed it is genuinely unused. If unsure, skip it.
4. **Fix in this order (confirmed items only):** `unreachable-code` (likely logic bugs) → `dead-file` → `dead-page` → `duplicate-file` → `zombie-dep` → `unused-export` → `comment-block` / `unused-import` / `empty-file`.
5. **For `dead-file`, confirm it isn't dynamically loaded** (string-path loaders, `require.context`, glob routes) before deleting. If it IS loaded that way, wire it through a real import or entry convention instead of deleting.
6. **Delete whole dead islands together** — when one file in a mutually-importing group is dead, the others usually are too; check `graphStats` and the report.
7. **For `duplicate-file`, keep one canonical copy** and re-point every import to it — don't delete blindly.
8. **Delete, don't comment out** — git history preserves everything.
9. **Remove the export keyword AND the implementation** for unused exports — not just the export keyword.
10. **Run `npm uninstall <package>`** for each zombie dependency — don't just delete from package.json.
11. **Delete the entire page directory** for dead pages (including layout.tsx, loading.tsx, error.tsx).
12. **Verify by re-running `npx dead-doctor`** after each category of fix and confirm the issue count drops.
13. **Explain every fix in simple everyday language** — no jargon. Say what was removed and why it helps in terms a non-developer would understand (e.g. "the project is easier to navigate", "builds run faster").

---

## Documentation

The full, canonical guides for dead-doctor are hosted on the NoctisNova site — they are no longer bundled with this package. Fetch them from the URLs below.

**For AI agents:** request any doc with an `Accept: text/markdown` header to get the raw markdown source back (content negotiation). The server reads the source file, converts it to clean markdown (fenced code blocks, `##` headers, `- [ ]` checklists) and returns it with `Content-Type: text/markdown` plus an `x-markdown-tokens` header.

```bash
curl -H "Accept: text/markdown" https://noctisnova.com/tools/dead-doctor/dead-code-guide
```

| Guide | URL |
|---|---|
| Dead Code Guide | https://noctisnova.com/tools/dead-doctor/dead-code-guide |
| Advanced Reachability & Cleanup | https://noctisnova.com/tools/dead-doctor/advanced-reachability-and-cleanup |
| All NoctisNova tools | https://noctisnova.com/tools |

---

## Links

| Resource | URL |
|---|---|
| NoctisNova | https://noctisnova.com |
| Dead Files Guide | https://noctisnova.com/tools/dead-doctor/dead-code-guide |
| Unused Exports Guide | https://noctisnova.com/tools/dead-doctor/dead-code-guide |
| Duplicate Files Guide | https://noctisnova.com/tools/dead-doctor/advanced-reachability-and-cleanup |
| Dead Pages Guide | https://noctisnova.com/tools/dead-doctor/dead-code-guide |
| Zombie Deps Guide | https://noctisnova.com/tools/dead-doctor/advanced-reachability-and-cleanup |
| Commented Code Guide | https://noctisnova.com/tools/dead-doctor/dead-code-guide |
| Unreachable Code Guide | https://noctisnova.com/tools/dead-doctor/advanced-reachability-and-cleanup |
