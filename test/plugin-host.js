import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const pluginSource = await readFile(resolve(projectRoot, "src", "plugin.js"), "utf8");

export const loadPlugin = ({
  apiKey = "chksz_test_key",
  response,
  sourceText = pluginSource,
} = {}) => {
  const registration = {};
  const handlers = {};
  const requests = [];
  const settings = { apiKey };

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
      requests.push({ url, options });
      return typeof response === "function" ? response(new URL(url), options) : response;
    },
    log: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
  };

  const context = {
    splayer,
    URL,
    Promise,
    console,
    setTimeout,
    clearTimeout,
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
    resolutionCore: context.__resolutionCore,
    sourcePolicies: context.__sourcePolicies,
    createRuntimeAdapter: context.__createRuntimeAdapter,
  };
};
