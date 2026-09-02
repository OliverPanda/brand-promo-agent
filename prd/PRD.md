# PRD — 自动化品宣机器人 Agent（品牌宣传片自动生成）

| 项 | 内容 |
|----|------|
| 文档版本 | v0.3（M1 + M2 执行基线） |
| 日期 | 2026-09-03 |
| 负责人 | 铭星链 MingStar 主理人 / 交付总监 |
| 架构选型 | **Mastra（TypeScript）** —— 见 [ADR-001](./ADR-001-framework-selection.md) |
| 交付形态 | 网页端（Web）单页应用 + 后端 Agent 工作流服务 |
| 状态 | M1（DEMO 全跑通）+ M2（真实 one-api Provider + 成本预算）已完成；待 M3 持久化与真实计费回写 |

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
| M3 | HITL 完整化 + 成本配额 + 历史记录 | 可上线内测 |
| M4 | 模板库 + 多语言 + 小程序并入 | 全量上线 |

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

## 17. 附录

- 关联架构决策：[ADR-001 框架选型（Mastra）](./ADR-001-framework-selection.md)
- 代码仓库（本期原型）：`brand-promo-agent/`（Express + Mastra + 静态前端）
- 复用能力：MingStar 全局语言提示词（`src/utils/language.ts`）、ai-core 素材生成、one-api 模型路由。
