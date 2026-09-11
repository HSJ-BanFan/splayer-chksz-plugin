/**
 * @name        ChKSz 音源
 * @id          chksz.splayer-source
 * @version     0.2.0
 * @description 使用 ChKSz API 解析网易云、QQ 音乐和酷狗播放地址
 * @author      HSJ-BanFan
 * @homepage    https://github.com/HSJ-BanFan/splayer-chksz-plugin
 * @type        source
 * @grant       network
 * @apiLevel    1
 * @updateUrl   https://raw.githubusercontent.com/HSJ-BanFan/splayer-chksz-plugin/main/dist/chksz.splayer-source.js
 * @changelog   网易云无版权歌曲自动改用 QQ 音乐 / 酷狗播放\nQQ 音乐与酷狗同样支持音质降级
 */

const API_BASE_URL = "https://api.chksz.com";
const API_KEY_SETTING = "apiKey";
const REQUEST_TIMEOUT = 20_000;

const CROSS_PLATFORM_SETTING = "crossPlatformFallback";
const DURATION_TOLERANCE_SECONDS = 20;
const SEARCH_RESULT_LIMIT = 10;
const CROSS_PLATFORM_MAX_CANDIDATES = 3;
const CROSS_PLATFORM_REQUEST_BUDGET = 8;
const CROSS_PLATFORM_TIME_BUDGET = 10_000;
const CROSS_PLATFORM_LIMIT_ERROR = "CHKSZ_CROSS_PLATFORM_LIMIT";
const RESOLUTION_TIME_BUDGET = 18_000;
const RESOLUTION_TIMEOUT_ERROR = "CHKSZ_RESOLUTION_TIMEOUT";
const REQUEST_TIMEOUT_ERROR = "CHKSZ_REQUEST_TIMEOUT";
const NETWORK_ERROR = "CHKSZ_NETWORK_ERROR";

const QUALITY_NAMES = ["lq", "sq", "hq", "lossless", "hi-res"];
// Logical downgrade ladder shared by every provider: hi-res → lossless → hq → sq → lq.
const QUALITY_FALLBACKS = Object.fromEntries(
  QUALITY_NAMES.map((quality, index) => [
    quality,
    QUALITY_NAMES.slice(0, index + 1).reverse(),
  ]),
);

const SOURCE_POLICIES = {
  wy: {
    name: "ChKSz 网易云",
    identity: { idParameter: "id" },
    playback: {
      endpoint: "/api/163_music",
      qualityParameter: "level",
      qualityValues: {
        "hi-res": "jymaster",
        lossless: "lossless",
        hq: "exhigh",
        sq: "exhigh",
        lq: "standard",
      },
      qualityAlternatives: { "hi-res": ["hires"] },
      qualityFallbacks: QUALITY_FALLBACKS,
    },
    // NetEase lacks the rights to many catalogues; look the same song up elsewhere.
    crossPlatform: { sources: ["tx", "kg"] },
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
        "hi-res": "master",
        lossless: "flac",
        hq: "320k",
        sq: "320k",
        lq: "128k",
      },
      qualityAlternatives: { "hi-res": ["hires"] },
      qualityFallbacks: QUALITY_FALLBACKS,
    },
    search: {
      endpoint: "/api/qq_music",
      keywordParameter: "msg",
      params: { num: SEARCH_RESULT_LIMIT },
      candidateIdField: "mid",
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
        "hi-res": "master",
        lossless: "flac",
        hq: "320k",
        sq: "320k",
        lq: "128k",
      },
      qualityAlternatives: { "hi-res": ["hires"] },
      qualityFallbacks: QUALITY_FALLBACKS,
    },
    search: {
      endpoint: "/api/kugou_music",
      keywordParameter: "msg",
      params: {},
      candidateIdField: "id",
    },
    actions: {
      musicLyric: { request: "trackDetails" },
      musicPic: { request: "trackDetails" },
    },
  },
};

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

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
    if (typeof value === "number" && Number.isFinite(value))
      return String(value);
  }

  throw pluginError("CHKSZ_TRACK_INVALID", "歌曲缺少平台 ID，无法请求 ChKSz。");
};

