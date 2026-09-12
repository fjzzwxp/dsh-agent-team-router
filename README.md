# Agent Team Router（DSH 插件）v2

> 把一段任务文本，自动路由为**合适的多角色团队编制**，并管理团队调度、分层 DAG 依赖、**关键路径/并行度分析**、**多 Agent 协作协议（handoff/inbox）** 与 **5 阶段质量门禁**。
> 原 `agent-team-router`（WorkBuddy skill）能力的 DSH (DeepSeek Harness) / Cordis 4 插件化重实现，本次 v2 补齐了工程化编排能力。

---

## 〇、本次补齐的缺口 → 实现映射

| 缺口 | v1 状态 | v2 实现 |
|------|---------|---------|
| **角色库** | 仅 ~48 个精选角色 | 集成 **agency-agents 273+ 专业角色** + 精选中文域角色，**共 297 个**；覆盖工程/营销/设计/电商/教育/金融/安全等 25 域（`tools/build-roles.js` 可复现抽取） |
| **DAG 编排** | 仅阶段级线性（依赖所有更早阶段） | **分层 DAG**：任务依赖「紧邻前序阶段」全部任务（去掉跨阶段冗余边），提供 `buildDag()`（节点/边/拓扑序/环检测） |
| **并行优化** | 无 | `analyze()` 计算 **关键路径（阶段 spine）**、最短工期 `makespan`、最大并行度、平均并行度、**相对全串行加速比**、可并行任务数、简易排程（ES/EF） |
| **AgentTeams 协作协议** | 各 Agent 独立工作 | **handoff / inbox 协议**：任务完成自动向下游投递制品；派工自动注入上游上下文；支持手动 `handoff` 与 `sendMessage` 跨任务协作 |
| **质量门禁** | 仅 assurance 单一 pass/reject | **5 阶段流程门禁** `qualityGate()`：调研→分析→设计→产出→审查逐阶段出口校验，**并强制阶段顺序门禁**（前序未过则后续不交付） |

---

## 一、功能介绍

- **智能路由**：基于 TF-IDF 加权关键词匹配，把任务映射到角色库中的合适角色，抑制泛词（如"数据/分析"）喧宾夺主；每阶段取 **Top-K 候选**（默认 3）避免编制膨胀。
- **五阶段编排**：`调研(discovery) → 分析(analysis) → 设计(design) → 产出(creation) → 审查(assurance)`，自动生成**分层 DAG**（后阶段依赖紧邻前阶段，层内任务可并行）。
- **数量推断**：检测到"多/批量/矩阵/分别"或"N 个"等规模信号时，各阶段主角色自动放大为多人并行。
- **关键路径与并行度**：`analyze` 给出分层 DAG 的关键路径、最短工期、最大并行度与加速比，辅助排期决策。
- **多 Agent 协作协议**：上游 Agent 产出自动投递到下游 Agent 的 `inbox`；下游派工时把上游上下文作为背景注入；支持显式 `handoff` 与 `sendMessage`。
- **5 阶段质量门禁**：逐阶段出口校验 + 阶段顺序门禁；审查阶段须 `verdict(pass/reject)` + `findings`；汇总时阻断项一目了然。
- **教研友好**：内置 **教育域角色**——课程设计、教学教研、培训讲师、学情分析、职教、企业培训、测评等，教研/培训/课程开发任务可精准命中。
- **零依赖核心**：路由与状态机为纯 Node 内置模块，既可作为 DSH 工具调用，也可脱离 DSH 直接以 CLI 使用。

### 内置角色域覆盖（25 域，297 角色）
营销、电商、研究、设计、产品、工程、写作、分析、战略、教育、金融、安全、医疗、学术、游戏、GIS、空间计算、项目管理、测试、支持、付费媒体、游戏开发……（运行 `team_router_catalog()` 或 `node router.js --catalog` 查看全量）。

---

## 二、安装（通过 dsh 命令）

### 方式 A：从本地目录安装
```bash
dsh plugin --profile web add /path/to/dsh-agent-team-router
```

### 方式 B：从 GitHub 安装
```bash
git clone https://github.com/fjzzwxp/dsh-agent-team-router.git
dsh plugin --profile web add ./dsh-agent-team-router
```

### 方式 C：发布到 npm 后安装
```bash
npm publish          # 在插件目录内
dsh plugin --profile web add dsh-agent-team-router
```

安装后，DSH 注入以下工具（前缀 `team_router_`）：
`route` · `catalog` · `assemble` · `status` · `ready` · `dispatch` · `complete` · `handoff` · `inbox` · `review` · `analyze` · `gates` · `merge`

---

## 三、使用示例（DSH 工具调用）

