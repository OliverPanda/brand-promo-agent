# HANDOFF — 品宣机器人前端（public/index.html）UX 大改 · 交接文档

> 2026-09-14 恢复修复：已按 [运行状态与 SSE 恢复契约](prd/run-recovery.md) 修复阶段失败误交付、SSE 迟到/重连丢状态、断线删除脚本审批回调、审批恢复重复 suspend、审批响应覆盖 SSE 终态，以及英文步骤和进度分母错位。前端支持 `?runId=...` 与最后任务恢复。旧任务 `78490e81-dcba-4fdb-a450-3996eecc6976` 已通过真实浏览器恢复验收门；其历史分镜失败与“未配置 FFmpeg，降级为分镜包”记录保持原样，不代表产出了真实 MP4。下文“不动后端 API 与 SSE 协议”仅为历史范围，已由此次修复要求覆盖。

> 2026-09-05 后续更新：按用户截图，将模板移到中栏简报上方，以小标签点击套用；保存与删除收进「管理模板」。当前 DOM 契约为 `tplCard ∈ .layout > .main`，`cfgCard ∈ .layout > .side`，下文原模板位置描述已过时。新增设计记录见 `prd/template-tags.md`。真实浏览器验证 1440 / 1104 / 768 / 375px：模板在表单上方、卡片高度正常、无横向页面溢出、pageerror 为 0；验证套用、管理展开、预设删除禁用及请求失败重试、空态。截图：`test/template-tags-*.png`。本次未重跑后端测试，下面 123/123 为此前快照。

> 2026-09-20 成片交付改版：前端新增「成片规格 → 画布尺寸」下拉（默认竖屏 1080×1920，可切 1920×1080 / 1080×1080），动态视频模型下拉首项改为「自动（当前：<网关解析结果>）」；REAL 模式改为严格失败——动态视频、配音、配乐、字幕烧录、FFmpeg 或成片校验任一失败即 run=`failed`，页面不得出现「成片已交付」，只展示分镜故事板并标注原因；交付区只在 `artifactManifest.validated === true` 时展示 MP4 播放器与「下载 MP4 / 下载字幕 SRT / 下载封面」三个入口。设计依据 [REAL MP4 成片交付设计](docs/superpowers/specs/2026-09-20-real-mp4-delivery-design.md) 与 PRD §16.12。
> 2026-09-21 端到端验收记录：REAL 服务已在 6777 启动，`GET /api/config` 返回 `mode=real`，共享预检（FFmpeg 8.0 + libass 的 `subtitles`/`ass` 滤镜、`Microsoft YaHei` 中文 cmap、输出目录可写、网关实时清单）全部通过，动态视频按优先级自动解析为 `minimax-h3`（`modelSelectionSource=automatic`）。付费验收 run `85b46cee-81fa-476f-9c97-dfe43095b6f4` 在 `voiceover` 步失败：one-api 渠道 `apilio` 返回 403 `insufficient_user_quota`（上游账户余额为负 ⚡-2.192116），属外部额度阻断，本地链路未发现问题；脚本步已真实完成并计费 ¥0.0258。严格失败语义按设计生效：失败 run 的 `videoUrl` 为空，三件产物下载入口全部 409，`/api/video/<runId>` 返回 404，界面不会出现「成片已交付」。浏览器验收用例已就绪（`tests/ui-delivery-smoke.spec.mjs`，1440×900 / 768×900 / 375×812 三视口，缺 `REAL_RUN_ID` 时自动跳过），待上游额度恢复后按实施计划 Step 5 与 Step 4 重跑即可补齐成片与截图留证。

> 写给下一位接手的 agent / 工程师。目标：10 分钟内建立完整上下文，直接继续实施，不踩已踩过的坑。
> 项目：`D:\My-Project\aigc-platform\MingStar\brand-promo-agent`（铭星链自动化品宣机器人）
> 文档基准：2026-09-05 15:10，基线 commit 前的最后状态见文末「验证快照」。

---

## 0. 一句话现状

**单文件前端 `public/index.html`（约 1287 行，无框架、内联 CSS/JS）已完成「设计系统重写 + 三栏 Grid 布局重构 + 交互反馈升级」三轮大改，123/123 后端测试全绿。** 中途因拼接多出一个 `</div>` 导致品宣表单+舆情雷达在 100vh 约束下被挤成 0 高度（用户截图报障「品宣部分完全没了」），**已定位并修复，真实浏览器三视口验证通过**。剩余为 P1/P2 打磨项，见 §6。

