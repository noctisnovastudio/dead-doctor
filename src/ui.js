/**
 * ui.js — dead-doctor
 * Terminal UI: score box, numbered dead-code issue list, agent prompt builder.
 */

import boxen from "boxen";
import chalk from "chalk";
import path from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REPORT_FILE = "./.dead-doctor-report.json";
const BAR_WIDTH   = 30;
const MAX_FILES   = 3;

// ---------------------------------------------------------------------------
// Rule metadata
// ---------------------------------------------------------------------------

const RULE_META = {
  "dead-file": {
    badge: "WARN",
    badgeFn: (s) => chalk.bgYellow.black.bold(` ${s} `),
    category: "Dead Code",
    label: "Dead File (Unreachable)",
    penalty: 6,
    explanation:
      "A file that cannot be reached from ANY entry point (page, route, layout, index.html script, config, test, or " +
      "package main) by following imports — directly or transitively. Unlike a single unused export, " +
      "this is a whole module (often a whole island of modules) that nothing the app runs depends on.",
    realWorld:
      "A feature was deleted but its `lib/oldFeature/` folder stayed. Five files still import each other " +
      "so each looks 'used' — but nothing reachable imports the group. It still ships, builds, and gets " +
      "maintained for no reason. Reachability analysis finds the whole dead island.",
    severity: "warning",
    docs: "https://noctisnova.com/tools/dead-doctor/dead-code-guide",
  },

  "unused-export": {
    badge: "WARN",
    badgeFn: (s) => chalk.bgYellow.black.bold(` ${s} `),
    category: "Dead Code",
    label: "Unused Exports",
    penalty: 5,
    explanation:
      "A specific exported symbol that no file importing this module actually consumes — proven by " +
      "resolving every import edge to the real file (not a global name guess). " +
      "Dead exports defeat tree-shaking and inflate your JavaScript bundle.",
    realWorld:
      "A 20KB utility function exported but never used means every user downloads and parses " +
      "20KB of JavaScript they don't need — on every page load. On mobile, that's a slow first render.",
    severity: "warning",
    docs: "https://noctisnova.com/tools/dead-doctor/dead-code-guide",
  },

  "duplicate-file": {
    badge: "WARN",
    badgeFn: (s) => chalk.bgYellow.black.bold(` ${s} `),
    category: "Dead Code",
    label: "Duplicate File",
    penalty: 4,
    explanation:
      "Two or more files are byte-for-byte identical once whitespace and comments are normalised. " +
      "Copy-pasted modules silently drift out of sync — a bug fixed in one copy stays broken in the others — " +
      "and double the code everyone has to read and maintain.",
    realWorld:
      "`utils/format.ts` was copied into a new feature folder instead of imported. Months later the original " +
      "gets a timezone fix; the copy doesn't, and only that feature shows wrong times. One canonical copy avoids this.",
    severity: "warning",
    docs: "https://noctisnova.com/tools/dead-doctor/advanced-reachability-and-cleanup",
  },

  "unused-import": {
    badge: "INFO",
    badgeFn: (s) => chalk.bgBlue.white.bold(` ${s} `),
    category: "Dead Code",
    label: "Unused Imports",
    penalty: 3,
    explanation:
      "Import statements where the imported binding is never used in the file body. " +
      "These add to bundle parse time, confuse readers about what a file actually depends on, " +
      "and often signal a refactor that was only half-finished.",
    realWorld:
      "A file with 8 unused imports loads 8 modules the browser doesn't need, " +
      "increasing parse time and memory pressure — especially on mobile CPUs.",
    severity: "info",
    docs: "https://noctisnova.com/tools/dead-doctor/dead-code-guide",
  },

  "dead-page": {
    badge: "WARN",
    badgeFn: (s) => chalk.bgYellow.black.bold(` ${s} `),
    category: "Ghost Page",
    label: "Unreachable Next.js Page",
    penalty: 8,
    explanation:
      "A Next.js App Router page file that exists in the filesystem but is never linked to " +
      "from anywhere in the codebase. No <Link href>, no router.push(), no redirect() — " +
      "this page is invisible to users but still compiled, deployed, and maintained.",
    realWorld:
      "An orphaned /dashboard/reports page still gets built on every deploy, included in the " +
      "sitemap, and potentially indexed by search engines — serving content users can never " +
      "navigate to through the app.",
    severity: "warning",
    docs: "https://noctisnova.com/tools/dead-doctor/dead-code-guide",
  },

  "empty-file": {
    badge: "INFO",
    badgeFn: (s) => chalk.bgBlue.white.bold(` ${s} `),
    category: "Dead Code",
    label: "Empty / Hollow File",
    penalty: 3,
    explanation:
      "A TypeScript source file with no meaningful content — just whitespace, comments, " +
      "or only import statements with nothing actually exported or executed. " +
      "It's dead weight that pollutes the file tree and confuses new developers.",
    realWorld:
      "An empty components/OldButton.tsx left from a component rename makes every developer " +
      "who opens the directory wonder if there's a second button component — then spend time " +
      "reading a file that does nothing.",
    severity: "info",
    docs: "https://noctisnova.com/tools/dead-doctor/dead-code-guide",
  },

  "zombie-dep": {
    badge: "WARN",
    badgeFn: (s) => chalk.bgYellow.black.bold(` ${s} `),
    category: "Zombie Dependency",
    label: "Unused Package Dependency",
    penalty: 5,
    explanation:
      "A package listed in your package.json `dependencies` that is never imported in any " +
      "source file in the project. It gets installed on every `npm install`, adds to your " +
      "`node_modules` size, and expands your security audit surface.",
    realWorld:
      "10 unused dependencies = 10 extra packages to audit for CVEs every week, " +
      "10 more packages slowing down CI installs, and 10 more potential supply-chain " +
      "attack vectors (like the left-pad incident, but with security implications).",
    severity: "warning",
    docs: "https://noctisnova.com/tools/dead-doctor/advanced-reachability-and-cleanup",
  },

  "comment-block": {
    badge: "INFO",
    badgeFn: (s) => chalk.bgBlue.white.bold(` ${s} `),
    category: "Dead Code",
    label: "Commented-Out Code Block",
    penalty: 2,
    explanation:
      "A large block of consecutive comment lines that appears to be commented-out code " +
      "rather than documentation. This code is never executed, misleads readers about " +
      "the codebase's intent, and adds visual noise to code reviews.",
    realWorld:
      "A 40-line commented function body makes every code reviewer wonder: is this " +
      "intentionally disabled? Is this a WIP? Should I uncomment this? Git history " +
      "already preserves the code — commented-out code should be deleted.",
    severity: "info",
    docs: "https://noctisnova.com/tools/dead-doctor/dead-code-guide",
  },

  "unreachable-code": {
    badge: "WARN",
    badgeFn: (s) => chalk.bgYellow.black.bold(` ${s} `),
    category: "Dead Code",
    label: "Unreachable Code After Return/Throw",
    penalty: 5,
    explanation:
      "Statements that appear after an unconditional `return`, `throw`, `break`, or `continue` " +
      "and will never execute. This is almost always a logic bug — the developer likely " +
      "intended those statements to run before the early exit.",
    realWorld:
      "A validation check placed after a `return` statement means the validation never runs — " +
      "data that should have been rejected gets processed, potentially corrupting your database " +
      "or causing a crash downstream.",
    severity: "warning",
    docs: "https://noctisnova.com/tools/dead-doctor/advanced-reachability-and-cleanup",
  },
};

