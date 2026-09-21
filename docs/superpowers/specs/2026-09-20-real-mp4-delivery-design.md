# REAL 模式社交媒体 MP4 成片交付设计

日期：2026-09-20  
状态：已确认，待实施计划

## 1. 目标

在现有 Node.js、Express、Mastra、One-API 与 FFmpeg 技术栈内，使 REAL 模式稳定交付一个可播放、可下载的 MP4。成片必须包含动态画面、真人可听配音、背景配乐和烧录在画面中的中文台词字幕，同时附带独立 SRT 文件。

REAL 模式采用严格交付语义：动态视频、配音、配乐、字幕生成、FFmpeg 合成或成片校验任一失败，任务进入 `failed`，不得把分镜包或静态占位物标记为成功成片。诊断用中间产物可以保留，但不属于交付物。

## 2. 已确认的产品决策

- Provider 默认模式为 `real`。
- 字幕必须烧录进画面，另外保留 UTF-8 SRT 供二次编辑。
- 动态视频必须有默认模型；优先级依次为：
  1. `minimax-h3`
  2. `7zhe-seedance`
  3. `seedance-2.0`
  4. 网关中其他兼容 Seedance 2.0 型号
- 用户手动选择的视频模型覆盖自动选择；手动选择的模型不在实时网关清单时，提交前报错。
- 默认画布为 `1080×1920`、`9:16`；允许切换 `1920×1080`、`16:9` 和 `1080×1080`、`1:1`。
- 分镜、场景图、动态视频、封面、字幕安全区和最终 MP4 使用同一画布规格。
- 成片写入 `data/outputs/<runId>/final.mp4`，SRT 写入同目录；由现有 Express 服务提供在线播放与下载。

## 3. 方案选择

采用现有服务内 FFmpeg 合成，不引入 Remotion、浏览器渲染器或独立媒体微服务。

原因：现有代码已经具备静态图与动态片段合成、TTS、音乐、SRT 和 `/api/video/:runId` 播放基础；FFmpeg 已安装且现有测试已覆盖 H.264/AAC 输出。此次只需补齐统一素材规格、严格失败、字幕烧录、音频本地化和持久化交付。该方案变更面最小，也符合当前单进程交付形态。

## 4. 画布规格

Brief 新增 `canvasPreset`，采用受控枚举：

| 值 | 分辨率 | 比例 | 场景 |
| --- | --- | --- | --- |
| `social-portrait` | 1080×1920 | 9:16 | 默认；抖音、视频号、快手、小红书 |
| `social-landscape` | 1920×1080 | 16:9 | B 站、YouTube、官网 |
| `social-square` | 1080×1080 | 1:1 | 方形信息流 |

服务端由单一 `CANVAS_PRESETS` 映射解析宽、高、比例和字幕样式。客户端只提交枚举，不提交任意宽高，避免无界分辨率、异常资源消耗与前后端规格漂移。

“统一画布”约束适用于进入项目工作区并供预览、后续生成和交付使用的标准化资产。供应商原始响应允许尺寸不一致，但不得直接进入后续消费链路。画布参数贯穿以下环节：

1. 分镜提示词明确画幅、主体安全区和构图方向。
2. Seedream 请求使用对应 `aspect_ratio`；其他图像模型使用对应像素尺寸。
3. 场景图返回后立即标准化为目标画布并落入 run 工作区；标准化文件用于预览与封面。图生视频首帧只接受图像渠道返回的公网 http(s) URL（见 §6.2 第 5 条），本地标准化文件不直接作为首帧输入。
4. 动态视频请求携带供应商支持的比例或尺寸参数；返回后立即标准化为目标画布、25fps、H.264/yuv420p，再用于预览和最终拼接。
5. FFmpeg 最终合成前再次校验片段参数，形成防御性边界。
6. 封面取目标画布首帧，不再直接复用尺寸不确定的原始图片。
7. 字幕位置依据画布计算安全边距：竖屏底部避开平台操作栏，横屏和方屏按各自安全区处理。

默认使用 `force_original_aspect_ratio=increase` 后居中裁切，避免社交视频出现黑边。分镜提示词提前约束构图，降低关键主体被裁掉的概率。

## 5. 默认视频模型解析

模型解析必须使用网关 `/models` 的实时原始条目，不仅依赖现有分类结果。当前分类正则不会把 `minimax-h3` 识别为视频，需将其列入视频模型识别规则。

解析规则：

