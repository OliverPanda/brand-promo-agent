# 运行状态与 SSE 恢复契约

## 问题与方案

Mastra `start/resume` 返回的失败结果不一定 reject。服务端必须检查结果状态，并核对核心步骤没有 failed，只在 success 时进入下一阶段；step-failed 仅描述步骤失败，run-failed 由阶段边界确认最终失败后发布一次，保存 error。不得把失败结果覆盖为 awaiting_delivery/success。脚本 resume 已有 approval 时不得再次 suspend。

SSE 首次连接与自动重连均发送 `hello`、`snapshot: { runId, ts, run }`，run 为 GET /api/runs/:runId 相同的公开快照。success/failed 随后补发对应终态事件并关闭；awaiting_delivery 补发 final-review 并保持连接。不存在的 run 返回 HTTP 404。断开连接只清理订阅与心跳，不删除业务审批回调。

前端复用 EventSource 原生重连，收到 snapshot 重建步骤，恢复脚本门、成片门或交付结果；网络异常显示重连提示。URL 的 runId 优先，其次恢复本浏览器最后一次任务，不自动选择其他任务。新任务清空旧步骤与结果；旧流事件不能污染新任务。请求失败应显示可重试提示。

审批响应可能晚于 SSE 终态，审批成功后重新读取 GET /api/runs/:runId，禁止以固定“交付中/重新生成中”文案覆盖更晚的运行状态。切换任务后忽略旧审批响应。

步骤固定为 ingestBrief、writeScript、prepareVideo、storyboard、generateScenes、voiceover、music、composite，全部提供中文名称。进度按真实 done 状态计算，不因收到交付事件强制抹掉失败步骤。

## 设计依据与验收

本次只调整运行交互状态与中文文案，依据 ../spec/design/pc-design.md，复用现有 Token、卡片和弹窗。历史 handoff 中“不动 SSE 协议”已被本次修复要求覆盖。

回归覆盖迟到订阅、成功/失败终态、两类审批门重连、连接清理、Mastra resolve failed、异常拒绝、旧流隔离、刷新恢复和进度重建。集成测试使用现有 node:test、内存 store 与 demo provider，不触发真实付费生成。

## 验证记录（2026-09-14）

- `npm test`：139/139，通过；包含 16 个新增回归用例及现有 FFmpeg 合成测试。脚本审批集成用例追加了先断开 SSE 再审批的验证。
- 原任务在 1440/768/375px 视口刷新均恢复成片验收门、中文八步骤、无横向溢出、无 pageerror。其历史分镜失败保留为 7/8，未伪造全步骤成功。
- 浏览器离线后重新建立 SSE 显示“正在自动重连”，恢复网络后原生重连获取快照、恢复验收门。
- `git diff --check`、内联脚本语法检查通过。截图：`test/_preview/run-recovery-1440.png`；测试日志：`test/_preview/run-recovery-tests.log`。
- 本轮未重新执行付费品宣生成或验收历史产物；原任务仍为历史降级分镜包。未执行 Staging 发布及整套 MingStar 基础服务验收。
