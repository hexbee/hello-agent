/**
 * SSR 冒烟探测：AISidebar 的会话分页（visibleChildren +「展开更多」）。
 *
 * 不起 Electron / 浏览器，直接 renderToStaticMarkup 校验：
 * 1. 展开的项目默认只渲染前 SESSION_PAGE_SIZE 个会话；
 * 2. 超出的会话渲染「展开更多」行并标注剩余数量；
 * 3. 受控「全部折叠」时不渲染任何会话行。
 *
 * 运行：cd apps/desktop && pnpm exec tsx ../../spikes/probes/sidebar-pagination-probe.tsx
 */
import { renderToStaticMarkup } from "../../apps/desktop/node_modules/react-dom/server";
import { createElement } from "../../apps/desktop/node_modules/react/index.js";
import { AISidebar } from "../../apps/desktop/src/renderer/components/agents/ai-sidebar";
import type { SidebarResource } from "../../apps/desktop/src/renderer/components/agents/ai-sidebar";

const PAGE_SIZE = 5;

const projects: SidebarResource[] = [
  {
    id: "/tmp/p1",
    label: "project-one",
    kind: "project",
    children: Array.from({ length: 12 }, (_, i) => ({
      id: `/tmp/p1/session-${i}.jsonl`,
      label: `session-${i}`,
      kind: "file" as const,
    })),
  },
  {
    id: "/tmp/p2",
    label: "project-two",
    kind: "project",
    children: [
      { id: "/tmp/p2/only.jsonl", label: "only-session", kind: "file" as const },
    ],
  },
];

function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

// ── 1. 展开项目：只渲染前 5 个会话 +「展开更多」行 ───────────────────────
const expandedHtml = renderToStaticMarkup(
  createElement(AISidebar, {
    items: projects,
    expandedIds: new Set(["/tmp/p1", "/tmp/p2"]),
    visibleChildren: PAGE_SIZE,
    showMoreLabel: "展开更多",
  }),
);

const p1Sessions = expandedHtml.match(/session-\d+/g) ?? [];
const uniqueP1 = [...new Set(p1Sessions)];
if (uniqueP1.length !== PAGE_SIZE) {
  fail(`p1 应只渲染 ${PAGE_SIZE} 个会话，实际 ${uniqueP1.length}: ${uniqueP1.join(",")}`);
}
// 容器行本身必须仍在（回归防护：曾漏掉 entry 导致展开后项目行消失）。
if (!expandedHtml.includes("project-one") || !expandedHtml.includes("project-two")) {
  fail("展开后项目容器行必须仍然可见");
}
for (let i = 0; i < PAGE_SIZE; i++) {
  if (!uniqueP1.includes(`session-${i}`)) {
    fail(`渲染的不是前 ${PAGE_SIZE} 个会话: ${uniqueP1.join(",")}`);
  }
}
if (!expandedHtml.includes("展开更多")) {
  fail("缺少「展开更多」行");
}
if (!expandedHtml.includes("还有 7 个未显示")) {
  fail("「展开更多」应标注剩余 7 个");
}
if (!expandedHtml.includes("only-session")) {
  fail("p2 只有 1 个会话（≤ 上限），应完整渲染");
}
const moreRowCount = (expandedHtml.match(/还有 \d+ 个未显示/g) ?? []).length;
if (moreRowCount !== 1) {
  fail(`只应有 1 个「展开更多」行（属于 p1），实际 ${moreRowCount}`);
}

// ── 2. 全部折叠：不渲染任何会话 ────────────────────────────────────────
const collapsedHtml = renderToStaticMarkup(
  createElement(AISidebar, {
    items: projects,
    expandedIds: new Set<string>(),
    visibleChildren: PAGE_SIZE,
    showMoreLabel: "展开更多",
  }),
);
if ((collapsedHtml.match(/session-\d+/g) ?? []).length > 0) {
  fail("全部折叠时不应渲染会话");
}
if (collapsedHtml.includes("展开更多")) {
  fail("全部折叠时不应有「展开更多」");
}
if (!collapsedHtml.includes("project-one") || !collapsedHtml.includes("project-two")) {
  fail("全部折叠时项目行仍应可见");
}

console.log("✓ 分页渲染：展开项目只显示前 5 个会话，剩余收进「展开更多」");
console.log("✓ 无需分页：会话数 ≤ 上限时不出现「展开更多」");
console.log("✓ 全部折叠：项目行保留，会话与「展开更多」隐藏");
