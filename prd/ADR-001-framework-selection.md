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