1. Brief 明确携带 `videoModel` 时，验证其存在且属于视频生成模型，然后直接使用。
2. 未携带时，在实时清单中按精确 ID 查找 `minimax-h3`。
3. 不存在时查找 `7zhe-seedance`。
4. 再查找精确 ID `seedance-2.0`。
5. 最后从 ID 中包含 Seedance 2.0 语义的候选中稳定排序，优先正式版，再选 fast，最后 mini。
6. 无可用候选时，在任何素材付费调用前失败，错误信息列出期望模型和当前可用候选摘要。

解析结果写回 `run.brief.videoModel` 和运行审计信息。页面默认项显示“自动：当前解析到 `<model>`”，用户仍可手动切换。

## 6. 生成与合成数据流

### 6.1 提交前预检

`POST /api/generate` 在创建付费任务前完成：

- REAL 模式、One-API 地址与密钥存在；
- FFmpeg 与 ffprobe 可执行；
- FFmpeg 支持 `subtitles`/libass 滤镜；
- 中文字体可用；
- 默认或手选动态视频模型可用；
- TTS 模型能从实时清单解析（默认 `speech-02-hd`）；配乐桥模型 `mureka-song`（提交）与 `mureka-query`（轮询）同时存在于实时清单；
- 输出目录可创建、可写。

预检只验证本地能力、配置和网关清单，不通过额外的付费 canary 调用探测音频端点。配乐不走 OpenAI 音频端点（网关 `new-api` 无 `/audio/music` 路由，调用必然 404），而是复用 MingStar 既有的 Mureka 协议桥：`mureka-song` 提交任务、`mureka-query` 轮询取音频地址，二者与 ai-core 走同一 one-api 渠道、同一密钥。预检失败返回明确的 4xx/5xx 错误，不创建“运行中”任务。音频端点的真实可用性通过调整后的工作流顺序验证：脚本批准后先执行 TTS 和配乐，二者成功后才调用更昂贵的场景图和动态视频。

### 6.2 素材生成

工作流保持 Mastra 两段式结构。视频阶段顺序调整为 `prepareVideo → voiceover → music → storyboard → generateScenes → composite`。脚本审批后：

1. TTS 按确认后的每条 `script.voiceover` 分别生成语音片段；每段生成后立即用 ffprobe 读取实际时长。任一片段失败则终止。
2. 将语音片段按脚本顺序拼接，每段之间加入固定 120ms 静音缓冲；由实测时长累积得到权威时间轴。
3. 生成并验证背景配乐。TTS 或配乐通道实际不可用时在此失败，尚未发生场景图和视频费用。
   - 配乐桥的「提交」与「轮询」两次调用各自对上游瞬时故障做有限重试：默认 2 次尝试（`PROMO_MUSIC_ATTEMPTS`，上限 3），退避 `PROMO_MUSIC_RETRY_BACKOFF_MS`（默认 2000ms × 第几次）。2026-09 真实验收在 `voiceover` 成功后、`generateScenes` 之前被一次性 `502 bridge_upstream_unavailable`（`UND_ERR_SOCKET`）打断，重发同一请求即可恢复，属于典型瞬时故障。
   - 只重试瞬时故障：网关 5xx、网络类文案（`bridge_upstream_unavailable`、`UND_ERR_*`、`ECONNRESET`、`ETIMEDOUT`、`socket hang up`、`fetch failed`）。契约类错误（4xx、缺少 `taskId`、`content` 非 JSON）必须立即抛出：重发同样失败，只会拉长失败时间并掩盖真实原因。
   - 重试边界与视频一致：只允许重试「一次桥调用」。提交与轮询必须分别包重试，不得把 `generateMusic` 的整个流程（含轮询等待、音频下载与物化）包进重试外壳，否则下游失败会重新提交一次已付费的配乐任务。音频下载失败由 `materializeMedia` 的下载重试负责（只对同一 URL 重试）。
4. 根据权威语音时间轴和 `canvasPreset` 生成分镜。分镜必须与 voiceover 一一对应，每镜时长等于对应语音片段时长加缓冲；数量不一致视为分镜失败。
   - 分镜请求固定带 `response_format: {type:"json_object"}`，网关据此强制顶层为对象，提示词与解析必须同为对象语义：system 要求 `{"scenes":[...]}`，解析层再兼容 `scenes`/`array`/`storyboard` 等常见键名漂移与一层嵌套，并在两者都失配时对原始文本抠第一个括号平衡的数组字面量。实测 `deepseek-v4-flash` 会返回 `{"array":[...]}`，只认 `scenes` 会让整步误判为 0 个分镜。
   - `musicClimax` 同时接受布尔值与 0~1 情绪强度：数值 ≥ 0.8 记为高潮。实测模型倾向给数值，若只做布尔转换会把每一镜都判成高潮。