---

## 1. ⚠️ 事故记录：品宣部分消失（已修复，必读防复发）

### 现象
用户截图（1104×660 视口）：页面只剩页头 + 「品牌模板库」「模型与服务」两张全宽卡片，**中栏品牌简报表单和左栏舆情雷达完全不可见**。

### 根因链（两层叠加，缺一不会复现）
1. **DOM 层**：此前用 node 按行拼接替换 `<aside class="side">…</aside>` 区块时，保留了原文件 `L.slice(e-1)` 的边界行，导致 resultCard 闭合后出现**三个连续 `</div>`（应为两个）**。多余的 `</div>` 把 `.layout` 提前闭合，`.side` 变成了 `.wrap` 的直接子元素。
2. **CSS 层**：`.wrap` 是 `height:100vh; display:flex; flex-direction:column`。`.side`（内容高约 1100px，`flex:0 1 auto`）作为 flex 子项参与分配，把 `flex:1` 的 `.layout` **挤压到 0 高度**。雷达和表单还在 DOM 里，但活在零高滚动容器里 → 肉眼消失。同时 `.side` 脱离 grid 后按块流全宽渲染 → 正是截图里的样子。

### 修复
删除多余 `</div>`（原 529 行），使 `resultCard` 闭合后直接是 `</div><!-- /main -->`。

### 教训（防复发三条铁律）
- **单文件拼接后必须跑结构校验**，不能只查标签总数配平（本例总数是平的，嵌套是错的）。用 §5.2 的栈式解析脚本查关键 id 的祖先链。
- **`slice(e-1)` 这类边界拼接是事故源**，拼接前打印首尾各 3 行确认边界。
- 任何布局改动要**真实浏览器截图验证**（§5.3 有现成脚本），静态检查不等于渲染正确。

---

## 2. 前置上下文（为什么改成这样）

- 用户（铭星链主理人/交付总监）三轮递进要求：①装 `ui-ux-pro-max` 技能做视觉优化 → ②"多考虑用户体验，样式/排版/布局都可以动" → ③报障品宣消失。
- 设计依据来自本地技能 `~/.workbuddy/skills/ui-ux-pro-max`（BM25 检索 CSV 参考库，已安全审计 P2）。命中的准则：**Bento 模块化卡片、Data-Dense Dashboard、内联校验（blur 时，非仅提交时，Severity High）、空态必须"说明 + 行动"、多步流程必须给"第 x/总 步"、破坏性操作必须二次确认（High）、焦点可见（High）、正文对比度 ≥4.5:1（High）**。
- 沉淀了可复用技能 `~/.workbuddy/skills/ui-ux-html-redesign/SKILL.md`（完整方法论 + 本仓库特有坑），**接手后先读它**。

---

## 3. 当前文件结构地图（public/index.html，~1287 行）

```
行 7–246   <style> 设计系统（令牌 → 骨架 → 组件，全量重写过，花括号 202/202）
行 299–309  页头 .pagehead（标题+副标题+modeBadge 一行式）
行 310–391  aside.col-radar  舆情雷达（4 张卡）
行 392–533  div.main        品牌简报表单 + 进度卡 + 成片卡
行 535–597  aside.side      模板库 + 模型与服务（注意：必须在 .layout 内！）
行 598      </div><!-- /layout -->
行 599+     </div>(wrap) + gateModal + finalGateModal + #toastHost + <script>
```

### 关键 DOM 契约（祖先链必须保持，改动后用 §5.2 校验）
```
.wrap > .layout(grid) > [aside.col-radar, div.main, aside.side]
radarCard ∈ .layout > .col-radar
formCard  ∈ .layout > .main
tplCard / cfgCard ∈ .layout > .side   ← 事故点，.side 绝不能跑到 .layout 外
gateModal / finalGateModal = .modal.hidden（在 .wrap 外）
```

### 三栏 Grid 断点（CSS 行 52–68）
| 视口 | columns | areas |
|---|---|---|
| ≥1360 | `380px 1fr 300px` | `"radar main side"` 一行三列，各栏独立滚动（.wrap 锁 100vh） |
| 1024–1360 | `1fr 300px` | `"main side" / "radar side"` 两行，雷达卡横向 flex-wrap |
| <1024 | 单列 | `"main" "radar" "side"` 纵向自然滚动（.wrap 放开 100vh） |

