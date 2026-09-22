# 全片视觉风格固化设计

日期：2026-09-23
状态：已实施

## 1. 问题

真实链路产出的成片出现「第一个分镜是真人、后面是动漫」的画风漂移。三处独立成因叠加：

1. **分镜阶段没有风格输入**：`generateStoryboard` 的提示词只写「视觉风格全程统一」这句空话，从不携带任何风格信息，`temperature=0.7`，模型对每个分镜各写一段彼此无关的画面描述。
2. **图像阶段只在尾部追加**：`generateSceneMedia` 把 `styleReference` 关键词拼在提示词末尾（`${prompt}；参考风格：${ref}`），且 `styleReference` 为空时完全没有风格约束。
3. **动态视频阶段完全没有风格约束**：`requestSceneVideoTask` 的 `prompt` 只取 `scene.visualPrompt`，与分镜、场景图各自为政；首帧被内容审核拒绝后走文生退化路径时同样没有约束。

只要这三段提示词不同源，各分镜就会各自选一种画风。修一处不够，必须让三段共用同一个来源。

## 2. 方案

新增受控风格预设注册表 `src/media/style.js`，与 `src/media/canvas.js` 同构（冻结注册表 + 解析函数 + 提示词函数），作为全片风格的**唯一事实来源**：

- `STYLE_PRESETS`：`photoreal`（真人实拍，默认）/ `anime`（动漫）/ `three-d`（3D 渲染）/ `illustration`（插画）/ `ink-wash`（国风水墨）/ `custom`（自定义）。
- `resolveStyle(id)`：未知值直接抛错，禁止静默回落，避免提交了风格却悄悄变成默认值。
- `stylePrompt(brief)`：返回一段含画风、光影、材质、色彩四个可判定维度 + 全片统一硬约束的中文风格锚点；`custom` 时拼接用户在 `Brief.styleDescription` 中的补充描述。

Brief 新增两个结构化字段（与既有 `styleReference` 并存）：

| 字段 | 语义 | 约束 |
| --- | --- | --- |
| `stylePreset` | 画面风格预设标识 | 受控枚举，默认 `photoreal`；未知值 400 |
| `styleDescription` | 自定义风格补充描述 | ≤200 字；`stylePreset=custom` 时必填 |

`styleReference` 保持原语义不变（`data:`/http(s) 走图生图，纯关键词追加到提示词），只把用户输入框标签改为「风格参考图 / 关键词」以区分。

### 2.1 注入点

| 阶段 | 位置 | 注入方式 |
| --- | --- | --- |
| 分镜 | `generateStoryboard` user prompt | 携带风格锚点，并要求 `visualPrompt` 只描述画面内容、不得自定义画风；`temperature` 由 0.7 降到 0.4 |
| 场景图 | `generateSceneMedia` | 风格锚点**前置**（原实现是尾部追加关键词） |
| 动态视频 | `requestSceneVideoTask` | 风格锚点前置，覆盖「带首帧」与「无公网首帧/首帧被拒退化」两条路径 |
| DEMO 分镜 | `demoStoryboard` | 去掉逐镜随机 `pick(tones, rnd)`，改为统一锚点 |
| 交付回显 | `composeFinalVideo` → `manifest.style` | 记录 `preset` / `label` / `description`，交付页展示「风格」 |

### 2.2 为什么不做「逐镜前缀」

曾考虑要求模型让每镜 `visualPrompt` 以同一段风格锚点原文开头。放弃原因：锚点由下游图像与视频阶段统一前置，逐镜再抄一遍会让最终提示词出现两段重复锚点，浪费 token 且可能让模型把风格词当成内容描述。风格只允许有一个来源。

### 2.3 与首帧退化的关系

FR-4.5 的首帧内容审核退化（`InputImageSensitiveContentDetected.PrivacyInformation`）只改变输入形态（去掉首帧走文生），**不得改变 prompt**。风格锚点位于 `requestSceneVideoTask` 构造 prompt 的位置，早于首帧判定，因此退化路径天然携带同一锚点。

## 3. 影响面

- `src/media/style.js`（新增）
- `src/schemas.js`：`stylePreset` / `styleDescription` + `custom` 必填校验
- `src/mastra/providers.js`：分镜、场景图、动态视频、DEMO 分镜四处注入
- `src/media/ffmpeg.js`：`manifest.style` 透传
- `public/index.html`：风格预设下拉 + 自定义描述输入 + 交付区风格回显
- `docs/openapi.json`：BrandBrief 新增字段
- `tests/style.test.mjs`（新增）与既有 provider / 前端用例扩展

## 4. 验收

1. `stylePrompt` 对同一 Brief 恒返回同一字符串，且五个预设两两不同。
2. 分镜 user prompt、场景图 body.prompt、动态视频提交 body.prompt 三者都包含同一段风格锚点。
3. 纯文生与首帧退化两条视频路径的 prompt 都包含风格锚点。
4. 未知 `stylePreset` / `custom` 缺 `styleDescription` 在 `POST /api/generate` 返回 400。
5. 交付页在 `brief.stylePreset` 或 `manifest.style` 存在时展示风格标签。
