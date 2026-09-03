// 项目化文案灵感库：结合铭星链（MingStar）产品线特点预置的「卖点 + 核心信息点」候选。
// 用途：前端「换一批」轮换（GET /api/copyideas），套用模板后自动给第一批，可再换。
// 设计原则：
//  - 文案必须结合本产品线真实能力（小程序即用 / 图文视频音乐多模态 / Studio 分镜 / 专业圈层 /
//    星钻与分润激励 / 多语言出海），不做空泛口号，也不虚构量化数字（无价格/时长等未经验证指标）。
//  - 每场景 3 批，角度不同：① 上手效率 ② 一站式能力 ③ 生态激励；卖点 ≤60 字（与 brief 一致）。
//  - 离线确定性（不依赖 LLM），与 DEMO 模式一致；batch 越界自动环绕。
//  - key 与 PRESETS（templates.js）的 id 对齐；未匹配到 preset 时回落 platform（通用）。

const SCENARIOS = {
  // ── 铭星链 · AIGC 一站式创作平台（主品牌）──
  "preset-mingstar": {
    label: "铭星链 · 一站式 AI 创作平台",
    language: "zh-CN",
    batches: [
      {
        selling: "从灵感到成片，铭星链让每个人都做得起专业宣传片",
        keyMessages: ["图文、视频、音乐一站式创作，一个平台全搞定", "小程序即开即用，手机也能产出专业级作品", "多模型可选，脚本、画面、配音、配乐全自动"],
      },
      {
        selling: "一句话生成脚本、分镜与成片，把想法交给铭星链",
        keyMessages: ["文案、图像、配乐、合成一次成型", "专业圈层认证，让好作品被看见", "面向出海的多语言模板，一键适配海外市场"],
      },
      {
        selling: "创作不只是爱好——铭星链让好作品持续产生收益",
        keyMessages: ["星钻激励体系，创作与互动都有回报", "收益分润透明，创作者直接参与分成", "从个人创作者到专业团队，都在铭星链"],
      },
    ],
  },

  // ── 铭星链小程序 · 移动端创作社区 ──
  "preset-miniapp": {
    label: "铭星链小程序 · 移动端创作社区",
    language: "zh-CN",
    batches: [
      {
        selling: "手机上的一站式 AI 创作台，通勤路上也能出片",
        keyMessages: ["无需专业设备，小程序随时创作与发布", "图文、音乐、MV 等创作工具都在一个入口", "作品一键分享，边创作边涨粉"],
      },
      {
        selling: "你的 AI 创作社区已上线，灵感与同道都在这里",
        keyMessages: ["专业圈层让作品直达同好与潜在合作", "星秀场展示舞台，让新作品第一时间被看到", "乐队、分镜等进阶玩法持续上新"],
      },
      {
        selling: "手机创作、平台激励，把热爱做成持续收入",
        keyMessages: ["参与互动即获星钻，通用与出海双轨可用", "优质创作者享专属流量与官方扶持", "创作数据一目了然，收益实时可见"],
      },
    ],
  },

  // ── 铭星链 Studio · 专业分镜创作（视频/AI 导演）──
  "preset-studio": {
    label: "铭星链 Studio · 专业分镜创作",
    language: "zh-CN",
    batches: [
      {
        selling: "像导演一样创作：铭星链 Studio 把想法拆成可执行的分镜",
        keyMessages: ["结构化五阶段流程，从大纲到成片步步可控", "分镜级画面与视频素材独立生成、独立验收", "镜头数量与布局规范，网格排版专业整洁"],
      },
      {
        selling: "专业视频创作不该靠玄学——铭星链 Studio 让过程可复现",
        keyMessages: ["每条分镜保留候选素材，不满意随时重来", "团队协作共创，专业创作者的进阶工作台", "与音乐、配音工具打通，成片链路完整"],
      },
      {
        selling: "面向专业创作者：把时间留给创意，把流程交给 Studio",
        keyMessages: ["脚本、画面、音频结构化沉淀，越用越顺手", "专业圈层认证创作者优先体验新能力", "个人、团队、机构都能在 Studio 找到节奏"],
      },
    ],
  },

  // ── 铭星链音乐 · AI 配乐与乐队创作 ──
  "preset-music": {
    label: "铭星链音乐 · AI 配乐创作",
    language: "zh-CN",
    batches: [
      {
        selling: "词曲唱、编曲配乐一站式生成，你的下一首歌交给铭星链",
        keyMessages: ["从一句灵感词到完整歌曲，多阶段创作", "为视频一键配乐，情绪与节奏自动匹配", "多音色可选，demo 即刻试听"],
      },
      {
        selling: "人人都有创作欲，铭星链让音乐创作不再设门槛",
        keyMessages: ["AI 作曲与真人协作结合，越用越懂你的风格", "乐队玩法与独立歌曲创作并行，各取所需", "成曲可同步到图文视频，打通全链路作品"],
      },
      {
        selling: "创作、发布、收益一条龙，音乐人也值得被好好对待",
        keyMessages: ["作品入库专业圈层，被更多项目采用", "版权与分润规则清晰透明", "多语言发行支持，把音乐带到海外"],
      },
    ],
  },

  // ── 铭星链出海版（Global Creator，en）──
  "preset-global-en": {
    label: "MingStar Creator · Global AIGC Platform",
    language: "en",
    batches: [
      {
        selling: "From idea to promo video in one sentence — MingStar",
        keyMessages: ["Script, storyboard, visuals, voice and music in one flow", "Multilingual templates for global markets", "Pick your models — text, image and more"],
      },
      {
        selling: "Pro creation, on your phone — anywhere with MingStar",
        keyMessages: ["Create and publish right from your mobile", "A creator community with verified circles and showcases", "Studio-grade storyboard workflow on the go"],
      },
      {
        selling: "Creation that pays: earn and share revenue on MingStar",
        keyMessages: ["Star-diamond incentives with global and local tracks", "Transparent profit sharing for creators", "From solo creators to teams — grow together"],
      },
    ],
  },

  // ── 通用回落：铭星链平台（未选模板 / 自定义场景）──
  platform: {
    label: "铭星链 · 平台通用文案",
    language: "zh-CN",
    batches: [
      {
        selling: "一站式 AIGC 创作平台，图文视频音乐一次成片",
        keyMessages: ["脚本、画面、配音、配乐多模型全自动", "小程序与专业 Studio 两种节奏自由切换", "创作、认证、激励、分润完整生态"],
      },
      {
        selling: "把专业创作能力装进手机，人人都能成为创作者",
        keyMessages: ["移动端即用，无需专业设备与后期团队", "多语言出海模板，覆盖更广的观众", "专业圈层认证让作品直达同好"],
      },
      {
        selling: "不止创作工具，更是让作品被看见、被回报的社区",
        keyMessages: ["星钻激励与透明分润，付出有回报", "从乐队到 MV 再到分镜大片，玩法持续上新", "创作者、团队与品牌都在铭星链协作"],
      },
    ],
  },
};

export function listCopyScenario(presetId) {
  return SCENARIOS[presetId] || SCENARIOS.platform;
}

// batch 环绕取模；返回带下标与总数的快照，便于前端展示「第 n/m 批」。
export function listCopyIdeas(presetId, batch = 0) {
  const scenario = listCopyScenario(presetId);
  const total = scenario.batches.length;
  const idx = ((Number(batch) || 0) % total + total) % total;
  const item = scenario.batches[idx];
  return {
    preset: SCENARIOS[presetId] ? presetId : "platform",
    scenario: scenario.label,
    language: scenario.language,
    batch: idx,
    total,
    sellingPoint: item.selling,
    keyMessages: [...item.keyMessages],
  };
}
