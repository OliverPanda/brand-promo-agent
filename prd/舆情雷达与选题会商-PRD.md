# PRD — 舆情雷达 + AI 选题会商（品牌市场智能决策模块）

| 项 | 内容 |
|----|------|
| 文档版本 | v0.2（**开放问题已全部决议**，可拆任务书实施） |
| 日期 | 2026-09-04 |
| 负责人 | 铭星链 MingStar 主理人 / 交付总监 |
| 上游需求 | 舆情雷达（7x24h）+ 选题会商（AI 辅助）两条原始需求（见 §1.2） |
| 数据源 | **TikHub**（多平台社媒数据 API，https://user.tikhub.io）——2026-09-04 主理人决议 |
| 关联系统 | brand-promo-agent（自动化品宣机器人，选题确认后一键下发生成宣传片）、one-api 网关（LLM 情绪分析 + 选题生成） |
| 状态 | 决议完成：数据源=TikHub；情绪分析=one-api LLM；**CTR 效果回流 / 外部通知通道 / 竞品清单与竞品动作识别 = 本期不做**（§11 决议记录） |

---

## 1. 背景与目标

### 1.1 背景
品宣产出侧已有自动化链路（brand-promo-agent：Brief → 宣传片成片），但**输入侧仍是纯人工拍脑袋**：市场/运营团队缺少「今天该打什么、防什么」的决策依据。行业热词、竞品动作、负面舆情散落在各社交平台，靠人肉刷新；选题靠周会头脑风暴，没有数据反馈闭环。

### 1.2 原始需求（主理人输入，本 PRD 的完善对象）
> · 舆情雷达（7x24h）：接入社交媒体API+爬虫，自动抓取行业热词、竞品动作（如竞品调价/换代言）、自然语言情绪（NLP）。设定异常阈值（如负面声量突增200%），触发自动预警。
> · 选题会商（AI辅助）：基于品牌人设库（Tone & Voice），AI每日生成10个选题，结合历史CTR数据自动打分排序，PM一键确认本周"必打战役"和"防御性声量"。

### 1.3 目标
1. **看得见**：7x24h 自动聚合全网行业声量、情绪走向，一屏可视。
2. **叫得响**：异常（负面突增、热词爆点）在 15 分钟内预警到责任人。
3. **拍得准**：AI 每日产出带数据依据的选题清单，PM 确认的每个选题都能追溯到「为什么是它」（热度/契合度打分明细）。
4. **连得上**：确认的选题一键转成 brand-promo-agent 的 Brief，直接进入成片流水线，闭环「决策 → 产出」。

### 1.4 北极星指标
- 预警时延：异常发生 → 预警触达 **< 15 分钟**。
- 选题采纳率：AI 生成的 TOP10 选题被 PM 采纳（进周战役）比例 **≥ 40%**。
- 闭环率：确认的「必打战役」中 **≥ 50%** 在 24h 内经 brand-promo-agent 产出物料。
- 防御响应：负面预警 → 防御性声量上线 **< 4 小时**。

---

## 2. 用户角色

| 角色 | 描述 | 核心诉求 |
|------|------|----------|
| PM（市场负责人） | 选题会商的决策者 | 一眼看清风险与机会，一键定本周战役 |
| 运营 | 日常盯盘、执行防御声量 | 预警及时、选题可直接开工 |
| 品牌主理人 / 老板 | 看大盘 | 行业声量趋势、投入产出 |
| 管理员 | 平台运营 | TikHub 配额与订阅词配置、阈值规则、成本监控 |

---

## 3. 范围

### 3.1 In Scope（本期）
- 舆情数据接入：**TikHub 多平台社媒数据 API**（抖音 / 小红书 / 微博 / B站 等，以 TikHub OpenAPI 实际覆盖为准），经 Collector 适配器层接入；关键词订阅驱动拉取。
- 行业热词榜：分词统计、环比趋势、热度排名（日/周榜）。
- 情绪分析（NLP）：**one-api LLM** 逐条打分（正/中/负 + 置信度，指纹缓存去重计费），聚合出品牌维度的情绪指数。
- AI 选题会商：品牌人设库（Tone & Voice）+ 舆情数据 → 每日 10 个选题、多维打分排序、PM 确认「必打战役」与「防御性声量」。
- 选题 → 产出闭环：确认选题一键生成 Brief 下发 brand-promo-agent。

### 3.2 Out of Scope（本期不做，2026-09-04 主理人决议）
- **CTR 效果回流**（原 FR-9）：投放数据系统对接与回填整体不做；打分模型去掉 CTR 维度（§FR-8 预留接口，后续启用）。
- **异常检测与预警 + 站内信预警中心**（原 FR-5，2026-09-04 二次决议收窄）：规则引擎、预警生命周期、站内信整体不做；情绪能力收窄为「打分 + 聚合摘要」（负面声量 / 情绪指数口径随摘要 API 与前端看板输出，供人工查看）。
- **外部通知通道**（原 FR-5.2 的企微 webhook / 邮件 / 短信）：全部不做，仅站内信。
- **竞品库与竞品动作识别**（原 FR-3 的调价/换代言等事件识别）：不做；竞品名仅作为搜索关键词参与声量/热词/情绪统计。
- 自建爬虫（TikHub 已覆盖数据获取，不重复建设；Collector 适配器抽象保留，未来可插拔）。
- 全网无差别采集（仅限订阅关键词命中的公开内容）、账号矩阵自动发文、视频帧级理解、私域舆情、KOL 投放管理。