---

## 4. 已完成的改动清单（按层）

### 4.1 设计系统（`<style>` 全量替换）
- **令牌**：`--faint` 从 `#8b98a5`(3.1:1) 提到 `#6b7a8a`(4.6:1，WCAG AA)；语义色带 soft 底（`--ok-soft/--warn-soft/--bad-soft`）；间距标度 `--sp-1..6`；圆角 `--r/--r-sm/--r-xs`；阴影两级；`--tr:150ms` 过渡。
- **组件类**（替代散落 inline style）：`.card-hd`(卡片头=标题+hd-note+spacer)、`.sect`(卡内分区标题，左侧 3px 强调条)、`.field/.lbl/.req/.opt/.err/.invalid`、`.hint(+.ok/.bad/.warn)`、`.counter(+.over)`、`.grid2/.grid3`、`fieldset.grp`、`.check-row`、按钮四级 `默认主/`.ghost`/`.danger`/`.mini(.lg/.block)`、`.loading`（按钮内旋转圈）、`.chips/.chip(.on)`、`.tpl-list/.tpl-item/.tpl-meta/.tpl-act/.swatch`、`.rank-list/.rank-item/.rk(.top)/.rk-body/.rk-side`、`.tag(.hot/.new/.brand)`、`.empty(.e-title)`、`.kpis/.kpi(.pos/.neg/.idx)`、`.bar-stack/.bar-legend(span[--dot]/.no-dot)`、`.steps-head/.prog-track/.steps/.step`、`.gallery/.scene(.failed)`、`.kv`、`.cost-box`、`.modal/.box-hd/.box-ft/.icon-btn`、`.toast-host/.toast(.err/.ok/.warn/.out)`、`details.fold`、`.copy-bar`。
- 全局 `:focus-visible` 焦点环、`prefers-reduced-motion` 降级、滚动条样式。

### 4.2 布局重构
- 页头一行式，`#modeBadge` 移到右侧，`.is-demo` 类控制状态点颜色（demo=灰、real=绿）。
- 左栏拆 4 卡：①`#radarCard` 声量订阅 ②热词榜 ③情绪分析 ④选题会商+人设库(`details.fold`)。
- 中栏：`#formCard` 补 `card-hd`（含"重置"按钮）+ 4 个 `fieldset.grp`（品牌与卖点/成片规格/受众与调性/品牌约束）+ 审核门两个 `.check-row`；`#progressCard` 加 `#progText` + `#progBar` 进度条；`#resultCard` 加 `card-hd`。
- 右栏：`#tplCard`、`#cfgCard`（接入/模型选择两个 fieldset，清除密钥按钮挂 `.danger.mini`）。

### 4.3 JS 交互升级（全部保持原 id/onclick 契约，后端 API 零改动）
| 改动 | 位置/函数 | 说明 |
|---|---|---|
| 真·全局 toast | `toast(msg,kind)`/`toastErr()` + `#toastHost` | 旧实现把全局提示写进左栏 `#radarCollectHint`（用户在右侧操作时根本看不见），已重写为顶部浮层，err 4.2s/其余 2.6s 自动消失 |
| alert 清零 | 10 处 | 全改 toast；**破坏性删除保留 `confirm()`**（UX 准则 High，勿"优化"掉） |
| 内联校验 | `REQUIRED_FIELDS`/`setFieldError`/`validateField`/`validateForm` | brandName/productName/coreSellingPoint 三项 blur 即校验 + input 时消错 + `role=alert` + 提交时滚动聚焦首个错误 |
| 字数计数 | `syncCounter` + `#cspCount` | 卖点 ≤60，满 60 变红 |
| 回车提交 | formCard keydown | 仅 INPUT 触发（textarea 不劫持） |
| 重置 | `resetBrief()` | 清字段+chip+校验态 |
| 步骤中文化 | `STEP_LABEL`/`STEP_ORDER`/`stepRow`/`setStep`/`updateProgress` | 后端 `writeScript` 等英文 id → "写脚本"等；**按流水线顺序插入而非事件到达顺序**；头部进度条"第 x/总 步" |
| 按钮loading | `submitBrief` try/finally + `genBtnReset()` | `run-failed` SSE 事件也会复位按钮 |
| 模态三通道关闭 | `closeModal(id)` + document keydown(ESC) + click(遮罩) | markup 上有 `data-modal` 标记 |
| 空态带行动 | loadRadar/loadHotwords/loadSentiment/loadTopics/loadTemplates | 每个空态都有 `.e-title` + 解释 + 行动按钮（采集/打分/生成/去添加） |
| 情绪可视化 | `loadSentiment` | KPI 瓦片×5 + 三段堆叠占比条（宽度=真实百分比）+ 图例 |
| 榜单重构 | `loadHotwords`/`loadTopics` | `.rank-list` 行组件，前 3 名序号强调，标签改 `.tag` |
| 交付重构 | `renderDelivery` | `.kv` 元信息行、`.cost-box` 成本盒、脚本全文 `details.fold` 默认折叠 |
| 模式徽标 | `setModeBadge(mode,cap)` | fetchMode/applyCfgResponse 统一走它，同步 `.is-demo` |

