# PRD — 自动化品宣机器人 Agent（品牌宣传片自动生成）

| 项 | 内容 |
|----|------|
| 文档版本 | v0.5（M1 + M2 + M3 + M4 执行基线） |
| 日期 | 2026-09-03 |
| 负责人 | 铭星链 MingStar 主理人 / 交付总监 |
| 架构选型 | **Mastra（TypeScript）** —— 见 [ADR-001](./ADR-001-framework-selection.md) |
| 交付形态 | 网页端（Web）单页应用 + 后端 Agent 工作流服务 |
| 状态 | M1（DEMO）+ M2（真实 one-api Provider + 成本预算）+ M3（HITL 成片门 + 账户配额 + 历史持久化 + 参考图图生图）+ **M4（模板库 + 多语言）已完成**；**全量上线就绪（部署清单见 §16.11）**。本期**小程序并入** 按用户决策不做（详见 §16.11.1 范围锁定） |

---

## 0. 术语表

| 术语 | 含义 |
|------|------|
| Brief | 品牌简报：用户填写的品牌/产品/受众/调性/卖点等结构化输入 |
| Agent | 基于 LLM 的自治推理单元（Mastra Agent） |
| Workflow | 由多个 Step 组成的有向执行图（Mastra Workflow） |
| Step | 工作流中的一个可执行单元（可调用 Agent / 工具 / 纯函数） |
| 场景（Scene） | 宣传片的一个镜头单元，含画面描述、台词、时长、素材 |
| 分镜（Storyboard） | 全部 Scene 的结构化集合 |
| HITL | Human-In-The-Loop，人工审核门 |
| Provider | 对外部能力（LLM/视频/TTS/音乐）的适配层抽象 |
| DEMO 模式 | 使用确定性离线生成，无需任何外部密钥即可本地运行 |

---

## 1. 背景与目标

### 1.1 背景
铭星链（MingStar）已具备 AIGC 素材生成能力（文生图/图生图 Seedream、音乐 Mureka、视频合成等）。但目前这些能力是「原子工具」，需要人逐个调用、拼接、反复调参，才能产出一支宣传片。**缺乏一条把「一句话品牌诉求」直接变成「成片」的端到端自动化链路**。

### 1.2 目标
构建一个**自动化品宣机器人 Agent**，让市场/运营人员（甚至老板）在网页端填一份品牌简报，系统自动：
1. 生成宣传片**脚本**（旁白文案 + 结构）；
2. 生成**分镜**（镜头拆解）；
3. 逐场景生成**画面素材**（图/视频）；
4. 生成**配音**（TTS）；
5. 生成/选取**配乐**；
6. **合成**成片并**交付**（生成可播放/下载链接）。

全程网页端可见、可干预、可追溯。

### 1.3 成功指标（北极星）
- **首次成片时间（Time-to-First-Video）**：从提交 Brief 到拿到可看成片 < 5 分钟（DEMO 模式 < 10 秒）。
- **一次通过率**：用户无需返工即采纳成片的比例 ≥ 60%。
- **成本可控**：单次成片外部 API 花费可预估、可设上限、可审计。
- **品牌一致性**：成片调性偏离 Brief 的比例 < 10%（模型评审 + 人工抽检）。

---

## 2. 范围

### 2.1 In Scope（本期）
- 网页端 Brief 表单 + 实时流水线进度 + 成片交付页。
- 端到端 Mastra Workflow：Brief → 脚本 → 分镜 → 场景素材 → 配音 → 配乐 → 合成 → 交付。
- DEMO 模式（离线确定性生成）与真实 Provider 接入（one-api / MingStar ai-core）双轨。
- 关键人工审核门（脚本确认、成片确认）。
- 运行日志 / 成本追踪（OTel 风格）。
- 多语言生成（复用 MingStar 全局语言提示词能力）。

### 2.2 Out of Scope（本期不做）
- 真实支付/计费扣星钻（仅预留钩子，接入四大阻断域的分润/星钻体系为后续）。
- 多平台自动发布（抖音/视频号自动上传）——仅产出可下载文件与链接。
- 实时数字人/口播真人形象生成。
- 复杂的 A/B 多概念并行探索（架构预留 `.parallel()`，本期不做 UI）。
- 移动端原生（小程序）版本——网页端优先，后续可并入 mingstar-miniapp。

---

## 3. 用户角色

| 角色 | 描述 | 核心诉求 |
|------|------|----------|
| 品牌主 / 老板 | 非技术，只想要「一条好片子」 | 极简输入、快速出片、看得懂进度 |
| 市场运营 | 日常产出宣传内容 | 模板复用、批量、可控调性、成本透明 |
| 剪辑/设计师 | 对成片质量要求高 | 可中途介入、可导出分镜与素材二次精修 |
| 管理员 | 平台运营 | 成本监控、配额、供应商路由、审核队列 |

---

## 4. 用户故事

- 作为**品牌主**，我想填好公司名、产品、一句话卖点、想要「科技感」，点击生成，几分钟后拿到一支带配音和配乐的 30 秒宣传片，这样我不用懂剪辑也能做品宣。
- 作为**市场运营**，我想保存一套品牌模板（Logo 色、口号、禁用词），下次一键套用，保证调性统一。
- 作为**市场运营**，我想在脚本生成后先预览再决定是否花预算生成视频，避免浪费。
- 作为**设计师**，我想下载分镜 JSON 和每张场景图，便于在 PR 里二次精修。
- 作为**管理员**，我想看到每个 Brief 花了多少钱、调了哪个模型、哪一步最慢，便于优化成本。

---

## 5. 功能需求（FR）

### FR-1 品牌 Brief 采集
- **FR-1.1** 网页端表单字段：
  - 公司/品牌名（必填）
  - 产品/服务名（必填）
  - 一句话核心卖点（必填，≤ 60 字）
  - 目标受众（下拉+自定义：Z世代/白领/企业采购/宝妈…）
  - 宣传调性（多选：科技感/温情/高端/国潮/搞笑/专业…）
  - 核心信息点（多行，可列 1–5 条）
  - 期望时长（15s / 30s / 60s / 90s）
  - 画面风格参考（可选：关键词或参考图 URL）
  - 语言（复用 MingStar 全局语言提示词：zh-CN/zh-TW/en/ja/ko）
  - 配音音色（男声/女声/沉稳/活泼…）
  - 是否启用 HITL 审核门（默认开启脚本门）
- **FR-1.2** 表单校验：必填项、卖点长度、时长合法性。
- **FR-1.3** 支持「从模板加载」：预置 ≤ 5 个品牌模板（含 Logo 主色、禁用词、默认调性）。

### FR-2 脚本生成（Agent）
- **FR-2.1** 调用脚本 Agent（LLM），依据 Brief 产出：
  - 标题
  - 旁白文案（按时长估算字数，含时间轴标记）
  - 结构（开场钩子 → 痛点 → 方案 → 卖点 → CTA）
  - 情绪曲线标注
- **FR-2.2** 须遵循品牌约束：禁用词过滤、调性一致性、语言一致。
- **FR-2.3** 输出结构化 JSON（供后续步骤消费），并渲染为可读预览。

### FR-3 分镜生成（Agent）
- **FR-3.1** 依据脚本拆解为 N 个 Scene（N 由时长决定：约每 3–5s 一个镜头）。
- **FR-3.2** 每个 Scene 含：
  - 画面描述（prompt，供图像/视频生成）
  - 台词/字幕
  - 镜头运动（推/拉/摇/固定）
  - 时长
  - 是否需要配乐高潮点
- **FR-3.3** 全片视觉风格统一（色彩/光线/主体一致性约束）。

### FR-4 场景素材生成（Provider）
- **FR-4.1** 对每个 Scene 生成画面素材（图或短视频片段）。
- **FR-4.2** 支持参考图输入（图生图，复用 Seedream 参考图免费能力）。
- **FR-4.3** 失败重试与降级：单场景失败不阻断全片，标记后跳过/用占位。
- **FR-4.4** 并行生成（Mastra `.parallel()` 或 Provider 批量），控制并发与配额。

### FR-5 配音生成（TTS Provider）
- **FR-5.1** 依据旁白文案 + 选定音色生成音频。
- **FR-5.2** 支持字幕时间轴对齐（SRT 产出）。
- **FR-5.3** 多语言配音（与 FR-1 语言一致）。

### FR-6 配乐生成/选取（Music Provider）
- **FR-6.1** 依据情绪曲线生成或选取背景音乐。
- **FR-6.2** 支持用户上传/从曲库选取（后续）。
- **FR-6.3** 淡入淡出与情绪点对齐。