---

## 4. 功能需求（FR）

### FR-1 数据接入层（TikHub）
- **FR-1.1 TikHub 单轨接入**：Collector 层封装 TikHub API（鉴权 `Bearer $TIKHUB_API_KEY`，`TIKHUB_BASE_URL` 默认 `https://api.tikhub.io`）；凭据仅服务端持有（`.env` 已被 gitignore 覆盖，不入库、不下发前端）。
- **FR-1.2 订阅驱动拉取**：关键词订阅组（品牌名 / 行业词 / 竞品名，管理员可配）定时触发搜索类端点拉取公开内容；**具体端点与分页参数 M1 落地时以 TikHub OpenAPI 文档为准**（提供 `tools/probe-tikhub.mjs` 只读探针脚本对拍，最小费用验证）。
- **FR-1.3 配额与成本**：TikHub 按量计费——每次拉取记录用量（请求数/条数）归集到成本（复用 cost/quota 范式）；轮询频率默认 5 分钟/轮/订阅组，**单平台 QPS ≤ 1**，配额余量低于 20% 触发运维预警。
- **FR-1.4 数据标准化**：统一 `RawMention` 结构（平台、脱敏作者、时间、文本、互动数、链接、抓取时间、平台标识）；TikHub 各平台返回结构差异在适配器内抹平。
- **FR-1.5 幂等去重**：以（平台 + 内容指纹 hash）去重；同源转发聚合。
- **FR-1.6 合规红线**：仅公开数据、不绕过登录墙、不留存可识别个人信息（作者只留脱敏 ID）；订阅词配置变更管理员留痕。
- **FR-1.7 依赖降级**：TikHub 单平台接口失败不阻断其他平台；整体断流 > 30 分钟触发运维预警；`PROMO_PROVIDER_MODE=demo` 下用种子数据跑通全链路（零外部依赖）。

### FR-2 行业热词
- **FR-2.1** 中文分词 + 停用词 + 行业自定义词表（品牌别名/竞品别名/黑名单词，可维护）。
- **FR-2.2** 热词计算：词频 × 互动加权 × 时间衰减，产出**日榜/周榜 TOP 50**，含环比涨幅。
- **FR-2.3** 新词识别：环比涨幅 > 300% 的新词自动标记「爆点候选」，进入预警候选池。

### FR-3 竞品词监测（轻量，动作识别本期不做）
- **FR-3.1** 竞品名作为**普通订阅关键词**参与热词榜与声量/情绪统计（与品牌词同口径）。
- **FR-3.2** 竞品维度情绪指数单独展示（竞品负面 vs 品牌负面对照），作为防御/机会判断的输入。
- ⏸️ 竞品动作事件识别（调价/换代言/新品/大促/危机分类）整体推迟——依赖竞品清单与专项数据端点，本期不做（§11 决议 4）。

### FR-4 情绪分析（one-api LLM，2026-09-04 决议锁定）
- **FR-4.1** 逐条 `RawMention` 经 one-api LLM 打分：`{ sentiment: pos|neu|neg, score, confidence }`；DEMO 模式用词典规则（零成本、确定性）。
- **FR-4.2 成本控制三件套**：① **指纹缓存**——同内容不重复计费（LLM 结果按内容 hash 落缓存）；② **批量打分**——单次请求合并 ≤ 20 条；③ 预算闸门——情绪分析每日 LLM 花费上限可配（`PROMO_NLP_DAILY_CAP`），超限当日降级为词典规则并告警。
- **FR-4.3** 聚合维度：品牌 / 竞品词 / 行业 × 时间窗（1h / 24h / 7d）的情绪指数与负面声量占比。
- **FR-4.4 声量口径（全模块统一）**：`声量 = 内容条数`；**负面声量 = sentiment=neg 且 confidence ≥ 0.6 的条数**。

### FR-5 异常检测与预警（7x24h）
- **FR-5.1 规则引擎**（规则可配、可停用，管理员界面维护）：
  | 规则 | 默认阈值 | 级别 |
  |------|----------|------|
  | 负面声量突增 | 近 1h 负面声量 ≥ 前 24h 同期均值 × 3（即突增 200%） | 🔴 P0 |
  | 负面占比超线 | 24h 负面占比 ≥ 30% 且声量 ≥ 基线 | 🟠 P1 |
  | 热词爆点 | 新词环比 > 300% 且进入 TOP 10 | 🟡 P2 |
  | 长尾沉默告警 | 品牌声量 24h 低于基线 50%（提示投放失灵） | 🟡 P2 |
- **FR-5.2 通知通道**：**仅站内信**（顶栏红点 + 预警中心列表）；企微/邮件/短信通道本期不做（§11 决议 3）。同一事件 2h 内不重复触达。
- **FR-5.3** 预警详情：命中规则、数据快照（声量曲线 + 代表性负面内容 TOP5 + 情绪占比）、AI 一句话建议（如「建议 4h 内出防御性声明 → 一键转防御选题」）。
- **FR-5.4** 预警生命周期：`firing → acked（认领）→ resolved（处置）`；站内信场景下 P0 超 30 分钟未认领在列表置顶加急标。