// Rule display order — most impactful first
const RULE_ORDER = [
  "unreachable-code",
  "dead-file",
  "dead-page",
  "duplicate-file",
  "zombie-dep",
  "unused-export",
  "comment-block",
  "unused-import",
  "empty-file",
];

// ---------------------------------------------------------------------------
// Progress bar
// ---------------------------------------------------------------------------

export function renderProgressBar(score) {
  const clamped = Math.min(100, Math.max(0, score));
  const filled  = Math.round((clamped / 100) * BAR_WIDTH);
  const empty   = BAR_WIDTH - filled;
  const bar     = "█".repeat(filled) + "░".repeat(empty);

  if (clamped >= 80) return chalk.green(bar);
  if (clamped >= 50) return chalk.yellow(bar);
  return chalk.red(bar);
}

// ---------------------------------------------------------------------------
// Score badge
// ---------------------------------------------------------------------------

export function renderScoreBadge(score) {
  const clamped = Math.min(100, Math.max(0, score));

  let grade, colourFn;
  if (clamped >= 90)      { grade = "A · Clean";         colourFn = chalk.green.bold; }
  else if (clamped >= 80) { grade = "B · Good";           colourFn = chalk.green; }
  else if (clamped >= 65) { grade = "C · Fair";           colourFn = chalk.yellow.bold; }
  else if (clamped >= 50) { grade = "D · Cluttered";      colourFn = chalk.yellow; }
  else                    { grade = "F · Dead Weight";    colourFn = chalk.red.bold; }

  return colourFn(`${clamped}/100  ${grade}`);
}

// ---------------------------------------------------------------------------
// Score header box
// ---------------------------------------------------------------------------