### FR-7 合成（Video Provider）
- **FR-7.1** 将场景素材 + 配音 + 配乐 + 字幕合成为最终视频。
- **FR-7.2** 输出 MP4（H.264）+ 封面图 + 时长。
- **FR-7.3** 失败回退：若合成服务不可用，至少交付「分镜幻灯片 + 音频」可下载包。

### FR-8 交付
- **FR-8.1** 成片页展示：视频播放器、分镜故事板画廊、可下载资源（MP4 / SRT / 分镜 JSON / 脚本）。
- **FR-8.2** 生成分享链接（短期有效）。
- **FR-8.3** 历史记录列表（我的宣传片）。

### FR-9 人工审核门（HITL）
- **FR-9.1** 脚本门：脚本生成后 suspend，用户确认/修改后再继续 costly 的素材生成。
- **FR-9.2** 成片门：合成后用户验收，不通过可指定某 Scene 重生成。
- **FR-9.3** 超时自动通过（可配置，避免卡死）。

### FR-10 成本与配额
- **FR-10.1** 每次运行预估花费上限（Budget Cap），超限中止并提示。
- **FR-10.2** 每步 token/费用归集到本次运行。
- **FR-10.3** 管理员视图：按用户/模型/步骤的成本报表。

### FR-11 可观测与追溯
- **FR-11.1** 每次运行有 runId，全链路步骤状态/输入输出/耗时/费用可追溯。
- **FR-11.2** SSE 实时推送进度到前端。
- **FR-11.3** 错误统一结构（step / code / message / retryable）。

### FR-12 多语言与全球化
- **FR-12.1** 复用 MingStar 全局语言提示词机制，语言作为全局约束注入每步 prompt。
- **FR-12.2** 成片语言与 Brief 语言一致。

---

## 6. 非功能需求（NFR）

| 类别 | 要求 |
|------|------|
| 性能 | DEMO 模式端到端 < 10s；生产模式（含真实视频生成）P95 < 5min；单步超时 120s（视频步可更长）。 |
| 可扩展 | 水平扩展：Agent/Workflow 服务无状态，外部调用经 Provider 抽象；重负载可上队列（BullMQ/SQS）。 |
| 可靠性 | 单场景失败不阻断全片；步骤级重试（指数退避）；工作流 suspend/resume 持久化。 |
| 成本 | 每次运行 Budget Cap 可配；费用可观测；模型路由可切换（贵→便宜降级）。 |
| 品牌安全 | 禁用词过滤、调性一致性校验、输出护栏（防注入/违规）。 |
| 安全 | API Key 仅服务端；前端不持密钥；用户隔离（runId 归属）。 |
| 可观测 | OTel tracing + 成本/时延/错误率埋点；可接 Langfuse/Datadog。 |
| 合规 | 生成内容版权与肖像权提示；保留人工验收记录。 |

---

## 7. 数据模型（核心实体）

```ts
interface BrandBrief {
  brandName: string;
  productName: string;
  coreSellingPoint: string;        // ≤60字
  audience: string[];
  tones: string[];                 // 科技感/温情/...
  keyMessages: string[];
  durationSec: 15 | 30 | 60 | 90;
  styleReference?: string;         // 参考图 URL/关键词
  language: 'zh-CN' | 'zh-TW' | 'en' | 'ja' | 'ko';
  voiceTone: string;               // 男声/女声/沉稳...
  hitlEnabled: boolean;
}

interface Script {
  title: string;
  voiceover: { timecode: string; text: string }[];
  structure: string[];
  moodCurve: string[];
}

interface Scene {
  index: number;
  visualPrompt: string;
  subtitle: string;
  camera: 'push' | 'pull' | 'pan' | 'fixed';
  durationSec: number;
  musicClimax?: boolean;
  mediaUrl?: string;               // 生成后回填
  status: 'pending' | 'generating' | 'done' | 'failed';
}

interface PromoRun {
  runId: string;
  brief: BrandBrief;
  script?: Script;
  storyboard?: Scene[];
  voiceUrl?: string;
  musicUrl?: string;
  videoUrl?: string;
  status: 'running' | 'suspended' | 'success' | 'failed';
  cost: { step: string; tokens: number; amount: number }[];
  createdBy: string;
  createdAt: string;
}
```

---

## 8. API 契约（草案）

### POST /api/generate
- 请求：`BrandBrief`
- 响应：`{ runId }`，随后通过 SSE 推送进度。

### GET /api/generate/:runId/stream （SSE）
- 事件：`step-start` / `step-progress` / `step-done` / `step-failed` / `run-done` / `run-failed`
- 每事件携带 `{ runId, step, status, output?, error? }`

### POST /api/generate/:runId/approve
- 用于 HITL 审核门：脚本确认后继续 / 成片验收。
- 体：`{ decision: 'approve' | 'reject', edits?: Partial<Script> }`

### GET /api/runs/:runId
- 返回 `PromoRun` 完整状态（历史/详情页）。

### GET /api/runs
- 当前用户的历史列表。

---

## 9. Agent / Workflow 架构（Mastra）

```
                 ┌─────────────────────────────────────────┐
   网页端 Brief ─▶│            Mastra Workflow               │
                 │                                          │
                 │  ingestBrief                             │
                 │      │                                   │
                 │      ▼                                   │
                 │  writeScript (Agent: LLM)  ─┐ HITL 脚本门 │
                 │      │                      │ suspend    │
                 │      ▼                      │ resume     │
                 │  storyboard  (Agent: LLM)  ┘            │
                 │      │                                   │
                 │      ▼                                   │
                 │  generateScenes (Provider×N, parallel)   │
                 │      │                                   │
                 │      ▼                                   │
                 │  voiceover (TTS Provider)                │
                 │      │                                   │
                 │      ▼                                   │
                 │  music (Music Provider)                 │
                 │      │                                   │
                 │      ▼                                   │
                 │  composite (Video Provider)             │
                 │      │                                   │
                 │      ▼                                   │
                 │  deliver  ──▶ 成片页 / 分享链接           │
                 └─────────────────────────────────────────┘
```

- **步骤即 Mastra Step**：每个环节 `createStep({ id, inputSchema, outputSchema, execute })`。
- **流式进度**：Step 内向事件总线 `emit(runId, {step, status, output})`，服务端 SSE 转发。
- **HITL**：`writeScript` 后 `suspend`，等待 `/approve` 再 `resume`。
- **并行**：`generateScenes` 用 `.parallel()` 或 Provider 内部批量，控制并发与配额。
- **可观测**：每步 `cost` 归集；失败 `status: failed` 不阻断（标记后继续）。

---

## 10. Provider 集成策略

所有外部能力经 **Provider 接口** 抽象，默认 **DEMO**（离线确定性），环境变量注入后切生产：

| 能力 | DEMO 实现 | 生产实现 |
|------|-----------|----------|
| LLM（脚本/分镜） | 模板化确定性生成 | one-api → `deepseek-v4-flash` 等 |
| 图像/视频素材 | SVG 占位图（按 Scene 描述生成） | MingStar ai-core `/api/v1/ai/...`（Seedream 图生图、`doubao-seedream-4-0-250828`） |
| TTS 配音 | 静音/占位音频 + SRT | one-api 音频通道（Mureka 桥） |
| 配乐 | 占位音轨 | one-api 音乐通道 |
| 合成 | 分镜幻灯片打包 | 服务端 FFmpeg / MingStar 合成服务 |

> 切换只需实现对应 Provider 接口并设置环境变量，**工作流代码不变**。

---

## 11. 部署拓扑（Web）

```
┌──────────────┐      ┌────────────────────────────┐      ┌──────────────────────┐
│  浏览器 SPA  │─────▶│  Web 服务 (Express)         │─────▶│  Mastra Workflow 引擎 │
│ (Brief表单/  │ SSE  │  - 静态前端                 │      │  - Agents + Steps    │
│  进度/成片)  │◀─────│  - /api/generate (SSE)     │◀─────│  - Event Bus          │
└──────────────┘      └────────────────────────────┘      └──────────┬───────────┘
                                                                     │ Provider 抽象
                                                                     ▼
                                                          ┌──────────────────────┐
                                                          │ one-api / ai-core /  │
                                                          │ TTS / Music / 合成    │
                                                          └──────────────────────┘
```

- **形态 A（本期原型）**：单进程 Node（Express + Mastra 同进程），前端静态托管，本地 `localhost` 运行。
- **形态 B（生产）**：Mastra 部署到 Vercel/Cloudflare 或独立 Node 服务；重负载场景在 Workflow 前加队列（BullMQ/SQS）解耦请求与执行；存储用 PostgreSQL/LibSQL 持久化运行态。