### FR-6 品牌人设库（Tone & Voice）
- **FR-6.1** 人设档案：品牌调性关键词、口号、禁用词、人格画像（第一人称是谁、说话风格样例 3 条）、禁忌话题、视觉主色。
- **FR-6.2** 与 brand-promo-agent 的 BrandTemplate **同源复用**（人设库为模板库的上游超集，不重复维护两份）；修改人设库自动同步模板。
- **FR-6.3** 选题与生成均以人设库为全局约束注入 prompt（复用 brand-promo-agent 已有的 `withGlobalLanguage` / 禁用词 / 主色注入机制）。

### FR-7 AI 选题生成（每日 10 个）
- **FR-7.1 输入上下文**（每次生成注入 Agent）：人设库 + 近 7 天热词榜 + 未关闭预警 + 竞品词声量/情绪对照 + 本周已定战役（防重复）。**注意：无 CTR 数据（决议 2），历史效果维度本期不注入。**
- **FR-7.2 生成配额**：每日 1 次（可手动补跑），产出 **10 个选题**，每个选题含：
  - 标题 / 核心信息点（≤3 条）/ 建议形式（宣传片/图文/海报）/ 建议渠道；
  - 类型标签：`进攻`（必打战役）/ `借势`（热词）/ `防御`（负面/竞品）；
  - 依据摘要（引用了哪些热词/预警/声量数据——**强制引用，禁止无依据编造**）。
- **FR-7.3 去重与一致性**：与近 14 天已采纳选题语义去重（embedding 相似度 ≥ 0.85 拒绝）；全部选题过禁用词与禁忌话题过滤。

### FR-8 选题打分排序
- **FR-8.1 打分模型**（0-100，权重可配；**本期无 CTR 数据源，权重已重分配**）：
  | 维度 | 本期权重 | 数据来源 |
  |------|----------|----------|
  | 热度势能 | 45% | 选题关联热词/预警的实时声量与涨幅 |
  | 品牌契合度 | 35% | 与人设库调性的一致性（LLM 评审打分） |
  | 风险度 | 20% | 负向扣分：蹭敏感热词、与负面事件过度关联 |
  | 历史 CTR | **预留 0%** | 接口保留（`ctr` 字段与权重槽位），后续接入效果数据后启用 |
- **FR-8.2** 排序输出：TOP10 按总分降序，附维度明细与依据引用；**打分可解释**（每个维度点开能看到数据引用）。

### FR-9 会商工作台（PM 决策）
> （原 FR-9 效果回流已按决议移出本期，本章重新编号）
- **FR-9.1 周会模式**：一键进入本周会商视图——TOP10 选题 + 未关闭预警 + 竞品词声量/情绪对照。
- **FR-9.2 一键确认**：
  - 勾选 ≤ 3 个选题标记为**「必打战役」**（进攻）；
  - 勾选 ≤ 2 个标记为**「防御性声量」**（跟随负面事件，预设 4h 响应 SLA）；
  - 其余可「保留观察」或「否决」（否决需选原因，回流给 Agent 优化）。
- **FR-9.3 下发生成**：确认的选题一键生成 Brief（预填品牌/卖点/调性/语言，复用 templates 套用逻辑）并调用 `POST /api/generate` 进入 brand-promo-agent 流水线；生成进度在工作台内嵌展示。
- **FR-9.4 周报沉淀**：本周会商结果（战役/防御/否决原因）自动生成周报存档。

### FR-10 可观测与追溯
- **FR-10.1** 采集/NLP/预警/选题全链路有 runId 与耗时/费用归集（复用 brand-promo-agent 的 cost/quota 机制；TikHub 用量与 LLM token 分别计量）。
- **FR-10.2** 每个选题、每条预警可回放到「当时的数据快照」，禁止事后改数。

---

## 5. 非功能需求（NFR）

| 类别 | 要求 |
|------|------|
| 时效 | TikHub 拉取轮询 ≤ 5 分钟/轮/订阅组；预警端到端 < 15 分钟 |
| 合规 | 仅公开数据、PIPL 最小化存储（作者脱敏）、订阅配置审批留痕、数据可删除 |
| 成本 | TikHub 按量费用 + LLM 情绪/选题费用均归集到 cost/quota；`PROMO_NLP_DAILY_CAP` 每日情绪预算上限；超限降级词典规则 |
| 可靠 | TikHub 单平台失败不阻断其他平台；LLM 超时/失败降级词典规则；预警落库即达（不因下游故障丢失） |
| 扩展 | Collector 适配器抽象保留——未来可插拔官方 API / 其他数据服务商，处理/预警/选题层零改动 |
| 安全 | TikHub key 与 one-api 凭据仅服务端；订阅词表权限化管理 |

---

## 6. 数据模型（核心实体）

