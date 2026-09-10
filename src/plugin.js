/**
 * @name        ChKSz 音源
 * @id          chksz.splayer-source
 * @version     0.1.0
 * @description 使用 ChKSz API 解析网易云、QQ 音乐和酷狗播放地址
 * @author      HSJ-BanFan
 * @homepage    https://github.com/HSJ-BanFan/splayer-chksz-plugin
 * @type        source
 * @grant       network
 * @apiLevel    1
 * @updateUrl   https://raw.githubusercontent.com/HSJ-BanFan/splayer-chksz-plugin/main/dist/chksz.splayer-source.js
 * @changelog   首次公开发布
 */

const API_BASE_URL = "https://api.chksz.com";
const API_KEY_SETTING = "apiKey";
const REQUEST_TIMEOUT = 20_000;

const QUALITY_NAMES = ["lq", "sq", "hq", "lossless", "hi-res"];
const NETEASE_QUALITY_FALLBACKS = {
  "hi-res": ["hi-res", "lossless", "hq", "sq", "lq"],
  lossless: ["lossless", "hq", "sq", "lq"],
  hq: ["hq", "sq", "lq"],
  sq: ["sq", "lq"],
  lq: ["lq"],
};

const SOURCE_POLICIES = {
  wy: {
    name: "ChKSz 网易云",
    identity: { idParameter: "id" },
    playback: {
      endpoint: "/api/163_music",
      qualityParameter: "level",
      qualityValues: {
        "hi-res": "hires",
        lossless: "lossless",
        hq: "exhigh",
        sq: "exhigh",
        lq: "standard",
      },
      qualityFallbacks: NETEASE_QUALITY_FALLBACKS,
    },
    actions: {
      musicLyric: { endpoint: "/api/163_lyric", params: {} },
      musicPic: {
        endpoint: "/api/163_music",
        params: { level: "standard", type: "json" },
      },
    },
  },
  tx: {
    name: "ChKSz QQ 音乐",
    identity: { idParameter: "mid" },
    playback: {
      endpoint: "/api/qq_music",
      qualityParameter: "size",
      qualityValues: {
        "hi-res": "hires",
        lossless: "flac",
        hq: "320k",
        sq: "320k",
        lq: "128k",
      },
    },
    actions: {
      musicLyric: { request: "trackDetails" },
      musicPic: { request: "trackDetails" },
    },
  },
  kg: {
    name: "ChKSz 酷狗",
    identity: { idParameter: "id" },
    playback: {
      endpoint: "/api/kugou_music",
      qualityParameter: "size",
      qualityValues: {
        "hi-res": "hires",
        lossless: "flac",
        hq: "320k",
        sq: "320k",
        lq: "128k",
      },
    },
    actions: {
      musicLyric: { request: "trackDetails" },
      musicPic: { request: "trackDetails" },
    },
  },
};

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

const pluginError = (code, message) => {
  const error = new Error(message);
  error.code = code;
  return error;
};