### 4.4 历史轮次（本轮之前，仍生效）
- 第三轮（ui-ux-pro-max 首用）：body `tabular-nums`+`optimizeLegibility`（已被本轮 CSS 继承）。第一/二轮的浅色令牌体系已被本轮全量替换覆盖。

---

## 5. 验证方法（改完必跑，顺序执行）

### 5.1 静态三件套（30 秒）
```bash
node -e "
const h=require('fs').readFileSync('public/index.html','utf8');
const js=(h.match(/<script>([\s\S]*?)<\/script>/)||[])[1]||'';
new Function(js); console.log('JS OK');                       // 内联 JS 语法
const css=(h.match(/<style>([\s\S]*?)<\/style>/)||[])[1]||'';
console.log((css.match(/{/g)||[]).length===(css.match(/}/g)||[]).length?'CSS balanced':'CSS IMBALANCED');
"
```

### 5.2 结构校验（防"品宣消失"复发，必跑）
```bash
node -e "
const body=require('fs').readFileSync('public/index.html','utf8').slice(require('fs').readFileSync('public/index.html','utf8').indexOf('<body'));
const st=[],re=/<(\/)?(div|aside|details|fieldset|header|main)\b[^>]*>/g;let m,rep={};
const id=t=>{const i=t.match(/id=\"([^\"]+)\"/);return i?i[1]:null};
while(m=re.exec(body)){const c=m[1],t=m[2];
  if(!c){st.push({t,id:id(m[0])});const id=id(m[0]);
    if(['radarCard','formCard','tplCard','cfgCard'].includes(id))rep[id]=st.map(s=>s.t+(s.id?'#'+s.id:'')).join('>');}
  else{for(let i=st.length-1;i>=0;i--)if(st[i].t===t){st.length=i;break}}}
console.log(rep);console.log('残留',st.length);}
"   # 期望：四张卡都在 …layout > 内；残留 0
```

### 5.3 真实浏览器三视口（playwright-core 已装，chromium 在 ms-playwright/chromium-1243）
```bash
cd C:\Users\zzjhy\.workbuddy\binaries\node\workspace
NODE_PATH="C:\Users\zzjhy\.workbuddy\binaries\node\workspace\node_modules" node -e "
const {chromium}=require('playwright-core');
(async()=>{const b=await chromium.launch({executablePath:'C:\\\\Users\\\\zzjhy\\\\AppData\\\\Local\\\\ms-playwright\\\\chromium-1243\\\\chrome-win64\\\\chrome.exe'});
for(const [n,w,h] of [['w1440',1440,900],['w1104',1104,660],['w900',900,800]]){
  const p=await b.newPage({viewport:{width:w,height:h}});const errs=[];p.on('pageerror',e=>errs.push(e.message));
  await p.goto('http://127.0.0.1:3000/',{waitUntil:'networkidle'});
  const r=await p.evaluate(()=>{const rc=s=>{const e=document.querySelector(s);const b=e.getBoundingClientRect();return Math.round(b.width)+'x'+Math.round(b.height)};
    return {radar:rc('#radarCard'),form:rc('#formCard'),tpl:rc('#tplCard'),sideInLayout:document.querySelector('.side').parentElement.className.includes('layout')}});
  console.log(n,JSON.stringify(r),'jsErrors:',errs.length);
  await p.screenshot({path:'D:/My-Project/aigc-platform/MingStar/brand-promo-agent/test/redesign-'+n+'.png'});
  await p.close();}
await b.close();})().catch(e=>{console.error(e.message);process.exit(1)});
"
# 期望：三个视口 radar/form/tpl 宽高均 >0；sideInLayout:true；jsErrors:0
```