---

## 12. 验收标准（DoD）

- [ ] 网页端可填写 Brief 并提交，SSE 实时显示 8 步进度。
- [ ] DEMO 模式下，无需任何外部密钥，端到端产出「分镜画廊 + 脚本 + 占位成片」可下载。
- [ ] 脚本 HITL 门可在用户确认后才继续后续步骤。
- [ ] 单场景生成失败不影响全片，且在前端明确标记。
- [ ] 每次运行有 runId，可查步骤耗时/费用归集。
- [ ] 生产 Provider 接入后（注入密钥），同样工作流产出真实 MP4。
- [ ] `vue-tsc`/类型检查无新增错误；核心 Workflow 单测覆盖各 Step 输入输出。

---

## 13. 里程碑（草案）

| 阶段 | 内容 | 交付 |
|------|------|------|
| M1 | 选型 + PRD + 架构（本期） | 本文档 + ADR-001 + Web 原型（DEMO） |
| M2 | 真实 Provider 接入（one-api/ai-core）+ FR-10 成本预算 | 产出真实 MP4 + 成本归集与预算闸门（详见 §16.9） |
| M3 | HITL 完整化 + 成本配额 + 历史记录 | 可上线内测（已完成，见 §16.10） |
| M4 | 模板库 + 多语言（**小程序并入按用户决策本期不做**） | 全量上线就绪（部署清单见 §16.11） |

---

## 14. 风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| 真实视频 API 成本高/慢 | 体验差、烧钱 | Budget Cap + 模型降级 + DEMO 默认 |
| 品牌调性漂移 | 成片不符预期 | 脚本 HITL 门 + 调性校验 + 模型评审 |
| 单步失败导致全失败 | 出不了片 | 步骤级重试 + 容错降级 |
| 外部服务不稳定 | 超时 | 指数退避 + 超时自动通过/占位 |
| 密钥泄露 | 安全 | 仅服务端 + 环境变量 + 轮换 |

---

## 15. 开放问题（v0.2 已决议）

> v0.2 将以下开放问题全部给出 M1 可执行基线决策；需结合四大阻断域（分润/星钻）的部分明确推迟到 M2/M3，不在本期阻塞。

1. **成片时长上限与单次成本上限默认值** →
   - M1 DEMO 为离线确定性，零外部成本，故**不引入真实预算闸**；仅做参数合法性（时长 ∈ {15,30,60,90}s，**M1 上限 90s**，默认 30s）。
   - 生产模式（M2）预算上限（如 ¥20/次）与四大阻断域分润/星钻体系挂钩，本期不接入计费，仅预留 `cost` 字段结构（见 §7 `PromoRun.cost`）与 Provider 调用埋点位置。
2. **脚本门前是否做 A/B 多方案** → **M1 不做**。每 run 仅产出 1 版脚本（与 §2.2 Out-of-Scope「A/B 多概念并行」一致，推迟到 M4）。PRD §9 工作流保持单链 `writeScript → storyboard`。
3. **参考图与资产库打通** → **M1 仅接受可选 `styleReference`（关键词字符串或 URL）字段并透传**，不实现真实图生图（Provider 生产路径未接通，见 §10）。DEMO 模式下该字段仅参与 SVG 占位图的文案标注，不影响确定性输出。与 MingStar 资产库（ai-core 资产服务）的打通列为 M2 接入项。
4. **管理员成本报表计费口径** → **M1 不实现计费/报表**。M2 直接复用 ai-core 计费模块（经 one-api 的 token/费用回写），不在本期重复造轮子；PRD §10 Provider 策略已锁定「one-api 统一路由」通道。

## 16. M1 执行基线（v0.2 新增，本期末交付目标）

> 本章是 v0.2 相对 v0.1 的核心增量：把「M1 Web 原型（DEMO）」从目标陈述落地为**可构建、可运行、可验收**的明确基线。其余章节（FR/NFR/数据模型/API/架构）保持不变，本章只做**锁定与补充**。

### 16.1 M1 范围锁定（与 §2 对齐的本期子集）
- ✅ PRD §1~§12 中 **DEMO 模式**能离线跑通的部分：FR-1（Brief 采集）、FR-2（脚本）、FR-3（分镜）、FR-4（场景素材，确定性 SVG 占位）、FR-5（配音 SRT）、FR-6（配乐占位）、FR-7（合成占位打包）、FR-8（交付页）、FR-9（脚本 HITL 门）、FR-11（SSE 实时进度 + runId 追溯）、FR-12（多语言）。
- ⏸️ 明确推迟：FR-10 成本配额（M2）、FR-9.2 成片门（M2，M1 仅脚本门）、历史列表持久化（M1 用进程内 Map，重启即清空）、真实 MP4 合成（M2）、参考图图生图（M2）。

### 16.2 目录与文件落地清单（M1）
```
brand-promo-agent/
├── package.json            # 补齐缺失的 src/server.js 入口（dev/start）
├── prd/PRD.md              # 本文档 v0.2
├── prd/ADR-001-*.md        # 框架选型（已采纳）
├── src/
│   ├── server.js           # 【新增】Express + Mastra 装配 + SSE + 静态托管
│   ├── mastra/
│   │   ├── workflow.js      # 【新增】createWorkflow 编排 8 步，脚本步 suspend
│   │   ├── providers.js     # 【已有】6 能力 Provider 抽象 + DEMO 实现
│   │   ├── eventBus.js      # 【已有】EventEmitter 进度总线
│   │   └── svg.js           # 【已有】encodeSVG
│   ├── store.js            # 【新增】进程内 PromoRun 状态表（Map）
│   └── schemas.js          # 【新增】Zod BrandBrief / 各步输入输出 schema
├── public/index.html       # 【新增】Brief 表单 + SSE 进度 + 交付页（原生 JS，无构建）
└── tests/                  # 【新增】providers/eventBus/server 冒烟
```

### 16.3 Provider 接口签名（M1 锁定，对应 §10）
```js
generateScript(brief) -> { title, voiceover[{timecode,text}], structure[], moodCurve[], language }
generateStoryboard(brief, script) -> Scene[]   // Scene: {index, visualPrompt, subtitle, camera, durationSec, musicClimax, status}
generateSceneMedia(scene, brief) -> { mediaUrl(data:image/svg), kind:'image', model }
generateVoiceover(script, brief) -> { voiceUrl:null, srt, voiceTone, model }
generateMusic(brief, storyboard) -> { musicUrl:null, mood, model }
composite(scenes, voice, music, brief) -> { videoUrl:null, poster, storyboardGallery[], srt, note, model }
```
> DEMO 实现已存在于 `providers.js`；生产实现（one-api/ai-core）按 §10 在 M2 接通，本期所有生产分支 `throw "real provider not wired"` 即为预期。

### 16.4 工作流拓扑（对应 §9，Mastra v1.63 API）
```
ingestBrief(Zod BrandBrief)
  → writeScript(Agent/LLM; DEMO=模板) ── suspend(脚本 HITL, 等 /approve) ── resume
  → storyboard(Agent/LLM; DEMO=模板)
  → generateScenes(Provider×N, .parallel() 或串行)
  → voiceover(TTS Provider) → music(Music Provider) → composite(Video Provider) → deliver
```
- 运行引擎：`new Mastra({ workflows:{promo}, storage: new InMemoryStore() })`（`@mastra/core/storage` 的 `InMemoryStore`，进程内持久化以支持 suspend/resume）。
- 进度：`writeScript/storyboard/generateScenes/voiceover/music/composite` 每步 `execute` 内调 `eventBus.emitProgress(runId, step, status, data)`。
- HITL：`writeScript` 步 `execute` 内 `await suspend({ script })`；`POST /api/generate/:runId/approve` 调 `run.resume({ resumeData:{ decision, edits } })`。

### 16.5 API 端点（对应 §8，M1 全量实现）
- `POST /api/generate` → `{ runId }`（校验 BrandBrief，建 PromoRun，启动 workflow `createRun().start()`）
- `GET /api/generate/:runId/stream` → SSE（`step-start|step-progress|step-done|step-failed|run-done|run-failed`）
- `POST /api/generate/:runId/approve` → `{ decision:'approve'|'reject', edits? }`（脚本门 resume）
- `GET /api/runs/:runId` → `PromoRun`
- `GET /api/runs` → `PromoRun[]`（进程内，M1 不持久化）