const textOrEmpty = (value) => (typeof value === "string" ? value.trim() : "");

const ARTIST_SEPARATOR = /[/、,，&]/;

/** Metadata SPlayer attaches to musicInfo; only used for cross-platform matching. */
const getTrackDescriptor = (musicInfo) => ({
  name: textOrEmpty(musicInfo?.name),
  singer: textOrEmpty(musicInfo?.singer),
  interval: textOrEmpty(musicInfo?.interval),
});

const getSourcePolicy = (source) => {
  const policy = SOURCE_POLICIES[source];
  if (!policy) {
    throw pluginError(
      "CHKSZ_SOURCE_UNSUPPORTED",
      `不支持的 SPlayer 音源：${String(source)}。`,
    );
  }
  return policy;
};

const buildTrackParams = (source, id, quality, nativeQualityOverride) => {
  const policy = getSourcePolicy(source);
  const requestedQuality = QUALITY_NAMES.includes(quality) ? quality : "hq";
  return {
    policy,
    requestedQuality,
    params: {
      [policy.identity.idParameter]: id,
      [policy.playback.qualityParameter]:
        nativeQualityOverride ?? policy.playback.qualityValues[requestedQuality],
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
    for (const [key, value] of Object.entries({
      ...params,
      apikey: getApiKey(),
    })) {
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
      if (
        isRecord(value) &&
        typeof value.message === "string" &&
        value.message.trim()
      ) {
        return value.message.trim();
      }
    }
    return "";
  };

  const redactSensitiveData = (value) =>
    String(value ?? "")
      .replace(/([?&]apikey=)[^&\s]+/gi, "$1[REDACTED]")
      .replace(/chksz_[A-Za-z0-9._~-]+/gi, "chksz_[REDACTED]");

  const getHeader = (headers, name) => {
    if (!isRecord(headers)) return "";
    const wanted = name.toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === wanted && typeof value === "string")
        return value;
    }
    return "";
  };

  const throwHttpError = (response) => {
    const status = Number(response?.status) || 0;
    const bodyMessage = redactSensitiveData(getBodyMessage(response?.body));
    const parts = [`ChKSz 请求失败（HTTP ${status}）`];
    if (bodyMessage) parts.push(bodyMessage);

    if (status === 429) {
      const retryAfter = getHeader(response?.headers, "retry-after");
      if (retryAfter) parts.push(`请在 ${retryAfter} 秒后再试`);
    }

    const code = status > 0 ? `CHKSZ_HTTP_${status}` : "CHKSZ_HTTP_ERROR";
    throw pluginError(code, parts.join("："));
  };

  const throwApiError = (body) => {
    const apiCode = Number(body?.code);
    if (!Number.isInteger(apiCode) || apiCode === 200) return;

    const bodyMessage = redactSensitiveData(getBodyMessage(body));
    const isHttpStatus = apiCode >= 400 && apiCode <= 599;
    const prefix = isHttpStatus
      ? `ChKSz 请求失败（HTTP ${apiCode}）`
      : `ChKSz 返回错误码 ${apiCode}`;
    const code = isHttpStatus ? `CHKSZ_HTTP_${apiCode}` : `CHKSZ_API_${apiCode}`;
    throw pluginError(code, bodyMessage ? `${prefix}：${bodyMessage}` : prefix);
  };

  const isUnavailableQualityError = (error) =>
    error?.code === "CHKSZ_HTTP_404" &&
    /music url not found\s*,\s*song may be unavailable at this quality level/i.test(
      error.message || "",
    );

  // Key, quota, ban and rate-limit failures affect every request; stop probing after them.
  const isAccountError = (error) =>
    /^CHKSZ_(CONFIG_|HTTP_(401|402|403|429)$)/.test(String(error?.code));

  const isCrossPlatformLimitError = (error) =>
    error?.code === CROSS_PLATFORM_LIMIT_ERROR;

  const isResolutionTimeoutError = (error) =>
    error?.code === RESOLUTION_TIMEOUT_ERROR;

  const isRequestTimeoutError = (error) =>
    error?.code === REQUEST_TIMEOUT_ERROR;

  const isHostRequestTimeoutError = (error) =>
    ["PLUGIN_REQUEST_TIMEOUT", "REQUEST_TIMEOUT", "ETIMEDOUT", "ESOCKETTIMEDOUT"].includes(
      String(error?.code),
    ) || error?.name === "TimeoutError";

  const isOperationalError = (error) =>
    error?.code === NETWORK_ERROR || isRequestTimeoutError(error);

  const isProviderError = (error) =>
    /^CHKSZ_(HTTP(?:_\d{3}|_ERROR)|API_|INVALID_RESPONSE)/.test(
      String(error?.code),
    );

  const isCrossPlatformEnabled = () => {
    const value = splayer.getSetting(CROSS_PLATFORM_SETTING);
    return value === undefined || value === null || value === "" || value === true;
  };

  const requestWithTimeout = async (
    url,
    options,
    timeoutCode = REQUEST_TIMEOUT_ERROR,
  ) => {
    const timeout = Number(options?.timeout) > 0 ? Number(options.timeout) : REQUEST_TIMEOUT;
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(() => splayer.request(url, options)),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            reject(
              pluginError(
                timeoutCode,
                timeoutCode === RESOLUTION_TIMEOUT_ERROR
                  ? "SPlayer 播放地址解析已达到时间上限。"
                  : timeoutCode === CROSS_PLATFORM_LIMIT_ERROR
                    ? "ChKSz 跨平台兜底已达到请求或时间上限。"
                    : `ChKSz 请求超过 ${timeout} 毫秒。`,
              ),
            );
          }, timeout);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  const requestJson = async (endpoint, params, { budget, deadline } = {}) => {
    let timeout = REQUEST_TIMEOUT;
    let timeoutCode = REQUEST_TIMEOUT_ERROR;
    const remainingResolutionTime = Number.isFinite(deadline)
      ? deadline - Date.now()
      : Infinity;
    if (remainingResolutionTime <= 0) {
      throw pluginError(
        RESOLUTION_TIMEOUT_ERROR,
        "SPlayer 播放地址解析已达到时间上限。",
      );
    }

    if (budget) {
      const remainingTime = budget.deadline - Date.now();
      if (budget.remaining <= 0 || remainingTime <= 0) {
        throw pluginError(
          CROSS_PLATFORM_LIMIT_ERROR,
          "ChKSz 跨平台兜底已达到请求或时间上限。",
        );
      }
      budget.remaining -= 1;
      timeout = Math.max(1, Math.min(REQUEST_TIMEOUT, remainingTime));
      timeoutCode = CROSS_PLATFORM_LIMIT_ERROR;
    }
    if (Number.isFinite(remainingResolutionTime)) {
      if (remainingResolutionTime < timeout) {
        timeoutCode = RESOLUTION_TIMEOUT_ERROR;
      }
      timeout = Math.max(1, Math.min(timeout, remainingResolutionTime));
    }

    const requestUrl = buildApiUrl(endpoint, params);
    const requestOptions = {
      method: "GET",
      responseType: "json",
      timeout,
    };
    let response;
    try {
      response = await requestWithTimeout(requestUrl, requestOptions, timeoutCode);
    } catch (error) {
      if (
        isRequestTimeoutError(error) ||
        isResolutionTimeoutError(error) ||
        isCrossPlatformLimitError(error)
      ) {
        throw error;
      }
      if (isHostRequestTimeoutError(error)) {
        const hostTimeoutCode =
          timeoutCode === RESOLUTION_TIMEOUT_ERROR &&
          Number.isFinite(deadline) &&
          Date.now() >= deadline
            ? RESOLUTION_TIMEOUT_ERROR
            : timeoutCode === CROSS_PLATFORM_LIMIT_ERROR &&
                budget &&
                Date.now() >= budget.deadline
              ? CROSS_PLATFORM_LIMIT_ERROR
              : REQUEST_TIMEOUT_ERROR;
        throw pluginError(
          hostTimeoutCode,
          hostTimeoutCode === RESOLUTION_TIMEOUT_ERROR
            ? "SPlayer 播放地址解析已达到时间上限。"
            : hostTimeoutCode === CROSS_PLATFORM_LIMIT_ERROR
              ? "ChKSz 跨平台兜底已达到请求或时间上限。"
              : `ChKSz 请求超过 ${timeout} 毫秒。`,
        );
      }
      throw pluginError(
        NETWORK_ERROR,
        `ChKSz 网络请求失败：${redactSensitiveData(error?.message ?? error)}`,
      );
    }

    if (
      !response ||
      Number(response.status) < 200 ||
      Number(response.status) >= 300
    ) {
      throwHttpError(response);
    }

    if (!isRecord(response.body)) {
      throw pluginError(
        "CHKSZ_INVALID_RESPONSE",
        "ChKSz 返回的不是有效 JSON 对象。",
      );
    }

    throwApiError(response.body);
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

    const url = candidates.find(
      (value) => typeof value === "string" && value.trim(),
    );
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
      const message = redactSensitiveData(getBodyMessage(body));
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
    const logicalQualities = policy.playback.qualityFallbacks?.[
      requestedQuality
    ] ?? [requestedQuality];
    const attemptedNativeQualities = new Set();
    const { qualityValues } = policy.playback;

    return logicalQualities
      .flatMap((candidateQuality) =>
        [
          qualityValues[candidateQuality],
          ...(policy.playback.qualityAlternatives?.[candidateQuality] ?? []),
        ].map((nativeQuality) => ({ candidateQuality, nativeQuality })),
      )
      .filter(({ nativeQuality }) => {
        if (attemptedNativeQualities.has(nativeQuality)) return false;
        attemptedNativeQualities.add(nativeQuality);
        return true;
      });
  };

  const resolveOnPlatform = async (source, quality, id, requestContext = {}) => {
    const { policy, requestedQuality } = buildTrackParams(source, id, quality);
    const qualityCandidates = selectQualityCandidates(policy, requestedQuality);
    let body;
    let resolvedQuality = requestedQuality;

    for (const [index, { candidateQuality, nativeQuality }] of qualityCandidates.entries()) {
      const { params } = buildTrackParams(source, id, candidateQuality, nativeQuality);

      try {
        body = await requestJson(policy.playback.endpoint, params, requestContext);
        resolvedQuality = candidateQuality;
        break;
      } catch (error) {
        const hasFallback = index < qualityCandidates.length - 1;
        if (!hasFallback || !isUnavailableQualityError(error)) throw error;
      }
    }

    const result = normalisePlaybackResponse(body);
    result.quality = resolvedQuality;
    return { result, body };
  };

  const normaliseText = (value) =>
    String(value ?? "")
      .toLowerCase()
      .replace(/[\s\p{P}\p{S}]+/gu, "");

  const splitArtists = (value) =>
    String(value ?? "").split(ARTIST_SEPARATOR).map(normaliseText).filter(Boolean);

  const exactlyEqual = (a, b) => Boolean(a) && Boolean(b) && a === b;

  const parseDurationSeconds = (value) => {
    if (typeof value === "number") {
      if (!Number.isFinite(value) || value <= 0) return 0;
      // Values this large can only be milliseconds.
      return value >= 36_000 ? value / 1000 : value;
    }
    const text = textOrEmpty(value);
    const clock = /^(\d{1,3}):(\d{2})$/.exec(text);
    if (clock) return Number(clock[1]) * 60 + Number(clock[2]);
    return parseDurationSeconds(Number(text));
  };

  /** 0 = different song, 2 = exact normalised title. */
  const matchScore = (track, candidate, { requireDuration = false } = {}) => {
    if (!isRecord(candidate)) return 0;
    const wantedName = normaliseText(track.name);
    const candidateName = normaliseText(candidate.name);
    if (!exactlyEqual(wantedName, candidateName)) return 0;

    const wantedArtists = splitArtists(track.singer);
    const candidateArtists = splitArtists(candidate.singer);
    if (
      wantedArtists.length &&
      (!candidateArtists.length ||
        !wantedArtists.some((artist) =>
          candidateArtists.some((other) => exactlyEqual(artist, other)),
        ))
    ) {
      return 0;
    }

    const wantedSeconds = parseDurationSeconds(track.interval);
    const candidateSeconds = parseDurationSeconds(
      candidate.interval ?? candidate.duration,
    );
    if (requireDuration && wantedSeconds && !candidateSeconds) return 0;
    if (
      wantedSeconds &&
      candidateSeconds &&
      Math.abs(wantedSeconds - candidateSeconds) > DURATION_TOLERANCE_SECONDS
    ) {
      return 0;
    }

    return wantedName === candidateName ? 2 : 1;
  };

  const extractCandidates = (body) => {
    for (const container of [body, body?.data, body?.result]) {
      if (Array.isArray(container?.list)) return container.list;
    }
    return [];
  };

  const extractTrackDetails = (body) => {
    for (const container of [body, body?.data, body?.result]) {
      if (!isRecord(container)) continue;
      const details = {};
      for (const key of ["name", "singer", "interval", "duration"]) {
        if (container[key] !== undefined && container[key] !== null && container[key] !== "") {
          details[key] = container[key];
        }
      }
      if (Object.keys(details).length > 0) return details;
    }
    return {};
  };

  const findMatchingTracks = async (source, track, requestContext = {}) => {
    const { search } = getSourcePolicy(source);
    const primaryArtist = track.singer.split(ARTIST_SEPARATOR)[0].trim();
    const keyword = [track.name, primaryArtist].filter(Boolean).join(" ");
    const body = await requestJson(
      search.endpoint,
      {
        ...search.params,
        [search.keywordParameter]: keyword,
      },
      requestContext,
    );

    const matches = [];
    for (const candidate of extractCandidates(body)) {
      const score = matchScore(track, candidate);
      if (score <= 0 || !isRecord(candidate)) continue;
      const rawId = candidate[search.candidateIdField];
      const id = typeof rawId === "number" ? String(rawId) : textOrEmpty(rawId);
      if (id) matches.push({ candidate, id, score });
    }
    return matches
      .sort((left, right) => right.score - left.score)
      .slice(0, CROSS_PLATFORM_MAX_CANDIDATES)
      .map(({ candidate, id }) => ({ candidate, id }));
  };

  const resolveAcrossPlatforms = async (policy, quality, track, deadline) => {
    const budget = {
      remaining: CROSS_PLATFORM_REQUEST_BUDGET,
      deadline: Math.min(deadline, Date.now() + CROSS_PLATFORM_TIME_BUDGET),
    };
    const requestContext = { budget, deadline };
    let firstRecoverableError;

    const rememberRecoverableError = (error) => {
      if (
        !firstRecoverableError &&
        (isOperationalError(error) || isProviderError(error))
      ) {
        firstRecoverableError = error;
      }
    };

    for (const targetSource of policy.crossPlatform.sources) {
      const targetPolicy = getSourcePolicy(targetSource);
      try {
        const matches = await findMatchingTracks(targetSource, track, requestContext);
        for (const { candidate, id } of matches) {
          try {
            const resolution = await resolveOnPlatform(
              targetSource,
              quality,
              id,
              requestContext,
            );
            const resolvedCandidate = {
              ...candidate,
              ...extractTrackDetails(resolution.body),
            };
            const requireDuration = parseDurationSeconds(track.interval) > 0;
            if (
              targetSource === "tx" &&
              requireDuration &&
              parseDurationSeconds(resolvedCandidate.interval) <= 0
            ) {
              splayer.log.warn(
                `${targetPolicy.name} 候选（${id}）详情缺少有效时长，跳过《${track.name}》。`,
              );
              continue;
            }
            if (matchScore(track, resolvedCandidate, { requireDuration }) <= 0) {
              splayer.log.warn(
                `${targetPolicy.name} 候选（${id}）未通过《${track.name}》的时长校验。`,
              );
              continue;
            }

            splayer.log.info(
              `《${track.name}》在${policy.name}不可用，已改用 ${targetPolicy.name} 播放（${id}）。`,
            );
            return resolution.result;
          } catch (error) {
            if (isResolutionTimeoutError(error)) throw error;
            if (isCrossPlatformLimitError(error)) throw error;
            if (isAccountError(error)) throw error;
            rememberRecoverableError(error);
            splayer.log.warn(
              `${targetPolicy.name} 匹配《${track.name}》失败：${error?.message ?? error}`,
            );
          }
        }
      } catch (error) {
        if (isResolutionTimeoutError(error)) throw error;
        if (isCrossPlatformLimitError(error)) throw error;
        if (isAccountError(error)) throw error;
        rememberRecoverableError(error);
        splayer.log.warn(
          `${targetPolicy.name} 匹配《${track.name}》失败：${error?.message ?? error}`,
        );
      }
    }

    if (budget.remaining <= 0 || budget.deadline - Date.now() <= 0) {
      throw pluginError(
        CROSS_PLATFORM_LIMIT_ERROR,
        "ChKSz 跨平台兜底已达到请求或时间上限。",
      );
    }
    if (firstRecoverableError) throw firstRecoverableError;
    return null;
  };

  const resolve = async ({ source, quality, id, track }) => {
    const { policy } = buildTrackParams(source, id, quality);
    const descriptor = getTrackDescriptor(track);
    const deadline = Date.now() + RESOLUTION_TIME_BUDGET;

    try {
      const resolution = await resolveOnPlatform(source, quality, id, { deadline });
      return resolution.result;
    } catch (error) {
      const canCrossSearch =
        Boolean(policy.crossPlatform) &&
        isUnavailableQualityError(error) &&
        Boolean(descriptor.name) &&
        isCrossPlatformEnabled();
      if (!canCrossSearch) throw error;

      const fallback = await resolveAcrossPlatforms(policy, quality, descriptor, deadline);
      if (fallback) return fallback;

      const platformNames = policy.crossPlatform.sources
        .map((target) => getSourcePolicy(target).name)
        .join("、");
      throw pluginError(
        "CHKSZ_TRACK_UNAVAILABLE",
        `${policy.name}无法提供《${descriptor.name}》的播放地址（${error.message}），且在 ${platformNames} 中未匹配到同一首歌。`,
      );
    }
  };

  return { requestJson, resolve };
};