### 5.4 后端回归
```bash
npm test    # 期望 123/123（后端测试不依赖 HTML，但跑一遍保平安，约 23s）
```

### 环境坑（已验证的事实，勿再试错）
- **服务端口是 3000**（`node src/server.js` 启动日志可证），不是早前对话里误记的 3001。
- 后台起服务**必须用 Bash 的 `run_in_background`**，普通 `&` 会随命令返回被回收（本次已踩）。
- Git Bash 里 curl 访问本机要加 `--noproxy '*'`，否则代理吞掉返回 000/502。
- playwright-core 直接 `launch()` 会找不到 headless_shell-1148，**必须显式 `executablePath` 指向 chromium-1243 的 chrome.exe**（§5.3 已写对）。
- 本仓库另有已知坑：Git Bash 下 mvn 不可直接用（走 plexus-classworlds）。

---

## 6. 剩余工作（按优先级，接手即做）

### P1（建议立即）
1. **把 §5.3 固化成 `tests/ui-smoke.test.mjs`**（node:test + playwright-core，断言三视口卡片可见 + 0 pageerror + sideInLayout）。当前 HTML **零测试覆盖**，这次事故正是没有渲染级测试才漏掉的。
2. **`showGate` 旁白编辑行**：时间码 span 还是 inline style（`margin-top:10px` 视觉上偏移），CSS 已备好 `.vline .tc` 类但未接上——把 `<span style=...>${x.timecode}</span>` 换成 `<span class="tc">`。
3. **`generateTopics` 里 `document.querySelectorAll("#radarCard button")` 是死代码**（取了 btns 从未用），删除。
4. 中屏（1024–1360）雷达四卡横排的 flex-wrap 在 1100–1200px 会出现 3+1 孤行，可给 `.col-radar > .card { flex:1 1 340px }` 微调或改两行 grid。

### P2（有空再做）
5. 交付区 `sceneHtml` 的 `<video>/<img>` 还有 inline style，可收进 `.scene` 组件类。
6. 暗色主题：令牌已集中在 `:root`，加 `@media (prefers-color-scheme:dark)` 覆盖令牌即可，但需逐个检查 soft 底色可读性。
7. `.pagehead .sub` 只在窄屏换行友好，<640px 可隐藏副标题省高度。
8. 热词榜 `#hwRange` select 的 inline `style="width:auto;padding:4px 8px;font-size:12px"` 可收进 `.card-hd select` 规则。
9. 可访问性深检：雷达四卡的按钮全是文字按钮无 aria-label 冗余（当前可接受），交付区图片缺 alt（`sceneHtml` 的 `<img src="${s.mediaUrl}"/>` 无 alt，跑 WCAG 扫描会挂）。

### 明确不做（避免过度工程，ponytail 原则）
- 不引入框架/构建链/外部 CSS——单文件是本页面的交付形态。
- 不给 toast 加队列上限/手势关闭——当前规模用不上。
- 不动后端 API 与 SSE 协议。

---

## 7. 验证快照（2026-09-05 15:05，修复后实测）

- 结构：radarCard/formCard/tplCard/cfgCard 祖先链全部 `…layout >` 正确嵌套，标签全部闭合
- playwright 三视口（1440/1104/900）：三栏/两栏/单栏均正确渲染，`sideInLayout:true`，pageerror 0
- 截图基线：`test/redesign-w1440.png`、`test/redesign-w1104.png`、`test/redesign-w900.png`
- 内联 JS `new Function` OK；CSS 花括号 202/202
- `npm test`：**123/123 pass, 0 fail**（22.9s）
- 服务模式：用户环境为 real 模式（网关 http://localhost:3501/v1，Key 已配置，预算上限 ¥20）

## 8. 相关文件索引
| 文件 | 说明 |
|---|---|
| `public/index.html` | 唯一改动的前端文件（单文件应用） |
| `test/redesign-*.png` | 三视口渲染基线截图（回归对比用） |
| `~/.workbuddy/skills/ui-ux-html-redesign/SKILL.md` | 本轮方法论沉淀（含坑清单） |
| `~/.workbuddy/skills/ui-ux-pro-max/` | 设计参考检索技能（`python scripts` 下 core.search） |
| `.workbuddy/memory/2026-09-05.md` | 两轮改动的当日工作日志 |