5. 每镜生成场景图，立即归一为目标画布，并保留图像渠道返回的公网 http(s) URL 作为图生视频首帧（`scene.frameImageUrl`）。
   - 上游视频渠道由供应商自行下载首帧，只接受可公网访问的 http(s) URL。实测：`data:` URL（含 base64 内联）被上游以 `refusing to download from disallowed scheme 'data'` 拒绝；`host.docker.internal`、`127.0.0.1` 等本机地址同样不可达。
   - 图像渠道返回的 `https://portal.volces.com/...` 公网地址可直接作为首帧；该 URL 失效或图片渠道只返回 `b64_json` 时，本条动态片段降级为文生（仅 prompt），并记录可审计原因。本地 `mediaPath` 仍用于预览与最终合成。
   - 首帧是否真正生效以视频任务响应的 `usage.input_image_count` 为准：纯文生为 0，带首帧为 1 以上。该字段只用于审计与验证，不进入用户可见的降级判定。
   - `first_frame_image` 字段对 `minimax-h3` 无效（该字段只属于 hailuo 系配置），首帧统一走 `image` 字段。
   - 首帧图被上游内容审核拒绝时必须去掉首帧退化为文生视频后重试，而不是立即抛错终止整条 run：2026-09-22 真实验收中 `doubao-seedance-2-0-260128` 返回 400 `InputImageSensitiveContentDetected.PrivacyInformation`（`The request failed because the input image 'content[1]' may contain real person`），旧逻辑把它当契约错误直接抛出，整条已付费 run 因一张图被判失败。同渠道实测任务 365 的纯文生（`usage.input_image_count=0`）可正常出片，证明该审核只针对输入图；上游各候选渠道会下载同一张首帧并被同样拒绝，换模型救不了，换输入形态才是唯一活路。去掉首帧后仍失败才进入常规候选降级链，且该退化只改变输入形态，不改变画面诉求与 prompt。