### 16.6 前端行为（对应 FR-1/FR-8/FR-11）
单文件 `public/index.html`（原生 HTML+JS，无构建步骤）：
1. Brief 表单（字段同 FR-1.1，含语言下拉复用 MingStar 全局语言枚举 zh-CN/zh-TW/en/ja/ko）。
2. 提交 → `POST /api/generate` → 拿到 runId → `EventSource(/api/generate/:runId/stream)` 实时渲染 8 步进度条。
3. 脚本步 `suspend` 时前端弹出「脚本预览 + 确认/修改」门，点确认 → `POST /approve`。
4. `run-done` 后渲染交付页：分镜画廊（每 Scene 的 SVG 占位图 + 字幕）、脚本全文、SRT 下载、占位成片说明。

### 16.7 M1 DoD（验收，对应 §12）
- [ ] `npm install` 后 `npm start` 无报错，监听端口（默认 3000）。
- [ ] 网页端填 Brief 提交，SSE 实时显示 ≥8 步进度直至 `run-done`。
- [ ] DEMO 模式零外部密钥，端到端产出「分镜画廊 + 脚本 + SRT + 占位成片说明」可查看/下载。
- [ ] 脚本 HITL 门：未 `/approve` 前不进入 storyboard；`/approve` 后继续。
- [ ] 单场景失败（注入故障）不阻断全片，前端明确标记（M1 至少代码层 `try/catch` 标记 `status:'failed'` 占位）。
- [ ] 每次运行有 runId，`GET /api/runs/:runId` 返回完整 `PromoRun`（含 steps 耗时）。
- [ ] `node --test` 或 vitest 冒烟：providers demo 确定性、eventBus、server 端到端（POST→runId→SSE run-done→GET 状态）。

### 16.8 构建与验证步骤
1. `npm install`（已完成，225 包）。
2. 写 `src/schemas.js` / `src/store.js` / `src/mastra/workflow.js` / `src/server.js` / `public/index.html` / `tests/*`。
3. `node src/server.js` 启动，用 `curl` 跑 `POST /api/generate` + 读 SSE + `GET /api/runs/:runId` 验证。
4. `node --test tests/` 跑单测。
5. 满足 §16.7 DoD 即 M1 完成；提交 git（本期首次纳入版本控制）。

### 16.9 M2 执行基线（v0.3 新增，真实 Provider + 成本预算）

> M2 把 §10 选定的「one-api（OpenAI 兼容统一网关）」真实通道接通，并补齐 §15 决议中推迟到 M2 的 **FR-10 成本配额与预算上限**、FR-9.2 成片门（成片阶段已纳入预算闸门）、参考图图生图透传、成本报表（复用 ai-core 计费埋点结构）。**DEMO 路径完全保留、零回归**；真实路径仅在 `PROMO_PROVIDER_MODE=real` 时启用。

#### 16.9.1 M2 范围锁定（相对 §16.1 的增量）
- ✅ **真实 Provider 接入（one-api）**：脚本/分镜（LLM `/chat/completions`）、场景图（`/images/generations`，Seedream `doubao-seedream-4-0-250828`）、配音（`/audio/speech` TTS）、配乐（`/audio/music`，Mureka 桥），均经 `globalThis.fetch` 调 one-api，请求/响应严格按 OpenAI 兼容协议解析。
- ✅ **真实 MP4 合成**：服务端 FFmpeg（`PROMO_FFMPEG_BIN`）将场景图 + 配音 + 配乐合流为 MP4；未配置 FFmpeg 或合成失败时优雅降级为分镜包（DEMO 同款），不阻断交付。
- ✅ **真实链路全打通（2026-09 真机验证，new-api 网关 :3501 + 本机 ffmpeg 8.0）**：① seedream/doubao 渠道 `size` 用词汇 `1K|2K|4K` 并带 `aspect_ratio:"16:9"`（像素写法如 1024x576 该渠道拒绝，按 model 前缀自动归一）；② seedream 对 aspect 是 best-effort——同批 5 镜实测混出 1152×864 / 864×1152 竖图 / 1312×736，而 concat 要求同几何 → 合成层每镜 `scale+pad` 归一到 1280×720(16:9) 黑边画布再 concat，异源尺寸免疫；③ voiceover/music 渠道缺失（如 `tiny-iceberg` 无对应 TTS channel → 网关报 `No available channel`）时置 null **降级继续**，不再中断整链，成片仍产出（静音片）；④ 成片 `file://` 路径在 server API 边界统一映射为 `GET /api/video/:runId`（sendFile 带 Range 支持拖动），SSE（run-done/final-review）与 `GET /api/runs` 均经 `toPublicRun` 序列化，浏览器可播可下载。
- ✅ **FR-10 成本配额与预算上限**：真实 Provider 回传 `_usage`（tokens / images / minutes / tracks / videos），经 `cost.js` 单价表预估 → 归集到 `PromoRun.cost` → `checkBudget` 对 `PROMO_BUDGET_CAP`（默认 ¥20）闸门，超限抛 `BudgetExceededError` 中止并提示。
- ✅ **参考图图生图透传**：`brief.styleReference` 在真实图像生成时拼入 prompt（「参考风格：…」），DEMO 仅做 SVG 文案标注。
- ✅ **成本可见性**：前端 `GET /api/config` 暴露 `mode`/`provider`/`budgetCap`；交付页渲染每步 ¥ 明细与总额/上限对比。
- ⏸️ **仍推迟**：四大阻断域真实计费/扣星钻（仅预留 `cost` 结构，不接计费回写）；运行态持久化（M3，进程内 Map）；真实图生图模型（Seedream 参考图输入，M2 仅关键词透传）。

#### 16.9.2 M2 文件落地清单
```
src/
├── mastra/providers.js   # 【重写】getProviderMode() 门控；real 分支 oneApiPost() 调 one-api；DEMO 分支原样保留
├── cost.js               # 【新增】PRICING 单价表 + costFor/sumCost/checkBudget/BudgetExceededError/getBudgetCap
├── mastra/workflow.js    # 【修改】recordCost() 归集成本 + 预算闸门；各步透传 runId 修复（见 §16.9.5）
├── server.js             # 【修改】runVideoPhase 以 .then 观察 run.start（规避 Mastra 嵌套上下文卡死）；新增 GET /api/config
├── store.js              # 【不变】
├── schemas.js            # 【不变】
├── mastra/eventBus.js    # 【不变】
└── mastra/svg.js         # 【不变】
public/index.html          # 【修改】模式徽标（DEMO/真实）+ 成本卡片
tests/
├── providers.test.mjs    # 【不变】DEMO 确定性
├── providers-real.test.mjs # 【新增】mock fetch 验证 one-api 请求构造 + 响应解析 + _usage
├── cost.test.mjs         # 【新增】单价/汇总/预算闸门/BudgetExceededError
├── workflow-real-budget.test.mjs # 【新增】真实端到端成本归集 + 极小预算触发超限中止 + /api/config
└── server.test.mjs       # 【不变】HITL 开/关门 + 端到端
```

#### 16.9.3 真实 Provider 接口签名（M2 接通，对应 §10）
```js
// 真实模式（PROMO_PROVIDER_MODE=real）下，以下函数改走 one-api（OpenAI 兼容）：
generateScript(brief)          -> /chat/completions (response_format=json_object) -> {..., _usage:{tokens}}
generateStoryboard(brief,script)-> /chat/completions                              -> Scene[] 每镜 {..., _usage:{tokens}}
generateSceneMedia(scene,brief)-> /images/generations (model=PROMO_IMAGE_MODEL)    -> {mediaUrl, kind, _usage:{images:1}}
generateVoiceover(script,brief)-> /audio/speech (isBinary)                        -> {voiceUrl:data:audio/mp3;base64, srt, _usage:{minutes}}
generateMusic(brief,storyboard)-> /audio/music (model=PROMO_MUSIC_MODEL)          -> {musicUrl, mood, _usage:{tracks:1}}
composite(scenes,voice,music,brief) -> ffmpegAssemble() (PROMO_FFMPEG_BIN)        -> {videoUrl:file://...mp4, ..., _usage:{videos:1}}
// 合成实现（2026-09 真机修复后）：全镜有 videoUrl → ffmpegAssembleVideo（concat demuxer 直拼，保留编码）；
//   否则静态图幻灯 ffmpegAssemble —— 每图 -loop 1 -t <dur> 独立输入 + concat filter 拼接（不用 concat demuxer 的 duration 行：
//   其语法对单帧图片末段时长不可靠）。音频：voice 直 map（-map <idx>:a，无方括号）、voice+music 走 amix；输出 -t <画面总时长>
//   （音短尾部静音、音长截断，不用 -shortest 防画面被截到音轨长）。ffmpeg 需支持读 PNG/解码场景图（无 librsvg 构建不可用 SVG 素材）。
// 2026-09 真实网关适配追加：① 远程图按内容魔数嗅探真实扩展名落盘（png/jpg/webp——seedream 返回 JPEG 字节写 .png 必解码失败）；
//   ② 每镜先 scale+pad 归一到 1280×720 黑边画布再 concat（seedream 对 aspect_ratio 是 best-effort，混尺寸直拼必炸）；
//   ③ ffmpeg 失败抛错截 stderr 尾 400 字符（头部只有版本横幅）。④ videoUrl 在 providers 层仍为 file://，server API 边界 toPublicRun 映射为 /api/video/:runId。
// 任一真实步无 _usage（如未配置 FFmpeg 的合成降级）则不计成本；DEMO 模式全程无 _usage 不计成本。
```
> 模式判定：`getProviderMode()` 仅在 `PROMO_PROVIDER_MODE==="real"` 返回 `"real"`，否则 `"demo"`（安全默认，零外部依赖）。工作流代码不变，仅 env 切换。

