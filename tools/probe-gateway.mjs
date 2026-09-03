// 网关探测脚本：在【能连到你的 new-api / one-api】的环境运行一次，把输出贴回会话，
// 用于确认 /v1/models 返回结构与视频渠道 id，做精确分类与接入对拍。
// 用法：node tools/probe-gateway.mjs [--base https://…/v1] [--key sk-…]
//   缺省读取运行时配置（data/runtime-config.json 覆盖）> env（PROMO_ONEAPI_BASE_URL / PROMO_ONEAPI_API_KEY）。
// 只读 GET /v1/models，不产生任何生成费用。
import { getEffectiveOneApiBase } from "../src/runtime-config.js";
import { classifyRemoteModels } from "../src/models-gateway.js";

const argv = process.argv.slice(2);
const idxB = argv.indexOf("--base");
const idxK = argv.indexOf("--key");
const base = (idxB >= 0 ? argv[idxB + 1] : "") || getEffectiveOneApiBase();
const key = (idxK >= 0 ? argv[idxK + 1] : "") || process.env.PROMO_ONEAPI_API_KEY || process.env.OPENAI_API_KEY;

if (!base) {
  console.error("缺少供应商地址：node tools/probe-gateway.mjs --base http://127.0.0.1:8080/v1 --key sk-xxx");
  process.exit(1);
}
if (!key) {
  console.error("缺少 API 密钥：--key sk-xxx 或 env PROMO_ONEAPI_API_KEY");
  process.exit(1);
}

const url = `${base.replace(/\/$/, "")}/models`;
console.log(`GET ${url} …`);
try {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) {
    console.error(`网关 /models ${res.status}: ${(await res.text()).slice(0, 300)}`);
    process.exit(1);
  }
  const json = await res.json();
  const byType = classifyRemoteModels(json?.data || []);
  console.log("\n=== 分类结果 ===");
  for (const cat of ["llm", "image", "video", "audio"]) {
    console.log(`\n[${cat}] ${byType[cat].length} 个`);
    byType[cat].forEach((m) => console.log("  -", m));
  }
  console.log(`\n=== raw 前 12 项（含 type 字段原样）===`);
  (json?.data || []).slice(0, 12).forEach((m) => console.log(" ", JSON.stringify({ id: m.id, type: m.type, owned_by: m.owned_by })));
  console.log(`\n（共 ${json?.data?.length || 0} 个模型条目；如需接入真实视频生成，把上面输出完整贴回会话）`);
} catch (e) {
  console.error("探测失败：", e?.message || e);
  process.exit(1);
}
