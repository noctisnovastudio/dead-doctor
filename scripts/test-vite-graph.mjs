import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runGraphScans } from "../src/graph.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".test-vite-fixture");

function write(rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

fs.rmSync(root, { recursive: true, force: true });
write("index.html", `<!DOCTYPE html>
<html><body>
<script src="/config.js"></script>
<script type="module" src="/app.jsx"></script>
</body></html>`);
write("public/config.js", "window.CONFIG = {};\n");
write("vite.config.js", "export default { plugins: [] };\n");
write("package.json", '{ "name": "vite-fixture", "private": true, "type": "module" }\n');
write("icons.jsx", "export const Icons = {};\n");
write("catalog.jsx", "export const Catalog = {};\n");
write("data.jsx", "export const dashboardSB = {}; export const NebulaData = {};\n");
write("login.jsx", "export function LoginScreen() {}\n");
write("shell.jsx", "export function Sidebar() {} export function Topbar() {} export function LegalFooter() {}\n");
write("app.jsx", `import { Icons } from "./icons";
import { Catalog } from "./catalog";
import { dashboardSB, NebulaData } from "./data";
import { LoginScreen } from "./login";
import { Sidebar, Topbar, LegalFooter } from "./shell";
import React, { lazy } from "react";
const ServicesPage = lazy(() => import("./pages-services"), "ServicesPage");
const DevProjectsPage = lazy(() => import("./pages-dev"), "DevProjectsPage");
export default function App() { return null; }
`);
write("pages-services.jsx", `import React from "react";
import { Catalog } from "./catalog";
const GRevPage = React.lazy(() => import("./pages-services-grev"));
const CardsPage = React.lazy(() => import("./pages-cards"));
const ChatPage = React.lazy(() => import("./pages-services-chat"));
export default function ServicesPage() { return null; }
`);
write("pages-cards.jsx", `import { Catalog } from "./catalog";
export default function CardsPage() {}
`);
write("pages-services-chat.jsx", "export default function ChatPage() {}\n");
write("pages-services-grev.jsx", "export default function GRevPage() {}\n");
write("pages-dev.jsx", `import { SectionCard } from "./section";
export default function DevProjectsPage() {}
`);
write("section.jsx", "export function SectionCard() {}\n");
write("wizard.jsx", "export function Wizard() {}\n");
write("actually-dead.jsx", "export const deadOnly = 1;\n");

const { graphStats, issues } = runGraphScans(root);
const deadFiles = issues.filter((i) => i.rule === "dead-file").map((i) => i.file).sort();

console.log("graphStats", graphStats);
console.log("dead files", deadFiles);

const live = [
  "app.jsx", "icons.jsx", "data.jsx", "catalog.jsx", "shell.jsx",
  "pages-services.jsx", "pages-cards.jsx", "pages-services-chat.jsx",
  "pages-services-grev.jsx", "pages-dev.jsx",
];
const falsePositives = live.filter((f) => deadFiles.includes(f));
if (falsePositives.length) {
  console.error("FAIL false positives:", falsePositives);
  process.exit(1);
}
if (graphStats.entryPoints < 2) {
  console.error("FAIL expected HTML/Vite entry points, got", graphStats.entryPoints);
  process.exit(1);
}
if (graphStats.reachable < live.length) {
  console.error("FAIL reachable count too low:", graphStats.reachable);
  process.exit(1);
}
write("supabase/functions/pay/index.ts", `import { limit } from "../_shared/rate-limit.ts";
export default async function handler() { return limit(); }
`);
write("supabase/functions/_shared/rate-limit.ts", "export function limit() { return true; }\n");

const r2 = runGraphScans(root);
const dead2 = r2.issues.filter((i) => i.rule === "dead-file").map((i) => i.file);
if (dead2.some((f) => f.includes("supabase/functions"))) {
  console.error("FAIL supabase functions flagged dead:", dead2);
  process.exit(1);
}

console.log("PASS");
