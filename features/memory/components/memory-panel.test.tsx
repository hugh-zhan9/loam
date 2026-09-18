// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryPanel } from "./memory-panel";
import type { GateReport, MemoryStatus, StoredItem } from "../lib/types";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const memoryClient = vi.hoisted(() => ({
  getMemoryStatus: vi.fn(),
  setMemoryEnabled: vi.fn(),
  listProjects: vi.fn(),
  listStored: vi.fn(),
  checkGate: vi.fn(),
  adoptConclusion: vi.fn(),
  addMaterial: vi.fn(),
  deleteStored: vi.fn(),
  distillConclusion: vi.fn(),
  searchMemory: vi.fn(),
  recall: vi.fn(),
  retireConclusion: vi.fn(),
  addCounterexample: vi.fn(),
  downloadModel: vi.fn(),
  rebuildIndex: vi.fn(),
  rebindProject: vi.fn(),
  showStored: vi.fn(),
  getDiagnostics: vi.fn(),
  purgeDeleted: vi.fn(),
  exportBundle: vi.fn(),
  legacyImport: vi.fn(),
  getMemoryIntegrationStatus: vi.fn(),
  repairMemoryIntegration: vi.fn(),
  setupMemoryAgents: vi.fn(),
}));

vi.mock("../lib/memory-client", () => memoryClient);

function status(overrides: Partial<MemoryStatus> = {}): MemoryStatus {
  return {
    enabled: true,
    wing: "notes-9f3c1a",
    library: {
      path: "/home/u/.loam/memory/palace.db",
      exists: true,
      schemaVersion: 9,
      supportedSchemaVersion: 9,
      writable: true,
      drawerCount: 2,
      embeddingDim: 256,
      error: null,
    },
    modelReady: true,
    model: "minishlab/potion-multilingual-128M",
    ...overrides,
  };
}

function material(overrides: Partial<StoredItem> = {}): StoredItem {
  return {
    drawerId: "ev_1",
    kind: "material",
    room: "notes",
    sourceFile: "notes/decision.md",
    addedAt: "1786968000",
    importance: 1,
    statement: null,
    status: null,
    excerpt: "决定把导出改成打印当前渲染结果。",
    supportingRefs: [],
    verificationRefs: [],
    counterexampleRefs: [],
    ...overrides,
  };
}

function conclusion(overrides: Partial<StoredItem> = {}): StoredItem {
  return {
    drawerId: "kn_1",
    kind: "conclusion",
    room: "review",
    sourceFile: "knowledge://shu/general",
    addedAt: "1786968549",
    importance: 2,
    statement: "PDF export embeds a font subset",
    status: "candidate",
    excerpt: "Exports carry a subset of a system CJK face.",
    // Two pieces of material and the record written when it was adopted: the
    // shape every conclusion has, so the card's evidence row is exercised.
    supportingRefs: ["ev_1", "ev_2"],
    verificationRefs: ["cf_1"],
    counterexampleRefs: [],
    ...overrides,
  };
}

function gate(overrides: Partial<GateReport> = {}): GateReport {
  return {
    // Snake case throughout: this is upstream's type, handed through untouched.
    // A factory that invented camel case here is why the panel type-checked and
    // then crashed on the first real conclusion.
    drawer_id: "kn_1",
    tier: "qi",
    status: "candidate",
    target_status: "promoted",
    allowed: false,
    reasons: [],
    requirements: {
      min_supporting_refs: 1,
      min_verification_refs: 1,
      min_teaching_refs: 0,
      reviewer_required: false,
      counterexamples_block: true,
    },
    evidence_counts: {
      supporting: 1,
      counterexample: 0,
      teaching: 0,
      verification: 0,
    },
    ...overrides,
  };
}

let host: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function mountPanel() {
  await act(async () => {
    root.render(<MemoryPanel rootPath="/tmp/ws" />);
  });
  await flush();
}

function getButton(label: string) {
  const button = Array.from(host.querySelectorAll("button")).find((candidate) =>
    candidate.textContent?.includes(label),
  );
  if (!button) {
    throw new Error(`no button labelled ${label}`);
  }
  return button;
}