6. 使用选定视频模型生成动态片段，返回后立即归一为目标画布和编码。任一动态片段失败，`generateScenes` 失败并终止整条 REAL 工作流，不再静态降级。
   - 提交体必须携带模型硬校验字段：`duration` 为 4~30 的整数秒（场景权威时长向上取整后夹取，`normalizeSceneVideo` 再裁到权威时长），`ratio` 必须显式给出白名单比例（`21:9/16:9/4:3/1:1/3:4/9:16`，不接受 `adaptive`），两者与画布预设同源。
   - 成功响应的成片地址可能位于 `metadata.url`（`minimax-h3` 实测），解析层必须覆盖该位置，否则会被误判为「完成但未返回 URL」。
   - 失败原因可能是对象 `error:{code,message}`，错误信息必须抽取其中的 `message`，不得回落成 `[object Object]`。
   - 轮询必须在同一轮内遍历候选端点并择优，不得命中第一个 200 就停止：`/video/generations/{id}` → `/videos/generations/{id}` → `/videos/{id}`。实测同一任务 id 只有 `/video/generations/{id}` 返回 new-api 权威任务形态 `{code:"success",data:{status,fail_reason,result_url}}`，而 `/videos/{id}` 返回 200 却只有上游原始形态 `{status:"unknown",metadata:{url:""}}`；只认首个 200 会一直轮询到 180s 超时，并丢掉上游真实失败原因。
   - 轮询判定顺序为「成片 URL → 失败信息 → 成功终态」：任一候选给出 http(s) 成片地址，或给出 `fail_reason`/`error`（含 `status:"unknown"` 但带失败原因）即结束轮询，前者按成功物化、后者按失败终止；状态到达成功终态却没有 URL 时报「完成但未返回 URL」。
   - `result_url` 必须通过地址形态校验才算成片地址，只放行可物化的 `http(s):` / `data:` / `file:`：上游失败时会把同一段错误文案填进 `result_url`（实测 `upstream returned unrecognized message`），不校验会被误当成产物地址下载。网关注入的容器内回环地址同样不可当产物地址：`/video/generations/{id}` 的 `result_url` 实测为 `http://localhost:3000/v1/videos/{id}/content`（new-api 容器内地址，宿主机 `ECONNREFUSED`，改写成宿主端口后仍被网关自身的私网下载拦截拒绝），同一响应里 `metadata.url`（`https://ark-*.tos-*.volces.com/*.mp4` 签名地址）才是可直接下载的成片。因此解析层必须先收集全部候选，再按「公网可达 > 其他可物化形态」择优，不得按首次命中返回；否则回环地址会遮蔽真正的成片地址，让一个已经出片的付费任务在下载阶段失败。
   - 单镜视频对「上游自身瞬时故障」做有限重试：默认 2 次尝试（`PROMO_VIDEO_ATTEMPTS`，上限 3），同一模型内退避为指数 `PROMO_VIDEO_RETRY_BACKOFF_MS × 2^(n-1)`（默认 2000ms，`PROMO_VIDEO_RETRY_MAX_BACKOFF_MS` 封顶默认 30000ms）。实测`minimax-h3` 对同一份请求会偶发返回 `upstream returned unrecognized message`（约 1/3 概率，成功与失败交替），网关对失败任务自动冲正（`logs.type=6`），因此重试的净成本接近「只付成功那次」，而不重试会把偶发故障放大成整条 run 失败。契约类错误（4xx、字段缺失、首帧不合法）必须立即抛出：重发同样失败，只会多花钱并掩盖真实原因。**例外**：首帧图被内容审核拒绝（`InputImageSensitiveContentDetected.PrivacyInformation`）不属于此列——去掉首帧退化为文生后仍可能出片，必须按 §6.2 第 5 条先去掉首帧重试一次。
   - 退避必须是指数而非线性：2026-09 实测上游故障以 20~30 分钟的时间窗成簇出现（23:12–23:38 连续 FAILURE），线性 2s/4s 退避跑不出故障窗口；指数退避 + 模型级降级才是能自救的组合。
   - 渠道级不可用必须与契约类错误区分：余额不足（`insufficient_user_quota`/`预扣费额度失败`）、分组未开通、无可用渠道（`No available channel`/`model_not_found`）与请求内容无关，重发同一模型必然同样失败，但换下一个候选渠道仍可能出片。2026-09-22 真实验收中 `7zhe-seedance` 上游账户余额不足返回 403，旧逻辑按契约错误立即抛出，候选链里本可救场的 `seedance-2.0` 永远没被尝试，整条已付费 run 被判失败。此类错误必须跳过本模型剩余尝试、直接换下一个候选；仅当已是最后一个候选时才向上抛出。
- 模型级降级：单个候选模型尝试次数耗尽后，按交付优先级 `minimax-h3 → 7zhe-seedance → seedance-2.0`（`model-selection.js` 的 `VIDEO_MODEL_PRIORITY`，预检解析后写入 `Brief.videoModelFallbacks`）换下一个渠道重试整镜。手选或 env 配置只决定「先试哪个」，不关闭降级链——上游整段故障时换渠道是唯一活路，而失败任务已被网关冲正（净成本为 0），换模型不产生额外净费用。全部候选都失败才算整镜失败。契约类错误不换模型，立即抛出。
    - 逐镜降级是「同镜重试另一种模型」，因此一次 run 内可能出现多个不同视频模型出片；成本归集必须按每镜真实生效模型（`scene.videoModel`）计价，不得一律按 `Brief.videoModel` 估算。
   - 轮询超时默认放宽到 600s（`PROMO_VIDEO_TIMEOUT_MS`，可覆盖）：`minimax-h3` 实测单次任务 23:55:31 → 23:58:05 约 144s，旧默认 180s 只剩约 25% 余量，一旦抖动就会在**已付费生成**之后超时失败，费用与时间双损。放宽只影响等待上限，不改变成功判定与失败终止逻辑。
   - 重试边界必须区分「生成」与「物化」：只有提交 + 轮询失败才允许重试生成（可能产生新费用）；成片下载与归一化失败只对**同一成片 URL** 重试下载（`PROMO_MEDIA_DOWNLOAD_ATTEMPTS` 默认 4、上限 6，退避为指数 `PROMO_MEDIA_DOWNLOAD_BACKOFF_MS × 2^(n-1)`，默认 1500ms、`PROMO_MEDIA_DOWNLOAD_MAX_BACKOFF_MS` 默认封顶 15000ms），绝不重新提交生成任务。2026-09 真实验收中 `fetch failed` 恰好发生在成片下载阶段，旧的重试外壳把同一镜两次已付费生成任务（各 37500000 quota）都重跑了一遍，等于为一次网络抖动付两份钱。
    - 下载重试窗口必须够长以熬过瞬时断网：2026-09-22 真实验收中视频任务已 `SUCCESS`，但下载成片时 `fetch failed（ECONNREFUSED）` 连续 3 次、整个窗口仅约 4.5 秒，抖动跨过窗口后整条已付费 run 被判失败（该次生成只提交一次、无重复扣费）。改为指数退避后窗口约 22 秒，仍是有界重试，不会无限等待失效 URL。
   - HTTP 媒体下载失败必须保留底层 cause（`error.cause.code`，如 `ECONNRESET`/`EAI_AGAIN`/`UND_ERR_*`/`ENOTFOUND`），错误信息形如 `媒体下载失败：fetch failed（ECONNRESET）`；只有网络类故障与 `408/425/429/5xx` 才重试，其余 4xx 契约类错误立即失败。