const getMusicId = (musicInfo) => {
  if (!isRecord(musicInfo)) {
    throw pluginError("CHKSZ_TRACK_INVALID", "SPlayer 未提供有效的歌曲信息。");
  }

  for (const key of ["songmid", "id", "songId"]) {
    const value = musicInfo[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }

  throw pluginError("CHKSZ_TRACK_INVALID", "歌曲缺少平台 ID，无法请求 ChKSz。");
};

const getSourcePolicy = (source) => {
  const policy = SOURCE_POLICIES[source];
  if (!policy) {
    throw pluginError("CHKSZ_SOURCE_UNSUPPORTED", `不支持的 SPlayer 音源：${String(source)}。`);
  }
  return policy;
};

const buildTrackParams = (source, id, quality) => {
  const policy = getSourcePolicy(source);
  const requestedQuality = QUALITY_NAMES.includes(quality) ? quality : "hq";
  return {
    policy,
    requestedQuality,
    params: {
      [policy.identity.idParameter]: id,
      [policy.playback.qualityParameter]: policy.playback.qualityValues[requestedQuality],
      type: "json",
    },
  };
};

const createResolutionCore = () => {
  const getApiKey = () => {
    const value = splayer.getSetting(API_KEY_SETTING);
    const apiKey = typeof value === "string" ? value.trim() : "";

    if (!apiKey) {
      throw pluginError(
        "CHKSZ_CONFIG_MISSING",
        "未配置 ChKSz API Key：请打开 设置 → 插件管理 → ChKSz 音源 → 配置。",
      );
    }

    // RFC 3986 unreserved characters; this prevents accidentally sending whitespace or a URL.
    if (!/^chksz_[A-Za-z0-9._~-]+$/.test(apiKey)) {
      throw pluginError(
        "CHKSZ_CONFIG_INVALID",
        "ChKSz API Key 格式无效：Key 应以 chksz_ 开头，并只包含 URL 安全字符。",
      );
    }

    return apiKey;
  };

  const buildApiUrl = (endpoint, params) => {
    const url = new URL(`${API_BASE_URL}${endpoint}`);
    for (const [key, value] of Object.entries({ ...params, apikey: getApiKey() })) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  };

  const getBodyMessage = (body) => {
    if (!isRecord(body)) return "";
    for (const key of ["msg", "message", "error"]) {
      const value = body[key];
      if (typeof value === "string" && value.trim()) return value.trim();
      if (isRecord(value) && typeof value.message === "string" && value.message.trim()) {
        return value.message.trim();
      }
    }
    return "";
  };

  const getHeader = (headers, name) => {
    if (!isRecord(headers)) return "";
    const wanted = name.toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === wanted && typeof value === "string") return value;
    }
    return "";
  };

  const throwHttpError = (response) => {
    const status = Number(response?.status) || 0;
    const bodyMessage = getBodyMessage(response?.body);
    const parts = [`ChKSz 请求失败（HTTP ${status}）`];
    if (bodyMessage) parts.push(bodyMessage);

    if (status === 429) {
      const retryAfter = getHeader(response?.headers, "retry-after");
      if (retryAfter) parts.push(`请在 ${retryAfter} 秒后再试`);
    }

    const code = status > 0 ? `CHKSZ_HTTP_${status}` : "CHKSZ_HTTP_ERROR";
    throw pluginError(code, parts.join("："));
  };

  const isUnavailableQualityError = (error) =>
    error?.code === "CHKSZ_HTTP_404" &&
    /music url not found\s*,\s*song may be unavailable at this quality level/i.test(
      error.message || "",
    );

  const requestJson = async (endpoint, params) => {
    const response = await splayer.request(buildApiUrl(endpoint, params), {
      method: "GET",
      responseType: "json",
      timeout: REQUEST_TIMEOUT,
    });

    if (!response || Number(response.status) < 200 || Number(response.status) >= 300) {
      throwHttpError(response);
    }

    if (!isRecord(response.body)) {
      throw pluginError("CHKSZ_INVALID_RESPONSE", "ChKSz 返回的不是有效 JSON 对象。");
    }

    return response.body;
  };

  const extractUrl = (body) => {
    const candidates = [
      body?.url,
      body?.data?.url,
      body?.result?.url,
      typeof body?.data === "string" ? body.data : undefined,
      typeof body?.result === "string" ? body.result : undefined,
    ];

    const url = candidates.find((value) => typeof value === "string" && value.trim());
    if (!url) return "";

    const trimmed = url.trim();
    return /^https?:\/\//i.test(trimmed) ? trimmed : "";
  };

  const normaliseExpiry = (value) => {
    const number = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(number) || number <= 0) return undefined;
    const expiry = number < 1_000_000_000_000 ? number * 1000 : number;
    return expiry > Date.now() ? expiry : undefined;
  };

  const extractExpiry = (body) => {
    for (const container of [body, body?.data, body?.result]) {
      if (!isRecord(container)) continue;
      for (const key of ["expire", "expiresAt", "expires_at", "urlExpire"]) {
        const expiry = normaliseExpiry(container[key]);
        if (expiry) return expiry;
      }
    }
    return undefined;
  };

  const normalisePlaybackResponse = (body) => {
    const url = extractUrl(body);
    if (!url) {
      const message = getBodyMessage(body);
      throw pluginError(
        "CHKSZ_NO_URL",
        message ? `ChKSz 未返回播放地址：${message}` : "ChKSz 未返回播放地址。",
      );
    }

    const result = { url };
    const expire = extractExpiry(body);
    if (expire) result.expire = expire;
    return result;
  };

  const selectQualityCandidates = (policy, requestedQuality) => {
    const logicalQualities =
      policy.playback.qualityFallbacks?.[requestedQuality] ?? [requestedQuality];
    const attemptedNativeQualities = new Set();
    const { qualityValues } = policy.playback;

    return logicalQualities.filter((candidateQuality) => {
      const nativeQuality = qualityValues[candidateQuality];
      if (attemptedNativeQualities.has(nativeQuality)) return false;
      attemptedNativeQualities.add(nativeQuality);
      return true;
    });
  };

  const resolve = async ({ source, quality, id }) => {
    const { policy, requestedQuality } = buildTrackParams(source, id, quality);
    const qualityCandidates = selectQualityCandidates(policy, requestedQuality);
    let body;
    let resolvedQuality = requestedQuality;

    for (const [index, candidateQuality] of qualityCandidates.entries()) {
      const { params } = buildTrackParams(source, id, candidateQuality);

      try {
        body = await requestJson(policy.playback.endpoint, params);
        resolvedQuality = candidateQuality;
        break;
      } catch (error) {
        const hasFallback = index < qualityCandidates.length - 1;
        if (!hasFallback || !isUnavailableQualityError(error)) throw error;
      }
    }

    const result = normalisePlaybackResponse(body);
    result.quality = resolvedQuality;
    return result;
  };

  return { requestJson, resolve };
};