#### 16.9.4 成本与预算（FR-10，对应 §15 决议）
- 单价表 `PRICING`（CNY，元）：`writeScript/storyboard` ¥0.004/1k tokens；`generateScenes` ¥0.20/张；`voiceover` ¥0.1/分钟；`music` ¥0.5/曲；`composite` ¥1.0/视频。
- 归集：`withStep` 完成后调 `recordCost(runId, step, out)`，仅当 `out._usage` 存在时计入；`checkBudget(costs, {amount:0}, getBudgetCap())` 累算，超限抛 `BudgetExceededError`，`withStep` 捕获后置 `run.status=failed` 并 emit `run-failed`。
- 上限 `PROMO_BUDGET_CAP`（默认 20）每次运行实时读取环境变量，便于不改代码调整。
- M2 仅做「预估 + 闸门 + 归集」，不接入四大阻断域真实计费/扣星钻（仅预留 `PromoRun.cost` 结构，见 §7）。

#### 16.9.5 关键工程修正（M2 排障，必读）
1. **Mastra v1.63 suspend/resume 陷阱（M1 已记录）**：`suspend()` 始终以 `undefined` resolve 且不回传 resume 数据；`resume()` 重跑被挂起步骤后**不会继续下游 DAG**（实测卡在 suspended 步骤）。HITL 门采用两段式工作流（`promoScript` 收尾 suspend，`promoVideo` 由 server 冷启动）。
2. **M2 新增——嵌套工作流 `run.start` 卡死**：在 `promoScript.run.start()` 的续跑上下文（或 `/approve` 的 `resume` 续跑上下文）内直接 `await` 第二个工作流的 `run.start()`，Mastra 执行引擎会卡在 `storyboard` 之后不再调度 `generateScenes`。**修复**：以 `run.start(...).then(...)` 观察 Promise（detached 观测），并用 `setImmediate` 把 `runVideoPhase` 切到全新事件循环 tick，脱离父 continuation 的 AsyncLocalStorage 上下文。
3. **M2 新增——runId 透传断链**：两段式拆分后，`promoVideo` 的 `storyboard` 步在返回对象中**漏带 `runId`**，导致其后所有步骤与 `deliver` 的 `rid` 退化为 Mastra 内部 runId（`${runId}:video`），写入进程内 `store` 的键错位——表现为成片阶段完成但 `PromoRun.status` 永远 `running`、SSE `run-done` 被前端按 user-runId 过滤掉。**修复**：`storyboard/generateScenes/voiceover/music/composite` 各步返回对象均补回 `runId: rid`，确保 `deliver` 命中正确 store 键。

#### 16.9.6 M2 DoD（验收）
- [x] 设 `PROMO_PROVIDER_MODE=real` + one-api 环境变量后，`generateScript/storyboard/sceneMedia/voiceover/music` 实际构造正确请求（鉴权 `Bearer`、模型、size、voice 映射、响应 JSON 解析）并产出真实 `mediaUrl`/音频 data URI/音乐 URL。
- [x] 设 `PROMO_FFMPEG_BIN` 后 `composite` 真实合成为 MP4（或缺失时优雅降级为分镜包、不报错）。
- [x] 真实路径下 `PromoRun.cost` 累计每步 ¥ 预估；`PROMO_BUDGET_CAP` 调小至首步即超限时，run 中止于 `failed` 且提示「预算超限」，已归集成本保留 1 条。
- [x] `GET /api/config` 在真实模式返回 `provider:"one-api"` 与 `budgetCap`；前端徽标与成本卡片正确。
- [x] DEMO 模式零密钥端到端仍跑通（分镜画廊 + SRT），且全部 `node --test` 冒烟（M2 新增 25 例，合计 35 例）全绿。
- [x] 参考图 `styleReference` 在真实图像生成拼入 prompt。

---

## 16.10 M3 执行基线（v0.4 新增，HITL 完整化 + 成本配额 + 历史记录 + 参考图图生图）

> M3 把 §13 的「HITL 完整化 + 成本配额 + 历史记录」全部落地，使产品达到**可上线内测**标准；并补齐 M2 推迟的「真实参考图图生图」。

### 16.10.1 M3 范围锁定（相对 §16.9 的增量）
- ✅ **FR-9.2 成片门（HITL 完整化）**：`promoVideo` 止于 `composite`（移除自动 `deliver`）；composite 完成后若 `finalGateEnabled` 开启，server 置 `awaiting_delivery` 并推送 `final-review` 事件（SSE），前端弹「成片验收门」；`approve` → `publishDelivery`（纯函数，标记 success + 广播 run-done），`reject` → 重跑成片阶段（整段重生成，beta 简化）。**规避 Mastra v1.63 resume 续跑陷阱**：成片门不放在 Mastra 内 suspend，改为 server 侧状态机。
- ✅ **成本配额（账户级累计，FR-10 延伸）**：新增 `quota.js`，按 `createdBy`（账户）累计真实花费，受 `PROMO_QUOTA_CAP`（默认 ¥200）闸门；超限抛 `QuotaExceededError` 中止。`workflow.recordCost` 现在执行**两道闸门**（单 run `PROMO_BUDGET_CAP` + 账户 `PROMO_QUOTA_CAP`）。新增 `GET /api/quota`（账户剩余）、`GET /api/admin/costs`（按账户/步骤聚合报表）、`/api/config` 返回 `quotaCap`。
- ✅ **历史记录持久化（M3-A）**：`store.js` 由进程内 Map 改为「内存 Map + 原子写穿（temp→rename）」，`<PROMO_DATA_DIR>/runs.json`；启动 hydrate 恢复。重启后 `GET /api/runs` 不丢。新增 `PROMO_PERSIST`（默认 1）/ `PROMO_DATA_DIR`（默认 `./data`）。`resumers`（Mastra resume 闭包，含函数）不持久化（beta 已知限制：跨重启的 suspended 运行会丢失 resumer）。
- ✅ **真实参考图图生图（M3-D，关闭 M2 推迟项）**：`generateSceneMedia` 真实分支识别 `brief.styleReference`——`data:image` / `http(s)` URL 走 Seedream 图生图（`image` 字段，base64/URL，参考图免费），纯关键词仍追加到 prompt（M2 行为向后兼容）。
- ⏸️ **仍推迟（Out of Scope §2.2）**：真实支付/计费扣星钻、四大阻断域分润回写（仅预留 `PromoRun.cost` 结构与配额扣减，未接 ai-core 计费）；M4 模板库 / 多语言 / 小程序并入。

### 16.10.2 M3 文件落地清单
```
src/
├── store.js              # 【重写】进程内 Map → 文件写穿 + hydrate；PROMO_PERSIST/PROMO_DATA_DIR
├── quota.js              # 【新增】账户累计配额 + QuotaExceededError + 文件持久化(quotas.json)
├── cost.js               # 【不变】
├── mastra/workflow.js    # 【修改】recordCost 加配额闸门；移除 deliver 步；新增 publishDelivery()；promoVideo 止于 composite
├── mastra/providers.js   # 【修改】generateSceneMedia 真实分支支持参考图图生图(image 字段)
├── mastra/eventBus.js    # 【修改】新增 emitFinalReview（成片门 SSE 事件）
├── server.js             # 【修改】成片门状态机 + 状态感知 /approve + GET /api/quota + GET /api/admin/costs + /api/config 加 quotaCap；脚本失败不再误启成片阶段
├── schemas.js            # 【修改】新增 finalGateEnabled（默认 true）
└── mastra/svg.js         # 【不变】
public/index.html          # 【修改】成片验收门 UI(final-review) + finalGateEnabled 勾选 + 配额展示
tests/
├── store-persist.test.mjs   # 【新增】子进程 round-trip 验证写盘+rehydrate
├── quota.test.mjs           # 【新增】配额上限/累计/QuotaExceededError
├── server.test.mjs          # 【修改】适配成片门（awaiting_delivery→approve；reject→重生成）+ /api/quota
├── providers-real.test.mjs  # 【修改】参考图 data:/URL/关键词 三用例
├── workflow-real-budget.test.mjs # 【修改】成功路径 finalGateEnabled:false + 新增极小配额触发 QuotaExceededError
├── cost.test.mjs            # 【不变】
└── providers.test.mjs / eventBus.test.mjs # 【不变】
.env.example             # 【修改】新增 PROMO_QUOTA_CAP / PROMO_PERSIST / PROMO_DATA_DIR
```

