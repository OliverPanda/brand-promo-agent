# ADR-001：品牌宣传片自动生成 Agent 的编排框架选型

- **状态**：Accepted（已采纳）
- **日期**：2026-09-03
- **决策人**：Software Architect（铭星链 MingStar 架构通）
- **关联文档**：[PRD — 自动化品宣机器人 Agent](./PRD.md)

---

## 1. 背景（Context）

需要构建一个「自动化品宣机器人 Agent」：用户输入品牌信息（公司/产品/受众/调性/核心卖点），系统**自动产出一支品牌宣传片**（脚本 → 分镜 → 场景素材 → 配音 → 配乐 → 合成 → 交付），并以**网页端**为交付与交互界面。

在启动实现前，需要在两类主流 Agent 编排框架间做选型：

- **Mastra**（TypeScript，Apache-2.0）：Agent + Workflow DAG + Memory + RAG + MCP + Evals + Observability + Studio；工作流为显式有向图，支持 suspend/resume、streaming、Zod 类型校验；原生集成 Next.js / Express / Hono，可部署到 Vercel / Cloudflare / Node 独立服务；已被 Replit、PayPal、SoftBank 用于生产。
- **CrewAI**（Python，MIT）：基于「角色扮演」的多 Agent 协作（Researcher / Writer / QA 等），最快产出多 Agent 原型（约 10 分钟），社区最大（57k+ stars）；但**持久化执行原语与可观测深度较弱**，且为 Python，网页部署需额外包一层 FastAPI + 前端。

## 2. 决策（Decision）

**选用 Mastra（TypeScript）。**

理由按「工作流形态」匹配（2026 年框架选型铁律：按工作流形态选，而非按品牌）：

1. **本场景是确定性流水线，不是自由协作**。宣传片生成有明确的先后步骤与强约束（品牌调性一致性、成本闸门、人工审核门）。Mastra 的 Workflow DAG（`createStep` / `createWorkflow`，`.then()` / `.branch()` / `.parallel()`，suspend/resume，Zod 输入/输出 schema）正是为「步骤在执行前就已明确、需精确控制数据流」的场景设计。CrewAI 的自主角色协商反而会**损害**品牌一致性。
2. **网页原生部署**。Mastra 与本项目现有技术栈（mingstar-bff 即 Next.js、前端 UniApp/TS）同语言；可直接以 Express 独立服务 + 静态前端交付，或后续并入 Next.js BFF。CrewAI 是 Python，需要独立服务 + API + 前端三件套，部署更重。
3. **成本可观测性对视频生成至关重要**。视频/配音/配乐每一步都是真金白银的 API 调用，Mastra 内建 OTel tracing + token/成本追踪 + 人工审核门（suspend 等审批再继续），天然契合「先审脚本、再烧钱生成素材」的节流需求。
4. **LLM 创造力并未牺牲**。Mastra 的 Step 内可调用 Agent（LLM）做脚本/分镜创作，也可调用纯函数做确定性处理；即「需要推理处用模型、需要控制处用代码」。

## 3. 后果（Consequences）

**变得更容易**：
- 类型安全的多步编排与可复现执行（每次运行有结构化 steps 结果）。
- 网页端一键部署、SSE 实时进度推送、Studio 可视化调试。
- 与铭星链现有 TS 栈一致，团队无需引入 Python 技术债。
- 成本/耗时/失败率天然可观测，便于按场景计费（呼应四大阻断域的分润/星钻体系）。

**变得更难 / 接受的权衡**：
- Mastra 社区比 CrewAI 年轻（约 24.8k stars vs 57k），现成「crew 模板」较少——但本场景恰恰不需要现成 crew，反而需要可控 DAG，影响中性偏正。
- 工作流比 CrewAI 的自主 crew 更「脚本化」——对品牌一致性是**特性而非缺陷**，主动接受。
- 若未来需要「多概念自由探索」（一次产出 N 个竞争创意方案），可用 Mastra 的 `.parallel()` 并行多 Agent，而非引入 CrewAI；不引入第二套框架。

**明确的非目标**：不采用 CrewAI；不采用 LangGraph（图最强大但学习曲线陡、对 Vercel/Cloudflare 不友好，超出本项目需求）。

## 4. 供应商接入策略（与 MingStar 既有能力对齐）

- **LLM**：通过统一模型路由接入 one-api（已落库 `deepseek-v4-flash` 等），Mastra model router 单接口切换供应商。
- **视频/图像素材**：优先复用 MingStar ai-core 的 `/api/v1/ai/...`（Seedream 图生图、`doubao-seedream-4-0-250828` 等已预接），其次外部视频 API。
- **TTS / 配乐**：接入 one-api 音频通道（Mureka 已切 one-api 桥）。
- 所有外部依赖均通过 **Provider 接口** 抽象，默认 **DEMO 模式**（确定性离线生成，便于本地运行与演示），环境变量注入真实密钥后切生产。

## 5. M2 执行记录（v0.3 更新）