```ts
interface RawMention {
  id: string;                 // 平台+指纹 hash（幂等键）
  platform: 'douyin'|'xhs'|'weibo'|'bilibili'|'zhihu'|'weixin';  // 以 TikHub 实际覆盖为准
  sourceType: 'tikhub';       // 本期单一来源，保留枚举便于未来扩展
  authorHash: string;         // 脱敏作者 ID
  publishedAt: string;
  text: string;               // 已清洗文本
  metrics: { likes?: number; comments?: number; shares?: number };
  url: string;
  crawledAt: string;
  keywordSet: string;         // 命中的订阅词组
  _usage?: { requests: 1 };   // TikHub 计量
}

interface SentimentScore { sentiment: 'pos'|'neu'|'neg'; score: number; confidence: number; model: string; cached: boolean; }

interface Alert {
  id: string;
  ruleId: string;
  level: 'P0'|'P1'|'P2';
  snapshot: object;           // 触发时数据快照（不可变）
  suggestion?: string;        // AI 一句话建议
  status: 'firing'|'acked'|'resolved';
  ackedBy?: string; resolvedAt?: string;
}

interface Topic {
  id: string;
  date: string;               // 生成批次日
  title: string;
  keyMessages: string[];
  form: 'video'|'article'|'poster';
  channel: string[];
  type: 'offense'|'trend'|'defense';   // 进攻/借势/防御
  evidence: object;           // 引用的热词/预警/声量依据（强制）
  score: { heat: number; fit: number; risk: number; ctr?: number; total: number };  // ctr 预留
  status: 'generated'|'confirmed_battle'|'confirmed_defense'|'hold'|'rejected';
  rejectReason?: string;
  runId?: string;             // 下发 brand-promo-agent 的 runId
}
```

---

## 7. API 契约（草案）

### 采集与舆情
- `POST /api/radar/subscriptions` — 配置关键词订阅组（词组/平台/轮询间隔），管理员留痕
- `GET  /api/radar/hotwords?range=day|week` — 热词榜
- `GET  /api/radar/sentiment?target=brand|{competitorKeyword}&window=24h` — 情绪指数
- `GET  /api/radar/alerts?status=firing` — 预警列表（站内信）
- `POST /api/radar/alerts/:id/ack` / `/resolve` — 认领 / 处置
- `GET  /api/radar/quota` — TikHub 配额余量与当日 NLP 花费

### 选题会商
- `POST /api/topics/generate` — 触发本轮选题生成（每日定时 + 手动补跑）
- `GET  /api/topics?date=` — 某批次 TOP10（含打分明细）
- `POST /api/topics/:id/confirm` — body: `{ decision: 'battle'|'defense'|'hold'|'reject', rejectReason? }`
- `POST /api/topics/:id/dispatch` — 生成 Brief 并下发 brand-promo-agent → 返回 `{ runId }`
- `GET  /api/persona` / `PUT /api/persona` — 人设库读写（同步 BrandTemplate）

---

## 8. 架构

```
┌──────────────┐   ┌────────────────────┐   ┌─────────────────────────────┐
│ TikHub       │──▶│ Collector 层        │──▶│ 处理管道（队列解耦）          │
│ 多平台社媒API │   │ TikHub 适配器        │   │ 清洗→去重→分词→LLM情绪→聚合  │
│ (抖音/小红书/ │   │ 订阅驱动+配额计量    │   │ (指纹缓存+预算降级)          │
│  微博/B站)    │   └────────────────────┘   └──────────┬──────────────────┘
└──────────────┘                                       ▼
                                      ┌─────────────────────────────┐
                                      │ 存储层                        │
                                      │ mentions / hotwords /        │
                                      │ alerts / topics              │
                                      └──────┬───────────┬──────────┘
                                             ▼           ▼
                                  ┌────────────────┐ ┌──────────────────┐
                                  │ 预警规则引擎     │ │ 选题 Agent(Mastra)│
                                  │ 阈值+站内信      │ │ 人设库+舆情上下文  │
                                  └────────┬───────┘ └────────┬─────────┘
                                           ▼                  ▼
                                     PM 会商工作台 ◀──▶ brand-promo-agent
                                     （确认/下发）        （Brief→成片闭环）
```

- **形态 A（本期原型）**：与 brand-promo-agent 同栈（Node + Express + Mastra），单进程 + 定时任务（node-cron）；内存队列；LLM 批量打分 + 指纹缓存。
- **形态 B（生产）**：采集与处理拆独立进程 + BullMQ/Redis；存储升级 PostgreSQL；缓存升级 Redis。
- **DEMO/真实双轨**：沿用 `PROMO_PROVIDER_MODE` 范式——DEMO 用种子数据 + 词典情绪规则，真实模式接 TikHub + LLM；工作流层零改动。

---

## 9. 里程碑（v0.2 按决议调整）

| 阶段 | 内容 | 交付 |
|------|------|------|
| M1 | TikHub 适配器（probe 探针对拍端点）+ 订阅配置 + RawMention 落库去重 + 热词榜 + DEMO 种子数据 | 舆情看板可看 |
| M2 | one-api LLM 情绪打分（指纹缓存 + 批量 + 每日预算降级）+ 预警规则引擎 + 站内信预警中心 | 预警可触达 |
| M3 | 选题 Agent + 打分排序 + 一键下发 brand-promo-agent（v0.3 收窄：**无会商工作台**，FR-9.3 直连版） | 决策闭环 |
| M4 | ~~稳定化：配额监控、断流预警、成本报表（`GET /api/radar/quota`）、LLM 缓存命中率调优~~ | ❌ 不做（决议 8） |
| ⏸️ 后续期 | 竞品动作识别（依赖竞品清单）、CTR 效果回流（依赖投放数据系统）、外部通知通道、M4 稳定化全套 | 按主理人后续决策 |