const resolutionImplementation = createResolutionCore();
const { requestJson } = resolutionImplementation;
const resolutionCore = { resolve: resolutionImplementation.resolve };

const resolveUrl = async ({ source, quality, musicInfo }) => {
  const id = getMusicId(musicInfo);
  return resolutionCore.resolve({ source, quality, id });
};

const textFromValue = (value) => {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return "";
  for (const key of ["lyric", "text", "content"]) {
    if (typeof value[key] === "string") return value[key];
  }
  return "";
};

const extractTextField = (body, names) => {
  for (const container of [body, body?.data, body?.result]) {
    if (!isRecord(container)) continue;
    for (const name of names) {
      const text = textFromValue(container[name]);
      if (text) return text;
    }
  }
  return "";
};

const buildActionRequest = (source, action, id) => {
  const policy = getSourcePolicy(source);
  const actionPolicy = policy.actions[action];
  const params = {
    [policy.identity.idParameter]: id,
    ...actionPolicy.params,
  };

  if (actionPolicy.request === "trackDetails") {
    params[policy.playback.qualityParameter] = policy.playback.qualityValues.lq;
    params.type = "json";
  }

  return {
    endpoint: actionPolicy.endpoint ?? policy.playback.endpoint,
    params,
  };
};

const requestAction = async (source, action, id) => {
  const { endpoint, params } = buildActionRequest(source, action, id);
  return requestJson(endpoint, params);
};

const getLyric = async ({ source, musicInfo }) => {
  const id = getMusicId(musicInfo);
  const body = await requestAction(source, "musicLyric", id);

  return {
    lyric: extractTextField(body, ["lyric", "lrc"]),
    tlyric: extractTextField(body, ["tlyric", "tlrc", "translation"]),
    rlyric: extractTextField(body, ["rlyric", "romalrc", "romanization"]),
    awlyric: extractTextField(body, ["awlyric", "yrc", "qrc", "krc"]),
  };
};

const getCover = async ({ source, musicInfo }) => {
  const id = getMusicId(musicInfo);
  const body = await requestAction(source, "musicPic", id);

  const cover = extractTextField(body, ["cover", "coverUrl", "pic", "picUrl", "albumCover"]);
  return { url: /^https?:\/\//i.test(cover) ? cover : "" };
};

splayer.register({
  sources: Object.fromEntries(
    Object.entries(SOURCE_POLICIES).map(([source, policy]) => [
      source,
      {
        name: policy.name,
        actions: ["musicUrl", "musicLyric", "musicPic"],
        qualities: QUALITY_NAMES,
      },
    ]),
  ),
  settings: [
    {
      key: API_KEY_SETTING,
      type: "text",
      label: "ChKSz API Key",
      description: "仅保存在 SPlayer 本机设置中；不要分享配置文件。",
      default: "",
      placeholder: "chksz_...",
    },
  ],
});

splayer.on("musicUrl", resolveUrl);
splayer.on("musicLyric", getLyric);
splayer.on("musicPic", getCover);
