// 测试预加载（node --import）：在所有测试模块与 server.js 加载前设置环境。
// - STEP_DELAY_MS=10：加速每步停顿（避免 400ms 真实延时）。
// - PROMO_PERSIST=0：关闭 store/quota 文件写穿与启动 hydrate，测试全程内存态、互不污染、不落盘。
process.env.STEP_DELAY_MS = process.env.STEP_DELAY_MS || "10";
process.env.PROMO_PERSIST = "0";
process.env.PROMO_PROVIDER_MODE = "demo";