7. 音频 URL 支持 `data:`、`http(s):` 和 `file:`，统一下载或解码到任务工作目录，并校验 MIME、大小和 ffprobe 音轨。
8. 步骤间载荷必须完整透传。Mastra 每个 step 的返回值就是下一步的 `inputData`，链路 `voiceover → music → storyboard → generateScenes → composite` 中 `voice` 与 `music` 必须逐级带到 `composite`：合成需要「配音 + 配乐」两个音轨输入，任一中间步骤返回时漏掉 `music`，整条已经付过费的 run 都会在合成阶段以「配乐缺失」失败（2026-09-22 真实验收根因：`storyboard` 与 `generateScenes` 的返回值都只带了 `brief/script/voice/storyboard`，配乐虽然在 `music` 步已落盘，却从未抵达 `composite`）。该缺陷在 DEMO 模式下被掩盖——`demoComposite` 不读配乐也能返回分镜包；只有 REAL 模式走完整合成才暴露。因此新增或调整中间步骤时，必须回归检查下游步骤实际消费的字段是否仍在载荷中。

### 6.3 字幕

根据逐句 TTS 的实际时长生成标准 SRT：

- 时间格式为 `HH:MM:SS,mmm`；
- 第一条从 0 开始；每条开始时间为之前所有真实语音片段与 120ms 缓冲的累计值，结束时间为本段真实语音结束点；
- 时间轴必须单调、无负数、无重叠、不得超过成片时长；
- 文件编码为 UTF-8；
- 文本保留中文标点，清除非法控制字符。

字幕烧录分两步：先由权威 cues 生成一份显式声明 `PlayResX`/`PlayResY` 为目标画布尺寸的临时 ASS 文件（UTF-8 无 BOM，换行用 `\N`），再用 FFmpeg `ass` 滤镜烧录，两者同属 libass 管线。禁止让 `subtitles` 滤镜直接读取 SRT：该滤镜按默认 PlayRes 384x288 解析，会把底部安全边距错误映射到画面上部。

字体使用可配置 `PROMO_SUBTITLE_FONT`，默认优先 `Microsoft YaHei`，再回退系统可用的中文字体。样式使用白字、黑色描边，限制每行长度和最多两行，按画布预设设置字号与底部安全边距（`Alignment=2`、`WrapStyle: 2`）。Windows 下把临时 ASS 写入工作目录，滤镜只引用相对文件名并把进程 `cwd` 设为该目录，避免盘符冒号被当作滤镜参数分隔符。

### 6.4 视频标准化与拼接

不再假设供应商视频编码和尺寸一致。每个动态片段在生成后立即统一为目标画布、25fps、H.264、yuv420p、方形像素；按权威 Scene 时长裁剪，短片段采用末帧延展。随后使用 FFmpeg filter concat 合并，避免 concat demuxer 因编码参数不一致而失败。最终画面总时长由权威语音时间轴决定，禁止为了固定 Brief 秒数截断尾部配音。

### 6.5 音频混合

- 配音为主音轨，执行响度标准化，目标约 `-16 LUFS`、峰值不高于 `-1.5 dBTP`。
- 背景音乐默认降低到约 18%，再与配音混合。
- 最终音频编码为 AAC，48kHz，双声道。
- 输出时长以权威语音时间轴/Scene 总时长为准；配乐过长时截断，画面片段不足时末帧延展，不得截断配音。
- 配音或配乐不存在、为空、不可解码或合成后没有音轨，任务失败。