---

## 10. 风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| TikHub 依赖风险（接口变更/限流/涨价/停服） | 数据断流、成本波动 | 适配器隔离（换源只改 Collector）；配额余量预警（<20%）；断流>30min 运维预警；DEMO 种子数据保底演示 |
| LLM 情绪按条计费成本超预期 | 烧钱 | 指纹缓存 + 批量打分 + `PROMO_NLP_DAILY_CAP` 超限降级词典规则（FR-4.2） |
| LLM 情绪误判 | 误报/漏报 | confidence ≥ 0.6 才计负面；人工 ack 闭环；每周抽检 50 条校准 |
| LLM 选题编造依据 | 决策误导 | 依据强制引用热词/预警 ID，无引用不产出；打分明细可回放 |
| 预警疲劳 | 漏看 P0 | 同事件合并 + 2h 静默 + 站内信分级置顶 |
| 平台数据口径差异（互动数/去重规则） | 热度失真 | 适配器统一标准化（FR-1.4）；口径写入文档 |

---

## 11. 决议记录（v0.2，2026-09-04 主理人拍板）

| # | 原开放问题 | 决议 |
|---|-----------|------|
| 1 | 数据源选型与预算 | ✅ **TikHub**（https://user.tikhub.io，多平台社媒数据 API）；API-KEY 已落服务端 `.env`（`TIKHUB_API_KEY`，gitignore 覆盖不入库）；端点对拍用只读探针脚本 `tools/probe-tikhub.mjs`（M1 交付） |
| 2 | 历史 CTR 数据来源 | ❌ **不做**：本期无 CTR 数据源；效果回流整体移出；打分模型去 CTR 维度、权重重分配（热度 45/契合 35/风险 20），接口保留 `ctr` 字段与权重槽位 |
| 3 | 预警通知主通道 | ❌ **不做**外部通道（企微/邮件/短信）；~~仅站内信~~（决议 6 进一步收窄：站内信也不做） |
| 4 | 竞品清单 | ❌ **不做**：竞品库与动作识别（原 FR-3 事件分类）推迟；竞品名仅作订阅关键词参与声量/情绪统计（FR-3 轻量版） |
| 5 | 情绪分析模型 | ✅ **走 one-api LLM**（灵活、复用现有网关与计价），配指纹缓存 + 批量打分 + 每日预算上限降级三件套控制成本（FR-4.2）；量大后可平滑切专用 NLP 服务（适配器内替换） |
| 6 | 预警与站内信（2026-09-04 二次决议收窄，M2 落地时拍板） | ❌ **不做**：FR-5 规则引擎、预警生命周期、站内信预警中心整体移出；情绪能力止步于「打分 + 聚合摘要」（`POST /api/radar/score`、`GET /api/radar/sentiment` + 前端看板） |
| 7 | 会商工作台（2026-09-04 三次决议收窄，M3 落地时拍板） | ❌ **不做**：FR-9.1 周会视图 / FR-9.2 一键确认 / FR-9.4 周报移出；保留 FR-9.3 直连版——选题榜 + 一键下发（HITL 脚本门/成片门照常兜底人工审核） |
| 8 | M4 稳定化（2026-09-04 四次决议，M3 收官时拍板） | ❌ **不做**：配额监控、`GET /api/radar/quota` 成本报表、LLM 缓存命中率调优、node-cron 定时「采集→打分→生成」链整体移出；雷达模块定格于 M1+M2+M3 收窄版（手动触发的采集/打分/生成链） |

---

## 12. 验收标准（DoD，M3 为准）

- [ ] 配置品牌词 + ≥1 竞品词订阅后，系统在 DEMO 模式下可完整走通：采集（种子数据）→ 热词榜 → 情绪打分与指数 → 选题 10 个 → 打分排序 → PM 确认 → 下发 brand-promo-agent 产出宣传片。
- [ ] 真实模式下 TikHub 探针脚本对拍成功（≥1 个平台搜索端点），同样链路产出真实数据驱动的选题。
- [ ] ~~注入「负面声量突增 200%」模拟数据触发 P0 预警~~（预警/站内信移出范围，决议 6）；改为：情绪聚合摘要正确输出负面声量与情绪指数（M2 已落地，见 §14）。
- [x] 情绪分析：同内容二次打分命中指纹缓存（零 LLM 计费）；`PROMO_NLP_DAILY_CAP` 调小后当日自动降级词典规则（M2 已落地并测试，见 §14）。
- [x] 选题链路（M3 收窄版，见 §15）：DEMO 全程可走通 采集 → 热词/情绪 → 生成 10 选题（强制依据）→ 打分排序 → 一键下发进入 brand-promo-agent 流水线（runId 可查，HITL 脚本门挂起待审）；真实模式下选题经 one-api LLM 产出、依据词越界即淘汰。
- [ ] 每个选题可展开打分明细（热度/契合/风险）与数据依据引用；无依据的选题不出现。
- [ ] PM 确认「必打战役」后，工作台内嵌看到 brand-promo-agent 的 runId 与生成进度。
- [ ] 合规检查：库里任意 mention 作者字段均为脱敏 ID；订阅配置变更留痕可查；`TIKHUB_API_KEY` 不出现在任何 API 响应与前端代码中。