**1) 路由一个任务**
```
team_router_route(task="分析 TikTok Shop 泰国站美妆个护类目竞争格局，设计 3 个高潜力选品方案并产出落地文档")
```
返回角色清单（含五阶段标注）并写入 `roster.json`。

**2) 教研任务（自动命中教育域角色）**
```
team_router_route(task="为中职电商课设计一节10分钟试讲教案，任务驱动法讲解电商功能，制作配套课件")
```
会自动命中 `Course Designer` / `Training Facilitator` / `Instructional Curriculum Expert` 等。

> 若想手动补位，可用 `include`：`team_router_route(task="...", include="Course Designer:creation;Training Facilitator:creation")`

**3) 物化团队 → 调度 → 协作 → 汇总**
```
team_router_assemble(rosterPath="roster.json", workspace="./run")
team_router_ready(workspace="./run")
team_router_dispatch(workspace="./run", task="t1", member="m1")   # 自动注入上游 inbox 上下文
team_router_complete(workspace="./run", task="t1", member="m1", output="调研结论...")
team_router_handoff(workspace="./run", task="t1", to="t3", note="请重点参考趋势一")  # 协作投递
team_router_review(workspace="./run", task="tN", verdict="pass", findings="通过")
team_router_merge(workspace="./run", out="report.md")
```

**4) 关键路径与并行度分析**
```
team_router_analyze(workspace="./run")
# → 关键路径(设计→产出→审查)、makespan、最大并行度、加速比、可并行任务数
```

**5) 5 阶段质量门禁状态**
```
team_router_gates(workspace="./run")
# → 逐阶段（调研/分析/设计/产出/审查）完成度与门禁状态、阻断项
```

**6) 查看角色库目录（了解可 `--include` 的真实角色名）**
```
team_router_catalog()
```

---

## 四、脱离 DSH 的 CLI 用法（无需 dsh 运行时）

核心逻辑为纯 Node 模块，可直接命令行使用：

```bash
# 路由：任务 → roster.json
node router.js "分析 TikTok Shop 泰国站美妆个护竞争格局，给 3 个高潜力选品方向" --out roster.json
node router.js --catalog                 # 查看角色库目录

# 物化团队
node team.js assemble --roster roster.json --workspace ./run

# DAG 分析与质量门禁
node team.js analyze  --workspace ./run  # 关键路径/并行度
node team.js gate     --workspace ./run  # 5 阶段门禁状态

# 派工 / 完成 / 协作 / 审查 / 汇总
node team.js ready    --workspace ./run
node team.js dispatch --workspace ./run --task t1 --member m1
node team.js complete --workspace ./run --task t1 --member m1 --output "调研结论..."
node team.js handoff  --workspace ./run --task t1 --to t3 --note "请参考趋势一"
node team.js inbox    --workspace ./run --task t3
node team.js review   --workspace ./run --task tN --verdict pass --findings "通过"
node team.js merge    --workspace ./run --out report.md
```

---

## 五、目录结构

```
dsh-agent-team-router/
├── index.js            # DSH/Cordis 插件入口（注册 team_router_* 工具）
├── router.js           # 路由引擎 v2：TF-IDF 角色匹配 + 五阶段分配 + 数量推断 + Top-K
├── team.js             # 团队状态机 v2：分层 DAG + 关键路径/并行度 + 协作协议 + 5 阶段门禁
├── roles.json          # 内置角色库（297 角色，含 agency-agents 273 + 精选中文域）
├── cordis.patch.yml    # DSH 插件挂载声明
├── package.json        # 插件元信息与 dsh.bundle.patch 声明
├── tools/build-roles.js# 角色库生成器（从 agency-agents 抽取，可复现）
├── README.md
├── LICENSE
└── test/smoke.js       # 本地冒烟测试（30 项，无需 dsh 运行时）
```

---

## 六、数据契约

- **roster.json**（`route` 产出）：`{ task, generatedAt, roles:[{slot,name,domain,phase,phaseLabel,priority,count,duty,acceptance,handoffTo,matchedTerms,confidence}] }`
- **team.json**（团队状态）：成员展开、分层 DAG（任务 `dependsOn`）、尝试记录、`inbox` 协作上下文与 `artifact` 制品。
- **report.md**（`merge` 产出）：按五阶段聚合制品 + 审查意见 + 5 阶段质量门禁结论。

---

## 七、测试

```bash
npm test        # 等价于 node test/smoke.js
```

冒烟测试覆盖：角色库规模（≥270）、五阶段路由（电商/教研）、分层 DAG（依赖紧邻前序阶段、无环）、关键路径/并行度、协作协议（handoff/inbox 上下文注入）、5 阶段质量门禁（通过路径 + 拒绝阻断路径）。

---

## 八、许可

MIT © fjzzwxp