### 6.6 输出与交付

每个任务使用独立临时目录，成功后以原子移动写入：

```text
data/outputs/<runId>/final.mp4
data/outputs/<runId>/subtitles.srt
data/outputs/<runId>/poster.jpg
data/outputs/<runId>/manifest.json
```

`manifest.json` 记录画布、模型、各镜时长、音频模型、FFmpeg 版本、文件大小和校验摘要，不包含 API Key。

下载契约：

- `GET /api/video/:runId`：`video/mp4`，支持 Range，默认 inline 播放；
- `GET /api/runs/:runId/artifacts/video`：`video/mp4`，`Content-Disposition: attachment; filename="<safe-brand>-<runId>.mp4"`；
- `GET /api/runs/:runId/artifacts/subtitles`：`application/x-subrip; charset=utf-8`，下载 `.srt`；
- `GET /api/runs/:runId/artifacts/poster`：按实际图片 MIME 下载封面。

文件名中的品牌字符仅允许中文、字母、数字、短横线和下划线，其余替换为短横线。所有路径由服务端根据 runId 构造，禁止接受客户端文件路径。

成片验收门只在最终校验通过后展示播放器和下载入口。输出目录生命周期与 run 一致：store 因 `RUNS_CAP` 淘汰最旧 run 时，仅删除该 runId 对应且已验证位于 `data/outputs` 下的目录；应用重启不清理有效 run。除此之外本期不做定时清理。

### 6.7 TTS 通道回退链（Qwen-Omni 流式 PCM）

上游聚合渠道的语音额度是外部状态：模型在 `/models` 清单里存在，不代表该渠道此刻可付费出音。实测中 `speech-02-hd` 所属 apilio 渠道因上游账户余额为负，对所有 `/audio/speech` 请求返回 403 `insufficient_user_quota`，而模型清单照常包含该 ID。预检只校验清单与本地能力，无法在不付费的前提下探测额度，因此把额度故障的处置放在运行时：主通道失败后立刻切换到同一网关上的备用语音通道，而不是让整条 run 失败。

备用通道为通义千问 Omni 的多模态 `chat/completions` 语音输出，经同一 one-api 网关、同一密钥调用：

1. 主通道：`POST /audio/speech`（OpenAI 兼容 TTS），按句请求，返回音频容器字节。
2. 备用通道：`POST /chat/completions`，`modalities: ["text", "audio"]`、`audio: { voice, format: "pcm" }`、`stream: true`、`stream_options: { include_usage: true }`；音频以 SSE 分帧 `choices[0].delta.audio.data` 的 base64 片段返回，需自行拼接。
3. 备用通道返回的是无容器头的裸 PCM：**24 000 Hz、单声道、signed 16-bit little-endian**。依据为官方文档示例参数、按音频 token 数标定的帧字节数（3840 字节 = 80 ms）与频谱滚降一致性。
4. 裸 PCM 必须先封装合法的 RIFF/WAVE 头再进入受管素材链路，否则 `materializeMedia` 的魔数校验会拒绝，`ffprobe` 也无法读取时长。
5. 回退发生在单句粒度，且一旦某句回退成功，后续各句继续使用备用通道，避免同一支成片在中途切换音色。

回退触发条件为逐句合成失败（额度 403、路由 404/406、`No available channel`、5xx 或返回空音频）。主通道已产生的费用按既有语义计入 `_usage`；备用通道按实测音频秒数计量。若两条通道都失败，错误信息须同时列出两条通道的模型 ID 与最后一次失败原因。

备用模型由共享预检从网关实时清单解析后写入 `brief.ttsFallbackModel`，默认候选 `qwen3.5-omni-flash-2026-03-15`，可用 `PROMO_TTS_FALLBACK_MODEL` 覆盖。候选只接受非 realtime 变体：实测 `*-realtime-*` 型号经该网关调用不返回音频。

音色映射独立于 OpenAI 标准 voice 名：男声/沉稳对应 `Ethan`，活泼对应 `Dylan`，女声对应 `Serena`。`Chelsie` 在该渠道返回 0 字节音频，不列入候选。

## 7. 严格失败与状态语义

REAL 模式删除以下“成功降级”行为：