---

## 13. M1 实施记录（2026-09-04，已落地）

### 13.1 TikHub 端点矩阵（探针实测，非推断）
| 能力 | 端点 | 实测 |
|------|------|------|
| 账户/配额 | `GET /api/v1/tikhub/user/get_user_info` | ✅ 200（余额 $5，scopes 覆盖 douyin/search、xiaohongshu/app_v2、weibo/web、bilibili/web） |
| 抖音综合搜索 | `POST /api/v1/douyin/search/fetch_general_search_v2` body `{keyword,sort_type:"0",publish_time:"7",cursor:0}` | ✅ 200，`data.data.business_data[].data.aweme_info` |
| 小红书搜索 | `GET /api/v1/xiaohongshu/app_v2/search_notes?keyword&page` | ✅ 200，`data.data.data.items[].note` |
| B站搜索 | `GET /api/v1/bilibili/web/fetch_general_search?keyword&order=totalrank&page=1&page_size=20` | ✅ 200，`data.data.data.result[]` |
| 微博搜索 | `GET /api/v1/weibo/web/fetch_search` | ❌ **404**（TikHub 侧路由未上线）→ 适配器标 `unsupported`，fail-soft 跳过，不阻断其他平台 |
| 端点对拍工具 | `tools/probe-tikhub.mjs`（`npm run probe:tikhub`） | 只读模式零费用；`--live <平台> --kw <词>` 单次计费实测 |

### 13.2 成本优化（实测发现，写进 FR-1.3）
TikHub 计费响应内带 **24h 免费 `cache_url`**——同「平台+关键词」的重复轮询改走缓存链接即**零计费**，缓存失效才回落计费端点。适配器按 `platform:keyword` 维护 TTL 24h 的 cache_url 表。配合单平台 QPS≤1 节流（`PROMO_RADAR_QPS_GAP_MS`，默认 1100ms），5 分钟轮询的成本压力大幅下降。

### 13.3 热词分词（无分词库方案，实测调优）
- 组成：拉丁词（`[a-z0-9]+`，≥2 字）+ 订阅词表命中（任意长度，品牌词兜底）+ **中文 2-gram，步长 2 不重叠**。
- **去噪三招**（缺一即不可读，均已实测）：① 首尾虚词过滤（的/了/是/真…结尾或开头直接丢）；② 子串抑制（长词与子串计数接近 ≥80% → 丢子串）；③ 冷词门槛（中文词仅 1 次丢弃，**订阅关键词豁免**）。
- 调优过程：逐字滑窗（step=1）会让「赛道最近 / 近有点卷 / 大家怎么」同源碎片集体霸榜；改 step=2 不重叠后，实测 TOP12 变为 ai / 深度 / 体验 / 工具 / 效率 / 提升 / 分享 / 讨论 / 赛道…（可读）。

### 13.4 文件清单
```
src/radar/subscriptions.js   # 订阅词组（CRUD + 预置保护 + 写穿持久化）
src/radar/tikhub.js          # TikHub 适配器：端点矩阵 + cache_url 免计费 + DEMO 种子双轨
src/radar/mentions.js        # Mention 落库（内容指纹幂等去重，容量 5000 淘汰最旧）
src/radar/hotwords.js        # 热词计算（词频×互动×半衰期24h，日/周榜 + 环比 + 爆点）
src/server.js                # /api/radar/{status,subscriptions,collect,hotwords,mentions}
public/index.html            # 舆情雷达卡片：订阅管理 + 一键采集 + 热词榜（日/周切换）
tools/probe-tikhub.mjs       # 只读/实测探针
tests/radar-core.test.mjs    # 10 例：订阅/去重/热词去噪/适配器(mock fetch + cache_url)
tests/radar-server.test.mjs  # 4 例：端点 e2e（DEMO 零外呼断言）
```

### 13.5 M1 验收状态
- [x] `npm test` **108/108 全绿**（93 → 107 → 108，M1 新增 14 例 + 1 例去噪回归）。
- [x] DEMO 端到端：`POST /api/radar/collect` 采集 75 条（5 关键词 × 3 平台 × 5 条），`requests=0`（零计费）；二次采集 `added=0 / duplicates=75`（幂等去重成立，且跨进程重启仍命中）。
- [x] 热词榜可读，环比/`new`/爆点标记正常。
- [x] 前端内联 JS 语法校验通过；首页 HTTP 200。
- [x] 合规：作者字段在适配层即转为 `a:<hash>` 脱敏，入库无明文作者名（单测断言）。

### 13.6 已知限制与后续（M2 起）
- **微博不可用**：TikHub 路由未上线，等平台侧恢复后适配器去掉 `unsupported` 即可启用。
- **无分词库**：长实体（未订阅的 3~4 字词）识别不足；M2 若需要可引入轻量分词器（当前靠订阅词表兜底）。
- **无定时轮询**：M1 为手动「立即采集一轮」触发；FR-1.3 的 5 分钟轮询待 M2 接 node-cron（+ 进程常驻）。
- **无 NLP 情绪**：属 M2（FR-4，one-api LLM + 指纹缓存 + 每日预算降级）。→ 已在 §14 落地。