beforeEach(() => {
  vi.clearAllMocks();
  memoryClient.getMemoryStatus.mockResolvedValue(status());
  memoryClient.listProjects.mockResolvedValue([]);
  // The setup page mounts its three sections together, so the integration list
  // is fetched on that tab whether or not a test is about integrations.
  memoryClient.getMemoryIntegrationStatus.mockResolvedValue([]);
  memoryClient.getDiagnostics.mockResolvedValue({
    warnings: [],
    library: {
      path: "/home/u/.loam/memory/palace.db",
      exists: true,
      schemaVersion: 9,
      supportedSchemaVersion: 9,
      writable: true,
      drawerCount: 2,
      embeddingDim: 256,
      error: null,
    },
    model: { name: "minishlab/potion-multilingual-128M", ready: true, missing: [] },
    projects: [],
  });
  memoryClient.listStored.mockResolvedValue([]);
  memoryClient.checkGate.mockResolvedValue(gate());
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("MemoryPanel", () => {
  it("offers four tabs, grouped by the question each answers", async () => {
    // Six tabs described the data model — overview, material, conclusions,
    // context, integrations, diagnostics. These describe what a person is asking:
    // what do I have, how does it connect, what does an agent get, and how is this
    // set up. The graph is a tab because as a toggle under the tab bar, styled like
    // it, nobody could tell which control switched pages.
    await mountPanel();

    const tabs = Array.from(host.querySelectorAll("[role='tab']")).map(
      (tab) => tab.textContent,
    );

    expect(tabs).toEqual([
      "素材与结论",
      "关系图",
      "Agent 会读到什么",
      "设置与诊断",
    ]);
  });

  it("puts material and conclusions on one screen", async () => {
    // They were two tabs, and the motion they serve is one: select material,
    // draw a conclusion, see it appear beside what it was drawn from.
    memoryClient.listStored.mockImplementation(async (_root, filter) =>
      filter.kind === "conclusion" ? [conclusion()] : [material()],
    );

    await mountPanel();

    const workbench = host.querySelector("[data-testid='memory-workbench']");
    expect(workbench).not.toBeNull();
    // Both sides' own content, not just their headings: the material excerpt and
    // the conclusion's statement are visible at the same time.
    expect(workbench?.textContent).toContain(
      "决定把导出改成打印当前渲染结果。",
    );
    expect(workbench?.textContent).toContain("PDF export embeds a font subset");
  });

  it("carries the library's facts on every tab", async () => {
    // Which project, how much is stored, whether the model is there. These used
    // to be two tabs away, so an empty list could not be told from a broken one.
    await mountPanel();

    const strip = host.textContent ?? "";
    expect(strip).toContain("项目");
    expect(strip).toContain("素材");
    expect(strip).toContain("模型");
  });

  it("shows what a conclusion stands on, and opens one of them", async () => {
    // The refs were in the row all along and the panel never showed them, which
    // left "adopted" as a claim with no way to ask why.
    memoryClient.listStored.mockImplementation(async (_root, filter) =>
      filter.kind === "conclusion" ? [conclusion()] : [material()],
    );
    memoryClient.showStored.mockResolvedValue(
      material({ excerpt: "被引用的那条素材的全文。" }),
    );

    await mountPanel();
    expect(host.textContent).toContain("依据");

    await act(async () => {
      getButton("素材 1").click();
    });
    await flush();

    expect(memoryClient.showStored).toHaveBeenCalledWith("ev_1");
    expect(host.textContent).toContain("被引用的那条素材的全文。");
  });

  it("counts what the scope covers, not just this project", async () => {
    // With 全部项目 on, the strip used to keep showing this project's own counts —
    // "素材 2" over lists and a graph drawing eight hundred of them.
    memoryClient.listProjects.mockResolvedValue([
      {
        // The wing this workspace is bound to, per the status fixture.
        wing: "notes-9f3c1a",
        path: "/tmp/ws",
        lastActivity: "",
        total: 1024,
        evidence: 1022,
        knowledge: 2,
      },
      {
        wing: "inbox-8911e2",
        path: "/tmp/inbox",
        lastActivity: "",
        total: 3,
        evidence: 2,
        knowledge: 1,
      },
    ]);

    await mountPanel();
    expect(host.textContent).toContain("素材 1022");

    await act(async () => {
      getButton("本项目 ↔").click();
    });
    await flush();

    expect(host.textContent).toContain("素材 1024");
    expect(host.textContent).toContain("全部 2");
  });

  it("installs one agent per row, and says what happened", async () => {
    // Two controls used to do this: a 修复 on each row and a 配置智能体 under a
    // group of checkboxes. Both called the same install — `plan_memory_agent_repair`
    // is `plan_memory_agent_setup` — and neither reported anything, so pressing
    // either looked like nothing had happened even when it wrote files.
    const agent = (name: string, installed: boolean) => ({
      agent_source: name,
      installed,
      enabled: installed,
      authorized: installed,
      hook_version: installed ? "1" : null,
      last_event_at: null,
      last_error: null,
      doctor_status: installed ? "ok" : "not_checked",
    });
    memoryClient.getMemoryIntegrationStatus.mockResolvedValue([
      agent("claude", false),
      agent("codex", false),
      agent("cursor", false),
    ]);
    // The doctor was asked about one agent, so it answers about one agent — which
    // is why the panel re-reads the whole list rather than trusting this to be it.
    memoryClient.repairMemoryIntegration.mockResolvedValue({
      ok: true,
      statuses: [agent("claude", true)],
      errors: [],
      warnings: [],
    });
    memoryClient.getMemoryIntegrationStatus
      .mockResolvedValueOnce([
        agent("claude", false),
        agent("codex", false),
        agent("cursor", false),
      ])
      .mockResolvedValue([
        agent("claude", true),
        agent("codex", false),
        agent("cursor", false),
      ]);

    await mountPanel();
    await act(async () => {
      getButton("设置与诊断").click();
    });
    await flush();
    await act(async () => {
      getButton("安装").click();
    });
    await flush();

    expect(memoryClient.repairMemoryIntegration).toHaveBeenCalledWith(
      "/tmp/ws",
      "claude",
    );
    // Said where the button is. The panel's message bar used to skip this tab.
    expect(host.textContent).toContain("已给 claude 装好技能、MCP 与 hook");
    expect(host.textContent).toContain("重新安装");
    // And the other two rows survive: assigning the doctor's one-agent list
    // straight into state made them disappear.
    expect(host.textContent).toContain("Codex");
    expect(host.textContent).toContain("Cursor");
  });

  it("says the install started, on the row that was pressed", async () => {
    // Writing files under the home directory and running the doctor over them takes
    // long enough to wonder whether the click registered. The button used to keep
    // its label and merely grey out — along with the other two rows, so nothing said
    // which one had been pressed or that anything had begun.
    const agent = (name: string, installed: boolean) => ({
      agent_source: name,
      installed,
      enabled: installed,
      authorized: installed,
      hook_version: installed ? "1" : null,
      last_event_at: null,
      last_error: null,
      doctor_status: installed ? "ok" : "not_checked",
    });
    memoryClient.getMemoryIntegrationStatus.mockResolvedValue([
      agent("claude", false),
      agent("codex", false),
    ]);
    let finish: (() => void) | null = null;
    memoryClient.repairMemoryIntegration.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () =>
            resolve({
              ok: true,
              statuses: [agent("claude", true)],
              errors: [],
              warnings: [],
            });
        }),
    );

    await mountPanel();
    await act(async () => {
      getButton("设置与诊断").click();
    });
    await flush();
    await act(async () => {
      getButton("安装").click();
    });
    await flush();

    // The row that was pressed says so; the other one is only disabled.
    expect(host.textContent).toContain("安装中");
    expect(host.textContent?.match(/安装中/g)).toHaveLength(1);

    await act(async () => {
      finish?.();
      await flush();
    });

    // And when it is over, the outcome is on screen and the label has moved on.
    expect(host.textContent).not.toContain("安装中");
    expect(host.textContent).toContain("已给 claude 装好技能、MCP 与 hook");
  });

  it("acts on the entry it opened, without making you find it again", async () => {
    // The opened entry used to be a read-only strip along the bottom: you could see
    // what a graph dot said and then had to hunt the same row down in a list to do
    // anything about it.
    memoryClient.listStored.mockImplementation(async (_root, filter) =>
      filter.kind === "conclusion" ? [conclusion()] : [material()],
    );
    memoryClient.showStored.mockResolvedValue(
      material({ excerpt: "被引用的那条素材的全文。" }),
    );
    memoryClient.deleteStored.mockResolvedValue(undefined);

    await mountPanel();
    await act(async () => {
      getButton("素材 1").click();
    });
    await flush();

    const dialog = host.querySelector('[data-testid="memory-entry-dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain("被引用的那条素材的全文。");

    // Scoped to the dialog: the row behind it carries a 删除 of its own, and both
    // would have deleted the same id — so an unscoped query would pass either way.
    const dialogDelete = Array.from(
      dialog?.querySelectorAll("button") ?? [],
    ).find((button) => button.textContent === "删除");

    await act(async () => {
      dialogDelete?.click();
    });
    await flush();

    expect(memoryClient.deleteStored).toHaveBeenCalledWith("ev_1");
    // And it closes, because what it was showing is gone.
    expect(
      host.querySelector('[data-testid="memory-entry-dialog"]'),
    ).toBeNull();
  });

  it("draws material as the dimension, and says when there is none", async () => {
    // Material is the graph: a piece of it is a dot whether or not a conclusion has
    // been drawn from it, and a conclusion is the larger dot several of them make.
    memoryClient.listStored.mockImplementation(async (_root, filter) =>
      filter.kind === "conclusion" ? [] : [material()],
    );

    await mountPanel();
    await act(async () => {
      getButton("关系图").click();
    });
    await flush();

    expect(host.querySelector("svg")).not.toBeNull();
    expect(host.textContent).toContain("实线：归属 / 引用");
  });

  it("says the graph is empty rather than drawing an empty canvas", async () => {
    memoryClient.listStored.mockResolvedValue([]);

    await mountPanel();
    await act(async () => {
      getButton("关系图").click();
    });
    await flush();

    expect(host.textContent).toContain("还没有素材");
    expect(host.querySelector("svg")).toBeNull();
  });

  it("can read the whole library instead of one project", async () => {
    // One library serves every workspace, and the split by project is applied on
    // the way out of the store — so "everything I have ever stored" is a question
    // this panel can answer, and it has to be asked for rather than assumed.
    await mountPanel();

    // The scope control lives on the status strip, the line that says what you are
    // looking at, rather than as a second row of tab-shaped buttons.
    await act(async () => {
      getButton("本项目 ↔").click();
    });
    await flush();

    expect(memoryClient.listStored).toHaveBeenCalledWith("/tmp/ws", {
      kind: "conclusion",
      allProjects: true,
    });
  });

  it("points an empty project at the one that holds the material", async () => {
    // One library serves every workspace, so an empty project usually means the
    // material is filed under another one. Leaving a user in front of zeros is how
    // a working feature gets read as broken.
    memoryClient.listStored.mockResolvedValue([]);
    memoryClient.listProjects.mockResolvedValue([
      {
        wing: "notes-9f3c1a",
        path: "/tmp/ws",
        lastActivity: "1786968000",
        total: 0,
        evidence: 0,
        knowledge: 0,
      },
      {
        wing: "corporate-action",
        path: "/Users/x/project/corporate-action",
        lastActivity: "1786968000",
        total: 1002,
        evidence: 1001,
        knowledge: 1,
      },
    ]);

    await mountPanel();

    expect(host.textContent).toContain("这个项目是空的");
    expect(host.textContent).toContain("1001");

    await act(async () => {
      getButton("把这个工作区绑过去").click();
    });
    await flush();

    expect(memoryClient.rebindProject).toHaveBeenCalledWith(
      "corporate-action",
      "/tmp/ws",
    );
  });

  it("does not call material a conclusion in the agent pack", async () => {
    // The assembler returns conclusions and the material it matched on. Putting
    // both under "会注入的结论" misrepresents the one distinction the feature
    // rests on — and material chunks are long, so they were also an unreadable
    // wall of text.
    const long = "错误码表 ".repeat(200);
    memoryClient.recall.mockResolvedValue({
      brief: {
        query: "锁",
        summary: "Brief assembled from 0 cited key facts, 2 evidence items.",
        keyFacts: [],
        evidence: [],
        uncertainties: [],
        nextActions: [],
      },
      context: {
        query: "锁",
        anchors: [],
        items: [
          {
            section: "qi",
            drawerId: "kn_1",
            sourceFile: "knowledge://qi",
            text: "锁只覆盖入队临界区",
            tier: "qi",
            status: "promoted",
            anchorKind: "repo",
            anchorId: "a",
            evidenceRefs: [],
          },
          {
            section: "evidence",
            drawerId: "ev_9",
            sourceFile: "i18n/errors.go",
            text: long,
            tier: null,
            status: null,
            anchorKind: "repo",
            anchorId: "a",
            evidenceRefs: [],
          },
        ],
      },
      hits: [],
      truncated: false,
    });

    await mountPanel();
    await act(async () => {
      getButton("Agent 会读到什么").click();
    });
    await flush();

    // A query is typed first: an empty one is refused now, because a brief about
    // nothing comes back full of "nothing found" and reads as a fault.
    const input = host.querySelector<HTMLInputElement>(
      'input[placeholder="描述当前任务"]',
    );
    expect(input).not.toBeNull();
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    act(() => {
      setter?.call(input, "锁");
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await act(async () => {
      getButton("看看会拿到什么").click();
    });
    await flush();

    const text = host.textContent ?? "";
    expect(text).toContain("会注入的结论");
    expect(text).toContain("一起带上的素材");
    // The long chunk is clamped, with the length said out loud rather than pasted.
    expect(text).toContain("展开全文");
    expect(text).not.toContain(long.trim());
  });

  it("offers to bind this workspace to a project that already has material", async () => {
    // Moving or renaming a workspace makes it a new project as far as the library
    // is concerned. The advice was "rebind it manually" and there was no control
    // for it anywhere — the command existed and nothing called it.
    memoryClient.listProjects.mockResolvedValue([
      {
        wing: "notes-9f3c1a",
        path: "/tmp/notes",
        lastActivity: "1786968000",
        total: 0,
        evidence: 0,
        knowledge: 0,
      },
      {
        wing: "corporate-action",
        path: "/Users/x/project/corporate-action",
        lastActivity: "1786968000",
        total: 1001,
        evidence: 1000,
        knowledge: 1,
      },
    ]);

    await mountPanel();
    await act(async () => {
      getButton("设置与诊断").click();
    });
    await flush();
    await act(async () => {
      getButton("绑到这个项目").click();
    });
    await flush();

    expect(memoryClient.rebindProject).toHaveBeenCalledWith(
      "corporate-action",
      "/tmp/ws",
    );
  });

  it("tells an empty conclusions column what it is for and how to fill it", async () => {
    memoryClient.listStored.mockImplementation(async (_root, filter) =>
      filter.kind === "conclusion" ? [] : [material(), material()],
    );

    await mountPanel();

    // The count from the other column, the reason conclusions matter, and a way
    // to check what agents currently read — the old empty state named an action
    // and offered no way to take it.
    expect(host.textContent).toContain("只有被采纳的才会进 agent 的上下文");
    expect(host.textContent).toContain("看看 agent 现在读到什么");
    // The count comes from the other column, so the empty state says what there
    // is to work with rather than pointing at a tab.
    expect(host.textContent).toContain("2");
  });

  it("says the model is missing before anything can be written", async () => {
    memoryClient.getMemoryStatus.mockResolvedValue(
      status({ modelReady: false }),
    );

    await mountPanel();

    expect(host.textContent).toContain("还缺一个嵌入模型");
    expect(host.textContent).toContain("直接拒绝写入");
  });

  it("shows the gate's own reasons when adoption is refused", async () => {
    memoryClient.listStored.mockImplementation(async (_root, filter) =>
      filter.kind === "conclusion" ? [conclusion()] : [],
    );
    memoryClient.adoptConclusion.mockRejectedValue({
      error_code: "gate_failed",
      message: "promotion gate failed",
    });
    memoryClient.checkGate.mockResolvedValue(
      gate({
        reasons: ["verification_refs 0 < 1", "counterexample refs block promotion"],
      }),
    );

    await mountPanel();
    await act(async () => {
      getButton("采纳").click();
    });
    await flush();

    // The backend's wording reaches the screen unchanged; a summary would leave
    // the user unable to tell what to attach.
    expect(host.textContent).toContain("verification_refs 0 < 1");
    expect(host.textContent).toContain("counterexample refs block promotion");
  });

  it("leaves a refused conclusion exactly where it was", async () => {
    memoryClient.listStored.mockImplementation(async (_root, filter) =>
      filter.kind === "conclusion" ? [conclusion()] : [],
    );
    memoryClient.adoptConclusion.mockRejectedValue({
      error_code: "gate_failed",
      message: "promotion gate failed",
    });

    await mountPanel();
    await act(async () => {
      getButton("结论").click();
    });
    await flush();
    const before = memoryClient.listStored.mock.calls.length;
    await act(async () => {
      getButton("采纳").click();
    });
    await flush();

    // No optimistic move to "adopted": the row still offers adoption.
    expect(host.textContent).toContain("候选");
    expect(getButton("采纳")).toBeDefined();
    expect(memoryClient.listStored.mock.calls.length).toBe(before);
  });

  it("reports where an adoption was recorded when it succeeds", async () => {
    memoryClient.listStored.mockImplementation(async (_root, filter) =>
      filter.kind === "conclusion" ? [conclusion()] : [],
    );
    memoryClient.adoptConclusion.mockResolvedValue({
      drawerId: "kn_1",
      status: "promoted",
      confirmationDrawerId: "ev_review_1",
    });

    await mountPanel();
    await act(async () => {
      getButton("采纳").click();
    });
    await flush();

    expect(host.textContent).toContain("ev_review_1");
  });

  it("keeps the storage vocabulary out of the panel", async () => {
    memoryClient.listStored.mockImplementation(async (_root, filter) =>
      filter.kind === "conclusion" ? [conclusion()] : [],
    );

    await mountPanel();

    const text = host.textContent ?? "";
    for (const upstreamWord of ["wing", "drawer", "dao_tian", "dao_ren", "qi", "shu"]) {
      expect(text.toLowerCase()).not.toContain(upstreamWord);
    }
  });
});