### 16.10.3 成片门（FR-9.2）交互契约
- 状态机：`running → (suspended 脚本门) → running → (awaiting_delivery 成片门) → success | failed`。
- `composite` 完成后：若 `finalGateEnabled`，`updateRun(status:"awaiting_delivery")` + `emitFinalReview({videoUrl, gallery, poster, note})`；否则直接 `publishDelivery`。
- `POST /api/generate/:runId/approve` 按 `run.status` 分流：
  - `suspended` → 恢复 `promoScript`（脚本门），由 server 冷启动成片阶段；
  - `awaiting_delivery` + `approve` → `publishDelivery`；+ `reject`（`{scenes?}`）→ 清除 resumer、重跑成片阶段（整段重生成，beta 简化），完成后再次 `awaiting_delivery`；
  - `success`/`failed` → 409 无待审批门。

### 16.10.4 成本双闸门（FR-10 + M3 配额）
- `recordCost(runId, step, out)`：`out._usage` 存在才计量（DEMO 零成本）。先 `checkBudget(per-run)` → `BudgetExceededError`；再 `checkQuota(account, amount)` → `QuotaExceededError`；均通过才 `addUsage(account, amount)`。
- 单价表、预算上限读取（§16.9.4）不变；配额上限 `PROMO_QUOTA_CAP` 默认 ¥200，运行时实时读取。

### 16.10.5 关键工程修正（M3 排障，必读）
1. **成片门不放在 Mastra suspend（规避 v1.63 续跑陷阱）**：M2 已证实 `resume()` 重跑被挂起步骤后不继续下游 DAG。FR-9.2 成片门改用 **server 侧状态机 + `final-review` SSE 事件 + 纯函数 `publishDelivery`**，彻底绕开该陷阱。
2. **M3 回归——脚本失败误启成片阶段**：Mastra `promoScript.run.start()` 在脚本步因预算/配额抛错时**以 resolve 而非 reject 返回**（status 落 `failed`）。原 `runScriptPhase` 的 `else` 分支会据此继续冷启动成片阶段，落入嵌套上下文卡死（storyboard 后莫名置 `success`）。**修复**：`runScriptPhase` 在 `run.start` 返回后检查 `getRun(runId).status === "failed"` 则直接返回，保留 failed 终态，不再启动成片阶段。
3. **测试并发隔离**：`node --test` 同文件测试默认并发，会令 `PROMO_QUOTA_CAP`/`PROMO_BUDGET_CAP` 等全局环境变量在用例间竞态。测试脚本加 `--test-concurrency=1` 串行执行；并用 `tests/setup.mjs`（`--import` 预加载）统一设 `STEP_DELAY_MS` 与 `PROMO_PERSIST=0`（内存态、不落盘、互不污染）。

### 16.10.6 M3 DoD（验收）
- [x] 设 `PROMO_PROVIDER_MODE=real`：脚本门 + 成片门两段 HITL 均可在用户 approve 后继续；成片门 `reject` 触发整段重生成并可再次验收。
- [x] 运行态持久化：进程重启后 `GET /api/runs` 仍含历史运行（原子写穿 + hydrate 验证通过 `store-persist.test.mjs`）。
- [x] 账户配额：`PROMO_QUOTA_CAP` 调小至首步即超限时，run 中止于 `failed` 且提示「配额超限」；`GET /api/quota`、`GET /api/admin/costs` 正确聚合。
- [x] 参考图：`styleReference` 为 data:/URL 时真实分支携带 `image` 字段走图生图；纯关键词追加 prompt。
- [x] DEMO 模式零密钥端到端仍跑通（分镜画廊 + SRT + 成片门/脚本门），且全部 `node --test` 冒烟（M3 新增 13 例，合计 48 例）全绿。
- [x] 前端「成片验收门」UI（final-review 监听 + approve/reject）+ 成片门/配额勾选与展示。

---

## 16.11 M4 执行基线（v0.5 新增，模板库 + 多语言 + 全量上线就绪）

> M4 按 §13 落地 **FR-1.3 模板库** 与 **FR-12 多语言全球化**，并补充「全量上线」部署清单（形态 B 的生产化路径）。**小程序并入按用户决策本期不做**（见 §16.11.1）。M4 沿用 M1~M3 的「env 门控真实代码 + DEMO 完整保留」范式，`PROMO_PROVIDER_MODE` 切换不影响任何确定性路径；全部 `node --test` 冒烟由 48 → **58 例**全绿。

### 16.11.1 M4 范围锁定（相对 §16.10 的增量）
- ✅ **FR-1.3 模板库（Brand Template）**：用户可保存品牌预设（Logo 主色 / 禁用词 / 默认调性 / 默认语言 / 行业），一键套用以保证调性统一。首次启动自动写入 ≤5 个预置模板（`isPreset=true`，不可删除）。新增 `BrandTemplateSchema` + `templates.js` 写穿持久化（`templates.json`）+ `GET/POST/PUT/DELETE /api/templates` + 前端「模板管理器」。
  - **品牌约束必须全链路闭环**（评审 F1 教训）：`logoColor` / `bannedWords` 须在「表单采集 → 模板保存 → 模板套用 → Brief 提交 → Provider 注入」五环均接通，任一环漏接都会使 Provider 的 `if (brief.logoColor)` / `if (brief.bannedWords?.length)` 恒为假、能力对终端用户不存在。
- ✅ **FR-12 多语言（全局语言提示词）**：复用 MingStar 全局语言提示词语义（`src/utils/language.ts`）——**zh-CN 为空、不污染确定性输出**；其余语言在「文本生成」步骤（脚本 / 分镜）prompt 末尾追加「输出语言」指令；TTS 通过 `language` 参数传递；图像 / 音乐为视觉 / 器乐输出，语言已由上游分镜文本承载，不再单独注入。新增 `i18n.js`（`languageInstruction` / `withGlobalLanguage`），并移除 `providers.js` 内旧的局部 `langInstruction` switch（统一收敛到一处）。
- ✅ **全量上线部署清单（文档化，非本次部署）**：形态 B 的生产化路径在 §16.11.5 给出基线（队列解耦 / 存储升级 / 无状态部署），作为上线 checklist；本期仍以形态 A（单进程 Node + 静态前端）交付，部署清单不阻塞 M4 验收。
- ⏸️ **本期不做：小程序并入**：按用户 2026-09-03 决策，M4 不含「并入 mingstar-miniapp」这一支柱。网页端仍是唯一交付界面；`src/utils/language.ts`（mingstar-miniapp 侧）的全局语言提示词接口与本品宣 Agent 的 `i18n.js` 保持语义一致、互不依赖。
- ⏸️ **仍推迟（与 §2.2 / §15 一致）**：真实支付 / 计费扣星钻、四大阻断域分润回写（仅预留 `PromoRun.cost` 结构与配额扣减，未接 ai-core 计费）；A/B 多概念并行探索（架构预留 `.parallel()`，本期无 UI）。

### 16.11.2 M4 文件落地清单
```
src/
├── i18n.js               # 【新增】全局语言提示词：languageInstruction / withGlobalLanguage；复用 MingStar 语义（zh-CN 不污染）
├── templates.js          # 【新增】模板库：写穿持久化(templates.json) + 5 预置 + CRUD + 预置保护(isPresetTemplate 双保险判定)
├── schemas.js            # 【修改】BrandBriefSchema 加 logoColor/bannedWords；新增 BrandTemplateSchema + parseTemplate
├── mastra/providers.js   # 【修改】移除局部 langInstruction switch，改 withGlobalLanguage 注入；TTS 加 language 参数；
│                         #         logoColor 注入图像 prompt、bannedWords 注入脚本/分镜 prompt；DEMO 媒体套用 logoColor
├── server.js             # 【修改】新增 GET/POST/PUT/DELETE /api/templates（预置 DELETE 返回 409）
└── mastra/svg.js         # 【不变】
public/index.html          # 【修改】新增模板管理器 UI（#tplCard：列表/套用/删除/保存当前为模板）
.env.example             # 【不变】（沿用 M3 的 PROMO_PERSIST/PROMO_DATA_DIR）
tests/
├── i18n.test.mjs          # 【新增】zh-CN 不污染 / en·ja·ko·zh-TW 追加 / 未知语言不污染（3 例）
├── templates.test.mjs     # 【新增】预置种子 + CRUD + 预置保护 + 非法名抛错 + 跨进程写穿持久化（2 例）
├── providers-real.test.mjs# 【修改】TTS 携带 language:"en" / 分镜注入 "Output in English." / 脚本注入禁用词（3 例）
└── server.test.mjs        # 【修改】模板创建/列表/删除 经 /api/templates；非法模板名返回 400（2 例）
```

