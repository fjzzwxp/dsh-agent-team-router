# Agent Team Router（DSH 插件）

> 把一段任务文本，自动路由为**合适的多角色团队编制**，并管理团队调度、阶段依赖与质量门禁。
> 原 `agent-team-router`（WorkBuddy skill）能力的 DSH (DeepSeek Harness) / Cordis 4 插件化重实现。

---

## 一、功能介绍

- **智能路由**：基于 TF-IDF 加权关键词匹配，把任务映射到内置角色库中的合适角色，避免泛词（如"数据/分析"）喧宾夺主。
- **多角色编排**：按四阶段 **调研(discovery) → 分析(analysis) → 产出(creation) → 审查(assurance)** 组织团队，自动生成任务依赖图（pipeline 语义：后阶段依赖前阶段全部完成）。
- **数量推断**：检测到"多/批量/矩阵/分别"等规模信号时，各阶段主角色自动放大为多人并行。
- **质量门禁**：审查阶段任务必须有明确 `verdict(pass/reject)` + `findings`；汇总时校验产出完整性，阻断项一目了然。
- **教研友好**：内置 **教育域角色**——课程设计、教学教研、培训讲师、学情分析、职教、企业培训、测评等，教研/培训/课程开发任务可精准命中（无需每次手动干预）。
- **零依赖核心**：路由与状态机为纯 Node 内置模块，既可作为 DSH 工具调用，也可脱离 DSH 直接以 CLI 使用。

### 内置角色域覆盖
营销(marketing)、电商(ecommerce)、研究(research)、设计(design)、产品(product)、工程(engineering)、写作(writing)、分析(analysis)、战略(strategy)、**教育(education)**。

---

## 二、安装（通过 dsh 命令）

### 方式 A：从本地目录安装
```bash
dsh plugin --profile web add /path/to/dsh-agent-team-router
```

### 方式 B：从 GitHub 安装
```bash
# 先克隆，再 add 本地目录（dsh 暂未提供直接 git url add 时）
git clone https://github.com/fjzzwxp/dsh-agent-team-router.git
dsh plugin --profile web add ./dsh-agent-team-router
```

### 方式 C：发布到 npm 后安装
```bash
npm publish          # 在插件目录内
dsh plugin --profile web add dsh-agent-team-router
```

安装后，DSH 会注入以下工具（前缀 `team_router_`）：
`route` · `catalog` · `assemble` · `status` · `ready` · `dispatch` · `complete` · `review` · `merge`

---

## 三、使用示例（DSH 工具调用）

**1) 路由一个任务**
```
team_router_route(task="分析 TikTok Shop 泰国站美妆个护类目竞争格局，给 3 个高潜力选品方向")
```
返回角色清单并写入 `roster.json`。

**2) 教研任务（自动命中教育域角色）**
```
team_router_route(task="为中职电商课设计一节10分钟试讲教案：电子商务的功能与特性")
```
会自动命中 `Course Designer` / `Instructional Curriculum Expert` / `Training Facilitator` 等。

> 若想手动补位，可用 `include` 参数：
> `team_router_route(task="...", include="Course Designer:creation;Training Facilitator:creation")`

**3) 物化团队 → 调度 → 汇总**
```
team_router_assemble(rosterPath="roster.json", workspace="./run")
team_router_ready(workspace="./run")
team_router_dispatch(workspace="./run", task="t1", member="m1")
team_router_complete(workspace="./run", task="t1", member="m1", output="调研结论...")
team_router_review(workspace="./run", task="tN", verdict="pass", findings="通过")
team_router_merge(workspace="./run", out="report.md")
```

**4) 查看角色库目录（了解可 `--include` 的真实角色名）**
```
team_router_catalog()
```

---

## 四、脱离 DSH 的 CLI 用法（无需 dsh 运行时）

核心逻辑为纯 Node 模块，可直接命令行使用：

```bash
# 路由：任务 → roster.json
node router.js "分析 TikTok Shop 泰国站美妆个护竞争格局，给 3 个高潜力选品方向" --out roster.json

# 查看角色库目录
node router.js --catalog

# 物化团队
node team.js assemble --roster roster.json --workspace ./run

# 查看可派工任务 / 状态
node team.js ready   --workspace ./run
node team.js status  --workspace ./run

# 派工 / 完成 / 审查 / 汇总
node team.js dispatch  --workspace ./run --task t1 --member m1
node team.js complete  --workspace ./run --task t1 --member m1 --output "调研结论..."
node team.js review    --workspace ./run --task tN --verdict pass --findings "通过"
node team.js merge     --workspace ./run --out report.md
```

---

## 五、目录结构

```
dsh-agent-team-router/
├── index.js            # DSH/Cordis 插件入口（注册 team_router_* 工具）
├── router.js           # 路由引擎：TF-IDF 角色匹配 + 阶段分配 + 数量推断
├── team.js             # 团队状态机：建队/派工/完成/审查/汇总 + 质量门禁
├── roles.json          # 内置角色库（多域，含教育域）
├── cordis.patch.yml    # DSH 插件挂载声明
├── package.json        # 插件元信息与 dsh.bundle.patch 声明
├── README.md
├── LICENSE
└── test/smoke.js       # 本地冒烟测试（无需 dsh 运行时）
```

---

## 六、数据契约

- **roster.json**（`route` 产出）：`{ task, generatedAt, roles:[{slot,name,domain,phase,phaseLabel,priority,count,duty,acceptance,handoffTo,matchedTerms,confidence}] }`
- **team.json**（团队状态）：成员展开、任务图（`dependsOn` 阶段依赖）、尝试记录与制品。
- **report.md**（`merge` 产出）：按阶段聚合制品 + 审查意见 + 质量门禁结论。

---

## 七、测试

```bash
npm test        # 等价于 node test/smoke.js
```

冒烟测试覆盖：路由（电商/教研两类任务）、建队与依赖、派工、完成、审查、汇总与门禁。

---

## 八、许可

MIT © fjzzwxp