- 单镜动态视频失败后退回静态图；
- TTS 失败后生成静音片；
- 配乐失败后无配乐继续；
- FFmpeg 失败后以分镜包进入验收；
- 输出无音轨、无字幕或文件位于临时目录时标记成功。

步骤仍先写 `step-failed`，由服务端阶段边界统一将 run 置为 `failed` 并发一次 `run-failed`。错误结构至少包含阶段、用户可读原因和可审计的技术摘要。不得记录密钥、完整 data URL 或供应商敏感响应。

DEMO 模式可以继续输出分镜故事板，但页面必须明确标记为演示结果，不得显示“MP4 成片已交付”。

## 8. 成片校验门

FFmpeg 返回零退出码仍不足以判定成功。进入 `awaiting_delivery` 前必须执行：

- 文件存在且大小超过合理下限；
- ffprobe 确认容器为 MP4/MOV、视频编码 H.264、音频编码 AAC；
- 分辨率等于所选画布，像素格式为 yuv420p；
- 时长与 Scene 总时长误差在容许范围内；
- 至少一个视频流和一个非空音频流；
- SRT 存在且包含每条确认台词；
- 抽取第一条和最后一条字幕的时间中点帧，裁取画面底部 30% 字幕区域；相对同素材无字幕基线，变化像素比例须大于 0.5%；
- MP4、SRT 和 manifest 均位于持久化目录。

校验失败视为 composite 失败，不进入验收门。

## 9. 前端改动

- “成片规格”新增画布选择，默认“竖屏短视频 1080×1920”。
- 动态视频模型默认展示自动解析结果，并保留手动选择。
- 进度区新增“成片校验”状态或将其作为合成步骤的明确子状态。
- 交付区以最终 MP4 播放器为主，提供“下载 MP4”“下载 SRT”“下载封面”。
- 失败时显示具体失败阶段和重试入口；不展示“验收并交付”。
- 历史分镜包保持可查看，但标注“历史降级产物”，不追认成 MP4。

UI 修改遵循 `spec/design/pc-design.md`：复用现有 Token，正文不低于 14px，按钮使用现有交互状态，播放器和错误态覆盖 1440、768、375px。

失败页的“重新生成”使用原 Brief 创建全新 runId，并从脚本阶段完整重跑；不恢复失败步骤、不覆盖旧 run、不复用可能损坏的中间产物。旧 run 保持 failed 供审计，新 run 单独计费。按钮在请求进行中禁用，重复提交由客户端防抖和服务端一次性请求处理，不为本期新增跨请求幂等键。

## 10. 测试与验收

### 单元测试

- 画布枚举解析与非法值拒绝；
- 模型优先级和手选覆盖，包括当前会漏分的 `minimax-h3`；
- Seedance 候选稳定排序；
- SRT 时间格式、末条收口、中文和特殊字符；
- data/http/file 音频本地化及非法输入拒绝；
- REAL 严格失败与 DEMO 演示语义分离。

### FFmpeg 集成测试

使用本机 FFmpeg 生成短小测试素材，分别验证 9:16、16:9、1:1：

- 多段不同尺寸/帧率视频可统一合成为目标规格；
- 输出包含 H.264 视频流和 AAC 音轨；
- 配音、配乐同时存在；
- 中文字幕烧录后抽帧可见，中文字体不出现方框；
- SRT 同步生成；
- 输出持久化到 run 目录；
- 缺视频、配音、配乐、字体、subtitles 滤镜或 FFmpeg 时均失败。

### API 与浏览器验收

- 提交时自动选中优先模型并记录在 run；
- 三种画布均可提交，非法画布返回 400；
- 合成成功后成片门显示播放器与三个下载入口；
- HTTP Range 播放和下载响应正确；
- 真实失败不会出现验收门；
- failed run 点击“重新生成”会创建新 runId、保留旧 run 并完整重跑；
- 1440、768、375px 无横向溢出和页面异常。

### 完成标准

以一个真实 REAL run 为最终验收：使用自动默认动态模型，产出默认 1080×1920 MP4；肉眼确认画面、中文硬字幕，听到清晰配音及低音量背景音乐；ffprobe 与自动化检查全部通过；页面可播放并能下载 MP4 和 SRT。

## 11. 非目标

- 本期不引入 Remotion、独立媒体微服务、消息队列或云端转码集群。
- 不实现任意自定义分辨率和字幕样式编辑器。
- 不自动修复历史降级 run；历史记录只做如实标注。
- 不在本期实现对象存储上传；持久化目录为当前单机交付边界。
