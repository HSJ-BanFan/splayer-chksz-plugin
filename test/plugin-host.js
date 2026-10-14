import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const pluginSource = await readFile(
  resolve(projectRoot, "src", "plugin.js"),
  "utf8",
);

export const loadPlugin = ({
  apiKey = "chksz_test_key",
  settings: settingOverrides = {},
  response,
  probeResponse,
  directSearchResponse,
  jianbinResponse,
  now = () => Date.now(),
  sourceText = pluginSource,
} = {}) => {
  const registration = {};
  const handlers = {};
  const requests = [];
  const deliveryProbes = [];
  const directSearches = [];
  const jianbinRequests = [];
  const hostRequests = [];
  const logs = [];
  const settings = { apiKey, ...settingOverrides };

  const splayer = {
    register(args) {
      Object.assign(registration, args);
    },
    on(action, handler) {
      handlers[action] = handler;
    },
    getSetting(key) {
      return settings[key];
    },
    async request(url, options) {
      const entry = { url, options };
      hostRequests.push(entry);
      const parsedUrl = new URL(url);
      const isProbe = Boolean(options?.headers?.Range || options?.headers?.range);
      // 交付体检是对 CDN 的前几个字节探测，不算 ChKSz API 调用；`requests` 只保留解析类请求，
      // `deliveryProbes` 单独记账，`hostRequests` 是完整日志。
      if (isProbe) {
        deliveryProbes.push(entry);
        // 默认把探测地址当作可访问；要模拟地址不可用就传 probeResponse。
        if (probeResponse === undefined) {
          return { status: 206, body: new Uint8Array([0x66, 0x4c, 0x61, 0x43]) };
        }
        return typeof probeResponse === "function"
          ? probeResponse(parsedUrl, options)
          : probeResponse;
      }
      if (parsedUrl.host === "api.chksz.com") {
        requests.push(entry);
        return typeof response === "function"
          ? response(parsedUrl, options)
          : response;
      }
      // 煎饼（免费兜底源）单独记账；默认返回快速 503，让既有测试的请求序列与预算保持不变，
      // 要模拟煎饼可用就传 jianbinResponse。
      if (parsedUrl.host === "www.jbsou.cn") {
        jianbinRequests.push(entry);
        if (jianbinResponse === undefined) return { status: 503, body: "" };
        return typeof jianbinResponse === "function"
          ? jianbinResponse(parsedUrl, options)
          : jianbinResponse;
      }
      // 备用搜索打的是 QQ 音乐等公开接口，不是 ChKSz；单独记账，默认当作不可用，
      // 这样既有测试的 `requests` 和错误语义都不变，要模拟命中就传 directSearchResponse。
      directSearches.push(entry);
      if (directSearchResponse === undefined) return { status: 503, body: "" };
      return typeof directSearchResponse === "function"
        ? directSearchResponse(parsedUrl, options)
        : directSearchResponse;
    },
    log: Object.fromEntries(
      ["debug", "info", "warn", "error"].map((level) => [
        level,
        (...args) => logs.push({ level, args }),
      ]),
    ),
  };

  const context = {
    splayer,
    URL,
    Promise,
    console,
    setTimeout,
    clearTimeout,
    Date: class extends Date { static now() { return now(); } },
  };
  vm.runInNewContext(
    `${sourceText}
;globalThis.__createRuntimeAdapter = typeof createRuntimeAdapter === "undefined" ? undefined : createRuntimeAdapter;
;globalThis.__resolutionCore = typeof resolutionCore === "undefined" ? undefined : resolutionCore;
;globalThis.__sourcePolicies = typeof SOURCE_POLICIES === "undefined" ? undefined : SOURCE_POLICIES;`,
    context,
  );

  return {
    registration,
    handlers,
    requests,
    deliveryProbes,
    directSearches,
    jianbinRequests,
    hostRequests,
    logs,
    setSetting(key, value) { settings[key] = value; },
    resolutionCore: context.__resolutionCore,
    sourcePolicies: context.__sourcePolicies,
    createRuntimeAdapter: context.__createRuntimeAdapter,
  };
};
