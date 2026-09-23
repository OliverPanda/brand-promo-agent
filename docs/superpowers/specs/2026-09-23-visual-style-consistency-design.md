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

## 5. 第二阶：生成审计、固定 seed 与像素锚点

第一阶只解决了「提示词同源」。实测仍存在三类残余漂移：交付清单看不到每镜实际用的是哪个视频模型、走的是图生视频还是文生退化；同 prompt 下逐镜仍有随机抖动；以及跨镜之间没有任何像素级约束。第二阶按序补齐这三点。

### 5.1 生成审计（manifest 逐镜记录）

- `providers.generateSceneVideo` 在返回结果上附加 `videoMode`，取值由与首帧判定同源的谓词导出：`canDropFrame && !frameDropped` 为 `image-to-video`，否则为 `text-to-video`。
- `workflow.generateScenes` 把 `vid.videoMode` 写入该镜；`ffmpeg.composeFinalVideo` 把 `videoModel` / `videoMode` 带入 `manifest.scenes[i]`。
- 语义分工：`manifest.models.video` 是请求端解析出的模型，`manifest.scenes[i].videoModel` 是实际出片模型。渠道降级后两者不同，逐镜记录是权威口径。

### 5.2 固定 seed

- seed 取 `hashSeed(brief.brandName + brief.coreSellingPoint)`，全片同值、不逐镜变化；同一 Brief 重复生成得到相同 seed。
- 视频提交体走 `body.metadata.seed`。依据（网关源码 `napi-audit/src/new-api-0.13.2`）：`relay/common/relay_info.go:676-687` 的 `TaskSubmitReq` 只认 `prompt/model/mode/image/images/size/duration/seconds/input_reference/metadata`，顶层 `seed` 被丢弃；`relay/channel/task/doubao/adaptor.go:59` 定义 `Seed *dto.IntValue`，`:289` 经 `taskcommon.UnmarshalMetadata` 把 `metadata` 合入渠道请求；`task/taskcommon/helpers.go:16-30` 先删掉 metadata 里的 model 键再 JSON 往返，全仓库无 `DisallowUnknownFields`，因此未知 metadata 键静默忽略——minimax-h3（`task/hailuo/models.go:8-20` 无 seed 字段）收到该键无副作用。`dto/values.go:30-52` 的 `IntValue` 同时接受数字与数字字符串，传整数即可。
- 图像提交体带 `seed` 属于 best-effort：`dto/openai_image.go:14-37` 的 `ImageRequest` 不含 `seed`，未知字段落入 `Extra`，而 `:82-88` 的 `Extra` 合并被显式注释掉（原文 `// 不能合并ExtraFields！！！！！！！！`），序列化即丢；`relay/channel/volcengine/adaptor.go:108-111` 对 `RelayModeImagesGenerations` 直接原样返回，不做补救。既有测试只断言客户端 body，所以仍会通过。结论是图像 seed 当前不会到达上游，本改动不声称它已生效。
- 不为此打真实付费接口做验证；以客户端请求体断言覆盖。

### 5.3 像素锚点

- `generateSceneMedia` 新增 `options.referenceImageUrl`；命中公网 http(s) 且未被用户显式参考图占用时，写入 `body.image`。
- 优先级显式定义：用户显式 `styleReference`（`data:` 或 http(s)）> 像素锚点；纯关键词 `styleReference` 不占用 `image` 字段，像素锚点照常注入。理由是用户最新明确要求优先于系统默认策略（AGENTS.md 优先级规则）。
- `workflow.generateScenes` 保持单循环 image→video 的既有顺序，第 1 镜图像完成后把其 `frameImageUrl` 记为像素锚点，后续镜以 `mediaOptions.referenceImageUrl` 传入。
- 退化：`frameImageUrl` 只在图像渠道返回公网 URL 时存在。只回 `b64_json` 时静默跳过并 `warn` 一次，回到纯文字锚点；`tests/workflow-real-budget.test.mjs` 的图像 mock 正好只回 `b64_json`，该链路必须继续通过。
- `frameImageUrl` 语义不变，仍供本镜图生视频首帧使用；像素锚点是对它的额外复用，不改变首帧来源。

## 6. 验收（第二阶）

1. 带公网首帧的镜次 `videoMode` 为 `image-to-video`，无首帧或被拒退化的镜次为 `text-to-video`。
2. `manifest.scenes[i]` 含 `videoModel` / `videoMode`，且与 store 中该镜实际值一致。
3. 同一 Brief 两次求 seed 相同，不同 Brief 不同；视频提交体 `metadata.seed` 与之相等。
4. 用户显式 `styleReference`（data:/http）时 `body.image` 仍为用户的参考图；纯关键词时像素锚点照常注入；无公网锚点时不注入且不失败。