const resolutionImplementation = createResolutionCore();
const { requestJson } = resolutionImplementation;
const resolutionCore = { resolve: resolutionImplementation.resolve };

const resolveUrl = async ({ source, quality, musicInfo }) => {
  const id = getMusicId(musicInfo);
  return resolutionCore.resolve({ source, quality, id, track: musicInfo });
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

  const cover = extractTextField(body, [
    "cover",
    "coverUrl",
    "pic",
    "picUrl",
    "albumCover",
  ]);
  return { url: /^https?:\/\//i.test(cover) ? cover : "" };
};

const createRuntimeAdapter = (runtime) => ({
  register(metadata) {
    runtime.register(metadata);
  },
  bind({ musicUrl, musicLyric, musicPic }) {
    runtime.on("musicUrl", musicUrl);
    runtime.on("musicLyric", musicLyric);
    runtime.on("musicPic", musicPic);
  },
});
const runtimeAdapter = createRuntimeAdapter(splayer);
runtimeAdapter.register({
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
    {
      key: CROSS_PLATFORM_SETTING,
      type: "switch",
      label: "网易云无版权时改用 QQ 音乐 / 酷狗",
      description:
        "网易云在所有音质都没有播放地址时，按歌名、歌手和时长在 QQ 音乐、酷狗中匹配同一首歌。每次匹配会额外消耗 ChKSz 额度。",
      default: true,
    },
  ],
});
runtimeAdapter.bind({
  musicUrl: resolveUrl,
  musicLyric: getLyric,
  musicPic: getCover,
});