---

## 14. M2 实施记录（2026-09-04，已落地 · 收窄版）

> 范围收窄（决议 6）：**只做 LLM 情绪打分 + 聚合摘要**；预警规则引擎、站内信预警中心不做。

### 14.1 输出口径
每条去重后的 mention 打分为 `{ sentiment: pos|neu|neg, score: -1~+1, confidence: 0~1, source: llm|dict|demo }`。
- **严格负面声量口径**：`sentiment === "neg" && confidence >= 0.6`。词典降级 confidence=0.55（故意低于门槛，避免词典误判污染指标）；DEMO confidence=0.9（可进）。
- **情绪指数**：`(平均 score + 1) × 50` → 0（极负）~ 100（极正）。
- System 指令明确要求：反讽 / 阴阳怪气 / 明褒实贬一律判负面（词典法在该场景会误判为正面）。

### 14.2 降本三件套（FR-4.2 落地）
| 手段 | 实现 |
|------|------|
| 指纹缓存 | mentionId（内容指纹）→ 打分结果写穿 `data/radar-sentiment.json`（原子替换）；已打分内容零重复计费，重启后仍命中 |
| 批量打分 | 单次 `chat/completions` 打包 ≤ `PROMO_NLP_BATCH_SIZE`（默认 20）条，单条文本截断 300 字 |
| 每日预算 | `PROMO_NLP_DAILY_CAP`（0 = 不限）：当日 LLM 已打分条数达上限 → 后续批次自动降级词典规则（不报错，摘要标记 `downgraded`） |

### 14.3 模式分支与兜底
- **DEMO**：确定性特征词打分（source=demo，confidence 0.9），零外部依赖、可复现。
- **real + 网关已配置**：one-api LLM 批量打分（模型 = `PROMO_RADAR_NLP_MODEL` > `PROMO_LLM_MODEL` > `deepseek-v4-flash`；temperature 0.1 + json_object）。
- **兜底链**：网关未配置 / 单批 LLM 失败 / 单条结果非法或缺失 / 预算超限 → 词典规则（source=dict，confidence 0.55），单批失败不阻断整体。

### 14.4 API 与文件
```
POST /api/radar/score?limit=N   # 打分未处理声量（缓存跳过已打分；返回 llmScored/dictScored/demoScored/cacheSkipped/downgraded/tokens）
GET  /api/radar/sentiment?windowHours=24   # 聚合摘要：pos/neu/neg、严格负面声量、negRatio、情绪指数、分平台统计
GET  /api/radar/mentions        # 列表条目合并 sentiment/sentimentScore/sentimentConfidence/sentimentSource
GET  /api/radar/status          # nlp 配置（模型/批量/预算/今日用量）随 sentiment 摘要下发

src/radar/sentiment.js           # 打分模块（缓存持久化 / LLM 批量 / 词典降级 / DEMO 特征词 / 聚合摘要）
src/server.js                    # 上述 3 个新端点 + mentions 合并情绪字段
public/index.html                # 「情绪分析」面板：打分按钮 + 声量/正中负/负面声量/情绪指数 + 比例条
tests/radar-sentiment.test.mjs   # 6 例：DEMO 确定性 / 指纹缓存 / 聚合口径 / LLM 批量+预算降级 / 失败兜底 / server e2e
.env.example                     # PROMO_RADAR_NLP_MODEL / PROMO_NLP_BATCH_SIZE / PROMO_NLP_DAILY_CAP
```

### 14.5 M2 验收状态
- [x] `npm test` **114/114 全绿**（108 → 114，M2 新增 6 例）。
- [x] 指纹缓存：同内容二次打分 `pending=0`、`cacheSkipped` 正确计数（测试断言）。
- [x] 每日预算：`PROMO_NLP_DAILY_CAP=2` 时第 1 批走 LLM、第 2 批自动降级词典（mock fetch 断言仅 1 次外呼）。
- [x] 反讽用例：「又双叒翻车了…大开眼界」LLM 判 neg（score −0.92 / conf 0.93）；词典法同文本会误判——即 M2 存在的意义。
- [x] 单批 LLM 失败（HTTP 500）→ 该批词典兜底、错误入 `stats.errors`，不阻断不抛错。
- [x] server e2e：打分 → 摘要 → mentions 情绪字段合并全链路通过。

### 14.6 M2 已知限制与后续
- **定时打分**：仍为手动触发（与采集一致）；接 node-cron 后可「采集 → 打分」链上自动跑。
- **词典规则为兜底精度**：仅覆盖常见负面/正面词，长尾口语依赖 LLM；预算超限日指标精度下降（摘要已标记 `downgraded`）。
- **M3**：选题 Agent + 打分排序 + 会商工作台 + 一键下发（情绪摘要作为「品牌契合/风险」维度的输入）。

---

## 15. M3 实施记录（2026-09-04，已落地 · 收窄版）