### 16.11.3 多语言注入点（FR-12 落地映射）
| 步骤 | 注入方式 | 说明 |
|------|----------|------|
| 脚本生成 `generateScript` | `user = withGlobalLanguage(user, brief.language)` | 文本生成，末尾追加「输出语言」指令；`bannedWords` 一并发「禁用词：…」 |
| 分镜生成 `generateStoryboard` | `user = withGlobalLanguage(user, brief.language)` | 文本生成，同上；`logoColor` 一并发「品牌主色 …」约束 |
| 场景素材 `generateSceneMedia` | `prompt += '；主色 ' + brief.logoColor`（仅当设主色） | 视觉生成，仅注入品牌主色（弱语言学），不注入语言指令 |
| 配音 `generateVoiceover` | TTS body `language: brief.language \|\| "zh-CN"` | 经 one-api `/audio/speech` 的 `language` 参数传递（非 prompt） |
| DEMO 媒体 `demoSceneMedia` | `c1 = brief.logoColor \|\| paletteFor(...)` | 占位图主色套用品牌主色 |
> 语义约定：**zh-CN 为空不污染**（与 MingStar 规则一致），故 `withGlobalLanguage("...", "zh-CN")` 原样返回；未知 `language` 回落为空指令，亦不污染。图像 / 音乐无语言学输出，仅承接上游文本已含的语言信息。