export function renderScoreBox({ score, totalPenalty, issueCount, stats }) {
  const bar   = renderProgressBar(score);
  const badge = renderScoreBadge(score);

  const reclaimable = stats.reclaimableKb
    ? chalk.dim("  ·  ") + chalk.green(`~${stats.reclaimableKb} KB reclaimable`)
    : "";

  const content = [
    chalk.bold.white("dead-doctor") + chalk.dim("  v1.0.0"),
    chalk.dim(`${stats.files} source files  ·  ${stats.kb} KB`),
    "",
    `${bar}  ${badge}`,
    chalk.dim(`${issueCount} issue${issueCount !== 1 ? "s" : ""}  ·  penalty -${totalPenalty}pts`) + reclaimable,
  ].join("\n");

  return boxen(content, {
    padding: { top: 0, bottom: 0, left: 2, right: 2 },
    margin: { top: 1, bottom: 0 },
    borderStyle: "round",
    borderColor: score >= 80 ? "green" : score >= 50 ? "yellow" : "red",
  });
}

// ---------------------------------------------------------------------------
// Numbered issue list (react-doctor style)
// ---------------------------------------------------------------------------

export function renderIssueList(issues, { colour = true } = {}) {
  if (issues.length === 0) {
    return colour
      ? chalk.green("\n  ✓  No dead code detected — spotless codebase!\n")
      : "\n  No dead code detected.\n";
  }

  const grouped = groupByRule(issues);
  const orderedGroups = [
    ...RULE_ORDER.filter((r) => grouped[r]),
    ...Object.keys(grouped).filter((r) => !RULE_ORDER.includes(r)),
  ];

  const lines = [""];
  let idx = 1;

  for (const rule of orderedGroups) {
    const ruleIssues = grouped[rule];
    const meta = RULE_META[rule] ?? {
      badge: "INFO",
      badgeFn: (s) => `[${s}]`,
      category: "Code Quality",
      label: rule,
      explanation: "",
      realWorld: "",
      severity: "info",
      docs: "https://noctisnova.com/tools/dead-doctor/dead-code-guide",
    };

    const count      = ruleIssues.length;
    const badgeStr   = colour ? meta.badgeFn(meta.badge) : `[${meta.badge}]`;
    const heading    = colour ? chalk.bold(`${meta.category}: ${meta.label}`) : `${meta.category}: ${meta.label}`;
    const countStr   = colour ? chalk.dim(`(×${count})`) : `(×${count})`;

    lines.push(`${idx}. ${badgeStr} ${heading} ${countStr}`);

    if (meta.explanation) {
      lines.push(`   ${colour ? chalk.white(meta.explanation) : meta.explanation}`);
    }
    if (meta.realWorld) {
      lines.push(`   ${colour ? chalk.dim(meta.realWorld) : meta.realWorld}`);
    }

    lines.push(
      `   ${colour ? chalk.dim("Canonical fix:") : "Canonical fix:"}` +
      `${colour ? chalk.cyan(" " + meta.docs) : " " + meta.docs}`
    );

    // Show individual occurrences for this rule
    const shown    = ruleIssues.slice(0, MAX_FILES);
    const overflow = ruleIssues.length - shown.length;

    for (const issue of shown) {
      const loc = issue.file === "package.json"
        ? `package.json — ${issue.snippet}`
        : `${issue.file}:${issue.line}`;
      lines.push(colour ? `   ${chalk.dim("-")} ${chalk.cyan(loc)}` : `   - ${loc}`);
    }

    if (overflow > 0) {
      const more = `   +${overflow} more`;
      lines.push(colour ? chalk.dim(more) : more);
    }

    lines.push("");
    idx++;
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Full dashboard
// ---------------------------------------------------------------------------

export function renderDashboard({ score, totalPenalty, issues, stats }) {
  const reportPath = path.resolve(REPORT_FILE);
  const parts = [];

  parts.push(renderScoreBox({ score, totalPenalty, issueCount: issues.length, stats }));

  if (issues.length === 0) {
    parts.push(chalk.green("\n  ✓  Zero dead code — this codebase is clean!\n"));
    return parts.join("\n");
  }

  parts.push(renderIssueList(issues, { colour: true }));

  parts.push(chalk.dim(`Full results for all ${issues.length} issue${issues.length !== 1 ? "s" : ""} (.dead-doctor-report.json):`));
  parts.push(chalk.cyan(reportPath));
  parts.push("");
  parts.push(chalk.dim("Delete the dead code — git history preserves everything, you can always undo."));
  parts.push("");
  parts.push(
    chalk.dim("Verify: re-run ") +
    chalk.white("`npx dead-doctor`") +
    chalk.dim(" and confirm the issue count drops before merging.")
  );
  parts.push("");
  parts.push(chalk.dim("─".repeat(64)));
  parts.push(
    chalk.dim("  Built by ") + chalk.magenta.bold("NoctisNova") +
    chalk.dim("  ·  noctisnova.com  ·  hello@noctisnova.com")
  );
  parts.push("");

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Agent prompt builder
// ---------------------------------------------------------------------------

export function buildAgentPrompt(issues, reportPath, stats) {
  const grouped = groupByRule(issues);
  const orderedGroups = [
    ...RULE_ORDER.filter((r) => grouped[r]),
    ...Object.keys(grouped).filter((r) => !RULE_ORDER.includes(r)),
  ];

  const projectContext = [
    "CODEBASE CONTEXT — READ BEFORE TOUCHING ANY FILE",
    "──────────────────────────────────────────────────",
    `Project size: ${stats.files} source files, ${stats.kb} KB`,
    "",
    "Dead code removal conventions:",
    "  - VERIFY BEFORE YOU DELETE — static analysis can miss entry points (index.html scripts,",
    "    lazy/dynamic imports, public/ assets, string-path loaders). For every finding, prove it",
    "    is actually dead in THIS codebase before removing anything. If you cannot confirm, skip it.",
    "  - Delete, don't comment out — git history preserves deleted code",
    "  - Remove the export AND all its consumers when removing an unused export",
    "  - When removing a zombie dep, also run: npm uninstall <package-name>",
    "  - Dead pages: remove the page file AND any associated layout/loading/error files",
    "  - Never leave empty files — delete them entirely",
    "  - Run `npx dead-doctor` after each fix to verify the issue is gone",
    "──────────────────────────────────────────────────",
    "",
  ].join("\n");

  const header = `Review all ${issues.length} dead code issue${issues.length !== 1 ? "s" : ""} reported by dead-doctor. ` +
    `Verify each finding is true before deleting anything — leave unrelated code untouched.`;

  const issueBlock = renderIssueList(issues, { colour: false });

  const footer = [
    `Full results (.dead-doctor-report.json): ${reportPath}`,
    "",
    "IMPORTANT — verify before you delete:",
    "  The report is a starting point, not gospel. Before removing ANY file, export, import, or dependency:",
    "    1. Trace how the app actually starts (index.html <script src>, package.json main, Next.js pages).",
    "    2. Search for the symbol/path across the repo — imports, lazy(), import(), require(), href, fetch.",
    "    3. Ask: would deleting this break the build or a user-facing route? If yes or unsure, do NOT delete.",
    "    4. Only proceed once you have confirmed the finding is a true positive in this project.",
    "",
    "Delete confirmed dead code at the root — don't comment it out or add TODO comments.",
    "",
    "Order of operations (after verification):",
    "  1. Unreachable code — likely logic bugs, most impactful",
    "  2. Dead files — only after confirming unreachable (check index.html, lazy imports, dynamic loaders), then delete",
    "  3. Dead pages — remove page file + any orphaned layout/loading/error files",
    "  4. Duplicate files — keep one canonical copy, re-import it from the others, delete the rest",
    "  5. Zombie dependencies — run npm uninstall for each",
    "  6. Unused exports — remove the export keyword AND any local-only callers",
    "  7. Commented code blocks — delete entirely",
    "  8. Unused imports — remove the import line",
    "  9. Empty files — delete the file entirely",
    "",
    "Verify: re-run `npx dead-doctor` after each category and confirm issue count drops.",
    "",
    "For every fix, explain in simple everyday language — no jargon — what was removed and why it helps. " +
    "Focus on real-world benefits (e.g. \"the project is easier to navigate\", \"builds run faster\", " +
    "\"new developers won't get confused by leftover code\") so someone non-technical understands why it mattered.",
    "",
    "─────────────────────────────────────────────────────────────────",
    "dead-doctor  ·  Built by NoctisNova  ·  https://noctisnova.com",
  ].join("\n");

  return [projectContext, header, issueBlock, footer].join("\n");
}

// ---------------------------------------------------------------------------
// Summary line
// ---------------------------------------------------------------------------

export function renderSummaryLine(score, issueCount) {
  const bar   = renderProgressBar(score);
  const label = issueCount === 0
    ? chalk.green("Zero dead code — clean!")
    : chalk.yellow(`${issueCount} dead code issue${issueCount !== 1 ? "s" : ""} found.`);
  return `  ${bar}  ${label}`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function groupByRule(issues) {
  const grouped = {};
  for (const issue of issues) {
    (grouped[issue.rule] ??= []).push(issue);
  }
  return grouped;
}