**决策延续**：M2 按 §4 选定策略落地——真实 Provider 全部经 **one-api（OpenAI 兼容统一网关）** 接入：脚本/分镜走 `/chat/completions`，场景图走 `/images/generations`（Seedream `doubao-seedream-4-0-250828`），配音走 `/audio/speech`，配乐走 Mureka 桥 `/audio/music`；合成走服务端 **FFmpeg**（`PROMO_FFMPEG_BIN`）。工作流代码零改动，仅由 `PROMO_PROVIDER_MODE=real` 切换，DEMO 路径完整保留、零回归。

**M2 工程修正（已落实，详见 PRD §16.9.5）**：
1. **两段式工作流 + store 审批门**（继承 M1 对 Mastra v1.63 suspend/resume 陷阱的规避）：HITL 脚本门放在 `promoScript` 收尾步 suspend，审批通过由 server 冷启动 `promoVideo`。
2. **嵌套工作流 `run.start` 卡死**：在 `promoScript.run.start()` 续跑上下文内直接 `await` 第二个工作流的 `run.start()`，Mastra 引擎会卡在 `storyboard` 之后不再调度后续步骤。改为以 `run.start(...).then(...)` 观察 Promise，并用 `setImmediate` 把成片阶段切到全新事件循环 tick，脱离父 continuation 的 AsyncLocalStorage 上下文。
3. **runId 透传断链**：两段式拆分后 `promoVideo` 的 `storyboard` 步漏带 `runId`，导致其后所有步骤与 `deliver` 的 store 键退化为 Mastra 内部 runId，成片完成却 `PromoRun.status` 永远 `running`、SSE `run-done` 被前端按 user-runId 过滤。已为各步返回对象补回 `runId: rid`。

**成本与预算（FR-10）**：真实 Provider 回传 `_usage`（tokens/images/minutes/tracks/videos）→ `cost.js` 单价表预估 → 归集 `PromoRun.cost` → `checkBudget` 对 `PROMO_BUDGET_CAP`（默认 ¥20，运行时实时读取）闸门，超限中止。M2 仅做预估+闸门+归集，不接四大阻断域真实计费/扣星钻（预留 `cost` 结构）。

**验证**：`node --test tests/` 全绿（35 例，含 M2 新增 25 例：mock fetch 验证 one-api 请求构造/响应解析、成本/预算逻辑、真实端到端成本归集、极小预算触发超限中止、`/api/config`）；DEMO 与 real 两条路径均端到端跑通。

## 6. M3 执行记录（v0.4 更新）

**范围延展**：M3 按 §13 落地 HITL 完整化（FR-9.2 成片门）+ 成本配额（账户级累计）+ 历史记录（持久化）+ 真实参考图图生图，达到**可上线内测**。

**M3 工程修正（已落实）**：
1. **成片门改用 server 侧状态机，不放在 Mastra suspend**：M2 已证实 `resume()` 重跑被挂起步骤后不继续下游 DAG。FR-9.2 成片门改为——`promoVideo` 止于 `composite`；composite 完成后 server 置 `awaiting_delivery` + 广播 `final-review` SSE 事件；`/approve` 的 `approve` 分支调纯函数 `publishDelivery`（标记 success + run-done），`reject` 分支重跑成片阶段（整段重生成，beta 简化）。彻底规避 v1.63 续跑陷阱。
2. **M3 回归——脚本失败误启成片阶段**：Mastra `promoScript.run.start()` 在脚本步因预算/配额抛错时**以 resolve 而非 reject 返回**（status 落 `failed`）。原 `runScriptPhase` 的 `else` 分支据此继续冷启动成片阶段，落入嵌套上下文卡死（storyboard 后莫名置 `success`）。修复：`runScriptPhase` 在 `run.start` 返回后检查 `getRun(runId).status === "failed"` 即返回，保留 failed 终态，不再启动成片阶段。
3. **持久化落地**：`store.js` 由进程内 Map 改为「内存 Map + 原子写穿（temp→rename）」，`<PROMO_DATA_DIR>/runs.json`；启动 hydrate 恢复历史。`quota.js` 按账户累计配额，文件 `quotas.json` 持久化。`PROMO_PERSIST=0` 可关闭写穿（测试用）。

**成本双闸门**：`workflow.recordCost` 对真实 `_usage` 先 `checkBudget(单 run PROMO_BUDGET_CAP)` 再 `checkQuota(账户 PROMO_QUOTA_CAP)`，均超限即中止。新增 `GET /api/quota`、`GET /api/admin/costs`、`/api/config.quotaCap`。

**验证**：`node --test tests/` 全绿（48 例，M3 新增 13 例：store-persist 子进程 round-trip、quota 配额/累计/QuotaExceededError、server 成片门 awaiting→approve / reject→重生成、/api/quota、providers 参考图 data:/URL/关键词 三用例、workflow 极小配额触发 QuotaExceededError）；DEMO 与 real 两路径均端到端跑通，含两段 HITL 门与历史持久化。