### 16.11.4 模板库契约（FR-1.3）
- **实体**：`BrandTemplate { id?, name(必填), brandName?, productName?, coreSellingPoint?, logoColor?, bannedWords[], defaultTone(默认"专业"), defaultLanguage(enum LANGUAGES, 默认"zh-CN"), industry?, isPreset(默认false) }`（`BrandTemplateSchema` + `parseTemplate`，非法名抛「name: Required」类错误）。
- **预置（≤5，不可删）——按铭星链产品线定制（2026-09 适配）**：
  `preset-mingstar`(平台主品牌,#6366f1,科技感) / `preset-miniapp`(小程序拉新,#0ea5e9,专业) / `preset-studio`(Studio 分镜,#111827,高端) / `preset-music`(音乐配乐,#7c3aed,专业) / `preset-global-en`(出海 EN,#1d4ed8,专业,en)。
  每条携带 `brandName`/`productName`/`coreSellingPoint`（套用即得项目化 brief，卖点 ≤60 字）。首启写入；**seed 迁移**：预置内容升级由 `PRESET_SEED`（data/templates.seed）识别，旧版预置自动替换、用户自定义模板保留。
- **API**：`GET /api/templates`（列出含预置）→ `POST /api/templates`（201 新建，400 非法）→ `PUT /api/templates/:id`（更新）→ `DELETE /api/templates/:id`（404 不存在 / **409 预置不可删** / 200 ok）→ `GET /api/copyideas?preset&batch`（项目化文案灵感，3 批轮换、越界环绕、未知回落 platform）。
- **套用**：前端 `applyTemplate(t)` 回填**全部**模板字段到 Brief 表单——品牌名 / 产品名 / 卖点 / 语言 / 默认调性 **+ 品牌主色 `logoColor`（含启用勾选）+ 禁用词 `bannedWords`**（顿号分隔展示，解析兼容中英文逗号与顿号），并自动带出该产品线**第 1 批文案灵感**（卖点 + 核心信息点）。表单「换一批」按钮轮换 `/api/copyideas` 的 2/3 批（仍围绕铭星链产品线真实能力）。`saveCurrentAsTemplate()` 将当前表单（含品牌约束）存为自定义模板。
  > 评审 F1 前车之鉴：初版 `applyTemplate` 只回填 5 个基础字段、漏掉 `logoColor`/`bannedWords`，导致模板库最有价值的品牌约束「存得进、套不出」。**套用必须覆盖全部字段，不可只覆盖基础字段。**
- **主色格式**：`logoColor` 仅接受 `#RGB` / `#RRGGBB`（`LOGO_COLOR` schema，Brief 与 Template 共用）。评审 F6：原为任意 ≤20 字符串，会直接进入 DEMO 的 SVG 填充属性并破坏渲染。
- **模型与服务配置（右侧面板，2026-09）**：布局改左主右栏（≤960px 回落单栏）。右侧「模型与服务」含 **运行模式（demo/real）+ 供应商 API 地址 + API Key**、脚本/分镜模型与场景图模型下拉（留空 = env 默认，清单来自 `GET /api/config.models`，`PROMO_LLM_CHOICES`/`PROMO_IMAGE_CHOICES` 扩展）、配音/配乐当前模型只读。三项运行时覆盖由 `src/runtime-config.js` 持久化 `data/runtime-config.json`（写穿 + 原子替换，`PROMO_PERSIST=0` 仅内存；**data/ 已 gitignore**），**免重启即时生效**：`providers` / `models-gateway` 每次调用现取「运行时覆盖 > env」（base/mode/key 同一语义）；`POST /api/config` 校验（地址 http(s)、mode ∈ demo|real、key ≤200）保存 / 空串清覆盖；`GET /api/config` 回显 `mode` + `providerBaseUrl` + `apiKeySet`。**密钥安全模型 = 可写不可读**：浏览器→服务端单向写入一次（保存后即从输入框清空），明文仅落本地 data/ 盘、**绝不回显/绝不下发前端**；`/api/models` 第二道守卫与密钥读取均走「运行时 > env」生效键（修：曾只认 env 导致页面存了 key 仍报未配置）。
- **动态视频能力 + 网关模型清单实时拉取（2026-09）**：
  - **模型清单动态化**：新增 `GET /api/models?refresh=1`（`src/models-gateway.js`）——从**当前生效供应商网关**拉 `GET {base}/models`（Bearer、5s 超时、60s TTL），按条目 `type` 字段优先、缺失按模型 id 关键词分类（`video > audio > image > llm`）。`real` 且网关可达 → `source=gateway` 返回真实清单；`real` 但网关失败 → 503（**不返回占位，避免误导**）；DEMO → `source=fallback`（llm/image 内置清单 + video 占位候选，仅声明路由演示）。
  - **右侧面板增「动态视频模型」下拉**（首项「不启用」）：数据源 = `/api/models` 的 video 分类；页面加载与「保存供应商地址」后自动拉取（地址变了强刷 `refresh=1`），llm/image 下拉并入网关真实条目。「从网关刷新模型清单」按钮手动强刷。
  - **Brief 增 `videoModel`**（请求级覆盖，语义同 `llmModel`/`imageModel`）；`GET /api/config.models.video` 回显 `current`（env `PROMO_VIDEO_MODEL`，可空 = 不启用）。
  - **生成链路（仅 `real` + `brief.videoModel` 生效）**：`providers.generateSceneVideo` 走 OpenAI 兼容 `POST {base}/videos/generations`（`image` = 本镜场景图 URL → 图生视频，无图退化为文生；兼容同步返回与异步任务轮询 `GET /videos/{id}` / `/videos/generations/{id}`，`PROMO_VIDEO_TIMEOUT_MS` 默认 180s）。workflow `generateScenes` 每镜图后动态化，**单镜失败降级为静态图不阻断全片**（FR-4.3）；产出落 `scene.videoUrl`/`scene.videoModel`。合成：全部镜为动态片段 → FFmpeg concat 直拼 + 音频混流；否则走原静态图路径。交付页模型行显示「动态视频 xxx（静态降级）」如实标注。
  - **成本**：`generateScenes` 计费表增 `perVideo`（占位价，真实单价待网关渠道确认）。
  - **交付预览**：交付页与成片门分镜画廊——有 `scene.videoUrl` 的镜渲染 `<video controls>`（可播放动态片段，带「⦿动态」徽标），否则静态图；成片门 preview 的 gallery 取完整 storyboard（含 videoUrl）。
  - **调用骨架回归保障**：`tests/video-provider.test.mjs` 以本地 stub 网关锁定 7 条路径——同步返回 / 异步轮询至 succeeded（output 对象）/ GET 404 → 备选 `/videos/generations/{id}` / 任务失败 / 轮询超时（`PROMO_VIDEO_TIMEOUT_MS`）/ 未指定模型 / DEMO stub。`extractVideoUrl` 兼容 `{url|video_url}`、`data/output/results/videos` 数组、`output` 对象、`content` 对象/数组等形态。
  - **对拍工具**：`tools/probe-gateway.mjs` 在真实网关环境运行（只读 GET /models 零费用），输出分类与 raw type，用于精确适配渠道。⚠️ 真实调用端点/任务返回字段**以目标网关实现为准**——stub e2e 已验证 OpenAI 兼容骨架，若你的 new-api 渠道字段有出入，跑一次探测脚本把输出贴回即可微调。

### 16.11.5 全量上线部署清单（形态 B，checklist 文档化）
> 本期（M4）仍以形态 A 单进程交付；以下为「全量上线」生产化的明确基线，待运维/部署阶段执行，不阻塞 M4 验收。

1. **无状态化 + 队列解耦**：Mastra Workflow 服务与 Express 解耦为独立无状态进程；重负载在 Workflow 前加 **BullMQ（Redis）或 AWS SQS** 队列，把 `POST /api/generate` 请求与异步执行解耦（§11 NFR「可扩展」要求）。当前两段式 HITL（server 侧状态机 + `final-review` SSE）已天然适配异步重跑。
2. **存储升级**：运行态从历史 `runs.json` 原子写穿升级为 **PostgreSQL / LibSQL** 持久化（`PromoRun` 全字段 + 配额表）；当前 `store.js`/`quota.js` 的写穿抽象已抽象出 `DATA_DIR`，迁移只需换底层 `read/write` 实现。
3. **静态前端部署**：`public/index.html` 托管至 **Vercel / Cloudflare Pages** 或独立 CDN；API 服务部署至 Vercel Functions / Cloudflare Workers / Node 独立服务，经 CORS / 网关暴露 SSE 端点。
4. **密钥与隔离**：`PROMO_PROVIDER_MODE=real` + one-api 凭据仅服务端环境变量；用户隔离由 `createdBy` → 账户配额（`PROMO_QUOTA_CAP`）承托；上线前接入四大阻断域计费（关闭 §16.11.1 推迟项）。
5. **可观测**：OTel tracing + 成本/时延/错误率埋点接入 Langfuse/Datadog（§6 NFR「可观测」）；`GET /api/admin/costs` 已就绪。

### 16.11.6 M4 DoD（验收）
- [x] 多语言：设 `brief.language="en"`，真实脚本/分镜 prompt 末尾含 `Output in English.`；`generateVoiceover` 真实 TTS body 携带 `language:"en"`；`zh-CN` 下 prompt 零污染（确定性输出不变）。
- [x] 品牌安全：`brief.bannedWords` 注入脚本/分镜 prompt（真实用例验证「禁用词：最、第一」）；`logoColor` 注入分镜/图像 prompt 与 DEMO 占位图主色。
- [x] **品牌约束全链路闭环（评审 F1）**：表单可采集主色/禁用词 → `applyTemplate` 全字段回填 → `submitBrief` 随 Brief 提交 → Provider 注入生效（真实 + DEMO 双路径均有用例覆盖）。
- [x] 模板库：`GET /api/templates` 首启返回 5 预置；`POST` 新建自定义、`PUT` 更新、`DELETE` 自定义成功；**DELETE 预置返回 409**；非法模板名 `POST` 返回 400。
- [x] **预设防篡改（评审 F2/F3）**：`POST` 忽略客户端 `id` 与 `isPreset`；`isPreset` 为系统标志位（新建恒 false、更新沿用原值）；预设判定「标志位 + `preset-` 前缀」双保险；伪造 id 覆盖后预设仍存在且不可删。
- [x] **预置与持久化解耦（评审 F4）**：`PROMO_PERSIST=0` 下 `listTemplates()` 仍返回 5 预置。
- [x] **PUT 部分更新（评审 F5）**：`PUT` 仅传 `name` 时，`logoColor`/`industry`/`defaultLanguage` 等未传字段保留原值。
- [x] **主色格式校验（评审 F6）**：非法 `logoColor`（如 `red;background:url(x)`）返回 400。
- [x] 前端：模板管理器 UI（列表 + 套用 + 删除 + 保存当前为模板）可用；套用回填 Brief 表单**含主色与禁用词**；预置删除按钮禁用。
- [x] 持久化：模板跨进程写穿 + hydrate 验证通过（`templates.test.mjs` 子进程 round-trip）。
- [x] 回归：DEMO 模式零密钥端到端仍跑通（分镜画廊 + SRT + 成片门/脚本门），全部 `node --test` 冒烟（M4 合计 **65 例**）全绿；**新增用例经变异测试验证可捕获对应缺陷**（回退任一项修复均有对应用例转红）。

### 16.11.7 关键工程修正（M4 评审，必读）

> M4 首版提交（`475904c`）经深度评审发现 6 项缺陷（详见 [M4 评审报告](./M4-review-2026-09-03.md)），已全部修复并验证。**本节为后续迭代的红线。**

1. **F1 品牌约束闭环断裂（P0）**：初版前端 `applyTemplate()` 只回填 5 个基础字段、漏掉 `logoColor`/`bannedWords`；`submitBrief()` 也不携带二者；`templateToBrief()` 为零调用死代码。后果：Provider 的 `if (brief.logoColor)` / `if (brief.bannedWords?.length)` **恒为假**——模板库最有价值的品牌约束对终端用户完全不存在。**修复**：表单增主色（color input + 启用勾选，默认关闭以保证 M3 零回归）与禁用词输入；采集/套用/提交三处全部接通；删除死代码。
2. **F2 预设可覆盖删除（P1）**：`POST /api/templates` 直接 `saveTemplate(req.body)`，而 `id`/`isPreset` 均客户端可控 → `POST {id:"preset-tech", isPreset:false}` 即可覆盖并删除预设；删光后 `templates.json` 变 `[]`，重启因 `fs.existsSync` 为真不再重注 → **5 个预设永久丢失**。**修复**：服务端剥离 `id`/`isPreset`；数据层 `isPreset` 强制「新建 false / 更新沿用原值」；判定用「标志位 + `preset-` 前缀」双保险。
3. **F3 僵尸模板（P1）**：`POST {isPreset:true}` 可造出永不可删模板。**修复**：同 F2，服务端强制 `isPreset:false`。
4. **F4 预置被持久化开关劫持（P1）**：`hydrate()` 首行 `if (!persistEnabled()) return;` 吞掉预置注入 → `PROMO_PERSIST=0` 下预置数为 **0**（应为 5）。**修复**：预置注入前置且无条件，仅读盘/写盘受开关控制。
5. **F5 PUT 全量替换（P2）**：`saveTemplate({...req.body, id})` 使部分更新静默丢字段（实测只传 `name` 后 `logoColor`/`industry` 变 undefined、语言退回默认 zh-CN）。**修复**：`PUT` 改为 `{...prev, ...body, id}` merge，且要求目标已存在（否则 404）。
6. **F6 主色无格式校验（P2）**：任意 ≤20 字符串可进入 DEMO 的 SVG 填充属性破坏渲染。**修复**：加 `#RGB`/`#RRGGBB` 正则（`LOGO_COLOR`，Brief 与 Template 共用）。

**方法论红线（本次评审最大教训）**：
- **测试全绿 ≠ 行为正确**。F5 被既有用例「通过」掩盖——该用例只断言 `name`，对「全量替换」与「merge」两种语义都成立。新增用例必须能区分正确实现与错误实现。
- **新能力须验「UI → 提交 → Provider 生效」全链路**，不能只验后端单元。F1 的后端用例全是绿的，但前端根本没接线。
- **服务端必须剥离客户端可控的权限/标志位字段**（`id`、`isPreset`、`role` 一类），不可直接透传 `req.body`。
- **交付前对新增用例做变异测试**：逐个回退修复，确认对应用例转红。本次 4 项变异（F2/F3、F4、F5、F6）全部被捕获。

---

## 17. 附录

- 关联架构决策：[ADR-001 框架选型（Mastra）](./ADR-001-framework-selection.md)
- 代码仓库（本期原型）：`brand-promo-agent/`（Express + Mastra + 静态前端）
- 复用能力：MingStar 全局语言提示词（`src/utils/language.ts`）、ai-core 素材生成、one-api 模型路由。