> 范围收窄（决议 7）：**不做会商工作台**；交付「选题 Agent + 打分排序 + 一键下发」直连版。
> 插曲：M2 落地时写入的 §11 决议 6 行因会话中断丢失，本轮补齐（决议 6/7 现均在档）。

### 15.1 选题 Agent（FR-7 落地口径）
- 输入上下文：人设库 + 近 7 天热词榜（过滤选题侧停用词：相关/以及/我们等 2-gram 虚词残留）+ 近 7 天情绪摘要 + 订阅关键词。
- 产出 10 个选题：标题 / 核心信息点（≤3）/ 建议形式（宣传片|图文|海报）/ 建议渠道 / 类型标签（offense 进攻 | trend 借势 | defense 防御）。
- **强制依据（FR-7.2）**：每个选题必须引用 ≥1 个真实热词；LLM 产出里 evidenceWords 越界（不在热词表）一律丢弃，全部失效则该条淘汰。
- **过滤（FR-7.3 简化版）**：禁用词/禁忌话题命中即过滤（errors 留痕）；近 14 天已下发选题按标题精确去重（语义 embedding 留后续）。
- 模式：DEMO = 确定性模板（defense 分支仅在负面声量 > 0 时占用末 2 席）；real = one-api LLM（temperature 0.6 + json_object），**有效产出 < 5 → 整体回落 DEMO**，5~9 → DEMO 补齐缺口。

### 15.2 打分排序（FR-8 落地口径）
- `total = 0.45×热度 + 0.35×契合 + 0.20×(100−风险度)`；`ctr` 槽位预留（恒 null，决议 2）。
- 分值全部钳制 0~100（LLM 给 150 → 100）；按总分降序输出 rank 1~10，前端展示维度明细与依据。

### 15.3 一键下发（FR-9.3 直连版）
- `POST /api/radar/topics/:id/dispatch` → 人设预填 Brief（brandName/卖点/调性/受众/主色/禁用词，选题标题注入 keyMessages）→ 复用 `POST /api/generate` 流水线 → 返回 runId。
- **HITL 不旁路**：hitlEnabled 默认 true，脚本确认门/成片门照常弹出——直连不等于跳过人工审核。
- 下发历史留痕（topicId/title/type/runId/dispatchedAt，近 14 天），支撑去重与追溯（FR-10.2）。

### 15.4 人设库（FR-6 轻量版）
- 单例档案 `data/radar-persona.json`，预置「铭星链」默认值；PUT 合并保存 + 字段级校验（主色 #RGB/#RRGGBB、数组 ≤12 项、语言枚举）。
- `personaViolations()` 供选题过滤与下发约束共用。与 BrandTemplate 双向自动同步（FR-6.2 完整版）留后续。

### 15.5 API 与文件
```
GET  /api/radar/persona                    # 人设读取（附 topicConfig：模式/模型/权重）
PUT  /api/radar/persona                    # 人设合并保存（字段级校验，非法 400）
POST /api/radar/topics/generate            # 生成今日 10 选题（手动补跑覆盖当日；LLM 失败回落 DEMO）
GET  /api/radar/topics                     # 今日选题榜 + 近 14 天下发历史
POST /api/radar/topics/:id/dispatch        # 一键下发 → Brief → /api/generate 流水线 → runId

src/radar/persona.js             # 人设库（单例 + 校验 + 禁用词命中）
src/radar/topics.js              # 选题 Agent（LLM/DEMO 双轨 + 依据强制 + 打分 + 去重 + Brief 组装）
src/server.js                    # 上述 5 个端点（dispatch 复用 runScriptPhase）
public/index.html                # 「选题会商」面板：生成/榜单（类型标签+分数+依据）/一键下发 + 人设折叠编辑器
tests/radar-topics.test.mjs      # 7 例：人设校验 / 打分公式 / DEMO 确定性 / 过滤与去重 / LLM 越界淘汰 / LLM 合规补齐 / server e2e（下发挂起脚本门）
.env.example                     # PROMO_RADAR_TOPIC_MODEL / PROMO_RADAR_TOPIC_COUNT
```

### 15.6 M3 验收状态
- [x] `npm test` **121/121 全绿**（114 → 121，M3 新增 7 例）。
- [x] E2E smoke（DEMO）：采集 75 → 打分 75 → 生成 10 选题（rank1 总分 90）→ 下发 runId 返回，Brief 人设预填 + 选题标题注入。
- [x] server e2e：下发后 run 状态轮询至 `suspended`（脚本门挂起待审）——HITL 闭环成立。
- [x] 前端内联 JS 语法校验通过。
- [x] 停用词修正：选题不再引用「相关」类 2-gram 虚词残留（只挡选题侧，热词榜保持 M1 原样）。

### 15.7 已知限制与后续
- **语义去重未做**：14 天去重为标题精确匹配；embedding 相似度（FR-7.3 完整版）留后续。
- **选题 LLM 用量未入 cost/quota**：生成 token 数未归集到成本报表（FR-10.1 完整版留后续）。
- **M4 不做（决议 8）**：配额监控 / 成本报表 / 缓存命中率调优 / node-cron 定时链整体移出；采集→打分→生成维持手动触发（前端按钮驱动），雷达模块就此定格于 M1+M2+M3 收窄版。
