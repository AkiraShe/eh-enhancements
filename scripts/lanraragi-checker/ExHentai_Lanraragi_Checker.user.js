// ==UserScript==
// @name        ExHentai Lanraragi Checker
// @namespace   https://github.com/Putarku
// @match       https://exhentai.org/*
// @match       https://e-hentai.org/*
// @grant       GM_xmlhttpRequest
// @grant       GM_addStyle
// @grant       GM_getValue
// @grant       GM_setValue
// @grant       GM_registerMenuCommand
// @license MIT
// @version     1.7.3
// @author      Putarku, AkiraShe
// @description Checks if galleries on ExHentai/E-Hentai are already in your Lanraragi library and marks them by inserting a span at the beginning of the title.
// @homepage     https://github.com/AkiraShe/eh-enhancements
// @supportURL   https://github.com/AkiraShe/eh-enhancements/issues
// ==/UserScript==

(function() {
    'use strict';

    // ===== 简繁体转换映射表（在文件末尾初始化） =====
    let S2T_MAP = {};
    let T2S_MAP = {};

    // ===== 缩略图缓存（内存缓存，页面级别） =====
    const thumbnailCache = {};

    // 简体转繁体
    function toTraditional(text) {
        return text.split('').map(char => S2T_MAP[char] || char).join('');
    }

    // 繁体转简体
    function toSimplified(text) {
        return text.split('').map(char => T2S_MAP[char] || char).join('');
    }

    // ===== 原字典内容已移至文件末尾 =====

    // ===== 标记类型常量（必须在所有函数之前定义） =====
    const MARKER_TYPES = {
        FOUND: 'found',           // ✓ 精确匹配
        PARTIAL: 'partial',       // ! 可能匹配
        MULTIPLE: 'multiple',     // ?N 多个匹配
        NOT_FOUND: 'notfound',    // 🔄 未找到
        ERROR: 'error',           // ⚠️ 错误
        SEARCHING: 'searching'    // ⏳ 搜索中（临时）
    };

    // --- 用户配置开始 ---
    // 注意：以下值仅作为备用，优先使用脚本设置界面中保存的值
    const DEFAULT_LRR_SERVER_URL = 'http://localhost:3000'; // 替换为您的 Lanraragi 服务器地址
    const DEFAULT_LRR_API_KEY = ''; // 如果您的 Lanraragi API 需要密钥，请填写
    // --- 用户配置结束 ---

    // 其他配置（可选）
    const DEFAULT_CONFIG = {
        lrrServerUrl: DEFAULT_LRR_SERVER_URL,
        lrrApiKey: DEFAULT_LRR_API_KEY,
        maxConcurrentRequests: 5,
        cacheExpiryDays: 7,
        enableDeepSearch: false,
        cacheNotFoundResults: true,
        deepSearchConcurrency: 3,
        deepSearchDelay: 500,
        // 关键词管理（逗号分隔）
        authorWhitelist: '',
        coreWhitelist: '',
        coreBlacklist: 'AI Generated,Decensored,Patreon,Fanbox,Uncensored,Censored,定制,定製',
        // 页数匹配配置
        enablePagecountMatching: true,
        pagecountTolerance: 5,
        // 标题搜索优先级
        titleSearchOrder: 'gj'  // 'gj' 或 'gn'
    };

    // 加载配置
    function loadConfig() {
        const saved = GM_getValue('lrr_checker_config', null);
        const loaded = saved ? { ...DEFAULT_CONFIG, ...JSON.parse(saved) } : { ...DEFAULT_CONFIG };

        // 兼容旧版字段
        if (!loaded.authorWhitelist && loaded.authorKeywords) {
            loaded.authorWhitelist = loaded.authorKeywords;
        }
        if (!loaded.coreBlacklist && loaded.tagKeywords) {
            loaded.coreBlacklist = loaded.tagKeywords;
        }
        if (loaded.coreWhitelist === undefined) {
            loaded.coreWhitelist = '';
        }
        return loaded;
    }

    // 保存配置
    function saveConfig(config) {
        GM_setValue('lrr_checker_config', JSON.stringify(config));
        console.log('[LRR Checker] 配置已保存:', config);
    }

    // 当前配置
    let CONFIG = loadConfig();
    // 全局停止标志：出现连接/认证失败后，停止后续画廊检索，需刷新页面恢复
    let GLOBAL_STOP_ALL_CHECKS = false;
    // 已显示认证警告的标记，避免重复弹窗
    let AUTH_WARNING_SHOWN = false;
    // 记录是否已判定 Key 失效
    let KEY_INVALID_DETECTED = false;

    // 简单的右上角提示
    function showAuthWarningToast(messageLines) {
        if (AUTH_WARNING_SHOWN) return;
        AUTH_WARNING_SHOWN = true;
        const toast = document.createElement('div');
        toast.id = 'lrr-auth-warning-toast';
        const lines = Array.isArray(messageLines) ? messageLines : [
            'API Key 失效或未配置，当前依赖lrr浏览器登录。',
            '请在设置中更新 API Key。'
        ];
        toast.innerHTML = lines.map(l => `<div>${l}</div>`).join('');
        Object.assign(toast.style, {
            position: 'fixed',
            top: '20px',
            right: '20px',
            zIndex: '99999',
            background: 'rgba(255, 165, 0, 0.95)',
            color: '#111',
            padding: '10px 14px',
            borderRadius: '6px',
            boxShadow: '0 4px 12px rgba(0,0,0,0.25)',
            fontSize: '14px',
            fontWeight: '600',
            cursor: 'pointer'
        });
        toast.onclick = () => toast.remove();
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 8000);
    }

    // ===== 关键词工具函数 =====
    const CORE_SPLIT_RE = /[\s·・\-_:\/\\]+/g;
    const BRACKET_PAIRS = [
        ['\\(', '\\)'],
        ['\\[', '\\]'],
        ['\\{', '\\}'],
        ['（', '）'],
        ['【', '】'],
        ['《', '》'],
        ['「', '」'],
        ['『', '』']
    ];

    function parseKeywordList(str) {
        return str ? str.split(',').map(k => k.trim()).filter(k => k) : [];
    }

    function normalizeKeywordValue(value) {
        return (value || '').toLowerCase().trim();
    }

    function getAuthorKeywordList() {
        return parseKeywordList(CONFIG.authorWhitelist || CONFIG.authorKeywords || '');
    }

    function getCoreWhitelist() {
        return parseKeywordList(CONFIG.coreWhitelist).map(normalizeKeywordValue).filter(Boolean);
    }

    function getCoreBlacklist() {
        return parseKeywordList(CONFIG.coreBlacklist || CONFIG.tagKeywords || '').map(normalizeKeywordValue).filter(Boolean);
    }

    function containsKeyword(text, keywordList) {
        if (!text) return false;
        const normalized = text.toLowerCase();
        return keywordList.some(keyword => keyword && normalized.includes(keyword));
    }

    function stripBracketsPreservingWhitelist(title) {
        let preserved = [];
        let result = title;
        const whitelist = getCoreWhitelist();
        BRACKET_PAIRS.forEach(([open, close]) => {
            const pattern = new RegExp(`${open}([^${close}]*)${close}`, 'g');
            result = result.replace(pattern, (match, inner) => {
                if (!inner) return ' ';
                if (containsKeyword(inner, whitelist)) {
                    preserved.push(inner.trim());
                    return inner;
                }
                return ' ';
            });
        });
        return { text: result, preserved };
    }

    function removeBlacklistedSegments(text) {
        let result = text;
        const blacklist = getCoreBlacklist();
        blacklist.forEach(keyword => {
            if (!keyword) return;
            const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const pattern = new RegExp(escaped, 'gi');
            result = result.replace(pattern, ' ');
        });
        return result;
    }

    function splitCoreTokens(text) {
        return text
            .split(CORE_SPLIT_RE)
            .map(token => token.trim())
            .filter(token => token.length > 0)
            .map(token => token.replace(/^['"“”‘’]+|['"“”‘’]+$/g, ''))
            .filter(Boolean);
    }

    function extractCoreToken(title) {
        // 防御性检查：处理 null/undefined 输入
        if (!title || typeof title !== 'string') {
            console.log(`[LRR Checker] extractCoreToken: Invalid input - ${typeof title}`);
            return null;
        }
        let working = title;
        const whitelist = getCoreWhitelist();
        const blacklist = getCoreBlacklist();
        const whitelistOriginal = parseKeywordList(CONFIG.coreWhitelist);

        const preserved = [];
        const stripped = stripBracketsPreservingWhitelist(working);
        working = stripped.text;
        preserved.push(...stripped.preserved);

        working = removeBlacklistedSegments(working);

        const rawTokens = splitCoreTokens(working);
        const tokens = [...preserved, ...rawTokens];

        const uniqueTokens = [];
        const seen = new Set();
        let numberTokens = []; // 收集数字 token
        tokens.forEach(token => {
            const normalized = normalizeKeywordValue(token);
            if (!normalized) return;
            if (blacklist.includes(normalized)) return;
            if (seen.has(normalized)) return;
            seen.add(normalized);

            // 如果是纯数字，单独收集
            if (/^\d+$/.test(token)) {
                numberTokens.push(token);
            } else {
                uniqueTokens.push(token.trim());
            }
        });

        if (!uniqueTokens.length && !numberTokens.length) {
            const clean = title.replace(/[\[\](){}]/g, ' ').trim();
            return clean ? { token: clean } : null;
        }

        const whitelistHit = uniqueTokens.find(token => containsKeyword(token, whitelist));
        if (whitelistHit) {
            // 组合主 token 和数字 token
            const result = whitelistHit.trim();
            if (numberTokens.length > 0) {
                return { token: result, numberTokens: numberTokens };
            }
            return { token: result };
        }

        // 若用户在白名单文本中使用原大小写，优先返回原文本
        const exactWhitelistHit = uniqueTokens.find(token => whitelistOriginal.some(origin => origin && token.includes(origin)));
        if (exactWhitelistHit) {
            const result = exactWhitelistHit.trim();
            if (numberTokens.length > 0) {
                return { token: result, numberTokens: numberTokens };
            }
            return { token: result };
        }

        const sortedTokens = [...uniqueTokens].sort((a, b) => b.length - a.length);

        // 如果最长的词是通用词（如 Animated, GIFs），尝试组合前两个词
        const candidate = sortedTokens[0];
        const genericWords = ['animated', 'gifs', 'gif', 'images', 'pics', 'pictures', 'art', 'collection'];
        // 防御性检查：candidate 可能是 undefined（当 sortedTokens 为空时）
        const isGeneric = candidate && genericWords.includes(candidate.toLowerCase());

        if (isGeneric && sortedTokens.length > 1) {
            // 组合前两个词
            const combined = sortedTokens.slice(0, 2).join(' ');
            if (numberTokens.length > 0) {
                return { token: combined.trim(), numberTokens: numberTokens };
            }
            return { token: combined.trim() };
        }

        let processedCandidate = candidate;
        if (candidate && /[a-zA-Z]/.test(candidate)) {
            processedCandidate = candidate
                .replace(/(?:[-_+\s]*(?:vol\.?\d+|ch\.?\d+|part\d+))*$/gi, '')
                .replace(/[-_+]+$/g, '')
                .trim();
        }
        const finalToken = processedCandidate || candidate;
        if (finalToken && numberTokens.length > 0) {
            return { token: finalToken.trim(), numberTokens: numberTokens };
        }
        return finalToken ? { token: finalToken.trim() } : null;
    }

    function extractDateToken(text) {
        if (!text) return null;
        const dateRegex = /(\d{4}[\.\-/]\d{1,2}[\.\-/]\d{1,2})/;
        const match = text.match(dateRegex);
        return match ? match[1] : null;
    }

    // 检测文本语言
    function detectTextLanguage(text) {
        if (!text) return 'unknown';
        const hasChinese = /[\u4e00-\u9fa5]/.test(text);
        const hasJapanese = /[\u3040-\u309f\u30a0-\u30ff]/.test(text);
        const hasKorean = /[\uac00-\ud7af]/.test(text);

        if (hasChinese) return 'chinese';
        if (hasJapanese) return 'japanese';
        if (hasKorean) return 'korean';
        return 'other'; // 英文或其他语言
    }

    function normalizeDigits(input) {
        return input ? input.replace(/\D+/g, '') : '';
    }

    // 日期变体（去除分隔符等），用于交叉匹配 2025/11/5 与 2025115 一类标题
    function buildDateVariants(dateToken) {
        if (!dateToken) return [];
        const variants = [];
        const normalized = normalizeDigits(dateToken);
        variants.push(dateToken);
        if (normalized && normalized !== dateToken) variants.push(normalized);
        return [...new Set(variants)].filter(Boolean);
    }

    function buildResultValidator({ dateToken, coreToken }) {
        const normalizedCore = coreToken ? coreToken.toLowerCase() : null;
        const normalizedDate = dateToken ? normalizeDigits(dateToken) : null;
        return (file) => {
            const title = (file.title || '').toLowerCase();
            let ok = true;
            if (normalizedCore) {
                ok = ok && title.includes(normalizedCore);
            }
            if (normalizedDate) {
                ok = ok && normalizeDigits(title).includes(normalizedDate);
            }
            return ok;
        };
    }

    // 便捷访问
    const MAX_CONCURRENT_REQUESTS = CONFIG.maxConcurrentRequests;

    GM_addStyle(`
        .lrr-marker-span {
            font-weight: bold;
            border-radius: 3px;
            padding: 0px 3px;
            margin-right: 4px;
            font-size: 0.9em;
            cursor: pointer;
            position: relative;
            user-select: none;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            min-width: 1.4em;
        }

        .lrr-marker-span::before {
            content: attr(data-icon);
            line-height: 1;
        }

        .lrr-marker-downloaded {
            color: #28a745;
            background-color: #d4edda;
            font-weight: bold;
        }

        .lrr-marker-file {
            color: #6f42c1;
            background-color: #e7d9ff;
            font-weight: bold;
        }

        .lrr-marker-fallback {
            color: #6f42c1;
            background-color: #e7d9ff;
            font-weight: bold;
        }

        .lrr-marker-error {
            color: #dc3545;
            background-color: #fbe9ea;
        }

        .lrr-marker-multiple {
            color: #fd7e14;
            background-color: #fff3cd;
            font-weight: bold;
        }

        .lrr-marker-notfound {
            color: #666;
            background-color: transparent;
            border: 1px solid #999;
            font-size: 12px;
            cursor: pointer;
            padding: 2px 4px;
        }

        .lrr-marker-notfound:hover {
            color: #5c0d12;
            border-color: #5c0d12;
            background-color: #f5f5f5;
        }

        .lrr-marker-searching {
            color: #17a2b8;
            background-color: #d1ecf1;
            animation: pulse 1.5s ease-in-out infinite;
            font-weight: bold;
        }

        @keyframes pulse {
            0%, 100% {
                opacity: 1;
                transform: scale(1);
            }
            50% {
                opacity: 0.7;
                transform: scale(1.05);
            }
        }

        /* 弹出菜单 */
        .lrr-popup-menu {
            position: fixed;
            z-index: 10000;
            background: #edebdf;
            border: 1px solid #5c0d12;
            border-radius: 4px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
            padding: 8px 0;
            width: 280px;
            display: none;
            font-size: 13px;
            line-height: 1.5;
        }

        .lrr-popup-menu.show {
            display: block;
        }

        .lrr-popup-header {
            padding: 6px 12px;
            font-weight: bold;
            border-bottom: 1px solid #c8c4b7;
            margin-bottom: 4px;
            color: #5c0d12;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .lrr-popup-header-text {
            flex: 1;
        }

        .lrr-popup-refresh-btn {
            padding: 4px 8px;
            background: #fff;
            border: 1px solid #5c0d12;
            border-radius: 3px;
            color: #5c0d12;
            font-size: 11px;
            cursor: pointer;
            transition: all 0.2s;
            white-space: nowrap;
            margin-right: 8px;
        }

        .lrr-popup-refresh-btn:hover {
            background: #5c0d12;
            color: #fff;
        }

        .lrr-popup-item {
            padding: 6px 12px;
            cursor: pointer;
            color: #34353b;
            text-decoration: none;
            display: flex;
            align-items: center;
            gap: 10px;
            transition: background 0.15s;
            word-wrap: break-word;
        }

        .lrr-popup-item:hover {
            background: #d5d2ca;
            color: #000;
        }

        .lrr-popup-item-content {
            flex: 1;
            min-width: 0;
        }

        .lrr-popup-item-text {
            display: block;
            word-wrap: break-word;
            white-space: normal;
            line-height: 1.4;
            text-align: left;
        }

        .lrr-popup-item-label {
            font-size: 11px;
            color: #888;
            display: block;
            margin-bottom: 2px;
        }

        .lrr-popup-item-pagecount {
            font-size: 11px;
            color: #666;
            display: block;
            margin-top: 3px;
        }

        .lrr-popup-item-thumbnail {
            width: 80px !important;
            height: 80px !important;
            min-width: 80px;
            min-height: 80px;
            max-width: 80px;
            max-height: 80px;
            object-fit: cover;
            border-radius: 3px;
            border: 1px solid #c8c4b7;
            flex-shrink: 0;
            display: block !important;
            visibility: visible !important;
        }

        .lrr-popup-divider {
            height: 1px;
            background: #c8c4b7;
            margin: 4px 0;
        }

        .lrr-popup-id {
            font-family: monospace;
            font-size: 11px;
            color: #666;
            word-break: break-all;
        }
    `);

    // 注：CACHE_DURATION 和 CLEANUP_INTERVAL 都将在 cleanupExpiredCache 中使用 CONFIG.cacheExpiryDays 来计算
    const CLEANUP_INTERVAL = 1 * 24 * 60 * 60 * 1000; // 1 day cleanup interval

    function getCache(key) {
        const cached = localStorage.getItem(key);
        if (cached) {
            const { timestamp, data } = JSON.parse(cached);
            const cacheExpiryMs = CONFIG.cacheExpiryDays * 24 * 60 * 60 * 1000;
            if (Date.now() - timestamp < cacheExpiryMs) {
                return data;
            }
        }
        return null;
    }

    function setCache(key, data) {
        const item = {
            timestamp: Date.now(),
            data: data
        };
        localStorage.setItem(key, JSON.stringify(item));
    }

    // 清理过期缓存
    function cleanupExpiredCache() {
        const lastCleanup = localStorage.getItem('lrr-cache-last-cleanup');
        const currentTime = Date.now();

        // 如果距离上次清理超过1天，执行清理
        if (!lastCleanup || (currentTime - parseInt(lastCleanup)) > CLEANUP_INTERVAL) {
            console.log('[LRR Checker] Starting cache cleanup...');
            let removedCount = 0;

            // 根据用户设置的缓存有效期计算过期时间
            const cacheExpiryMs = CONFIG.cacheExpiryDays * 24 * 60 * 60 * 1000;

            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key && key.startsWith('lrr-checker-')) {
                    try {
                        const item = localStorage.getItem(key);
                        if (item) {
                            const cacheData = JSON.parse(item);
                            // 删除超过设定有效期的缓存
                            if (currentTime - cacheData.timestamp > cacheExpiryMs) {
                                localStorage.removeItem(key);
                                removedCount++;
                                i--; // 因为删除后数组长度变化
                            }
                        }
                    } catch (e) {
                        console.error(`[LRR Checker] Error cleaning up cache key ${key}:`, e);
                    }
                }
            }

            localStorage.setItem('lrr-cache-last-cleanup', currentTime.toString());
            console.log(`[LRR Checker] Cache cleanup completed. Removed ${removedCount} expired items.`);
        }
    }

    // 将网络请求包装为Promise（使用 GM_xmlhttpRequest）
    function makeRequest(options) {
        return new Promise((resolve, reject) => {
            let timeoutId;
            const timeout = options.timeout || 30000; // 30秒超时
            // 确保 headers 不为 undefined，方便追加认证头
            if (!options.headers) options.headers = {};

            // 允许调用方传入 apiKeyOverride，用于测试连接时无需保存配置
            const effectiveApiKey = (options.apiKeyOverride !== undefined) ? options.apiKeyOverride : CONFIG.lrrApiKey;

            // 若是访问 LRR 且有有效 API Key：附带 Base64 Bearer 头，并冗余携带原始 key 以兼容不同部署
            if (effectiveApiKey && options.url.startsWith(CONFIG.lrrServerUrl)) {
                let encodedKey = effectiveApiKey;
                try {
                    encodedKey = btoa(effectiveApiKey);
                } catch (e) {
                    console.warn('[LRR Checker] btoa 编码 API Key 失败，改用原始值', e);
                }
                options.headers['Authorization'] = `Bearer ${encodedKey}`;
                options.headers['X-API-Key'] = effectiveApiKey; // 某些反代方案使用自定义头
                const sep = options.url.includes('?') ? '&' : '?';
                options.url = `${options.url}${sep}apikey=${encodeURIComponent(effectiveApiKey)}`;
            }

            timeoutId = setTimeout(() => {
                console.warn(`[LRR Checker] Request timeout after ${timeout}ms: ${options.url}`);
                reject(new Error(`Request timeout after ${timeout}ms`));
            }, timeout);

            const requestConfig = {
                method: options.method,
                url: options.url,
                headers: options.headers,
                responseType: 'text',
                // 匿名模式：不携带 Cookie / 认证信息
                anonymous: options.anonymous === true,
                withCredentials: options.anonymous === true ? false : undefined,
                onload: function(response) {
                    clearTimeout(timeoutId);
                    // 认证/跨域排查：打印状态码与响应前200字
                    try {
                        const snippet = (response.responseText || '').slice(0, 200);
                        console.log(`[LRR Checker] HTTP ${response.status} <- ${options.url} bodyHead="${snippet}"`);
                    } catch (e) {
                        console.warn('[LRR Checker] 打印响应失败', e);
                    }
                    // 401 视为认证错误，提示用户；由调用方决定是否停止流程
            if (response.status === 401) {
                const err = new Error('Unauthorized (401)');
                err.isAuthError = true;
                if (!options.suppressAuthToast) {
                    KEY_INVALID_DETECTED = true;
                    showAuthWarningToast();
                }
                reject(err);
                return;
            }
                    // status 0 可能是沙箱限制，但可能仍有 responseText
                    if (response.status === 0 && !response.responseText) {
                        console.warn(`[LRR Checker] Received empty response (status 0, no text)`);
                        reject(new Error('Empty response from server'));
                    } else {
                        resolve(response);
                    }
                },
                onerror: function(error) {
                    clearTimeout(timeoutId);
                    console.debug(`[LRR Checker] Network request error (will retry):`, error.finalUrl);
                    reject(error);
                },
                onabort: function() {
                    clearTimeout(timeoutId);
                    console.warn(`[LRR Checker] Request aborted`);
                    reject(new Error('Request aborted'));
                },
                ontimeout: function() {
                    clearTimeout(timeoutId);
                    console.warn(`[LRR Checker] Request timeout`);
                    reject(new Error('Request timeout'));
                }
            };

            GM_xmlhttpRequest(requestConfig);
        });
    }

    // 限制并发请求数量的函数
    async function processInBatches(items, processFn, batchSize) {
        const results = [];
        for (let i = 0; i < items.length; i += batchSize) {
            const batch = items.slice(i, i + batchSize);
            const batchPromises = batch.map(processFn);
            const batchResults = await Promise.all(batchPromises);
            results.push(...batchResults);
        }
        return results;
    }

    // 收集需要查询的画廊信息
    const markerRegistry = new Map();
    let markerIdCounter = 0;
    let markerDelegatesInitialized = false;

    // 启动时主动验证 API Key（匿名请求，避免登录态掩盖问题）
    (async () => {
        if (!CONFIG.lrrApiKey) return;
        try {
            await makeRequest({
                method: 'GET',
                url: `${CONFIG.lrrServerUrl}/api/search/random?filter=${encodeURIComponent('lrr-key-probe')}`,
                anonymous: true
            });
        } catch (err) {
            if (err?.isAuthError) {
                KEY_INVALID_DETECTED = true;
                showAuthWarningToast();
            }
        }
    })();

    function initMarkerDelegates() {
        if (markerDelegatesInitialized) return;
        markerDelegatesInitialized = true;
        document.addEventListener('mouseover', handleMarkerMouseOver, true);
        document.addEventListener('click', handleMarkerClick, true);
    }

    function registerMarker(markerSpan, options = {}) {
        if (!markerSpan) return;
        initMarkerDelegates();
        if (!markerSpan.dataset.markerId) {
            markerSpan.dataset.markerId = `lrr-marker-${++markerIdCounter}`;
        }
        markerRegistry.set(markerSpan.dataset.markerId, options);
    }

    function cleanupMarker(markerSpan) {
        if (!markerSpan || !markerSpan.dataset.markerId) return;
        markerRegistry.delete(markerSpan.dataset.markerId);
        delete markerSpan.dataset.markerId;
    }

    function getMarkerOptions(markerSpan) {
        if (!markerSpan || !markerSpan.dataset.markerId) return null;
        return markerRegistry.get(markerSpan.dataset.markerId) || null;
    }

    function handleMarkerMouseOver(event) {
        const markerSpan = event.target.closest('.lrr-marker-span');
        if (!markerSpan || event.target !== markerSpan) return;
        const options = getMarkerOptions(markerSpan);
        if (!options) return;
        if (typeof options.onHover === 'function') {
            options.onHover(markerSpan, options);
            return;
        }
        if (typeof options.menuBuilder === 'function') {
            const menuData = options.menuBuilder(markerSpan, options);
            if (menuData) {
                createPopupMenu(markerSpan, menuData);
            }
        } else if (options.menuData) {
            createPopupMenu(markerSpan, options.menuData);
        }
    }

    function handleMarkerClick(event) {
        const markerSpan = event.target.closest('.lrr-marker-span');
        if (!markerSpan || event.target !== markerSpan) return;
        const options = getMarkerOptions(markerSpan);
        if (!options || typeof options.onClick !== 'function') return;
        options.onClick(event, markerSpan, options);
    }

    function collectGalleries() {
        const galleryLinks = document.querySelectorAll('.itg .gl1t a[href*="/g/"]');
        const galleriesToCheck = [];
        const cachedGalleries = [];

        galleryLinks.forEach(linkElement => {
            const galleryUrl = linkElement.href;
            const titleElement = linkElement.querySelector('.glink');

            if (!galleryUrl || !titleElement) {
                return;
            }

            if (titleElement.querySelector('.lrr-marker-span')) {
                return;
            }

            const cacheKey = `lrr-checker-${galleryUrl}`;
            const cachedData = getCache(cacheKey);

            if (cachedData) {
                console.log(`[LRR Checker] Using cached data for: ${galleryUrl}`);
                // 将缓存的画廊也加入处理队列
                cachedGalleries.push({
                    galleryUrl,
                    titleElement,
                    cacheKey,
                    cachedData
                });
                return;
            }

            galleriesToCheck.push({
                galleryUrl,
                titleElement,
                cacheKey
            });
        });

        // 异步并发处理缓存的画廊
        if (cachedGalleries.length > 0) {
            (async () => {
                await processInBatches(
                    cachedGalleries,
                    async (gallery) => {
                        // 缓存数据已经包含最终状态，直接显示而不需要重新处理
                        const { cachedData, titleElement } = gallery;
                        
                        if (cachedData.success === 1) {
                            // 精确匹配
                            console.log(`[LRR Checker] Found from cache: ${gallery.galleryUrl}`);
                            const isExactMatch = cachedData.isExactMatch === true;
                            const archiveId = cachedData.data?.id;
                            const archiveTitle = cachedData.archiveTitle || '加载中...';
                            const archivePagecount = cachedData.archivePagecount || null;
                            
                            const menuBuilder = () => {
                                const readerUrl = `${CONFIG.lrrServerUrl}/reader?id=${archiveId}`;
                                const thumbnailUrl = `${CONFIG.lrrServerUrl}/api/archives/${archiveId}/thumbnail`;
                                return {
                                    header: '已存档',
                                    items: [{
                                        text: archiveTitle,
                                        url: readerUrl,
                                        thumbnailUrl: thumbnailUrl,
                                        pagecount: archivePagecount
                                    }],
                                    refreshCallback: () => {
                                        clearGalleryCache(gallery.galleryUrl, null);
                                        const displayTitle = titleElement.textContent.replace(/\(LRR.*?\)/g, '').trim();
                                        refreshGalleryCheck(gallery.galleryUrl, titleElement, displayTitle);
                                    }
                                };
                            };
                            
                            setFinalMarker(titleElement, {
                                type: isExactMatch ? MARKER_TYPES.FOUND : MARKER_TYPES.PARTIAL,
                                icon: isExactMatch ? '✓' : '!',
                                label: isExactMatch ? 'LRR已收录' : 'LRR可能有匹配',
                                className: isExactMatch ? 'lrr-marker-downloaded' : 'lrr-marker-file',
                                menuBuilder: menuBuilder
                            });
                        } else if (cachedData.success === 0 && cachedData.count > 0) {
                            // 多个或单个备选结果
                            console.log(`[LRR Checker] ${cachedData.count} fallback result(s) from cache: ${gallery.galleryUrl}`);
                            if (cachedData.count === 1) {
                                // 单个备选
                                const fallbackFile = cachedData.files[0];
                                setFinalMarker(titleElement, {
                                    type: MARKER_TYPES.PARTIAL,
                                    icon: '!',
                                    label: 'LRR找到可能匹配（页数不完全符合）',
                                    className: 'lrr-marker-file',
                                    menuBuilder: () => ({
                                        header: '可能匹配',
                                        items: [{
                                            text: fallbackFile.title,
                                            url: `${CONFIG.lrrServerUrl}/reader?id=${fallbackFile.arcid}`,
                                            thumbnailUrl: `${CONFIG.lrrServerUrl}/api/archives/${fallbackFile.arcid}/thumbnail`,
                                            pagecount: fallbackFile.pagecount
                                        }]
                                    })
                                });
                            } else {
                                // 多个备选
                                setFinalMarker(titleElement, {
                                    type: MARKER_TYPES.MULTIPLE,
                                    icon: `?${cachedData.count}`,
                                    label: `LRR发现${cachedData.count}个可能匹配`,
                                    className: 'lrr-marker-multiple',
                                    menuBuilder: () => {
                                        const items = [];
                                        cachedData.files.forEach((file, index) => {
                                            if (index > 0) items.push({ divider: true });
                                            items.push({
                                                text: `${index + 1}. ${file.title}`,
                                                url: `${CONFIG.lrrServerUrl}/reader?id=${file.arcid}`,
                                                thumbnailUrl: `${CONFIG.lrrServerUrl}/api/archives/${file.arcid}/thumbnail`,
                                                pagecount: file.pagecount
                                            });
                                        });
                                        return { 
                                            header: `找到 ${cachedData.count} 个可能的匹配`, 
                                            items,
                                            refreshCallback: () => {
                                                clearGalleryCache(gallery.galleryUrl, null);
                                                const displayTitle = titleElement.textContent.replace(/\(LRR.*?\)/g, '').trim();
                                                refreshGalleryCheck(gallery.galleryUrl, titleElement, displayTitle);
                                            }
                                        };
                                    }
                                });
                            }
                        } else if (cachedData.isNetworkError === true) {
                            // 网络错误
                            console.log(`[LRR Checker] Network error from cache: ${gallery.galleryUrl}`);
                            setFinalMarker(titleElement, {
                                type: MARKER_TYPES.ERROR,
                                icon: '⚠️',
                                label: 'LRR连接失败',
                                className: 'lrr-marker-error',
                                onClick: (e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    clearGalleryCache(gallery.galleryUrl, '');
                                    const displayTitle = titleElement.textContent.replace(/\(LRR.*?\)/g, '').trim();
                                    refreshGalleryCheck(gallery.galleryUrl, titleElement, displayTitle);
                                }
                            });
                        } else {
                            // 未找到
                            console.log(`[LRR Checker] Not found from cache: ${gallery.galleryUrl}`);
                            setFinalMarker(titleElement, {
                                type: MARKER_TYPES.NOT_FOUND,
                                icon: '🔄',
                                label: 'LRR未找到',
                                className: 'lrr-marker-notfound',
                                onClick: (e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    clearGalleryCache(gallery.galleryUrl, null);
                                    const displayTitle = titleElement.textContent.replace(/\(LRR.*?\)/g, '').trim();
                                    refreshGalleryCheck(gallery.galleryUrl, titleElement, displayTitle);
                                }
                            });
                        }
                        return { success: true, galleryUrl: gallery.galleryUrl };
                    },
                    MAX_CONCURRENT_REQUESTS
                );
            })();
        }

        return galleriesToCheck;
    }

    // 初始收集
    let galleriesToCheck = collectGalleries();

    // 处理单个画廊的查询
    // 通过 gid/token 进行精确搜索（使用 source tag 格式）
    async function searchByGidToken(gid, token) {
        try {
            // 使用 source tag 中的原文片段格式进行搜索
            // 用引号包裹以进行短语搜索，避免分词后的模糊匹配
            const searchQuery = `"g/${gid}/${token}"`;
            console.log(`[LRR Checker] 尝试 gid/token 搜索: ${searchQuery}`);

            const headers = {};
            if (CONFIG.lrrApiKey) {
                headers['Authorization'] = `Bearer ${CONFIG.lrrApiKey}`;
            }

            let encodedQuery;
            try {
                encodedQuery = encodeURIComponent(searchQuery);
            } catch (err) {
                console.warn(`[LRR Checker] encodeURIComponent 失败，使用原始 query:`, err);
                // 回退方案：使用 encodeURI（较宽松的编码）
                try {
                    encodedQuery = encodeURI(searchQuery);
                } catch (err2) {
                    console.warn(`[LRR Checker] encodeURI 也失败，使用原始字符串`);
                    encodedQuery = searchQuery;
                }
            }

            const response = await makeRequest({
                method: 'GET',
                url: `${CONFIG.lrrServerUrl}/api/search/random?filter=${encodedQuery}`,
                headers: headers
            });

            const result = JSON.parse(response.responseText);

            if (result.data && result.data.length > 0) {
                console.log(`[LRR Checker] gid/token 搜索找到 ${result.data.length} 个结果`);
                // 调试：打印返回的结果列表
                result.data.forEach((file, index) => {
                    console.log(`[LRR Checker] 结果 ${index + 1}: ${file.title || file.filename}`);
                });
                return {
                    success: result.data.length === 1,
                    count: result.data.length,
                    files: result.data,
                    method: 'gidtoken'
                };
            } else {
                console.log(`[LRR Checker] gid/token 搜索无结果`);
                return { success: false, count: 0, method: 'gidtoken' };
            }
        } catch (err) {
            console.warn(`[LRR Checker] gid/token 搜索失败:`, err);
            // 标记为网络错误，让脚本知道应该停止后续搜索
            return { success: false, count: 0, method: 'gidtoken', isNetworkError: true };
        }
    }

    async function processGallery(gallery) {
        const { galleryUrl, titleElement, cacheKey } = gallery;
        // 若先前已出现网络/认证致命错误，直接跳过，避免继续请求
        if (GLOBAL_STOP_ALL_CHECKS) {
            console.log('[LRR Checker] Global stop flag set, skipping gallery:', galleryUrl);
            setFinalMarker(titleElement, {
                type: MARKER_TYPES.ERROR,
                icon: '⚠️',
                label: 'LRR连接失败（已停止）',
                className: 'lrr-marker-error'
            });
            return { success: false, galleryUrl, method: 'skipped', isNetworkError: true };
        }

        const headers = {};
        if (CONFIG.lrrApiKey) {
            headers['Authorization'] = `Bearer ${CONFIG.lrrApiKey}`;
        }

        // 在搜索开始时显示⏳标记，一次性显示，中间不改变
        setSearchingMarker(titleElement);

        try {
            // 提前提取页数，避免后续重复提取
            const ehPagecount = extractEhPagecount(titleElement);
            console.log(`[LRR Checker] 页数预提取: ${ehPagecount ? ehPagecount + '页' : '未找到'}`);

            // 优先级 1: gid/token 搜索（通过 source tag 内容精确查询）
            const gidTokenMatch = galleryUrl.match(/\/g\/(\d+)\/([a-f0-9]+)/);
            if (gidTokenMatch) {
                console.log(`[LRR Checker] Step 1: 尝试 gid/token 搜索`);
                const gidTokenResult = await searchByGidToken(gidTokenMatch[1], gidTokenMatch[2]);

                if (gidTokenResult.success && gidTokenResult.count === 1) {
                    console.log(`[LRR Checker] ✓ gid/token 搜索成功找到精确匹配`);
                    const result = { success: 1, data: { id: gidTokenResult.files[0].arcid }, method: 'gidtoken', isExactMatch: true };
                    setCache(cacheKey, result);
                    await handleResponse(result, titleElement, galleryUrl, [], cacheKey);
                    return { success: true, galleryUrl, method: 'gidtoken' };
                } else if (gidTokenResult.isNetworkError === true) {
                    // 第 1 层网络错误，立即停止不继续后续搜索
                    console.log(`[LRR Checker] gid/token 搜索网络错误，停止后续搜索`);
                    const result = { success: 0, isNetworkError: true };
                    // 网络错误不缓存，每次都重新检测
                    await handleResponse(result, titleElement, galleryUrl, [], cacheKey);
                    return { success: false, galleryUrl, method: 'gidtoken' };
                } else {
                    console.log(`[LRR Checker] gid/token 搜索未找到，继续标题搜索`);
                }
            }

            // 优先级 2: 完整标题搜索（第一阶段保险搜索）
            console.log(`[LRR Checker] Step 2: 尝试完整标题搜索`);
            
            // 获取完整标题（从画廊详情页提取 #gn 和 #gj）
            const titles = await fetchGalleryTitles(galleryUrl);
            if (!titles || (!titles.gn && !titles.gj)) {
                console.log(`[LRR Checker] Failed to fetch titles from detail page`);
                // 检查是否是网络错误
                const isNetworkError = titles && titles.isNetworkError === true;
                const result = { success: 0, isNetworkError };
                // 网络错误不缓存，每次都重新检测
                if (!isNetworkError) {
                    setCache(cacheKey, result);
                }
                await handleResponse(result, titleElement, galleryUrl, [], cacheKey);
                return { success: false, galleryUrl, method: 'none' };
            }
            
            // 决定使用哪个标题作为"完整标题搜索"的候选
            const shouldSearchGnFirst = CONFIG.titleSearchOrder !== 'gj';
            const primaryTitle = shouldSearchGnFirst ? titles.gn : titles.gj;
            const secondaryTitle = shouldSearchGnFirst ? titles.gj : titles.gn;
            
            // 阶段 1：完整标题搜索
            const fullTitleToSearch = primaryTitle ? primaryTitle.replace(/\s+/g, ' ').trim() : null;
            let fullTitleResult = null;
            
            // 缓存页数信息到 titleElement 供后续搜索使用（页数已在前面提取过）
            if (ehPagecount !== null && titleElement) {
                titleElement.dataset.ehPagecount = ehPagecount;
                console.log(`[LRR Checker] 缓存页数到 titleElement: ${ehPagecount}`);
            }
            
            if (fullTitleToSearch) {
                console.log(`[LRR Checker] Step 2a: Trying full title search (Phase 1 insurance): ${fullTitleToSearch}`);
                
                // 创建页数 validator（如果启用了页数匹配）
                let pagecountValidator = null;
                if (CONFIG.enablePagecountMatching && ehPagecount !== null) {
                    pagecountValidator = createPagecountValidator(ehPagecount, CONFIG.pagecountTolerance);
                    console.log(`[LRR Checker] Step 2a: 页数验证已启用，e-hentai页数=${ehPagecount}, 误差范围=±${CONFIG.pagecountTolerance}`);
                }
                
                fullTitleResult = await performAlternativeSearch(fullTitleToSearch, titleElement, galleryUrl, { 
                    skipCache: true,
                    validator: pagecountValidator 
                });
                
                if (fullTitleResult.success && fullTitleResult.count === 1) {
                    console.log(`[LRR Checker] ✓ 完整${shouldSearchGnFirst ? '#gn' : '#gj'}标题搜索成功（标题+页数匹配）`);
                    const result = { success: 1, data: { id: fullTitleResult.files[0].arcid }, method: 'full-title', isExactMatch: false };
                    setCache(cacheKey, result);
                    await handleResponse(result, titleElement, galleryUrl, [], cacheKey);
                    return { success: true, galleryUrl, method: 'full-title' };
                }
            }
            
            // 如果优先标题搜索失败，尝试次优先标题（完整）
            const secondaryTitleToSearch = secondaryTitle ? secondaryTitle.replace(/\s+/g, ' ').trim() : null;
            if (secondaryTitleToSearch && secondaryTitleToSearch !== fullTitleToSearch) {
                console.log(`[LRR Checker] Step 2b: Trying secondary full title search: ${secondaryTitleToSearch}`);
                
                // 创建页数 validator（如果启用了页数匹配）
                let secondaryPagecountValidator = null;
                if (CONFIG.enablePagecountMatching && ehPagecount !== null) {
                    secondaryPagecountValidator = createPagecountValidator(ehPagecount, CONFIG.pagecountTolerance);
                    console.log(`[LRR Checker] Step 2b: 页数验证已启用，e-hentai页数=${ehPagecount}, 误差范围=±${CONFIG.pagecountTolerance}`);
                }
                
                const secondaryResult = await performAlternativeSearch(secondaryTitleToSearch, titleElement, galleryUrl, { 
                    skipCache: true,
                    validator: secondaryPagecountValidator 
                });
                
                if (secondaryResult.success && secondaryResult.count === 1) {
                    console.log(`[LRR Checker] ✓ 完整${shouldSearchGnFirst ? '#gj' : '#gn'}标题搜索成功（标题+页数匹配）`);
                    const result = { success: 1, data: { id: secondaryResult.files[0].arcid }, method: 'full-title', isExactMatch: false };
                    setCache(cacheKey, result);
                    await handleResponse(result, titleElement, galleryUrl, [], cacheKey);
                    return { success: true, galleryUrl, method: 'full-title' };
                }
            }
            
            // 如果两个完整标题都搜索失败，触发第 3 层（深度搜索）
            console.log(`[LRR Checker] Step 2 完成，完整标题搜索失败，准备进入Step 3深度搜索`);
            const result = { success: 0 };
            setCache(cacheKey, result);
            await handleResponse(result, titleElement, galleryUrl, [], cacheKey);
            return { success: false, galleryUrl, method: 'none' };

        } catch (error) {
            console.error(`[LRR Checker] Error checking ${galleryUrl}:`, error);
            setFinalMarker(titleElement, {
                type: MARKER_TYPES.ERROR,
                icon: '⚠',
                label: 'LRR检查出错',
                className: 'lrr-marker-error',
                onClick: (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    clearGalleryCache(galleryUrl, null);
                    const displayTitle = titleElement.textContent.replace(/\(LRR.*?\)/g, '').trim();
                    refreshGalleryCheck(galleryUrl, titleElement, displayTitle);
                }
            });
            return { success: false, galleryUrl, error };
        }
    }

    // 执行缓存清理
    cleanupExpiredCache();

    // 处理画廊列表的函数
    function processGalleries(galleries) {
        if (galleries.length > 0) {
            console.log(`[LRR Checker] Processing ${galleries.length} galleries in parallel batches`);
            processInBatches(galleries, processGallery, MAX_CONCURRENT_REQUESTS)
                .then(results => {
                    console.log(`[LRR Checker] Completed all gallery checks. Success: ${results.filter(r => r.success).length}, Failed: ${results.filter(r => !r.success).length}`);
                })
                .catch(error => {
                    console.error(`[LRR Checker] Error in batch processing:`, error);
                });
        }
    }

    // 并行处理所有画廊查询，限制并发数
    processGalleries(galleriesToCheck);

    // 监听 DOM 变化，处理动态添加的内容（适配无限滚动等功能）
    const observer = new MutationObserver((mutations) => {
        let hasNewGalleries = false;

        for (const mutation of mutations) {
            if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
                for (const node of mutation.addedNodes) {
                    // 检查是否是画廊容器或包含画廊的节点
                    if (node.nodeType === Node.ELEMENT_NODE) {
                        if (node.classList && (node.classList.contains('gl1t') || node.querySelector('.gl1t'))) {
                            hasNewGalleries = true;
                            break;
                        }
                    }
                }
            }
            if (hasNewGalleries) break;
        }

        if (hasNewGalleries) {
            console.log('[LRR Checker] Detected new galleries added to DOM, processing...');
            const newGalleries = collectGalleries();
            processGalleries(newGalleries);
        }
    });

    // 开始监听，选择合适的容器
    const targetNode = document.querySelector('.itg') || document.body;
    if (targetNode) {
        observer.observe(targetNode, {
            childList: true,
            subtree: true
        });
        console.log('[LRR Checker] MutationObserver initialized, monitoring for dynamic content');
    }

    // 创建弹出菜单
    function createPopupMenu(markerSpan, menuData) {
        // 移除已存在的菜单
        const existingMenu = document.querySelector('.lrr-popup-menu');
        if (existingMenu) {
            existingMenu.remove();
        }

        const menu = document.createElement('div');
        menu.className = 'lrr-popup-menu';

        // 添加标题和刷新按钮
        if (menuData.header) {
            const header = document.createElement('div');
            header.className = 'lrr-popup-header';

            // 添加刷新按钮到标题行（左侧）
            if (menuData.refreshCallback) {
                const refreshBtn = document.createElement('button');
                refreshBtn.className = 'lrr-popup-refresh-btn';
                refreshBtn.textContent = '🔄';
                refreshBtn.title = '刷新缓存';
                refreshBtn.onclick = (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    menu.remove();
                    menuData.refreshCallback();
                };
                header.appendChild(refreshBtn);
            }

            const headerText = document.createElement('span');
            headerText.className = 'lrr-popup-header-text';
            headerText.textContent = menuData.header;
            header.appendChild(headerText);

            menu.appendChild(header);
        }

        // 添加菜单项
        if (menuData.items && menuData.items.length > 0) {
            menuData.items.forEach((item, index) => {
                if (item.divider) {
                    const divider = document.createElement('div');
                    divider.className = 'lrr-popup-divider';
                    menu.appendChild(divider);
                } else {
                    const menuItem = document.createElement('a');
                    menuItem.className = 'lrr-popup-item';
                    menuItem.href = item.url;
                    menuItem.target = '_blank';
                    menuItem.onclick = (e) => {
                        e.stopPropagation();
                        menu.remove();
                    };

                    // 添加缩略图（如果有）
                    if (item.thumbnailUrl) {
                    const img = document.createElement('img');
                    img.className = 'lrr-popup-item-thumbnail';

                    if (item.thumbnailData) {
                        // 如果已经有 Base64 数据，直接使用
                        img.src = item.thumbnailData;
                    } else {
                        // 显示加载占位符（使用灰色方块避免 Mixed Content）
                        img.src = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iODAiIGhlaWdodD0iODAiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PHJlY3Qgd2lkdGg9IjgwIiBoZWlnaHQ9IjgwIiBmaWxsPSIjZGRkIi8+PHRleHQgeD0iNTAlIiB5PSI1MCUiIGZvbnQtZmFtaWx5PSJBcmlhbCIgZm9udC1zaXplPSIxMiIgZmlsbD0iIzk5OSIgdGV4dC1hbmNob3I9Im1pZGRsZSIgZHk9Ii4zZW0iPuWKoOi9veS4rS4uLjwvdGV4dD48L3N2Zz4=';

                        // 异步加载缩略图（从 thumbnailUrl 中提取 archiveId）
                        const archiveIdMatch = item.thumbnailUrl ? item.thumbnailUrl.match(/\/archives\/([^/]+)\//) : null;
                        const archiveId = archiveIdMatch ? archiveIdMatch[1] : null;
                        fetchThumbnail(item.thumbnailUrl, archiveId).then(dataUrl => {
                            if (dataUrl) {
                                console.log(`[LRR Checker] Updating img.src with base64 data, length: ${dataUrl.length}`);
                                console.log(`[LRR Checker] Data URL starts with:`, dataUrl.substring(0, 50));

                                // 测试图片是否能加载
                                const testImg = new Image();
                                testImg.onload = () => {
                                    console.log(`[LRR Checker] Test image loaded successfully! Size: ${testImg.width}x${testImg.height}`);
                                    img.src = dataUrl;
                                };
                                testImg.onerror = (e) => {
                                    console.error(`[LRR Checker] Test image failed to load:`, e);
                                    console.log(`[LRR Checker] Trying to set anyway...`);
                                    img.src = dataUrl;
                                };
                                testImg.src = dataUrl;
                            } else {
                                console.log(`[LRR Checker] fetchThumbnail returned null`);
                            }
                        }).catch(error => {
                            console.error(`[LRR Checker] Error in fetchThumbnail promise:`, error);
                        });
                    }

                    menuItem.appendChild(img);
                }

                const content = document.createElement('div');
                content.className = 'lrr-popup-item-content';

                if (item.label) {
                    const label = document.createElement('span');
                    label.className = 'lrr-popup-item-label';
                    label.textContent = item.label;
                    content.appendChild(label);
                }

                const text = document.createElement('span');
                text.className = 'lrr-popup-item-text';
                text.textContent = item.text;
                if (item.isId) {
                    text.classList.add('lrr-popup-id');
                }
                content.appendChild(text);

                // 添加页数信息
                if (item.pagecount) {
                    const pagecount = document.createElement('span');
                    pagecount.className = 'lrr-popup-item-pagecount';
                    pagecount.textContent = `📄 ${item.pagecount} 页`;
                    content.appendChild(pagecount);
                }

                    menuItem.appendChild(content);
                    menu.appendChild(menuItem);
                }
            });
        }

        document.body.appendChild(menu);

        // 定位菜单函数
        const positionMenu = () => {
            if (!document.body.contains(markerSpan)) {
                menu.remove();
                return;
            }

            const rect = markerSpan.getBoundingClientRect();
            const menuWidth = menu.offsetWidth;
            const menuHeight = menu.offsetHeight;

            // 左对齐标记
            let left = rect.left;

            // 确保不超出右边界
            if (left + menuWidth > window.innerWidth - 10) {
                left = window.innerWidth - menuWidth - 10;
            }
            // 确保不超出左边界
            if (left < 10) {
                left = 10;
            }

            // 在标记上方显示
            let top = rect.top - menuHeight - 5;

            // 如果上方空间不够，显示在下方
            if (top < 10) {
                top = rect.bottom + 5;
            }

            menu.style.left = left + 'px';
            menu.style.top = top + 'px';
        };

        // 初始定位
        menu.style.visibility = 'hidden';
        menu.style.display = 'block';

        requestAnimationFrame(() => {
            positionMenu();
            menu.style.visibility = 'visible';
            menu.classList.add('show');
        });

        // 监听滚动和窗口大小变化，重新定位
        const handleScroll = () => positionMenu();
        const handleResize = () => positionMenu();

        window.addEventListener('scroll', handleScroll, { passive: true });
        window.addEventListener('resize', handleResize);

        // 鼠标离开标记和菜单时关闭
        let hideTimer = null;
        const startHideTimer = () => {
            hideTimer = setTimeout(() => {
                menu.remove();
                window.removeEventListener('scroll', handleScroll);
                window.removeEventListener('resize', handleResize);
            }, 300);
        };

        const cancelHideTimer = () => {
            if (hideTimer) {
                clearTimeout(hideTimer);
                hideTimer = null;
            }
        };

        markerSpan.addEventListener('mouseleave', startHideTimer);
        menu.addEventListener('mouseenter', cancelHideTimer);
        menu.addEventListener('mouseleave', startHideTimer);
    }

    // 获取缩略图（使用 GM_xmlhttpRequest 带认证）
    async function fetchThumbnail(thumbnailUrl, archiveId) {
        // 检查缓存
        if (archiveId && thumbnailCache[archiveId]) {
            console.log(`[LRR Checker] Using cached thumbnail for: ${archiveId}`);
            return thumbnailCache[archiveId];
        }

        console.log(`[LRR Checker] Fetching thumbnail: ${thumbnailUrl}`);

        return new Promise((resolve) => {
            // 构造认证头：与 makeRequest 保持一致，Bearer 采用 base64，额外带 X-API-Key
            const headers = {};
            if (CONFIG.lrrApiKey) {
                let encodedKey = CONFIG.lrrApiKey;
                try {
                    encodedKey = btoa(CONFIG.lrrApiKey);
                } catch (e) {
                    console.warn('[LRR Checker] btoa 编码 API Key 失败（thumbnail），改用原始值', e);
                }
                headers['Authorization'] = `Bearer ${encodedKey}`;
                headers['X-API-Key'] = CONFIG.lrrApiKey;
                // 在 URL 上追加 apikey 查询参数
                const sep = thumbnailUrl.includes('?') ? '&' : '?';
                thumbnailUrl = `${thumbnailUrl}${sep}apikey=${encodeURIComponent(CONFIG.lrrApiKey)}`;
            }

            GM_xmlhttpRequest({
                method: 'GET',
                url: thumbnailUrl,
                headers,
                responseType: 'arraybuffer',
                onload: (response) => {
                    try {
                        console.log(`[LRR Checker] Thumbnail response received (HTTP ${response.status})`);

                        // 将 ArrayBuffer 转换为 Base64
                        const bytes = new Uint8Array(response.response);
                        console.log(`[LRR Checker] Got ${bytes.length} bytes`);
                        // 若返回的是错误JSON或HTML（通常首字节为 { 或 < ），直接放弃
                        if (bytes.length === 0 || bytes[0] === 123 || bytes[0] === 60) {
                            let head = '';
                            try { head = new TextDecoder().decode(bytes.slice(0, 120)); } catch (e) {}
                            console.warn('[LRR Checker] Thumbnail response looks like non-image, skipping; head=', head);
                            resolve(null);
                            return;
                        }

                        // 创建 Blob
                        const blob = new Blob([bytes], { type: 'image/jpeg' });

                        // 使用 FileReader 转换为 Data URL
                        const reader = new FileReader();
                        reader.onloadend = () => {
                            console.log(`[LRR Checker] Thumbnail converted to base64 successfully`);
                            const dataUrl = reader.result;
                            // 缓存结果
                            if (archiveId) {
                                thumbnailCache[archiveId] = dataUrl;
                                console.log(`[LRR Checker] Thumbnail cached for: ${archiveId}`);
                            }
                            resolve(dataUrl);
                        };
                        reader.onerror = () => {
                            console.error('[LRR Checker] Error converting thumbnail to base64');
                            resolve(null);
                        };
                        reader.readAsDataURL(blob);
                    } catch (error) {
                        console.error(`[LRR Checker] Error processing thumbnail:`, error);
                        resolve(null);
                    }
                },
                onerror: (error) => {
                    console.error(`[LRR Checker] Error fetching thumbnail:`, error);
                    resolve(null);
                }
            });
        });
    }

    // 获取存档详细信息
    async function fetchArchiveInfo(archiveId) {
        const apiUrl = `${CONFIG.lrrServerUrl}/api/archives/${archiveId}/metadata`;
        const headers = {};
        if (CONFIG.lrrApiKey) {
            headers['Authorization'] = `Bearer ${CONFIG.lrrApiKey}`;
        }

        try {
            const response = await makeRequest({
                method: 'GET',
                url: apiUrl,
                headers: headers
            });

            const archiveData = JSON.parse(response.responseText);
            console.log(`[LRR Checker] Fetched archive info for ${archiveId}:`, archiveData);
            return archiveData;
        } catch (error) {
            console.error(`[LRR Checker] Error fetching archive info for ${archiveId}:`, error);
            return null;
        }
    }

    // 将备用搜索也改为Promise方式
    // 从 e-hentai 搜索页面提取画廊页数
    function extractEhPagecount(titleElement) {
        if (!titleElement) {
            console.log('[LRR Checker] extractEhPagecount: titleElement 为空');
            return null;
        }

        // 向上查找到 .gl1t 容器（搜索结果条目的根）
        let gl1tElement = titleElement;
        while (gl1tElement && !gl1tElement.classList?.contains?.('gl1t')) {
            gl1tElement = gl1tElement.parentElement;
        }

        if (!gl1tElement) {
            console.log('[LRR Checker] extractEhPagecount: 未找到 .gl1t 容器');
            return null;
        }

        // 在 .gl1t 内找到 .gl5t 子元素
        const gl5tElement = gl1tElement.querySelector('.gl5t');
        if (!gl5tElement) {
            console.log('[LRR Checker] extractEhPagecount: 未找到 .gl5t 子元素');
            return null;
        }

        console.log('[LRR Checker] extractEhPagecount: 找到 .gl5t 容器，开始查找页数...');

        // 查找页数文本 "50 pages" 的 div
        // 结构: .gl5t > div > div (第二个 div 包含页数)
        const allDivs = gl5tElement.querySelectorAll(':scope > div > div');
        console.log(`[LRR Checker] extractEhPagecount: 在 .gl5t 中检查 ${allDivs.length} 个 div 元素`);

        // 优化：使用 find() 查找第一个匹配的元素，找到即停止
        const pagecountDiv = Array.from(allDivs).find(div => {
            const text = div.textContent.trim();
            // 查找格式为 "50 pages" 或 "50 page" 或 "50 页" 的文本
            return /^\d+\s+(pages?|页)$/i.test(text);
        });

        if (pagecountDiv) {
            const match = pagecountDiv.textContent.trim().match(/(\d+)\s+(pages?|页)/i);
            if (match) {
                const pagecount = parseInt(match[1], 10);
                console.log(`[LRR Checker] extractEhPagecount: 找到页数 ${pagecount}`);
                return pagecount;
            }
        }

        console.log('[LRR Checker] extractEhPagecount: 未找到页数信息');
        return null;
    }

    // 创建页数匹配 validator
    function createPagecountValidator(ehPagecount, tolerance) {
        if (ehPagecount === null || ehPagecount === undefined || tolerance === null || tolerance === undefined) {
            console.log(`[LRR Checker] createPagecountValidator: 参数无效 (pagecount=${ehPagecount}, tolerance=${tolerance})`);
            return null;
        }

        console.log(`[LRR Checker] createPagecountValidator: 创建 validator，e-hentai页数=${ehPagecount}, 误差范围=±${tolerance}`);

        return (file) => {
            if (!file || !file.pagecount) {
                console.log(`[LRR Checker] pagecount validator: 跳过（无页数数据）`);
                return true; // 无页数数据时不过滤
            }
            const diff = Math.abs(file.pagecount - ehPagecount);
            const pass = diff <= tolerance;
            console.log(`[LRR Checker] pagecount validator: "${file.title}" - ${file.pagecount}页 vs ${ehPagecount}页, 差值=${diff}, 结果=${pass ? '通过' : '过滤'}`);
            return pass;
        };
    }

    async function performAlternativeSearch(searchQuery, titleElement, galleryUrl, options = {}) {
        const normalizedOptions = typeof options === 'boolean' ? { skipCache: options } : options;
        let {
            skipCache = false,
            disableStore = false,
            precision = 'normal',
            validator = null
        } = normalizedOptions;

        // 页数匹配：如果启用，则创建页数 validator
        // 注意：页数已在 processGallery() 中预先提取过，这里检查是否需要重新提取
        let pagecountValidator = null;
        if (CONFIG.enablePagecountMatching) {
            console.log('[LRR Checker] performAlternativeSearch: 页数匹配已启用');
            // 由于页数已在 processGallery() 中预提取，这里只在必要时重新提取（深度搜索）
            let ehPagecount = null;
            
            // 尝试从 titleElement 获取已缓存的页数（通过 data 属性）
            if (titleElement && titleElement.dataset && titleElement.dataset.ehPagecount) {
                ehPagecount = parseInt(titleElement.dataset.ehPagecount, 10);
                console.log(`[LRR Checker] 使用已缓存的页数: ${ehPagecount}`);
            } else {
                // 如果没有缓存，则重新提取（通常只在深度搜索时发生）
                ehPagecount = extractEhPagecount(titleElement);
                if (ehPagecount !== null && titleElement) {
                    titleElement.dataset.ehPagecount = ehPagecount;
                }
            }
            
            if (ehPagecount !== null) {
                pagecountValidator = createPagecountValidator(ehPagecount, CONFIG.pagecountTolerance);
                console.log(`[LRR Checker] performAlternativeSearch: 页数 validator 已创建`);
            } else {
                console.log('[LRR Checker] performAlternativeSearch: 未能提取到页数');
            }
        } else {
            console.log('[LRR Checker] performAlternativeSearch: 页数匹配已禁用');
        }

        // 如果有页数 validator，与现有 validator 组合
        if (pagecountValidator) {
            console.log('[LRR Checker] performAlternativeSearch: 应用页数 validator');
            const originalValidator = validator;
            validator = (file) => {
                // 页数 validator 必须通过
                if (!pagecountValidator(file)) {
                    console.log(`[LRR Checker] combined validator: 页数过滤不通过 "${file.title}"`);
                    return false;
                }
                // 如果还有其他 validator，也要通过
                if (originalValidator && !originalValidator(file)) {
                    console.log(`[LRR Checker] combined validator: 其他过滤不通过 "${file.title}"`);
                    return false;
                }
                console.log(`[LRR Checker] combined validator: 全部通过 "${file.title}"`);
                return true;
            };
        } else if (validator) {
            console.log('[LRR Checker] performAlternativeSearch: 无页数 validator，仅使用其他过滤');
        }

        // 确保搜索标记存在（防止被其他脚本移除）
        ensureSearchingMarker(titleElement);

        // 先检查搜索缓存（除非明确跳过）
        const cachedResult = !skipCache ? getCachedSearchResult(searchQuery) : null;
        if (cachedResult) {
            if (cachedResult.success && cachedResult.count > 0) {
                console.log(`[LRR Checker] Using cached search result for: ${searchQuery}`);
                // 使用缓存的结果，但仍需创建标记
                let matchedFiles = cachedResult.files;
                let matchCount = cachedResult.count;

                // 重新应用 validator（如果存在）
                if (validator) {
                    console.log(`[LRR Checker] 对缓存结果应用 validator，缓存数: ${matchCount}`);
                    const validated = matchedFiles.filter(file => validator(file));
                    console.log(`[LRR Checker] 缓存结果 validator 过滤: ${matchCount} -> ${validated.length}`);
                    matchedFiles = validated;
                    matchCount = validated.length;

                    // 如果 validator 过滤后无结果，视为未找到
                    if (matchCount === 0) {
                        console.log(`[LRR Checker] 缓存结果被 validator 全部过滤，视为未找到`);
                        const searchingMarker = titleElement.querySelector('.lrr-marker-span[data-is-searching="true"]');
                        if (searchingMarker) {
                            cleanupMarker(searchingMarker);
                            searchingMarker.remove();
                        }
                        return { success: false, searchQuery, count: 0 };
                    }
                }

                // 删除搜索标记
                const searchingMarker = titleElement.querySelector('.lrr-marker-span[data-is-searching="true"]');
                if (searchingMarker) {
                    cleanupMarker(searchingMarker);
                    searchingMarker.remove();
                }

                console.log(`[LRR Checker] 缓存结果处理：matchCount=${matchCount}，检查是否需要标记`);

                if (matchCount === 1) {
                    console.log(`[LRR Checker] 缓存单个匹配，创建标记`);
                    const archiveTitle = matchedFiles[0].title;
                    const archiveId = matchedFiles[0].arcid;
                    let altMarkerSpan = document.createElement('span');
                    altMarkerSpan.classList.add('lrr-marker-span');
                    setMarkerIcon(altMarkerSpan, '!', 'LRR缓存匹配');
                    altMarkerSpan.classList.add('lrr-marker-file');
                    registerMarker(altMarkerSpan, {
                        menuBuilder: () => {
                            const readerUrl = `${CONFIG.lrrServerUrl}/reader?id=${archiveId}`;
                            const thumbnailUrl = `${CONFIG.lrrServerUrl}/api/archives/${archiveId}/thumbnail`;
                            return {
                                header: '已找到',
                                items: [{
                                    text: archiveTitle,
                                    url: readerUrl,
                                    thumbnailUrl: thumbnailUrl,
                                    pagecount: matchedFiles[0].pagecount
                                }],
                                refreshCallback: () => {
                                    clearGalleryCache(galleryUrl, searchQuery);
                                    const displayTitle = titleElement.textContent.replace(/\(LRR.*?\)/g, '').trim();
                                    refreshGalleryCheck(galleryUrl, titleElement, displayTitle);
                                }
                            };
                        }
                    });
                    titleElement.prepend(altMarkerSpan);
                } else if (matchCount > 1) {
                    console.log(`[LRR Checker] 缓存多个匹配，创建可能匹配标记`);
                    // 清除旧标记再添加新标记
                    clearAllMarkers(titleElement);
                    let altMarkerSpan = document.createElement('span');
                    altMarkerSpan.classList.add('lrr-marker-span');
                    setMarkerIcon(altMarkerSpan, `?${matchCount}`, `LRR发现${matchCount}个可能匹配`);
                    altMarkerSpan.classList.add('lrr-marker-multiple');
                    registerMarker(altMarkerSpan, {
                        menuBuilder: () => {
                            const items = [];
                            matchedFiles.forEach((file, index) => {
                                const readerUrl = `${CONFIG.lrrServerUrl}/reader?id=${file.arcid}`;
                                const thumbnailUrl = `${CONFIG.lrrServerUrl}/api/archives/${file.arcid}/thumbnail`;
                                if (index > 0) {
                                    items.push({ divider: true });
                                }
                                items.push({
                                    text: `${index + 1}. ${file.title}`,
                                    url: readerUrl,
                                    thumbnailUrl: thumbnailUrl,
                                    pagecount: file.pagecount
                                });
                            });
                            return {
                                header: `找到 ${matchCount} 个可能的匹配`,
                                items: items,
                                refreshCallback: () => {
                                    clearGalleryCache(galleryUrl, searchQuery);
                                    const displayTitle = titleElement.textContent.replace(/\(LRR.*?\)/g, '').trim();
                                    refreshGalleryCheck(galleryUrl, titleElement, displayTitle);
                                }
                            };
                        }
                    });
                }
                // 缓存结果直接返回，让handleResponse处理标记
                return cachedResult;
            } else if (cachedResult.success === false) {
                // 使用缓存的未找到结果，直接返回而不是重新搜索
                console.log(`[LRR Checker] Using cached not-found result: ${searchQuery}`);
                // 缓存结果直接返回，让handleResponse处理标记
                return cachedResult;
            }
        }

        let encodedQuery;
        try {
            encodedQuery = encodeURIComponent(searchQuery);
        } catch (err) {
            console.warn(`[LRR Checker] performAlternativeSearch: encodeURIComponent 失败，使用原始 query:`, err);
            // 回退方案：使用 encodeURI（较宽松的编码）
            try {
                encodedQuery = encodeURI(searchQuery);
            } catch (err2) {
                console.warn(`[LRR Checker] performAlternativeSearch: encodeURI 也失败，使用原始字符串`);
                encodedQuery = searchQuery;
            }
        }

        const randomSearchUrl = `${CONFIG.lrrServerUrl}/api/search/random?filter=${encodedQuery}`;
        const headers = {};
        if (CONFIG.lrrApiKey) {
            headers['Authorization'] = `Bearer ${CONFIG.lrrApiKey}`;
        }

        try {
            const response = await makeRequest({
                method: 'GET',
                url: randomSearchUrl,
                headers: headers
            });

            try {
                const randomResult = JSON.parse(response.responseText);
                if (randomResult && randomResult.data && randomResult.data.length > 0) {
                    const matchCount = randomResult.data.length;
                    const matchedFiles = randomResult.data;
                    let effectiveFiles = matchedFiles;
                    let filteredApplied = false;

                    // 调试：打印所有搜索结果
                    console.log(`[LRR Checker] 搜索返回 ${matchCount} 个结果:`);
                    matchedFiles.forEach((file, idx) => {
                        console.log(`[LRR Checker]   ${idx + 1}. "${file.title || file.filename}" (${file.pagecount}页)`);
                    });

                    if (validator) {
                        console.log(`[LRR Checker] 准备应用 validator，搜索结果数: ${matchCount}`);
                        const validated = matchedFiles.filter(file => validator(file));
                        console.log(`[LRR Checker] Validator 过滤结果: ${matchCount} -> ${validated.length}`);
                        if (validated.length > 0) {
                            effectiveFiles = validated;
                            filteredApplied = true;
                            console.log(`[LRR Checker] 使用过滤后的结果`);
                        } else {
                            console.log(`[LRR Checker] validator 过滤后无结果，视为搜索失败`);
                            effectiveFiles = []; // 设为空数组，触发后续的"未找到"逻辑
                            filteredApplied = true;
                        }
                    }
                    console.log(`[LRR Checker] Found ${effectiveFiles.length} result(s) via alternative search: ${searchQuery}`);

                    // 如果只有一个结果，直接标记
                    if (effectiveFiles.length === 1) {
                        // 检查是否是精确匹配（无 validator 应用，或只有单个结果通过 validator）
                        const isExactMatch = !filteredApplied || matchedFiles.length === 1;
                        
                        if (!isExactMatch) {
                            // 单个结果但页数不完全匹配，返回为备选
                            console.log(`[LRR Checker] Single result but not exact match, treat as fallback`);
                            const result = { success: false, searchQuery, count: 1, files: effectiveFiles, precision, filtered: filteredApplied };
                            if (!disableStore) {
                                cacheSearchResult(searchQuery, result);
                            }
                            return result;
                        }
                        
                        console.log(`[LRR Checker] Single exact match found, returning result`);
                        
                        const result = { success: true, searchQuery, count: 1, files: effectiveFiles, precision, filtered: filteredApplied };
                        if (!disableStore) {
                            cacheSearchResult(searchQuery, result);
                        }
                        return result;
                    } else if (effectiveFiles.length === 0) {
                        // validator 过滤后无结果，这意味着没有结果在页数误差范围内
                        // 不收集备选结果（因为根本没有符合条件的）
                        console.log(`[LRR Checker] validator 过滤后无结果（超出页数误差范围）`);
                        const result = { success: false, searchQuery, count: 0 };
                        if (!disableStore && CONFIG.cacheNotFoundResults) {
                            cacheSearchResult(searchQuery, result);
                        }
                        return result;
                    } else {
                        // 多个结果，收集为备选，继续后续搜索而不立即显示
                        console.log(`[LRR Checker] Multiple matches (${effectiveFiles.length}) found in phase 1, collecting as fallback for further search`);
                        const result = { success: false, searchQuery, count: effectiveFiles.length, files: effectiveFiles, precision, filtered: filteredApplied };
                        if (!disableStore) {
                            cacheSearchResult(searchQuery, result);
                        }
                        // 不立即显示 ?N，返回 success: false 让脚本继续后续搜索
                        return result;
                        
                    }
                } else {
                    console.log(`[LRR Checker] Not found via alternative search: ${searchQuery}`);

                    // 不在这里添加最终标记，让调用方决定是否继续其他搜索
                    // 只缓存结果并返回
                    const result = { success: false, searchQuery, count: 0 };
                    if (!disableStore && CONFIG.cacheNotFoundResults) {
                        cacheSearchResult(searchQuery, result);
                    }
                    return result;
                }
            } catch (e) {
                console.error(`[LRR Checker] Error parsing JSON for alternative search:`, e, response.responseText);
                return { success: false, searchQuery, error: e };
            }
        } catch (error) {
            console.error(`[LRR Checker] Network error during alternative search:`, error);
            console.log(`[LRR Checker] Error object details:`, {
                hasResponse: !!error?.response,
                responseText: error?.response?.responseText?.substring(0, 100) || null,
                errorMessage: error?.message
            });
            // 返回错误结果，标记为网络错误（不是搜索无结果）
            return { success: false, searchQuery, isNetworkError: true, error };
        }
    }

    // ===== 统一标记管理API（集中式管理） =====
    
    // 获取当前标记信息
    function getCurrentMarker(titleElement) {
        if (!titleElement) return null;
        const marker = titleElement.querySelector('.lrr-marker-span');
        if (!marker) return null;
        
        let type = null;
        // 优先检查data-markerType（由setFinalMarker设置）
        if (marker.dataset.markerType) {
            type = marker.dataset.markerType;
        } else if (marker.dataset.isSearching === 'true') {
            type = MARKER_TYPES.SEARCHING;
        } else if (marker.classList.contains('lrr-marker-downloaded')) {
            type = MARKER_TYPES.FOUND;
        } else if (marker.classList.contains('lrr-marker-file')) {
            type = MARKER_TYPES.PARTIAL;
        } else if (marker.classList.contains('lrr-marker-multiple')) {
            type = MARKER_TYPES.MULTIPLE;
        } else if (marker.classList.contains('lrr-marker-error')) {
            type = MARKER_TYPES.ERROR;
        } else {
            // 默认认为是未找到
            type = MARKER_TYPES.NOT_FOUND;
        }
        
        return {
            type,
            isFinal: type !== MARKER_TYPES.SEARCHING,
            element: marker,
            icon: marker.dataset.icon || ''
        };
    }
    
    // 检查是否已有最终标记
    function hasFinalMarker(titleElement) {
        const current = getCurrentMarker(titleElement);
        return current && current.isFinal;
    }
    
    // 清理所有标记
    function clearAllMarkers(titleElement) {
        if (!titleElement) return;
        const markers = titleElement.querySelectorAll('.lrr-marker-span');
        markers.forEach(marker => {
            cleanupMarker(marker);
            marker.remove();
        });
    }
    
    // 设置搜索中标记（临时标记）
    function setSearchingMarker(titleElement) {
        if (!titleElement) return;
        
        // 清理所有现有标记
        clearAllMarkers(titleElement);
        
        // 添加搜索中标记
        let searchingMarker = document.createElement('span');
        searchingMarker.classList.add('lrr-marker-span', 'lrr-marker-searching');
        searchingMarker.dataset.isSearching = 'true';
        setMarkerIcon(searchingMarker, '⏳', 'LRR搜索中...');
        titleElement.prepend(searchingMarker);
        console.log('[LRR Checker] Set searching marker (⏳)');
    }
    
    // 设置最终标记
    function setFinalMarker(titleElement, config) {
        if (!titleElement || !config) return;
        
        const { type, icon, label, className, menuBuilder, onClick } = config;
        
        // 如果已有最终标记，不覆盖
        const current = getCurrentMarker(titleElement);
        if (current && current.isFinal) {
            console.log(`[LRR Checker] Final marker already exists (${current.type}), skipping: ${icon}`);
            return;
        }
        
        // 清理所有旧标记（包括临时标记）
        clearAllMarkers(titleElement);
        
        // 创建新标记
        let markerSpan = document.createElement('span');
        markerSpan.classList.add('lrr-marker-span', className || '');
        markerSpan.dataset.markerType = type;
        setMarkerIcon(markerSpan, icon, label);
        
        // 注册菜单或点击处理
        if (menuBuilder || onClick) {
            registerMarker(markerSpan, { menuBuilder, onClick });
        }
        
        titleElement.prepend(markerSpan);
        console.log(`[LRR Checker] Set final marker: ${icon} (${type})`);
    }

    // ===== 向后兼容性包装（旧API的兼容实现） =====
    // 这些函数保留用于兼容现有代码，新代码应使用上面的新API
    
    function removeAllMarkers(titleElement, keepSearching = false) {
        if (!titleElement) return false;
        const markers = titleElement.querySelectorAll('.lrr-marker-span');
        let removed = 0;
        markers.forEach(marker => {
            if (keepSearching && marker.dataset.isSearching === 'true') {
                return; // 保留搜索标记
            }
            cleanupMarker(marker);
            marker.remove();
            removed++;
        });
        return removed > 0;
    }

    function ensureSearchingMarker(titleElement) {
        // 兼容实现：如果没有搜索标记，添加一个
        const current = getCurrentMarker(titleElement);
        if (!current || current.type !== MARKER_TYPES.SEARCHING) {
            setSearchingMarker(titleElement);
        }
    }

    function ensureMarkerSlot(titleElement, allowReplace = false) {
        // 兼容实现：如果没有标记或可以替换，返回true
        if (!titleElement) return false;
        const current = getCurrentMarker(titleElement);
        if (!current) return true;
        if (current.type === MARKER_TYPES.SEARCHING) return true;
        if (allowReplace && current.type === MARKER_TYPES.MULTIPLE) return true;
        return false;
    }

    function setMarkerIcon(element, iconText, ariaLabel = null) {
        if (!element) return;
        element.dataset.icon = iconText || '';
        element.textContent = '';
        if (ariaLabel) {
            element.setAttribute('aria-label', ariaLabel);
        } else {
            element.removeAttribute('aria-label');
        }
    }

    async function handleResponse(result, titleElement, galleryUrl, fallbackResults = [], cacheKey = null) {
        // 注意：processGallery已在开始时显示⏳，我们只需设置最终图标
        // 不需要检查是否有最终标记，因为流程保证只调用一次

        if (result.success === 1 || result.success === true) {
            // 若此前检测到 Key 失效，但凭借登录态成功，仍提示一次
            if (KEY_INVALID_DETECTED) {
                showAuthWarningToast();
            }
            console.log(`[LRR Checker] Found: ${galleryUrl}`);
            // 兼容两种格式：gid/token搜索返回 { success: 1, data: {...} }，
            // performAlternativeSearch返回 { success: true, files: [...] }
            
            // 根据 isExactMatch 判断是否为精确匹配
            const isExactMatch = result.isExactMatch === true;
            
            // 兼容两种格式：
            // 1. gid/token搜索: result.data.id
            // 2. performAlternativeSearch: result.files[0].arcid
            const archiveId = result.data ? result.data.id : (result.files && result.files[0] ? result.files[0].arcid : null);
            const archiveTitle_initial = result.files && result.files[0] ? result.files[0].title : '加载中...';
            const archivePagecount_initial = result.files && result.files[0] ? result.files[0].pagecount : null;

            // 添加悬停事件
            let archiveTitle = archiveTitle_initial;
            let archivePagecount = archivePagecount_initial;
            
            // 创建菜单构建函数
            const menuBuilder = () => {
                const readerUrl = `${CONFIG.lrrServerUrl}/reader?id=${archiveId}`;
                const thumbnailUrl = `${CONFIG.lrrServerUrl}/api/archives/${archiveId}/thumbnail`;
                return {
                    header: '已存档',
                    items: [
                        {
                            text: archiveTitle,
                            url: readerUrl,
                            thumbnailUrl: thumbnailUrl,
                            pagecount: archivePagecount
                        }
                    ],
                    refreshCallback: () => {
                        clearGalleryCache(galleryUrl, null);
                        const displayTitle = titleElement.textContent.replace(/\(LRR.*?\)/g, '').trim();
                        refreshGalleryCheck(galleryUrl, titleElement, displayTitle);
                    }
                };
            };
            
            // 使用setFinalMarker统一处理标记
            if (isExactMatch) {
                console.log(`[LRR Checker] 精确匹配 - 显示 ✓`);
                setFinalMarker(titleElement, {
                    type: MARKER_TYPES.FOUND,
                    icon: '✓',
                    label: 'LRR已收录',
                    className: 'lrr-marker-downloaded',
                    menuBuilder: menuBuilder
                });
            } else {
                console.log(`[LRR Checker] 非精确匹配（备选结果）- 显示 !`);
                setFinalMarker(titleElement, {
                    type: MARKER_TYPES.PARTIAL,
                    icon: '!',
                    label: 'LRR可能有匹配',
                    className: 'lrr-marker-file',
                    menuBuilder: menuBuilder
                });
            }

            // 异步获取存档详细信息
            fetchArchiveInfo(archiveId).then(archiveInfo => {
                if (archiveInfo && archiveInfo.title) {
                    archiveTitle = archiveInfo.title;
                    archivePagecount = archiveInfo.pagecount;
                    console.log(`[LRR Checker] Archive info updated: ${archiveTitle}, pages: ${archivePagecount}`);
                    
                    // 更新缓存，添加archiveTitle和archivePagecount
                    if (cacheKey) {
                        const updatedCacheData = { 
                            ...result,
                            archiveTitle: archiveInfo.title,
                            archivePagecount: archiveInfo.pagecount
                        };
                        setCache(cacheKey, updatedCacheData);
                        console.log(`[LRR Checker] Updated cache with archive info`);
                    }
                }
            }).catch(error => {
                console.error(`[LRR Checker] Error fetching archive info:`, error);
            });
        } else if (result.isNetworkError === true) {
            // 网络错误（LRR 服务器无法连接）
            console.log(`[LRR Checker] Network error occurred when searching: ${galleryUrl}`);
            // 触发全局停止，直到用户刷新
            GLOBAL_STOP_ALL_CHECKS = true;
            setFinalMarker(titleElement, {
                type: MARKER_TYPES.ERROR,
                icon: '⚠️',
                label: 'LRR连接失败',
                className: 'lrr-marker-error',
                onClick: (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    // 网络错误不应该缓存，直接清除缓存重试
                    clearGalleryCache(galleryUrl, '');
                    const displayTitle = titleElement.textContent.replace(/\(LRR.*?\)/g, '').trim();
                    refreshGalleryCheck(galleryUrl, titleElement, displayTitle);
                }
            })
        } else {
            console.log(`[LRR Checker] Not found or error: ${galleryUrl} - ${result.error}`);

            // ⏳标记已在processGallery开始时显示，此处不需要重复设置
            // 直接进入深度搜索流程（如果启用）
            
            // 去除可能已存在的标记（如 ⏳, !, ✓ 等）
            const fullTitle = titleElement.textContent.replace(/^[⏳🔄!✓⚠?✗]\d*\s*/, '').trim();
            const { author, title } = extractAuthorAndTitle(fullTitle);
            const coreTokenInfo = extractCoreToken(title || fullTitle);
            const coreToken = coreTokenInfo ? coreTokenInfo.token : null;
            const titleDateToken = extractDateToken(title || fullTitle);

            console.log(`[LRR Checker] Extracted - Author: "${author}", Title: "${title}"`);

            if (!author) {
                // 没有作者信息，尝试深度搜索
                if (!CONFIG.enableDeepSearch) {
                    console.log(`[LRR Checker] Deep search disabled, skipping for: ${fullTitle}`);
                    setFinalMarker(titleElement, {
                        type: MARKER_TYPES.NOT_FOUND,
                        icon: '🔄',
                        label: 'LRR未找到',
                        className: 'lrr-marker-notfound',
                        onClick: (e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            clearGalleryCache(galleryUrl, null);
                            const displayTitle = titleElement.textContent.replace(/\(LRR.*?\)/g, '').trim();
                            refreshGalleryCheck(galleryUrl, titleElement, displayTitle);
                        }
                    });
                    return;
                }
                console.log(`[LRR Checker] No author in title, trying deep search: ${fullTitle}`);
                await performDeepSearch(galleryUrl, titleElement, fullTitle, new Set(), cacheKey);
                return;
            }

            if (author === title || title === null) {
                console.log(`[LRR Checker] Invalid title format, trying deep search: ${fullTitle}`);
                if (!CONFIG.enableDeepSearch) {
                    console.log(`[LRR Checker] Deep search disabled, stopping search for: ${fullTitle}`);
                    // 检查是否有备选结果（页数在误差范围内的）
                    if (fallbackResults.length > 0) {
                        console.log(`[LRR Checker] Found ${fallbackResults.length} fallback result(s) within pagecount tolerance`);
                        if (fallbackResults.length === 1) {
                            // 只有1个备选，显示为不完全匹配
                            const fallbackFile = fallbackResults[0];
                            setFinalMarker(titleElement, {
                                type: MARKER_TYPES.PARTIAL,
                                icon: '!',
                                label: 'LRR找到可能匹配（页数不完全符合）',
                                className: 'lrr-marker-file',
                                menuBuilder: () => ({
                                    header: '可能匹配',
                                    items: [{
                                        text: fallbackFile.title,
                                        url: `${CONFIG.lrrServerUrl}/reader?id=${fallbackFile.arcid}`,
                                        thumbnailUrl: `${CONFIG.lrrServerUrl}/api/archives/${fallbackFile.arcid}/thumbnail`,
                                        pagecount: fallbackFile.pagecount
                                    }]
                                })
                            });
                        } else {
                            // 多个备选，显示?N
                            setFinalMarker(titleElement, {
                                type: MARKER_TYPES.MULTIPLE,
                                icon: `?${fallbackResults.length}`,
                                label: `LRR发现${fallbackResults.length}个可能匹配`,
                                className: 'lrr-marker-multiple',
                                menuBuilder: () => {
                                    const items = [];
                                    fallbackResults.forEach((file, index) => {
                                        if (index > 0) items.push({ divider: true });
                                        items.push({
                                            text: `${index + 1}. ${file.title}`,
                                            url: `${CONFIG.lrrServerUrl}/reader?id=${file.arcid}`,
                                            thumbnailUrl: `${CONFIG.lrrServerUrl}/api/archives/${file.arcid}/thumbnail`,
                                            pagecount: file.pagecount
                                        });
                                    });
                                    return { header: `找到 ${fallbackResults.length} 个可能的匹配`, items };
                                }
                            });
                        }
                    } else {
                        // 没有备选结果，显示未找到
                        console.log(`[LRR Checker] No results found within pagecount tolerance`);
                        setFinalMarker(titleElement, {
                            type: MARKER_TYPES.NOT_FOUND,
                            icon: '🔄',
                            label: 'LRR未找到',
                            className: 'lrr-marker-notfound',
                            onClick: (e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                clearGalleryCache(galleryUrl, null);
                                const displayTitle = titleElement.textContent.replace(/\(LRR.*?\)/g, '').trim();
                                refreshGalleryCheck(galleryUrl, titleElement, displayTitle);
                            }
                        });
                    }
                    return;
                }
                await performDeepSearch(galleryUrl, titleElement, fullTitle, new Set(), cacheKey);
                return;
            }

            // 尝试提取标题的第一部分
            const searchQuery = `${author},${title}`;
            console.log(`[LRR Checker] Trying alternative search with: ${searchQuery}`);

            // 第一次尝试：作者 + 完整标题
            let searchResult = await performAlternativeSearch(searchQuery, titleElement, galleryUrl);
            if (searchResult.success && searchResult.count === 1) {
                // 找到单个结果，调用handleResponse设置最终标记
                await handleResponse(searchResult, titleElement, galleryUrl);
                return;
            }

            const tryCoreTokenSearch = async (token, numberTokens = [], skipCache = false) => {
                if (!token) return searchResult;
                const queries = [];
                const dateVariants = buildDateVariants(titleDateToken);

                // 生成搜索查询，优先包含数字 token
                if (numberTokens && numberTokens.length > 0) {
                    const numberStr = numberTokens.join(',');
                    dateVariants.forEach(date => queries.push(`${author},${date},${token},${numberStr}`));
                    queries.push(`${author},${token},${numberStr}`);
                }

                // 也保留不含数字的查询作为备选
                dateVariants.forEach(date => queries.push(`${author},${date},${token}`));
                queries.push(`${author},${token}`);

                const validator = buildResultValidator({ dateToken: titleDateToken, coreToken: token });
                for (const coreQuery of queries) {
                    console.log(`[LRR Checker] Trying core token search: ${coreQuery}`);
                    const result = await performAlternativeSearch(coreQuery, titleElement, galleryUrl, { skipCache, validator });
                    if (result.success && result.count === 1) {
                        return result;
                    }
                    searchResult = result;
                }
                return searchResult;
            };

            if ((!searchResult.success || searchResult.count === 0) && coreToken) {
                const numberTokens = coreTokenInfo && coreTokenInfo.numberTokens ? coreTokenInfo.numberTokens : [];
                searchResult = await tryCoreTokenSearch(coreToken, numberTokens);
                if (searchResult.success && searchResult.count === 1) {
                    await handleResponse(searchResult, titleElement, galleryUrl);
                return;
                }
            }

            // 如果首次搜索失败，尝试简繁体转换和去除英文
            if (!searchResult.success || searchResult.count === 0) {
                // 检测标题语言，只对中文/日文标题进行简繁转换
                const titleLanguage = detectTextLanguage(title);
                const shouldTryConversion = (titleLanguage === 'chinese' || titleLanguage === 'japanese');

                if (!shouldTryConversion) {
                    console.log(`[LRR Checker] Title language is '${titleLanguage}', skipping Traditional/Simplified Chinese conversion`);
                }

                // 尝试去除英文部分（保留中文、日文、数字、标点）
                const titleWithoutEnglish = title.replace(/\s+[A-Za-z]+(?:\s+[A-Za-z]+)*$/g, '').trim();

                const traditionalQuery = shouldTryConversion ? `${author},${toTraditional(title)}` : null;
                const simplifiedQuery = shouldTryConversion ? `${author},${toSimplified(title)}` : null;
                const traditionalQueryNoEn = (shouldTryConversion && titleWithoutEnglish !== title) ? `${author},${toTraditional(titleWithoutEnglish)}` : null;
                const simplifiedQueryNoEn = (shouldTryConversion && titleWithoutEnglish !== title) ? `${author},${toSimplified(titleWithoutEnglish)}` : null;

                // 移除可能已存在的未找到标记，以便后续成功搜索能创建新标记
                // 尝试繁体版本（跳过缓存，强制实际搜索）
                if (traditionalQuery && traditionalQuery !== searchQuery) {
                    console.log(`[LRR Checker] Trying traditional Chinese: ${traditionalQuery}`);
                    searchResult = await performAlternativeSearch(traditionalQuery, titleElement, galleryUrl, { skipCache: true });
                    if (searchResult.success && searchResult.count === 1) {
                        await handleResponse(searchResult, titleElement, galleryUrl);
                return;
                    }
                }

                // 尝试繁体版本（去除英文）
                if (traditionalQueryNoEn && traditionalQueryNoEn !== traditionalQuery && !searchResult.success) {
                    console.log(`[LRR Checker] Trying traditional Chinese without English: ${traditionalQueryNoEn}`);
                    searchResult = await performAlternativeSearch(traditionalQueryNoEn, titleElement, galleryUrl, { skipCache: true });
                    if (searchResult.success && searchResult.count === 1) {
                        await handleResponse(searchResult, titleElement, galleryUrl);
                return;
                    }
                }

                // 尝试简体版本（跳过缓存，强制实际搜索）
                if (simplifiedQuery && simplifiedQuery !== searchQuery && !searchResult.success) {
                    console.log(`[LRR Checker] Trying simplified Chinese: ${simplifiedQuery}`);
                    searchResult = await performAlternativeSearch(simplifiedQuery, titleElement, galleryUrl, { skipCache: true });
                    if (searchResult.success && searchResult.count === 1) {
                        await handleResponse(searchResult, titleElement, galleryUrl);
                return;
                    }
                }

                // 尝试简体版本（去除英文）
                if (simplifiedQueryNoEn && simplifiedQueryNoEn !== simplifiedQuery && !searchResult.success) {
                    console.log(`[LRR Checker] Trying simplified Chinese without English: ${simplifiedQueryNoEn}`);
                    searchResult = await performAlternativeSearch(simplifiedQueryNoEn, titleElement, galleryUrl, { skipCache: true });
                    if (searchResult.success && searchResult.count === 1) {
                        await handleResponse(searchResult, titleElement, galleryUrl);
                return;
                    }
                }

                if ((!searchResult.success || searchResult.count === 0) && coreToken) {
                    const tradCore = toTraditional(coreToken);
                    const simpCore = toSimplified(coreToken);
                    if (tradCore && tradCore !== coreToken) {
                        searchResult = await tryCoreTokenSearch(tradCore, true);
                        if (searchResult.success && searchResult.count === 1) {
                            await handleResponse(searchResult, titleElement, galleryUrl);
                return;
                        }
                    }
                    if ((!searchResult.success || searchResult.count === 0) && simpCore && simpCore !== tradCore) {
                        searchResult = await tryCoreTokenSearch(simpCore, true);
                        if (searchResult.success && searchResult.count === 1) {
                            await handleResponse(searchResult, titleElement, galleryUrl);
                return;
                        }
                    }
                }
            }

            // 如果失败或多个结果，尝试深度搜索（获取日文标题）
            if (!CONFIG.enableDeepSearch) {
                console.log(`[LRR Checker] Deep search disabled, stopping search for: ${fullTitle}`);
                // 检查是否有备选结果（页数在误差范围内的）
                if (fallbackResults.length > 0) {
                    console.log(`[LRR Checker] Found ${fallbackResults.length} fallback result(s) within pagecount tolerance`);
                    if (fallbackResults.length === 1) {
                        // 只有1个备选，显示为不完全匹配
                        const fallbackFile = fallbackResults[0];
                        setFinalMarker(titleElement, {
                            type: MARKER_TYPES.PARTIAL,
                            icon: '!',
                            label: 'LRR找到可能匹配（页数不完全符合）',
                            className: 'lrr-marker-file',
                            menuBuilder: () => ({
                                header: '可能匹配',
                                items: [{
                                    text: fallbackFile.title,
                                    url: `${CONFIG.lrrServerUrl}/reader?id=${fallbackFile.arcid}`,
                                    thumbnailUrl: `${CONFIG.lrrServerUrl}/api/archives/${fallbackFile.arcid}/thumbnail`,
                                    pagecount: fallbackFile.pagecount
                                }]
                            })
                        });
                    } else {
                        // 多个备选，显示?N
                        setFinalMarker(titleElement, {
                            type: MARKER_TYPES.MULTIPLE,
                            icon: `?${fallbackResults.length}`,
                            label: `LRR发现${fallbackResults.length}个可能匹配`,
                            className: 'lrr-marker-multiple',
                            menuBuilder: () => {
                                const items = [];
                                fallbackResults.forEach((file, index) => {
                                    if (index > 0) items.push({ divider: true });
                                    items.push({
                                        text: `${index + 1}. ${file.title}`,
                                        url: `${CONFIG.lrrServerUrl}/reader?id=${file.arcid}`,
                                        thumbnailUrl: `${CONFIG.lrrServerUrl}/api/archives/${file.arcid}/thumbnail`,
                                        pagecount: file.pagecount
                                    });
                                });
                                return { header: `找到 ${fallbackResults.length} 个可能的匹配`, items };
                            }
                        });
                    }
                } else {
                    // 没有备选结果，显示未找到
                    console.log(`[LRR Checker] No results found within pagecount tolerance`);
                    setFinalMarker(titleElement, {
                        type: MARKER_TYPES.NOT_FOUND,
                        icon: '🔄',
                        label: 'LRR未找到',
                        className: 'lrr-marker-notfound',
                        onClick: (e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            clearGalleryCache(galleryUrl, null);
                            const displayTitle = titleElement.textContent.replace(/\(LRR.*?\)/g, '').trim();
                            refreshGalleryCheck(galleryUrl, titleElement, displayTitle);
                        }
                    });
                }
                return;
            }
            
            console.log(`[LRR Checker] First search failed or multiple results, trying deep search for better match`);
            // 收集已尝试的查询，避免Deep Search重复
            const attemptedQueries = new Set();
            attemptedQueries.add(searchQuery); // 作者+标题
            if (coreToken) {
                const dateVariants = buildDateVariants(titleDateToken);
                dateVariants.forEach(date => attemptedQueries.add(`${author},${date},${coreToken}`));
                attemptedQueries.add(`${author},${coreToken}`);
            }
            attemptedQueries.add(`${author},${toTraditional(title)}`);
            attemptedQueries.add(`${author},${toSimplified(title)}`);
            await performDeepSearch(galleryUrl, titleElement, fullTitle, attemptedQueries, cacheKey);
        }
    }

    // ===== 标题缓存管理 =====
    function getTitleCache() {
        const cache = GM_getValue('lrr_title_cache', null);
        return cache ? JSON.parse(cache) : {};
    }

    function saveTitleCache(cache) {
        GM_setValue('lrr_title_cache', JSON.stringify(cache));
    }

    // ===== 搜索结果缓存管理 =====
    function getSearchCache() {
        const cache = GM_getValue('lrr_search_cache', null);
        return cache ? JSON.parse(cache) : {};
    }

    function saveSearchCache(cache) {
        GM_setValue('lrr_search_cache', JSON.stringify(cache));
    }

    function getCachedSearchResult(searchQuery) {
        const cache = getSearchCache();
        const entry = cache[searchQuery];
        if (entry && entry.timestamp) {
            const age = Date.now() - entry.timestamp;
            const maxAge = CONFIG.cacheExpiryDays * 24 * 60 * 60 * 1000;
            if (age < maxAge) {
                return entry.result;
            }
        }
        return null;
    }

    function cacheSearchResult(searchQuery, result) {
        // 不缓存网络异常（临时性问题，用户解决后应该重新获取）
        if (result.isNetworkError === true) {
            console.log(`[LRR Checker] Not caching network error for: ${searchQuery}`);
            return;
        }
        
        const cache = getSearchCache();
        cache[searchQuery] = {
            result: result,
            timestamp: Date.now()
        };
        saveSearchCache(cache);
    }

    function removeCachedSearchResult(searchQuery) {
        const cache = getSearchCache();
        if (cache[searchQuery]) {
            delete cache[searchQuery];
            saveSearchCache(cache);
            console.log(`[LRR Checker] Removed cached search result for: ${searchQuery}`);
        }
    }

    // ===== 单个画廊缓存刷新 =====
    function clearGalleryCache(galleryUrl, searchQuery) {
        // 清除标题缓存
        const titleCache = getTitleCache();
        if (titleCache[galleryUrl]) {
            delete titleCache[galleryUrl];
            saveTitleCache(titleCache);
            console.log(`[LRR Checker] Cleared title cache for: ${galleryUrl}`);
        }

        // 清除搜索结果缓存
        if (searchQuery) {
            const searchCache = getSearchCache();
            if (searchCache[searchQuery]) {
                delete searchCache[searchQuery];
                saveSearchCache(searchCache);
                console.log(`[LRR Checker] Cleared search cache for: ${searchQuery}`);
            }
        }

        // 清除缩略图缓存（从 URL 中提取所有可能的 archiveId）
        // 虽然我们无法直接从 galleryUrl 提取 archiveId，但我们可以清除所有缓存
        // 这在用户点击"刷新"时会清除所有缓存的缩略图
        for (const key in thumbnailCache) {
            delete thumbnailCache[key];
        }
        console.log(`[LRR Checker] Cleared all thumbnail cache`);

        // 清除URL匹配结果缓存
        const urlCacheKey = `lrr-checker-${galleryUrl}`;
        if (localStorage.getItem(urlCacheKey)) {
            localStorage.removeItem(urlCacheKey);
            console.log(`[LRR Checker] Cleared URL cache for: ${galleryUrl}`);
        }
    }

    function refreshGalleryCheck(galleryUrl, titleElement, displayTitle) {
        console.log(`[LRR Checker] Refreshing check for: ${displayTitle} (force refresh, skip cache)`);

        // 立即显示沙漏，表示正在重新搜索
        setSearchingMarker(titleElement);

        // 重新执行检查（强制跳过缓存）
        const cacheKey = `lrr-checker-${galleryUrl}`;
        processGallery({
            galleryUrl: galleryUrl,
            titleElement: titleElement,
            cacheKey: cacheKey
        });
    }

    function getCachedTitle(galleryUrl) {
        const cache = getTitleCache();
        const entry = cache[galleryUrl];
        if (entry && entry.timestamp) {
            const age = Date.now() - entry.timestamp;
            const maxAge = CONFIG.cacheExpiryDays * 24 * 60 * 60 * 1000;
            if (age < maxAge) {
                return entry.title;
            }
        }
        return null;
    }

    function cacheTitleForUrl(galleryUrl, title) {
        const cache = getTitleCache();
        cache[galleryUrl] = {
            title: title,
            timestamp: Date.now()
        };
        saveTitleCache(cache);
    }

    function exportTitleCache() {
        const cache = getTitleCache();
        const blob = new Blob([JSON.stringify(cache, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `LRR-TitleCache-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        alert('标题缓存已导出');
    }

    function exportAllCaches() {
        const titleCache = getTitleCache();
        const searchCache = getSearchCache();

        // 收集URL缓存
        const urlCache = {};
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.startsWith('lrr-checker-')) {
                urlCache[key] = JSON.parse(localStorage.getItem(key));
            }
        }

        const allCaches = {
            titleCache: titleCache,
            searchCache: searchCache,
            urlCache: urlCache,
            exportDate: new Date().toISOString(),
            version: '1.0'
        };

        const blob = new Blob([JSON.stringify(allCaches, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `LRR-AllCaches-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        const stats = `所有缓存已导出\n- 标题缓存: ${Object.keys(titleCache).length} 条\n- 搜索缓存: ${Object.keys(searchCache).length} 条\n- URL缓存: ${Object.keys(urlCache).length} 条`;
        alert(stats);
    }

    function importTitleCache() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'application/json';
        input.onchange = (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (event) => {
                try {
                    const imported = JSON.parse(event.target.result);
                    const current = getTitleCache();
                    const merged = { ...current, ...imported };
                    saveTitleCache(merged);
                    alert(`标题缓存已导入，共 ${Object.keys(merged).length} 条记录`);
                } catch (err) {
                    alert('导入失败：' + err.message);
                }
            };
            reader.readAsText(file);
        };
        input.click();
    }

    function importAllCaches() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'application/json';
        input.onchange = (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (event) => {
                try {
                    const imported = JSON.parse(event.target.result);

                    let stats = [];

                    // 导入标题缓存
                    if (imported.titleCache) {
                        const current = getTitleCache();
                        const merged = { ...current, ...imported.titleCache };
                        saveTitleCache(merged);
                        stats.push(`标题缓存: ${Object.keys(merged).length} 条`);
                    }

                    // 导入搜索缓存
                    if (imported.searchCache) {
                        const current = getSearchCache();
                        const merged = { ...current, ...imported.searchCache };
                        saveSearchCache(merged);
                        stats.push(`搜索缓存: ${Object.keys(merged).length} 条`);
                    }

                    // 导入URL缓存
                    if (imported.urlCache) {
                        let count = 0;
                        for (const key in imported.urlCache) {
                            localStorage.setItem(key, JSON.stringify(imported.urlCache[key]));
                            count++;
                        }
                        stats.push(`URL缓存: ${count} 条`);
                    }

                    alert(`所有缓存已导入\n${stats.join('\n')}`);
                } catch (err) {
                    alert('导入失败：' + err.message);
                }
            };
            reader.readAsText(file);
        };
        input.click();
    }

    function clearTitleCache() {
        if (confirm('确定要清空标题缓存吗？')) {
            GM_setValue('lrr_title_cache', JSON.stringify({}));
            alert('标题缓存已清空');
        }
    }

    function clearUrlCache() {
        if (confirm('确定要清空 URL 匹配结果缓存吗？')) {
            const keys = [];
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key && key.startsWith('lrr-checker-')) {
                    keys.push(key);
                }
            }
            keys.forEach(key => localStorage.removeItem(key));
            alert(`已清空 ${keys.length} 条 URL 匹配结果缓存`);
        }
    }

    function clearSearchCache() {
        if (confirm('确定要清空搜索结果缓存吗？')) {
            GM_setValue('lrr_search_cache', JSON.stringify({}));
            alert('搜索结果缓存已清空');
        }
    }

    // ===== 关键词导入导出 =====
    function exportKeywords() {
        const keywords = {
            authorWhitelist: CONFIG.authorWhitelist || '',
            coreWhitelist: CONFIG.coreWhitelist || '',
            coreBlacklist: CONFIG.coreBlacklist || '',
            // 兼容旧版字段
            authorKeywords: CONFIG.authorWhitelist || CONFIG.authorKeywords || '',
            tagKeywords: CONFIG.coreBlacklist || CONFIG.tagKeywords || '',
            exportDate: new Date().toISOString(),
            version: '2.0'
        };

        const blob = new Blob([JSON.stringify(keywords, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `LRR-Keywords-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        alert('关键词已导出');
    }

    function importKeywords() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'application/json';
        input.onchange = (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (event) => {
                try {
                    const imported = JSON.parse(event.target.result);

                    // 更新输入框显示
                    if (imported.authorWhitelist !== undefined) {
                        document.getElementById('authorWhitelist').value = imported.authorWhitelist;
                    } else if (imported.authorKeywords !== undefined) {
                        document.getElementById('authorWhitelist').value = imported.authorKeywords;
                    }
                    if (imported.coreWhitelist !== undefined) {
                        document.getElementById('coreWhitelist').value = imported.coreWhitelist;
                    }
                    if (imported.coreBlacklist !== undefined) {
                        document.getElementById('coreBlacklist').value = imported.coreBlacklist;
                    } else if (imported.tagKeywords !== undefined) {
                        document.getElementById('coreBlacklist').value = imported.tagKeywords;
                    }

                    alert('关键词已导入到输入框，请点击"保存"按钮保存配置');
                } catch (err) {
                    alert('导入失败：' + err.message);
                }
            };
            reader.readAsText(file);
        };
        input.click();
    }

    function clearAllCaches() {
        if (confirm('确定要清空所有缓存（包括标题缓存、搜索结果缓存和 URL 匹配结果缓存）吗？')) {
            // 清空标题缓存
            GM_setValue('lrr_title_cache', JSON.stringify({}));

            // 清空搜索结果缓存
            GM_setValue('lrr_search_cache', JSON.stringify({}));

            // 清空 URL 匹配结果缓存
            const keys = [];
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key && key.startsWith('lrr-checker-')) {
                    keys.push(key);
                }
            }
            keys.forEach(key => localStorage.removeItem(key));

            alert(`所有缓存已清空\n- 标题缓存已清空\n- 搜索结果缓存已清空\n- ${keys.length} 条 URL 匹配结果缓存已清空`);
        }
    }

    // ===== 深度搜索：访问详情页获取完整标题 =====
    async function fetchGalleryTitles(galleryUrl) {
        // 先检查缓存
        const cached = getCachedTitle(galleryUrl);
        if (cached) {
            // 检查缓存格式，旧格式直接忽略
            if (typeof cached === 'string') {
                console.log(`[LRR Checker] Old cache format detected, refetching titles`);
                // 继续往下执行，重新获取
            } else {
                console.log(`[LRR Checker] Using cached titles for: ${galleryUrl}`);
                return cached;
            }
        }

        // 只有在需要实际请求时才添加延迟
        await new Promise(resolve => setTimeout(resolve, CONFIG.deepSearchDelay));

        try {
            const response = await makeRequest({
                method: 'GET',
                url: galleryUrl
            });

            const parser = new DOMParser();
            const doc = parser.parseFromString(response.responseText, 'text/html');
            const gnElement = doc.querySelector('#gn');
            const gjElement = doc.querySelector('#gj');

            const titles = {
                gn: gnElement ? gnElement.textContent.trim() : null,
                gj: gjElement ? gjElement.textContent.trim() : null
            };

            if (titles.gn || titles.gj) {
                console.log(`[LRR Checker] Fetched titles - #gn: ${titles.gn}, #gj: ${titles.gj}`);
                // 缓存标题
                cacheTitleForUrl(galleryUrl, titles);
                return titles;
            }
        } catch (error) {
            console.error(`[LRR Checker] Error fetching gallery titles:`, error);
            // 返回错误标记，区分网络错误和其他错误
            return { isNetworkError: true, error };
        }
    }

    // 提取作者和标题的通用函数
    function extractAuthorAndTitle(fullTitle) {
        let author = null;
        let title = null;

        // 获取用户定义的关键词
        const userAuthors = getAuthorKeywordList();
        const userTags = parseKeywordList(CONFIG.coreBlacklist || CONFIG.tagKeywords || '');

        const cleanTitleText = (text) => {
            if (!text) return null;
            let cleaned = text;
            cleaned = cleaned.replace(/^[\-\s]+/, '').trim();
            // 将斜杠替换为空格（文件系统通常会将斜杠转换为空格或其他字符）
            cleaned = cleaned.replace(/\s*\/\s*/g, ' ');
            cleaned = cleaned.replace(/\s*\([^\)]+\)\s*/g, ' ');
            cleaned = cleaned.replace(/\s*\[[^\]]+\]\s*/g, ' ');
            cleaned = cleaned.replace(/\[\s*\]/g, ' ');
            for (const tag of userTags) {
                if (!tag) continue;
                const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                // 匹配前后有空格或在开头/结尾的标签
                cleaned = cleaned.replace(new RegExp(`(^|\\s)${escaped}(\\s|$)`, 'gi'), ' ');
            }
            cleaned = cleaned.replace(/\s+/g, ' ').trim();
            return cleaned || null;
        };

        // 优先级1：检查用户定义的作者关键词
        for (const knownAuthor of userAuthors) {
            // 大小写不敏感的匹配
            const authorRegex = new RegExp(knownAuthor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
            const authorMatch = fullTitle.match(authorRegex);
            if (authorMatch) {
                // 使用实际匹配到的文本作为作者（保持原始大小写）
                author = authorMatch[0];
                // 提取标题：去除作者部分和标签
                let remainingTitle = fullTitle;
                // 移除作者名称（使用原始匹配的文本）
                remainingTitle = remainingTitle.replace(authorMatch[0], '').trim();
                // 先移除方括号和圆括号内容
                remainingTitle = remainingTitle.replace(/\s*\([^\)]+\)\s*/g, ' ');
                remainingTitle = remainingTitle.replace(/\s*\[[^\]]+\]\s*/g, ' ');
                remainingTitle = remainingTitle.replace(/\[\s*\]/g, ' ').trim();
                // 移除开头的分隔符（- _ : 等）
                remainingTitle = remainingTitle.replace(/^[\s\-_:\/\\·・]+/, '').trim();
                // 再调用 cleanTitleText 进行最终清理
                title = cleanTitleText(remainingTitle);
                console.log(`[LRR Checker] Matched user author keyword: ${author}`);
                return { author, title };
            }
        }

        // 优先级2：尝试方括号格式
        const authorRegex = /\[((?!汉化|漢化|DL版|中国翻訳)[^\]]+)\]/;
        const authorMatch = fullTitle.match(authorRegex);
        author = authorMatch ? authorMatch[1] : null;

        // 检查是否为用户定义的标签关键词
        if (author && userTags.includes(author)) {
            author = null; // 重置，尝试短横线格式
        }

        // 如果有方括号作者，提取方括号后的标题
        if (author) {
            const afterBracket = fullTitle.slice(fullTitle.indexOf(']') + 1);
            title = cleanTitleText(afterBracket);
        } else {
            // 优先级3：尝试匹配 "作者 - 标题" 格式
            const dashFormatRegex = /^([^\-\[\]]+)\s*-\s*(.+)/;
            const dashMatch = fullTitle.match(dashFormatRegex);
            if (dashMatch) {
                author = dashMatch[1].trim();
                title = cleanTitleText(dashMatch[2]) || dashMatch[2].trim();
            }
        }

        // 优先级4：回退到首词作者推断（旧逻辑）
        if (!author) {
            const leadingMatch = fullTitle.match(/^([^\s\[\]\(\)\-]+)\s+(.+)/);
            if (leadingMatch) {
                let candidate = leadingMatch[1].trim();
                candidate = candidate.replace(/^[!！~、·•\*]+/, '').replace(/[!！~、·•\*]+$/, '');
                if (candidate && /[\p{Letter}\p{Number}]/u.test(candidate)) {
                    author = candidate;
                    title = cleanTitleText(leadingMatch[2]) || leadingMatch[2].trim();
                    console.log(`[LRR Checker] Fallback author detected: ${author}`);
                }
            }
        }

        return { author, title };
    }

    async function performDeepSearch(galleryUrl, titleElement, displayTitle, attemptedQueries = new Set(), cacheKey = null) {
        if (!CONFIG.enableDeepSearch) {
            console.log(`[LRR Checker] Deep search disabled, skipping: ${displayTitle}`);
            return;
        }

        console.log(`[LRR Checker] Performing deep search: ${displayTitle}`);
        console.log(`[LRR Checker] Already attempted ${attemptedQueries.size} queries, will skip duplicates`);

        // 保存现有的多结果标记，以便deep search失败时恢复
        const existingMultipleMarker = titleElement.querySelector('.lrr-marker-span.lrr-marker-multiple');
        let savedMarkerData = null;
        if (existingMultipleMarker) {
            savedMarkerData = {
                icon: existingMultipleMarker.dataset.icon,
                ariaLabel: existingMultipleMarker.getAttribute('aria-label'),
                options: getMarkerOptions(existingMultipleMarker)
            };
            console.log(`[LRR Checker] Saved existing multiple marker: ${savedMarkerData.icon}`);
        }

        const titles = await fetchGalleryTitles(galleryUrl);
        if (!titles || (!titles.gn && !titles.gj)) {
            console.log(`[LRR Checker] Failed to fetch titles from detail page`);
            return;
        }

        // 尝试从 #gn (英文/中文标题) 提取
        let searchResults = [];
        let fallbackResults = [];  // 收集备选结果（关键字匹配但页数不符）
        const summarizeAttempts = () => {
            return searchResults.map(r => `${r.type}:${r.query}${r.success ? '[✓]' : ''}`).join(' | ');
        };

        // 根据配置决定搜索顺序
        console.log(`[LRR Checker] 标题搜索优先级: ${CONFIG.titleSearchOrder === 'gj' ? '日文(#gj) > 英文(#gn)' : '英文(#gn) > 日文(#gj)'}`);
        const shouldSearchGnFirst = CONFIG.titleSearchOrder !== 'gj';

        // 第 3 层（深度搜索）：统一模板，根据配置决定处理顺序
        // 注意：完整标题搜索已在第 2 层完成，这里不再重复

        // 第一优先级：根据配置选择的标题类型
        if (shouldSearchGnFirst && titles.gn) {
            const { author: gnAuthor, title: gnTitle } = extractAuthorAndTitle(titles.gn);
            const gnCoreInfo = extractCoreToken(gnTitle || titles.gn);
            const gnCoreToken = gnCoreInfo ? gnCoreInfo.token : null;
            const gnNumberTokens = gnCoreInfo && gnCoreInfo.numberTokens ? gnCoreInfo.numberTokens : [];
            const gnDateToken = extractDateToken(titles.gn);
            console.log(`[LRR Checker] Deep search extracted from #gn - Author: "${gnAuthor}", Title: "${gnTitle}"`);

            if (gnAuthor && gnTitle && gnAuthor !== gnTitle) {
                const query = `${gnAuthor},${gnTitle}`;
                if (attemptedQueries.has(query)) {
                    console.log(`[LRR Checker] Skipping duplicate #gn search: ${query}`);
                } else {
                    console.log(`[LRR Checker] Trying #gn search: ${query}`);
                    const result = await performAlternativeSearch(query, titleElement, galleryUrl);
                    attemptedQueries.add(query);
                    if (result.success) {
                        // 成功找到，调用handleResponse设置最终标记
                        const handleResult = { success: 1, data: { id: result.files[0].arcid }, method: 'deep-search', isExactMatch: false };
                        await handleResponse(handleResult, titleElement, galleryUrl);
                        return;
                    }
                    // 如果搜索返回了结果（多个或单个），但页数不符合或多个可能匹配，收集为备选
                    if (result.count > 0 && result.files && result.files.length > 0) {
                        console.log(`[LRR Checker] 搜索返回 ${result.files.length} 个结果，收集为备选结果`);
                        fallbackResults = fallbackResults.concat(result.files);
                    }
                    searchResults.push({ type: 'gn', query, success: !!result.success });
                }
            }

            // 尝试提取标题的第一部分（去掉副标题）
            if (gnAuthor && gnTitle && gnTitle.includes('-')) {
                const titleFirstPart = gnTitle.split('-')[0].trim();
                if (titleFirstPart && titleFirstPart !== gnTitle) {
                    const simpleQuery = `${gnAuthor},${titleFirstPart}`;
                    if (!attemptedQueries.has(simpleQuery)) {
                        console.log(`[LRR Checker] Trying simplified #gn search: ${simpleQuery}`);
                        clearAllMarkers(titleElement);
                        const simpleResult = await performAlternativeSearch(simpleQuery, titleElement, galleryUrl);
                        attemptedQueries.add(simpleQuery);
                        if (simpleResult.success) {
                            return;
                        }
                        searchResults.push({ type: 'gn-simple', query: simpleQuery, success: !!simpleResult.success });
                    }
                }
            }

            if (gnAuthor && gnCoreToken) {
                const gnQueries = [];
                const gnDateVariants = buildDateVariants(gnDateToken);

                // 优先包含数字 token
                if (gnNumberTokens && gnNumberTokens.length > 0) {
                    const numberStr = gnNumberTokens.join(',');
                    gnDateVariants.forEach(date => gnQueries.push(`${gnAuthor},${date},${gnCoreToken},${numberStr}`));
                    gnQueries.push(`${gnAuthor},${gnCoreToken},${numberStr}`);
                }

                // 也保留不含数字的查询作为备选
                gnDateVariants.forEach(date => gnQueries.push(`${gnAuthor},${date},${gnCoreToken}`));
                gnQueries.push(`${gnAuthor},${gnCoreToken}`);

                for (const coreQuery of gnQueries) {
                    if (attemptedQueries.has(coreQuery)) {
                        console.log(`[LRR Checker] Skipping duplicate #gn core search: ${coreQuery}`);
                        continue;
                    }
                    console.log(`[LRR Checker] Trying #gn core search: ${coreQuery}`);
                    clearAllMarkers(titleElement);
                    const coreResult = await performAlternativeSearch(coreQuery, titleElement, galleryUrl, { skipCache: true, validator: buildResultValidator({ dateToken: gnDateToken, coreToken: gnCoreToken }) });
                    attemptedQueries.add(coreQuery);
                    if (coreResult.success) {
                        return;
                    }
                    searchResults.push({ type: 'gn-core', query: coreQuery, success: !!coreResult.success });
                }
            }

            // 注：完整 #gn 标题搜索已在第 2 层执行，此处不再重复
        }

        // 第二优先级：搜索另一种标题类型
        if (titles.gj && titles.gj !== titles.gn) {
            let { author, title: gjTitle } = extractAuthorAndTitle(titles.gj);
            const gjCoreInfo = extractCoreToken(gjTitle || titles.gj);
            const gjCoreToken = gjCoreInfo ? gjCoreInfo.token : null;
            const gjDateToken = extractDateToken(titles.gj) || extractDateToken(titles.gn);

            // 如果 #gj 没有作者，使用 #gn 的作者
            if (!author && titles.gn) {
                const gnExtract = extractAuthorAndTitle(titles.gn);
                author = gnExtract.author;
            }

            if (author && gjTitle && author !== gjTitle) {
                const query = `${author},${gjTitle}`;
                console.log(`[LRR Checker] Trying #gj search: ${query}`);
                const result = await performAlternativeSearch(query, titleElement, galleryUrl);
                if (result.success) {
                    // 成功找到，调用handleResponse设置最终标记
                    const handleResult = { success: 1, data: { id: result.files[0].arcid }, method: 'deep-search', isExactMatch: false };
                    await handleResponse(handleResult, titleElement, galleryUrl);
                    return;
                }
                // 如果搜索返回了结果（多个或单个），但页数不符合或多个可能匹配，收集为备选
                if (result.count > 0 && result.files && result.files.length > 0) {
                    console.log(`[LRR Checker] 搜索返回 ${result.files.length} 个结果，收集为备选结果`);
                    fallbackResults = fallbackResults.concat(result.files);
                }
                searchResults.push({ type: 'gj', query, success: !!result.success });
            }

            // 尝试提取标题的第一部分（去掉副标题）
            if (author && gjTitle && gjTitle.includes('-')) {
                const titleFirstPart = gjTitle.split('-')[0].trim();
                if (titleFirstPart && titleFirstPart !== gjTitle) {
                    const simpleQuery = `${author},${titleFirstPart}`;
                    console.log(`[LRR Checker] Trying simplified #gj search: ${simpleQuery}`);
                    clearAllMarkers(titleElement);
                    const simpleResult = await performAlternativeSearch(simpleQuery, titleElement, galleryUrl);
                    if (simpleResult.success) {
                        return;
                    }
                    searchResults.push({ type: 'gj-simple', query: simpleQuery, success: !!simpleResult.success });
                }
            }

            if (author && gjCoreToken) {
                const gjQueries = [];
                const gjDateVariants = buildDateVariants(gjDateToken);
                gjDateVariants.forEach(date => gjQueries.push(`${author},${date},${gjCoreToken}`));
                gjQueries.push(`${author},${gjCoreToken}`);
                for (const coreQuery of gjQueries) {
                    console.log(`[LRR Checker] Trying #gj core search: ${coreQuery}`);
                    clearAllMarkers(titleElement);
                    const coreResult = await performAlternativeSearch(coreQuery, titleElement, galleryUrl, { skipCache: true, validator: buildResultValidator({ dateToken: gjDateToken, coreToken: gjCoreToken }) });
                    if (coreResult.success) {
                        return;
                    }
                    // 如果搜索返回了结果（多个或单个），但页数不符合或多个可能匹配，收集为备选
                    if (coreResult.count > 0 && coreResult.files && coreResult.files.length > 0) {
                        console.log(`[LRR Checker] 搜索返回 ${coreResult.files.length} 个结果，收集为备选结果`);
                        fallbackResults = fallbackResults.concat(coreResult.files);
                    }
                    searchResults.push({ type: 'gj-core', query: coreQuery, success: !!coreResult.success });
                }
            }

            // 注：完整 #gj 标题搜索已在第 2 层执行，此处不再重复
        }

        if (searchResults.length > 0) {
            console.log(`[LRR Checker] Deep search with #gn/#gj failed. Tried: ${summarizeAttempts()}`);
        }

        // 最后尝试：提取日期进行搜索（避免字符转换问题）
        if (titles.gn) {
            const dateRegex = /(\d{4}[\.\-/]\d{1,2}[\.\-/]\d{1,2})/;
            const dateMatch = titles.gn.match(dateRegex);

            if (dateMatch) {
                const { author } = extractAuthorAndTitle(titles.gn);
                const dateCoreInfo = extractCoreToken(titles.gn);
                const dateCoreToken = dateCoreInfo ? dateCoreInfo.token : null;

                if (author) {
                    const dates = buildDateVariants(dateMatch[1]);
                    for (const date of dates) {
                        if (dateCoreToken) {
                            const queryWithDateAndCore = `${author},${date},${dateCoreToken}`;
                            console.log(`[LRR Checker] Final attempt with date + core: ${queryWithDateAndCore}`);
                            clearAllMarkers(titleElement);
                            const resultWithCore = await performAlternativeSearch(queryWithDateAndCore, titleElement, galleryUrl, {
                                skipCache: true,
                                precision: 'date-core',
                                validator: buildResultValidator({ dateToken: date, coreToken: dateCoreToken })
                            });
                            if (resultWithCore.success) {
                                return;
                            }
                            searchResults.push({ type: 'date-core', query: queryWithDateAndCore, success: !!resultWithCore.success });
                        }

                        const queryWithDate = `${author},${date}`;
                        console.log(`[LRR Checker] Final attempt with date: ${queryWithDate}`);
                        const result = await performAlternativeSearch(queryWithDate, titleElement, galleryUrl, {
                            skipCache: true,
                            disableStore: true,
                            precision: 'date-only',
                            validator: buildResultValidator({ dateToken: date, coreToken: null })
                        });
                        if (result.success) {
                            // 成功找到，调用handleResponse设置最终标记
                            const handleResult = { success: 1, data: { id: result.files[0].arcid }, method: 'deep-search', isExactMatch: false };
                            await handleResponse(handleResult, titleElement, galleryUrl);
                            return;
                        }
                        searchResults.push({ type: 'date', query: queryWithDate, success: !!result.success });
                    }
                }
            }
        }

        console.log(`[LRR Checker] All deep search attempts failed`);

        // 如果有保存的多结果标记，恢复它
        // 深度搜索完成，设置最终标记
        if (savedMarkerData) {
            // 有保存的多匹配标记，恢复为最终标记
            console.log(`[LRR Checker] Restoring saved multiple marker: ${savedMarkerData.icon}`);
            setFinalMarker(titleElement, {
                type: MARKER_TYPES.MULTIPLE,
                icon: savedMarkerData.icon,
                label: savedMarkerData.ariaLabel,
                className: 'lrr-marker-multiple',
                menuBuilder: savedMarkerData.options.menuBuilder
            });
        } else if (fallbackResults.length > 0) {
            // 虽然没有精确匹配，但收集到了备选结果
            console.log(`[LRR Checker] Deep search found ${fallbackResults.length} fallback result(s)`);
            if (fallbackResults.length === 1) {
                // 单个备选，显示!
                const fallbackFile = fallbackResults[0];
                setFinalMarker(titleElement, {
                    type: MARKER_TYPES.PARTIAL,
                    icon: '!',
                    label: 'LRR找到可能匹配（页数不完全符合）',
                    className: 'lrr-marker-file',
                    menuBuilder: () => ({
                        header: '可能匹配',
                        items: [{
                            text: fallbackFile.title,
                            url: `${CONFIG.lrrServerUrl}/reader?id=${fallbackFile.arcid}`,
                            thumbnailUrl: `${CONFIG.lrrServerUrl}/api/archives/${fallbackFile.arcid}/thumbnail`,
                            pagecount: fallbackFile.pagecount
                        }]
                    })
                });
                // 缓存单个备选结果
                if (cacheKey) {
                    const cacheData = { 
                        success: 0,  // 0表示备选结果
                        count: 1,
                        files: fallbackResults,
                        method: 'deep-search-partial'
                    };
                    setCache(cacheKey, cacheData);
                    console.log(`[LRR Checker] Cached partial fallback result`);
                }
            } else {
                // 多个备选，显示?N
                setFinalMarker(titleElement, {
                    type: MARKER_TYPES.MULTIPLE,
                    icon: `?${fallbackResults.length}`,
                    label: `LRR发现${fallbackResults.length}个可能匹配`,
                    className: 'lrr-marker-multiple',
                    menuBuilder: () => {
                        const items = [];
                        fallbackResults.forEach((file, index) => {
                            if (index > 0) items.push({ divider: true });
                            items.push({
                                text: `${index + 1}. ${file.title}`,
                                url: `${CONFIG.lrrServerUrl}/reader?id=${file.arcid}`,
                                thumbnailUrl: `${CONFIG.lrrServerUrl}/api/archives/${file.arcid}/thumbnail`,
                                pagecount: file.pagecount
                            });
                        });
                        return { 
                            header: `找到 ${fallbackResults.length} 个可能的匹配`, 
                            items,
                            refreshCallback: () => {
                                clearGalleryCache(galleryUrl, null);
                                const displayTitle = titleElement.textContent.replace(/\(LRR.*?\)/g, '').trim();
                                refreshGalleryCheck(galleryUrl, titleElement, displayTitle);
                            }
                        };
                    }
                });
                // 缓存多个备选结果
                if (cacheKey) {
                    const cacheData = { 
                        success: 0,  // 0表示多个备选结果
                        count: fallbackResults.length,
                        files: fallbackResults,
                        method: 'deep-search-multiple'
                    };
                    setCache(cacheKey, cacheData);
                    console.log(`[LRR Checker] Cached ${fallbackResults.length} fallback results`);
                }
            }
        } else {
            // 所有搜索都失败且没有备选，显示未找到标记
            console.log(`[LRR Checker] Deep search completed, no results found`);
            setFinalMarker(titleElement, {
                type: MARKER_TYPES.NOT_FOUND,
                icon: '🔄',
                label: 'LRR未找到匹配，点击刷新',
                className: 'lrr-marker-notfound',
                onClick: (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    clearGalleryCache(galleryUrl, null);
                    const displayTitle = titleElement.textContent.replace(/\(LRR.*?\)/g, '').trim();
                    refreshGalleryCheck(galleryUrl, titleElement, displayTitle);
                }
            });
        }
    }

    // ===== 设置面板 UI =====
    let settingsPanel = null;

    GM_addStyle(`
        .lrr-settings-mask {
            position: fixed;
            inset: 0;
            background: rgba(0,0,0,0.6);
            z-index: 99998;
        }
        .lrr-settings-panel {
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            width: min(900px, 90vw);
            max-height: 90vh;
            overflow: hidden;
            background: #f7f7fb;
            color: #222;
            border-radius: 10px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.35);
            z-index: 99999;
            display: flex;
            flex-direction: column;
        }
        .lrr-settings-panel header {
            padding: 16px 20px;
            font-size: 18px;
            font-weight: 700;
            border-bottom: 1px solid #e3e4ec;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .lrr-settings-panel header button {
            border: none;
            background: transparent;
            font-size: 24px;
            cursor: pointer;
            line-height: 1;
        }
        .lrr-settings-body {
            padding: 20px;
            overflow: auto;
            flex: 1;
        }
        .lrr-settings-form {
            display: grid;
            grid-template-columns: 2fr 1fr;
            gap: 25px;
        }
        .lrr-settings-left,
        .lrr-settings-right {
            display: flex;
            flex-direction: column;
            gap: 12px;
        }
        .lrr-settings-right {
            padding-left: 20px;
            border-left: 2px solid #e8e8f0;
        }
        .lrr-settings-section-title {
            font-size: 15px;
            font-weight: bold;
            margin: 0 0 8px 0;
            color: #5c0d12;
            border-bottom: 1px solid #e8e8f0;
            padding-bottom: 6px;
        }
        .lrr-settings-form label:not(.lrr-settings-checkbox-label) {
            display: flex;
            flex-direction: column;
            font-size: 13px;
            gap: 5px;
        }
        .lrr-settings-form label span {
            font-weight: 600;
        }
        .lrr-settings-right label:not(.lrr-settings-checkbox-label) {
            align-items: flex-start;
        }
        .lrr-settings-form input[type="text"],
        .lrr-settings-form input[type="number"],
        .lrr-settings-form textarea {
            padding: 8px 12px;
            border: 1px solid #d1d5e8;
            border-radius: 4px;
            font-size: 14px;
        }
        .lrr-settings-form input[type="number"] {
            width: 120px;
        }
        .lrr-settings-form textarea {
            resize: vertical;
            min-height: 50px;
        }
        .lrr-settings-form input[type="checkbox"] {
            width: 18px;
            height: 18px;
        }
        .lrr-settings-form .lrr-settings-checkbox-label {
            display: flex !important;
            flex-direction: row !important;
            align-items: flex-start !important;
            gap: 8px !important;
            margin-bottom: 12px !important;
            justify-content: flex-start !important;
        }
        .lrr-settings-checkbox-label input[type="checkbox"] {
            margin-top: 3px;
            flex-shrink: 0;
        }
        .lrr-settings-checkbox-label > span,
        .lrr-settings-checkbox-label > div {
            font-size: 14px;
            line-height: 1.5;
        }
        .lrr-settings-footer {
            padding: 16px 20px;
            border-top: 1px solid #e3e4ec;
            display: flex;
            gap: 10px;
            justify-content: flex-end;
        }
        .lrr-settings-btn {
            padding: 8px 16px;
            border: 1px solid #ccd3ea;
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
            min-width: 120px;
            box-sizing: border-box;
        }

        .lrr-cache-button-row {
            display: flex;
            gap: 10px;
            margin-bottom: 10px;
            flex-wrap: wrap;
            justify-content: center;
        }
        .lrr-settings-btn-primary {
            background: #4c7ef3;
            color: #fff;
            border-color: #4c7ef3;
        }
        .lrr-settings-btn-primary:hover {
            background: #3a6ad9;
        }
        .lrr-settings-btn-ghost {
            background: #fff;
            color: #333;
        }
        .lrr-settings-btn-ghost:hover {
            background: #f0f1f7;
        }
        .lrr-settings-shortcut {
            display: inline-flex;
            margin-left: 8px;
        }
        .lrr-settings-shortcut button {
            border: 1px solid #ccd3ea;
            background: #fff;
            color: #333;
            padding: 2px 10px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
        }
        .lrr-settings-shortcut button:hover {
            background: #4c7ef3;
            color: #fff;
            border-color: #4c7ef3;
        }
        .lrr-settings-section {
            margin-top: 20px;
            padding-top: 20px;
            border-top: 1px solid #e3e4ec;
        }
        .lrr-settings-section h3 {
            margin: 0 0 12px 0;
            font-size: 16px;
        }
        .lrr-settings-cache-info {
            font-size: 13px;
            color: #666;
            margin-bottom: 10px;
        }
    `);

    function openSettingsPanel() {
        if (settingsPanel) return;

        const mask = document.createElement('div');
        mask.className = 'lrr-settings-mask';
        mask.onclick = closeSettingsPanel;

        const panel = document.createElement('div');
        panel.className = 'lrr-settings-panel';
        settingsPanel = panel;

        const header = document.createElement('header');
        header.innerHTML = '<span>LRR Checker 设置</span>';
        const closeBtn = document.createElement('button');
        closeBtn.textContent = '×';
        closeBtn.onclick = closeSettingsPanel;
        header.appendChild(closeBtn);
        panel.appendChild(header);

        const body = document.createElement('div');
        body.className = 'lrr-settings-body';

        const form = document.createElement('div');
        form.className = 'lrr-settings-form';
        form.innerHTML = `
            <div class="lrr-settings-left">
                <h3 class="lrr-settings-section-title">关键词管理</h3>
                <label>
                    <span>作者白名单（逗号分隔，用于匹配作者）</span>
                    <textarea id="authorWhitelist" rows="2">${CONFIG.authorWhitelist || CONFIG.authorKeywords || ''}</textarea>
                </label>
                <label>
                    <span>核心白名单（逗号分隔，保留角色/作品关键词）</span>
                    <textarea id="coreWhitelist" rows="2">${CONFIG.coreWhitelist || ''}</textarea>
                </label>
                <label>
                    <span>核心黑名单（逗号分隔，剔除固定后缀/噪声）</span>
                    <textarea id="coreBlacklist" rows="2">${CONFIG.coreBlacklist || CONFIG.tagKeywords || ''}</textarea>
                </label>

                <h3 class="lrr-settings-section-title" style="margin-top: 15px;">服务器设置</h3>
                <label>
                    <span>Lanraragi 服务器地址</span>
                    <input type="text" id="lrrServerUrl" value="${CONFIG.lrrServerUrl}" placeholder="http://192.168.1.100:3000" />
                </label>
                <label>
                    <span>API 密钥（可选）</span>
                    <input type="text" id="lrrApiKey" value="${CONFIG.lrrApiKey}" placeholder="留空表示无需密钥" />
                </label>
                <div style="display:flex;gap:10px;align-items:center;margin-top:6px;">
                    <button class="lrr-settings-btn lrr-settings-btn-primary" id="lrrTestConnectionBtn" type="button">测试连接</button>
                    <span id="lrrTestConnectionResult" style="font-size:12px;color:#666;">用当前地址/API Key 发送测试请求</span>
                </div>
            </div>

            <div class="lrr-settings-right">
                <h3 class="lrr-settings-section-title">数值配置</h3>
                <label>
                    <span>最大并发请求数</span>
                    <input type="number" id="maxConcurrentRequests" value="${CONFIG.maxConcurrentRequests}" min="1" max="20" />
                </label>
                <label>
                    <span>缓存有效期（天）</span>
                    <input type="number" id="cacheExpiryDays" value="${CONFIG.cacheExpiryDays}" min="1" max="365" />
                </label>
                <label>
                    <span>深度搜索并发数</span>
                    <input type="number" id="deepSearchConcurrency" value="${CONFIG.deepSearchConcurrency}" min="1" max="10" />
                </label>
                <label>
                    <span>深度搜索间隔（毫秒）</span>
                    <input type="number" id="deepSearchDelay" value="${CONFIG.deepSearchDelay}" min="0" max="5000" step="100" />
                </label>

                <h3 class="lrr-settings-section-title" style="margin-top: 20px;">功能开关</h3>
                <label class="lrr-settings-checkbox-label">
                    <input type="checkbox" id="enableDeepSearch" ${CONFIG.enableDeepSearch ? 'checked' : ''} />
                    <span>启用深度搜索</span>
                </label>
                <label class="lrr-settings-checkbox-label">
                    <input type="checkbox" id="cacheNotFoundResults" ${CONFIG.cacheNotFoundResults ? 'checked' : ''} />
                    <span>缓存未匹配结果</span>
                </label>
                <label class="lrr-settings-checkbox-label">
                    <input type="checkbox" id="enablePagecountMatching" ${CONFIG.enablePagecountMatching ? 'checked' : ''} />
                    <span>启用页数匹配（精确搜索）</span>
                </label>
                <label>
                    <span>页数误差范围（正负多少页）</span>
                    <input type="number" id="pagecountTolerance" value="${CONFIG.pagecountTolerance}" min="0" max="20" />
                </label>
                <label>
                    <span>标题搜索优先级</span>
                    <select id="titleSearchOrder" style="padding: 4px; border-radius: 4px;">
                        <option value="gj" ${CONFIG.titleSearchOrder === 'gj' ? 'selected' : ''}>优先搜索日文标题 (#gj)</option>
                        <option value="gn" ${CONFIG.titleSearchOrder === 'gn' ? 'selected' : ''}>优先搜索英文标题 (#gn)</option>
                    </select>
                </label>
            </div>
        `;
        body.appendChild(form);

        // 缓存管理区域
        const cacheSection = document.createElement('div');
        cacheSection.className = 'lrr-settings-section';

        // 统计缓存数量
        const titleCacheCount = Object.keys(getTitleCache()).length;
        let urlCacheCount = 0;
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.startsWith('lrr-checker-')) {
                urlCacheCount++;
            }
        }

        const searchCacheCount = Object.keys(getSearchCache()).length;

        cacheSection.innerHTML = `
            <h3>缓存管理</h3>
            <div class="lrr-settings-cache-info">
                标题缓存: ${titleCacheCount} 条 | 搜索结果缓存: ${searchCacheCount} 条 | URL 匹配结果缓存: ${urlCacheCount} 条
            </div>
        `;

        const cacheButtons = document.createElement('div');

        // 第一行：导入导出按钮
        const row1 = document.createElement('div');
        row1.className = 'lrr-cache-button-row';

        const exportCacheBtn = document.createElement('button');
        exportCacheBtn.className = 'lrr-settings-btn lrr-settings-btn-ghost';
        exportCacheBtn.textContent = '导出标题缓存';
        exportCacheBtn.onclick = exportTitleCache;

        const importCacheBtn = document.createElement('button');
        importCacheBtn.className = 'lrr-settings-btn lrr-settings-btn-ghost';
        importCacheBtn.textContent = '导入标题缓存';
        importCacheBtn.onclick = importTitleCache;

        const exportAllCachesBtn = document.createElement('button');
        exportAllCachesBtn.className = 'lrr-settings-btn lrr-settings-btn-ghost';
        exportAllCachesBtn.textContent = '导出所有缓存';
        exportAllCachesBtn.onclick = exportAllCaches;
        exportAllCachesBtn.style.fontWeight = 'bold';

        const importAllCachesBtn = document.createElement('button');
        importAllCachesBtn.className = 'lrr-settings-btn lrr-settings-btn-ghost';
        importAllCachesBtn.textContent = '导入所有缓存';
        importAllCachesBtn.onclick = importAllCaches;
        importAllCachesBtn.style.fontWeight = 'bold';

        row1.appendChild(exportCacheBtn);
        row1.appendChild(importCacheBtn);
        row1.appendChild(exportAllCachesBtn);
        row1.appendChild(importAllCachesBtn);

        // 第二行：清空按钮
        const row2 = document.createElement('div');
        row2.className = 'lrr-cache-button-row';

        const clearTitleCacheBtn = document.createElement('button');
        clearTitleCacheBtn.className = 'lrr-settings-btn lrr-settings-btn-ghost';
        clearTitleCacheBtn.textContent = '清空标题缓存';
        clearTitleCacheBtn.onclick = clearTitleCache;

        const clearSearchCacheBtn = document.createElement('button');
        clearSearchCacheBtn.className = 'lrr-settings-btn lrr-settings-btn-ghost';
        clearSearchCacheBtn.textContent = '清空搜索缓存';
        clearSearchCacheBtn.onclick = clearSearchCache;

        const clearUrlCacheBtn = document.createElement('button');
        clearUrlCacheBtn.className = 'lrr-settings-btn lrr-settings-btn-ghost';
        clearUrlCacheBtn.textContent = '清空URL缓存';
        clearUrlCacheBtn.onclick = clearUrlCache;

        const clearAllCachesBtn = document.createElement('button');
        clearAllCachesBtn.className = 'lrr-settings-btn lrr-settings-btn-ghost';
        clearAllCachesBtn.textContent = '清空所有缓存';
        clearAllCachesBtn.onclick = clearAllCaches;
        clearAllCachesBtn.style.fontWeight = 'bold';

        row2.appendChild(clearTitleCacheBtn);
        row2.appendChild(clearSearchCacheBtn);
        row2.appendChild(clearUrlCacheBtn);
        row2.appendChild(clearAllCachesBtn);

        cacheButtons.appendChild(row1);
        cacheButtons.appendChild(row2);
        cacheSection.appendChild(cacheButtons);
        body.appendChild(cacheSection);

        panel.appendChild(body);

        const footer = document.createElement('div');
        footer.className = 'lrr-settings-footer';
        footer.style.display = 'flex';
        footer.style.justifyContent = 'space-between';
        footer.style.alignItems = 'center';

        // 左侧：关键词按钮
        const leftButtons = document.createElement('div');
        leftButtons.style.display = 'flex';
        leftButtons.style.gap = '8px';

        const exportKeywordsBtn = document.createElement('button');
        exportKeywordsBtn.className = 'lrr-settings-btn lrr-settings-btn-ghost';
        exportKeywordsBtn.textContent = '导出关键词';
        exportKeywordsBtn.style.fontSize = '13px';
        exportKeywordsBtn.style.padding = '6px 12px';
        exportKeywordsBtn.onclick = exportKeywords;

        const importKeywordsBtn = document.createElement('button');
        importKeywordsBtn.className = 'lrr-settings-btn lrr-settings-btn-ghost';
        importKeywordsBtn.textContent = '导入关键词';
        importKeywordsBtn.style.fontSize = '13px';
        importKeywordsBtn.style.padding = '6px 12px';
        importKeywordsBtn.onclick = importKeywords;

        leftButtons.appendChild(exportKeywordsBtn);
        leftButtons.appendChild(importKeywordsBtn);

        // 右侧：保存和取消按钮
        const rightButtons = document.createElement('div');
        rightButtons.style.display = 'flex';
        rightButtons.style.gap = '10px';

        const saveBtn = document.createElement('button');
        saveBtn.className = 'lrr-settings-btn lrr-settings-btn-primary';
        saveBtn.textContent = '保存';
        saveBtn.onclick = () => {
            CONFIG.authorWhitelist = document.getElementById('authorWhitelist').value.trim();
            CONFIG.coreWhitelist = document.getElementById('coreWhitelist').value.trim();
            CONFIG.coreBlacklist = document.getElementById('coreBlacklist').value.trim();
            // 同步旧字段，兼容旧配置结构
            CONFIG.authorKeywords = CONFIG.authorWhitelist;
            CONFIG.tagKeywords = CONFIG.coreBlacklist;
            CONFIG.lrrServerUrl = document.getElementById('lrrServerUrl').value.trim();
            CONFIG.lrrApiKey = document.getElementById('lrrApiKey').value.trim();
            CONFIG.maxConcurrentRequests = parseInt(document.getElementById('maxConcurrentRequests').value);
            CONFIG.cacheExpiryDays = parseInt(document.getElementById('cacheExpiryDays').value);
            CONFIG.enableDeepSearch = document.getElementById('enableDeepSearch').checked;

            // 处理缓存未匹配结果选项
            const newCacheNotFoundResults = document.getElementById('cacheNotFoundResults').checked;
            const oldCacheNotFoundResults = CONFIG.cacheNotFoundResults;
            CONFIG.cacheNotFoundResults = newCacheNotFoundResults;

            // 如果从启用改为禁用，清除所有未匹配的缓存
            if (oldCacheNotFoundResults && !newCacheNotFoundResults) {
                console.log('[LRR Checker] Clearing all not-found cached results...');
                const keys = Object.keys(localStorage);
                let clearedCount = 0;
                for (const key of keys) {
                    if (key.startsWith('lrr-search-')) {
                        try {
                            const cached = JSON.parse(localStorage.getItem(key));
                            if (cached && cached.success === false) {
                                localStorage.removeItem(key);
                                clearedCount++;
                            }
                        } catch (e) {
                            // 忽略解析错误
                        }
                    }
                }
                console.log(`[LRR Checker] Cleared ${clearedCount} not-found cached results`);
            }

            CONFIG.deepSearchConcurrency = parseInt(document.getElementById('deepSearchConcurrency').value);
            CONFIG.deepSearchDelay = parseInt(document.getElementById('deepSearchDelay').value);
            CONFIG.enablePagecountMatching = document.getElementById('enablePagecountMatching').checked;
            CONFIG.pagecountTolerance = parseInt(document.getElementById('pagecountTolerance').value);
            CONFIG.titleSearchOrder = document.getElementById('titleSearchOrder').value;

            saveConfig(CONFIG);
            alert('设置已保存！页面将刷新以应用新配置。');
            location.reload();
        };

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'lrr-settings-btn lrr-settings-btn-ghost';
        cancelBtn.textContent = '取消';
        cancelBtn.onclick = closeSettingsPanel;

        rightButtons.appendChild(saveBtn);
        rightButtons.appendChild(cancelBtn);

        footer.appendChild(leftButtons);
        footer.appendChild(rightButtons);
        panel.appendChild(footer);

        document.body.appendChild(mask);
        document.body.appendChild(panel);

        // 绑定测试连接按钮
        const testBtn = document.getElementById('lrrTestConnectionBtn');
        const testResultSpan = document.getElementById('lrrTestConnectionResult');
        if (testBtn) {
            testBtn.onclick = async () => {
                if (testResultSpan) {
                    testResultSpan.textContent = '测试中...';
                    testResultSpan.style.color = '#666';
                }
                const testUrl = document.getElementById('lrrServerUrl').value.trim() || DEFAULT_LRR_SERVER_URL;
                const testKey = document.getElementById('lrrApiKey').value.trim() || '';
                const formatTestError = (err) => {
                    if (!err) return '未知错误';
                    if (typeof err === 'string') return err;
                    if (err.status) {
                        return `HTTP ${err.status}${err.statusText ? ' ' + err.statusText : ''}`;
                    }
                    if (err.message) return err.message;
                    return '请求失败';
                };
                try {
                    const resp = await makeRequest({
                        method: 'GET',
                        url: `${testUrl}/api/search/random?filter=${encodeURIComponent('lrr-connection-test')}`,
                        // 禁用 Cookie，确保真正测试 API Key 而非登录态
                        anonymous: true,
                        apiKeyOverride: testKey || null,
                        suppressAuthToast: true
                    });
                    if (resp.status === 200) {
                        if (testResultSpan) {
                            testResultSpan.textContent = '测试成功，可正常访问。请点击“保存”以应用。';
                            testResultSpan.style.color = '#1e8e3e';
                        } else {
                            alert('测试成功：服务器可访问，API Key 可用或服务器允许匿名访问');
                        }
                    } else {
                        const msg = `测试返回状态 ${resp.status}，请检查服务器/Key`;
                        if (testResultSpan) {
                            testResultSpan.textContent = msg;
                            testResultSpan.style.color = '#d93025';
                        } else {
                            alert(msg);
                        }
                    }
                } catch (err) {
                    const errMsg = formatTestError(err);
                    if (err?.isAuthError) {
                        if (testResultSpan) {
                            testResultSpan.textContent = '测试失败：认证错误（请检查 API Key）';
                            testResultSpan.style.color = '#d93025';
                        } else {
                            alert('测试失败：认证错误（请检查 API Key）');
                        }
                    } else {
                        const msg = `测试失败：${errMsg}`;
                        if (testResultSpan) {
                            testResultSpan.textContent = msg;
                            testResultSpan.style.color = '#d93025';
                        } else {
                            alert(msg);
                        }
                    }
                }
            };
        }
    }

    function closeSettingsPanel() {
        if (!settingsPanel) return;
        const mask = document.querySelector('.lrr-settings-mask');
        if (mask) mask.remove();
        settingsPanel.remove();
        settingsPanel = null;
    }

    // 添加设置按钮到搜索栏
    function addSettingsButton() {
        const target = document.querySelector('.searchtext');
        if (!target) return;

        const wrapper = document.createElement('span');
        wrapper.className = 'lrr-settings-shortcut';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = 'LRR 设置';
        btn.onclick = openSettingsPanel;
        wrapper.appendChild(btn);

        const anchor = target.querySelector('p') || target;
        anchor.appendChild(wrapper);
    }

    // 注册菜单命令
    GM_registerMenuCommand('LRR Checker 设置', openSettingsPanel);

    // 页面加载完成后添加设置按钮
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', addSettingsButton);
    } else {
        addSettingsButton();
    }


    // ===== 简繁体转换映射表初始化 (OpenCC) =====
    // 数据来源: https://github.com/BYVoid/OpenCC
    // 简体→繁体: 2703 字符，繁体→简体: 3561 字符
    (function initOpenCCMaps() {
        const S2T_STR =
        "万萬与與丑醜专專业業丛叢东東丝絲丢丟两兩严嚴丧喪个個丰豐临臨为爲丽麗举舉么麼义義乌烏乐樂乔喬习習乡鄉书書买買乱亂了了争爭于於亏虧云雲亘亙亚亞产產亩畝亲親亵褻亸嚲亿億仅僅仆僕仇仇从從仑侖仓倉仪儀们們价價" +
        "仿仿众衆优優伙夥会會伛傴伞傘伟偉传傳伡俥伣俔伤傷伥倀伦倫伧傖伪僞伫佇体體余餘佛佛佣傭佥僉侠俠侣侶侥僥侦偵侧側侨僑侩儈侪儕侬儂侭儘俊俊俣俁俦儔俨儼俩倆俪儷俫倈俭儉修修借借债債倾傾偬傯偻僂偾僨偿償傤儎傥儻" +
        "傧儐储儲傩儺僵僵儿兒克克兑兌兖兗党黨兰蘭关關兴興兹茲养養兽獸冁囅内內冈岡册冊写寫军軍农農冬冬冯馮冲衝决決况況冻凍净淨凄悽准準凉涼凌凌减減凑湊凛凜几幾凤鳳凫鳧凭憑凯凱凶兇出出击擊凿鑿刍芻划劃刘劉则則刚剛" +
        "创創删刪别別刬剗刭剄刮刮制制刹剎刽劊刾㓨刿劌剀剴剂劑剐剮剑劍剥剝剧劇劝勸办辦务務劢勱动動励勵劲勁劳勞势勢勋勳勚勩匀勻匦匭匮匱区區医醫千千升升华華协協单單卖賣卜卜占佔卢盧卤滷卧臥卫衛却卻卷卷卺巹厂廠厅廳" +
        "历歷厉厲压壓厌厭厍厙厐龎厕廁厘釐厢廂厣厴厦廈厨廚厩廄厮廝县縣叁叄参參叆靉叇靆双雙发發变變叙敘叠疊只只台臺叶葉号號叹嘆叽嘰吁籲吃喫合合吊吊同同后後向向吓嚇吕呂吗嗎吨噸听聽启啓吴吳呐吶呒嘸呓囈呕嘔呖嚦呗唄" +
        "员員呙咼呛嗆呜嗚周周咏詠咙嚨咛嚀咝噝咤吒咨諮咸鹹咽咽哄哄响響哑啞哒噠哓嘵哔嗶哕噦哗譁哙噲哜嚌哝噥哟喲唇脣唛嘜唝嗊唠嘮唡啢唢嗩唤喚啧嘖啬嗇啭囀啮齧啯嘓啰囉啴嘽啸嘯喂喂喷噴喽嘍喾嚳嗫囁嗳噯嘘噓嘤嚶嘱囑噜嚕" +
        "噪噪嚣囂回回团團园園困困囱囪围圍囵圇国國图圖圆圓圣聖圹壙场場坏壞块塊坚堅坛壇坜壢坝壩坞塢坟墳坠墜垄壟垅壠垆壚垒壘垦墾垩堊垫墊垭埡垯墶垱壋垲塏垴堖埘塒埙壎埚堝堑塹堕墮塆壪墙牆壮壯声聲壳殼壶壺壸壼处處备備" +
        "复復够夠夫夫头頭夸誇夹夾夺奪奁奩奂奐奋奮奖獎奥奧奸奸妆妝妇婦妈媽妩嫵妪嫗妫嬀姗姍姜姜姹奼娄婁娅婭娆嬈娇嬌娈孌娘娘娱娛娲媧娴嫺婳嫿婴嬰婵嬋婶嬸媪媼媭嬃嫒嬡嫔嬪嫱嬙嬷嬤孙孫学學孪孿宁寧它它宝寶实實宠寵审審" +
        "宪憲宫宮家家宽寬宾賓寝寢对對寻尋导導寿壽将將尔爾尘塵尝嘗尧堯尴尷尸屍尽盡局局层層屃屓屉屜届屆属屬屡屢屦屨屿嶼岁歲岂豈岖嶇岗崗岘峴岚嵐岛島岩巖岭嶺岳嶽岽崬岿巋峃嶨峄嶧峡峽峣嶢峤嶠峥崢峦巒峰峯崂嶗崃崍崄嶮" +
        "崭嶄嵘嶸嵚嶔嵝嶁巅巔巨巨巩鞏巯巰币幣布布帅帥师師帏幃帐帳帘簾帜幟带帶帧幀席席帮幫帱幬帻幘帼幗幂冪干幹并並幸幸广廣庄莊庆慶床牀庐廬庑廡库庫应應庙廟庞龐废廢庵庵庼廎廪廩开開异異弃棄弑弒张張弥彌弦弦弪弳弯彎" +
        "弹彈强強归歸当當录錄彟彠彦彥彨彲彩彩彻徹征徵径徑徕徠御御忆憶忏懺志志忧憂念念忾愾怀懷态態怂慫怃憮怄慪怅悵怆愴怜憐总總怼懟怿懌恋戀恒恆恤恤恳懇恶惡恸慟恹懨恺愷恻惻恼惱恽惲悦悅悫愨悬懸悭慳悮悞悯憫惊驚惧懼" +
        "惨慘惩懲惫憊惬愜惭慚惮憚惯慣愈愈愠慍愤憤愦憒愿願慑懾慭憖懑懣懒懶懔懍戆戇戋戔戏戲戗戧战戰戚戚戬戩戯戱户戶才才扎扎扑撲托託扣扣执執扩擴扪捫扫掃扬揚扰擾折折抚撫抛拋抟摶抠摳抡掄抢搶护護报報抵抵担擔拐拐拟擬" +
        "拢攏拣揀拥擁拦攔拧擰拨撥择擇挂掛挚摯挛攣挜掗挝撾挞撻挟挾挠撓挡擋挢撟挣掙挤擠挥揮挦撏挨挨挽挽捝挩捞撈损損捡撿换換捣搗据據掳擄掴摑掷擲掸撣掺摻掼摜揽攬揾搵揿撳搀攙搁擱搂摟搄揯搅攪搜搜携攜摄攝摅攄摆擺摇搖" +
        "摈擯摊攤撄攖撑撐撵攆撷擷撸擼撺攛擜㩵擞擻攒攢敌敵敚敓敛斂敩斆数數斋齋斓斕斗鬥斩斬断斷旋旋无無旧舊时時旷曠旸暘昆昆昙曇昵暱昼晝昽曨显顯晋晉晒曬晓曉晔曄晕暈晖暉暂暫暅𣈶暗暗暧曖曲曲术術朱朱朴樸机機杀殺杂雜" +
        "权權杆杆杠槓条條来來杨楊杩榪杯杯杰傑松松板板极極构構枞樅枢樞枣棗枥櫪枧梘枨棖枪槍枫楓枭梟柜櫃柠檸柽檉栀梔栅柵标標栈棧栉櫛栊櫳栋棟栌櫨栎櫟栏欄树樹栖棲栗栗样樣核核栾欒桠椏桡橈桢楨档檔桤榿桥橋桦樺桧檜桨槳" +
        "桩樁桪樳梁梁梦夢梼檮梾棶梿槤检檢棁梲棂欞椁槨椝槼椟櫝椠槧椢槶椤欏椫樿椭橢椮槮楼樓榄欖榅榲榇櫬榈櫚榉櫸榝樧槚檟槛檻槟檳槠櫧横橫樯檣樱櫻橥櫫橱櫥橹櫓橼櫞檩檁欢歡欤歟欧歐欲欲歼殲殁歿殇殤残殘殒殞殓殮殚殫殡殯" +
        "殴毆毁毀毂轂毕畢毙斃毡氈毵毿毶𣯶氇氌气氣氢氫氩氬氲氳汇匯汉漢汤湯汹洶沄澐沈沈沟溝没沒沣灃沤漚沥瀝沦淪沧滄沨渢沩潙沪滬沾沾泛泛泞濘注注泪淚泶澩泷瀧泸瀘泺濼泻瀉泼潑泽澤泾涇洁潔洒灑洼窪浃浹浅淺浆漿浇澆浈湞" +
        "浉溮浊濁测測浍澮济濟浏瀏浐滻浑渾浒滸浓濃浔潯浕濜涂塗涌湧涚涗涛濤涝澇涞淶涟漣涠潿涡渦涢溳涣渙涤滌润潤涧澗涨漲涩澀淀澱渊淵渌淥渍漬渎瀆渐漸渑澠渔漁渖瀋渗滲温溫游遊湾灣湿溼溁濚溃潰溅濺溆漵溇漊滗潷滚滾滞滯" +
        "滟灩滠灄满滿滢瀅滤濾滥濫滦灤滨濱滩灘滪澦漓漓潆瀠潇瀟潋瀲潍濰潜潛潴瀦澛瀂澜瀾濑瀨濒瀕灏灝灭滅灯燈灵靈灶竈灾災灿燦炀煬炉爐炖燉炜煒炝熗点點炼煉炽熾烁爍烂爛烃烴烛燭烟煙烦煩烧燒烨燁烩燴烫燙烬燼热熱焕煥焖燜" +
        "焘燾煴熅熏燻爱愛爷爺牍牘牦犛牵牽牺犧犊犢状狀犷獷犸獁犹猶狈狽狝獮狞獰独獨狭狹狮獅狯獪狰猙狱獄狲猻猃獫猎獵猕獼猡玀猪豬猫貓猬蝟献獻獭獺玑璣玙璵玚瑒玛瑪玩玩玮瑋环環现現玱瑲玺璽珐琺珑瓏珰璫珲琿琎璡琏璉琐瑣" +
        "琼瓊瑶瑤瑷璦瑸璸璇璇璎瓔瓒瓚瓮甕瓯甌电電画畫畅暢畴疇疖癤疗療疟瘧疠癘疡瘍疬癧疭瘲疮瘡疯瘋疱皰疴痾症症痈癰痉痙痒癢痖瘂痨癆痪瘓痫癇痴癡瘅癉瘆瘮瘗瘞瘘瘻瘪癟瘫癱瘾癮瘿癭癞癩癣癬癫癲皂皁皑皚皱皺皲皸盏盞盐鹽" +
        "监監盖蓋盗盜盘盤眍瞘眦眥眬矓睁睜睐睞睑瞼瞆瞶瞒瞞瞩矚矩矩矫矯矶磯矾礬矿礦砀碭码碼砖磚砗硨砚硯砜碸砺礪砻礱砾礫础礎硁硜硕碩硖硤硗磽硙磑硚礄确確硵磠硷礆碍礙碛磧碜磣碱鹼礼禮祃禡祎禕祢禰祯禎祷禱祸禍禀稟禄祿" +
        "禅禪离離私私秃禿秆稈秋秋种種秘祕积積称稱秽穢秾穠稆穭税稅稣穌稳穩穑穡穞穭穷窮窃竊窍竅窎窵窑窯窜竄窝窩窥窺窦竇窭窶竖豎竞競笃篤笋筍笔筆笕筧笺箋笼籠笾籩筑築筚篳筛篩筜簹筝箏筹籌筼篔签籤筿篠简簡箓籙箦簀箧篋" +
        "箨籜箩籮箪簞箫簫篑簣篓簍篮籃篯籛篱籬簖籪籁籟籴糴类類籼秈粜糶粝糲粤粵粪糞粮糧粽糉糁糝糇餱糍餈系系紧緊絷縶緼縕縆緪纟糹纠糾纡紆红紅纣紂纤纖纥紇约約级級纨紈纩纊纪紀纫紉纬緯纭紜纮紘纯純纰紕纱紗纲綱纳納纴紝" +
        "纵縱纶綸纷紛纸紙纹紋纺紡纻紵纼紖纽紐纾紓线線绀紺绁紲绂紱练練组組绅紳细細织織终終绉縐绊絆绋紼绌絀绍紹绎繹经經绐紿绑綁绒絨结結绔絝绕繞绖絰绗絎绘繪给給绚絢绛絳络絡绝絕绞絞统統绠綆绡綃绢絹绣繡绤綌绥綏绦絛" +
        "继繼绨綈绩績绪緒绫綾绬緓续續绮綺绯緋绰綽绱鞝绲緄绳繩维維绵綿绶綬绷繃绸綢绹綯绺綹绻綣综綜绽綻绾綰绿綠缀綴缁緇缂緙缃緗缄緘缅緬缆纜缇緹缈緲缉緝缊縕缋繢缌緦缍綞缎緞缏緶缐線缑緱缒縋缓緩缔締缕縷编編缗緡缘緣" +
        "缙縉缚縛缛縟缜縝缝縫缞縗缟縞缠纏缡縭缢縊缣縑缤繽缥縹缦縵缧縲缨纓缩縮缪繆缫繅缬纈缭繚缮繕缯繒缰繮缱繾缲繰缳繯缴繳缵纘罂罌网網罗羅罚罰罢罷罴羆羁羈羟羥羡羨群羣翘翹翙翽翚翬耢耮耧耬耸聳耻恥聂聶聋聾职職聍聹" +
        "联聯聩聵聪聰肃肅肠腸肤膚肮骯肴餚肾腎肿腫胀脹胁脅胄胄胆膽背背胜勝胡胡胧朧胨腖胪臚胫脛胶膠脉脈脍膾脏髒脐臍脑腦脓膿脔臠脚腳脱脫脶腡脸臉腊臘腌醃腘膕腭齶腻膩腼靦腽膃腾騰膑臏膻羶臜臢致致舆輿舍舍舣艤舰艦舱艙" +
        "舻艫艰艱艳豔艺藝节節芈羋芗薌芜蕪芦蘆芸芸苁蓯苇葦苈藶苋莧苌萇苍蒼苎苧苏蘇苔苔苧薴苹蘋范範茎莖茏蘢茑蔦茔塋茕煢茧繭荆荊荐薦荙薘荚莢荛蕘荜蓽荝萴荞蕎荟薈荠薺荡蕩荣榮荤葷荥滎荦犖荧熒荨蕁荩藎荪蓀荫蔭荬蕒荭葒" +
        "荮葤药藥莅蒞莱萊莲蓮莳蒔莴萵莶薟获獲莸蕕莹瑩莺鶯莼蓴萚蘀萝蘿萤螢营營萦縈萧蕭萨薩葱蔥蒀蒕蒇蕆蒉蕢蒋蔣蒌蔞蒏醟蒙蒙蓝藍蓟薊蓠蘺蓣蕷蓥鎣蓦驀蔂虆蔑蔑蔷薔蔹蘞蔺藺蔼藹蕰薀蕲蘄蕴蘊薮藪藓蘚藴蘊蘖櫱虏虜虑慮虚虛" +
        "虫蟲虬虯虮蟣虱蝨虽雖虾蝦虿蠆蚀蝕蚁蟻蚂螞蚃蠁蚕蠶蚝蠔蚬蜆蛊蠱蛎蠣蛏蟶蛮蠻蛰蟄蛱蛺蛲蟯蛳螄蛴蠐蜕蛻蜗蝸蜡蠟蝇蠅蝈蟈蝉蟬蝎蠍蝼螻蝾蠑螀螿螨蟎蟏蠨衅釁衔銜补補表表衬襯衮袞袄襖袅嫋袆褘袜襪袭襲袯襏装裝裆襠裈褌" +
        "裢褳裣襝裤褲裥襉褛褸褴襤襕襴见見观觀觃覎规規觅覓视視觇覘览覽觉覺觊覬觋覡觌覿觍覥觎覦觏覯觐覲觑覷觞觴触觸觯觶訚誾詟讋誉譽誊謄讠訁计計订訂讣訃认認讥譏讦訐讧訌讨討让讓讪訕讫訖讬託训訓议議讯訊记記讱訒讲講" +
        "讳諱讴謳讵詎讶訝讷訥许許讹訛论論讻訩讼訟讽諷设設访訪诀訣证證诂詁诃訶评評诅詛识識诇詗诈詐诉訴诊診诋詆诌謅词詞诎詘诏詔诐詖译譯诒詒诓誆诔誄试試诖詿诗詩诘詰诙詼诚誠诛誅诜詵话話诞誕诟詬诠詮诡詭询詢诣詣诤諍" +
        "该該详詳诧詫诨諢诩詡诪譸诫誡诬誣语語诮誚误誤诰誥诱誘诲誨诳誑说說诵誦诶誒请請诸諸诹諏诺諾读讀诼諑诽誹课課诿諉谀諛谁誰谂諗调調谄諂谅諒谆諄谇誶谈談谉讅谊誼谋謀谌諶谍諜谎謊谏諫谐諧谑謔谒謁谓謂谔諤谕諭谖諼" +
        "谗讒谘諮谙諳谚諺谛諦谜謎谝諞谞諝谟謨谠讜谡謖谢謝谣謠谤謗谥諡谦謙谧謐谨謹谩謾谪謫谫譾谬謬谭譚谮譖谯譙谰讕谱譜谲譎谳讞谴譴谵譫谶讖谷谷豮豶贝貝贞貞负負贠貟贡貢财財责責贤賢败敗账賬货貨质質贩販贪貪贫貧贬貶" +
        "购購贮貯贯貫贰貳贱賤贲賁贳貰贴貼贵貴贶貺贷貸贸貿费費贺賀贻貽贼賊贽贄贾賈贿賄赀貲赁賃赂賂赃贓资資赅賅赆贐赇賕赈賑赉賚赊賒赋賦赌賭赍齎赎贖赏賞赐賜赑贔赒賙赓賡赔賠赕賧赖賴赗賵赘贅赙賻赚賺赛賽赜賾赝贗赞贊" +
        "赟贇赠贈赡贍赢贏赣贛赪赬赵趙赶趕趋趨趱趲趸躉跃躍跄蹌跖蹠跞躒践踐跶躂跷蹺跸蹕跹躚跻躋踌躊踪蹤踬躓踯躑蹑躡蹒蹣蹰躕蹿躥躏躪躜躦躯軀輼轀车車轧軋轨軌轩軒轪軑轫軔转轉轭軛轮輪软軟轰轟轱軲轲軻轳轤轴軸轵軹轶軼" +
        "轷軤轸軫轹轢轺軺轻輕轼軾载載轾輊轿轎辀輈辁輇辂輅较較辄輒辅輔辆輛辇輦辈輩辉輝辊輥辋輞辌輬辍輟辎輜辏輳辐輻辑輯辒轀输輸辔轡辕轅辖轄辗輾辘轆辙轍辚轔辞辭辟闢辩辯辫辮边邊辽遼达達迁遷过過迈邁运運还還这這进進" +
        "远遠违違连連迟遲迩邇迳逕迹跡适適选選逊遜递遞逦邐逻邏遗遺遥遙邓鄧邝鄺邬鄔邮郵邹鄒邺鄴邻鄰郁鬱郏郟郐鄶郑鄭郓鄆郦酈郧鄖郸鄲酂酇酝醞酦醱酱醬酸酸酽釅酾釃酿釀醖醞采採释釋里裏鉴鑑銮鑾錾鏨钅釒钆釓钇釔针針钉釘" +
        "钊釗钋釙钌釕钍釷钎釺钏釧钐釤钑鈒钒釩钓釣钔鍆钕釹钖鍚钗釵钘鈃钙鈣钚鈈钛鈦钜鉅钝鈍钞鈔钟鍾钠鈉钡鋇钢鋼钣鈑钤鈐钥鑰钦欽钧鈞钨鎢钩鉤钪鈧钫鈁钬鈥钭鈄钮鈕钯鈀钰鈺钱錢钲鉦钳鉗钴鈷钵鉢钶鈳钷鉕钸鈽钹鈸钺鉞钻鑽" +
        "钼鉬钽鉭钾鉀钿鈿铀鈾铁鐵铂鉑铃鈴铄鑠铅鉛铆鉚铇鉋铈鈰铉鉉铊鉈铋鉍铌鈮铍鈹铎鐸铏鉶铐銬铑銠铒鉺铓鋩铔錏铕銪铖鋮铗鋏铘鋣铙鐃铚銍铛鐺铜銅铝鋁铞銱铟銦铠鎧铡鍘铢銖铣銑铤鋌铥銩铦銛铧鏵铨銓铩鎩铪鉿铫銚铬鉻铭銘" +
        "铮錚铯銫铰鉸铱銥铲鏟铳銃铴鐋铵銨银銀铷銣铸鑄铹鐒铺鋪铻鋙铼錸铽鋱链鏈铿鏗销銷锁鎖锂鋰锃鋥锄鋤锅鍋锆鋯锇鋨锈鏽锉銼锊鋝锋鋒锌鋅锍鋶锎鐦锏鐧锐銳锑銻锒鋃锓鋟锔鋦锕錒锖錆锗鍺锘鍩错錯锚錨锛錛锜錡锝鍀锞錁锟錕" +
        "锠錩锡錫锢錮锣鑼锤錘锥錐锦錦锧鑕锨鍁锩錈锪鍃锫錇锬錟锭錠键鍵锯鋸锰錳锱錙锲鍥锳鍈锴鍇锵鏘锶鍶锷鍔锸鍤锹鍬锺鍾锻鍛锼鎪锽鍠锾鍰锿鎄镀鍍镁鎂镂鏤镃鎡镄鐨镅鎇镆鏌镇鎮镈鎛镉鎘镊鑷镋钂镌鐫镍鎳镎鎿镏鎦镐鎬镑鎊" +
        "镒鎰镓鎵镔鑌镕鎔镖鏢镗鏜镘鏝镙鏍镚鏰镛鏞镜鏡镝鏑镞鏃镟鏇镠鏐镡鐔镢钁镣鐐镤鏷镥鑥镦鐓镧鑭镨鐠镩鑹镪鏹镫鐙镬鑊镭鐳镮鐶镯鐲镰鐮镱鐿镲鑔镳鑣镴鑞镵鑱镶鑲长長门門闩閂闪閃闫閆闬閈闭閉问問闯闖闰閏闱闈闲閒闳閎" +
        "间間闵閔闶閌闷悶闸閘闹鬧闺閨闻聞闼闥闽閩闾閭闿闓阀閥阁閣阂閡阃閫阄鬮阅閱阆閬阇闍阈閾阉閹阊閶阋鬩阌閿阍閽阎閻阏閼阐闡阑闌阒闃阓闠阔闊阕闋阖闔阗闐阘闒阙闕阚闞阛闤队隊阳陽阴陰阵陣阶階际際陆陸陇隴陈陳陉陘" +
        "陕陝陦隯陧隉陨隕险險随隨隐隱隶隸隽雋难難雇僱雏雛雕雕雠讎雳靂雾霧霁霽霉黴霡霢霭靄靓靚靔靝静靜面面靥靨鞑韃鞒鞽鞯韉鞲韝韦韋韧韌韨韍韩韓韪韙韫韞韬韜韵韻页頁顶頂顷頃顸頇项項顺順须須顼頊顽頑顾顧顿頓颀頎颁頒" +
        "颂頌颃頏预預颅顱领領颇頗颈頸颉頡颊頰颋頲颌頜颍潁颎熲颏頦颐頤频頻颒頮颓頹颔頷颕頴颖穎颗顆题題颙顒颚顎颛顓颜顏额額颞顳颟顢颠顛颡顙颢顥颣纇颤顫颥顬颦顰颧顴风風飏颺飐颭飑颮飒颯飓颶飔颸飕颼飖颻飗飀飘飄飙飆" +
        "飚飈飞飛飨饗餍饜饣飠饤飣饥飢饦飥饧餳饨飩饩餼饪飪饫飫饬飭饭飯饮飲饯餞饰飾饱飽饲飼饳飿饴飴饵餌饶饒饷餉饸餄饹餎饺餃饻餏饼餅饽餑饾餖饿餓馀餘馁餒馂餕馃餜馄餛馅餡馆館馇餷馈饋馉餶馊餿馋饞馌饁馍饃馎餺馏餾馐饈" +
        "馑饉馒饅馓饊馔饌馕饢马馬驭馭驮馱驯馴驰馳驱驅驲馹驳駁驴驢驵駔驶駛驷駟驸駙驹駒驺騶驻駐驼駝驽駑驾駕驿驛骀駘骁驍骂罵骃駰骄驕骅驊骆駱骇駭骈駢骉驫骊驪骋騁验驗骍騂骎駸骏駿骐騏骑騎骒騍骓騅骔騌骕驌骖驂骗騙骘騭" +
        "骙騤骚騷骛騖骜驁骝騮骞騫骟騸骠驃骡騾骢驄骣驏骤驟骥驥骦驦骧驤髅髏髋髖髌髕鬓鬢鬶鬹魇魘魉魎鱼魚鱽魛鱾魢鱿魷鲀魨鲁魯鲂魴鲃䰾鲄魺鲅鮁鲆鮃鲇鮎鲈鱸鲉鮋鲊鮓鲋鮒鲌鮊鲍鮑鲎鱟鲏鮍鲐鮐鲑鮭鲒鮚鲓鮳鲔鮪鲕鮞鲖鮦鲗鰂" +
        "鲘鮜鲙鱠鲚鱭鲛鮫鲜鮮鲝鮺鲞鯗鲟鱘鲠鯁鲡鱺鲢鰱鲣鰹鲤鯉鲥鰣鲦鰷鲧鯀鲨鯊鲩鯇鲪鮶鲫鯽鲬鯒鲭鯖鲮鯪鲯鯕鲰鯫鲱鯡鲲鯤鲳鯧鲴鯝鲵鯢鲶鯰鲷鯛鲸鯨鲹鰺鲺鯴鲻鯔鲼鱝鲽鰈鲾鰏鲿鱨鳀鯷鳁鰮鳂鰃鳃鰓鳄鱷鳅鰍鳆鰒鳇鰉鳈鰁鳉鱂" +
        "鳊鯿鳋鰠鳌鰲鳍鰭鳎鰨鳏鰥鳐鰩鳑鰟鳒鰜鳓鰳鳔鰾鳕鱈鳖鱉鳗鰻鳘鰵鳙鱅鳚䲁鳛鰼鳜鱖鳝鱔鳞鱗鳟鱒鳠鱯鳡鱤鳢鱧鳣鱣鳤䲘鸟鳥鸠鳩鸡雞鸢鳶鸣鳴鸤鳲鸥鷗鸦鴉鸧鶬鸨鴇鸩鴆鸪鴣鸫鶇鸬鸕鸭鴨鸮鴞鸯鴦鸰鴒鸱鴟鸲鴝鸳鴛鸴鷽鸵鴕" +
        "鸶鷥鸷鷙鸸鴯鸹鴰鸺鵂鸻鴴鸼鵃鸽鴿鸾鸞鸿鴻鹀鵐鹁鵓鹂鸝鹃鵑鹄鵠鹅鵝鹆鵒鹇鷳鹈鵜鹉鵡鹊鵲鹋鶓鹌鵪鹍鵾鹎鵯鹏鵬鹐鵮鹑鶉鹒鶊鹓鵷鹔鷫鹕鶘鹖鶡鹗鶚鹘鶻鹙鶖鹚鷀鹛鶥鹜鶩鹝鷊鹞鷂鹟鶲鹠鶹鹡鶺鹢鷁鹣鶼鹤鶴鹥鷖鹦鸚鹧鷓" +
        "鹨鷚鹩鷯鹪鷦鹫鷲鹬鷸鹭鷺鹮䴉鹯鸇鹰鷹鹱鸌鹲鸏鹳鸛鹴鸘鹾鹺麦麥麸麩麹麴麺麪麽麼黄黃黉黌黡黶黩黷黪黲黾黽鼋黿鼌鼂鼍鼉鼹鼴齐齊齑齏齿齒龀齔龁齕龂齗龃齟龄齡龅齙龆齠龇齜龈齦龉齬龊齪龋齲龌齷龙龍龚龔龛龕龟龜鿎䃮" +
        "鿏䥑鿒鿓鿔鎶";


        const T2S_STR =
        "丟丢並并乾干亂乱亙亘亞亚佇伫佈布佔占併并來来侖仑侶侣侷局俁俣係系俓𠇹俔伣俠侠俥伡俬私倀伥倆俩倈俫倉仓個个們们倖幸倫伦倲㑈偉伟偑㐽側侧偵侦偽伪傌㐷傑杰傖伧傘伞備备傢家傭佣傯偬傳传傴伛債债傷伤傾倾僂偻僅仅" +
        "僉佥僑侨僕仆僞伪僤𫢸僥侥僨偾僱雇價价儀仪儁俊儂侬億亿儈侩儉俭儎傤儐傧儔俦儕侪儘尽償偿儣𠆲優优儭𠋆儲储儷俪儸㑩儺傩儻傥儼俨兇凶兌兑兒儿兗兖內内兩两冊册冑胄冪幂凈净凍冻凙𪞝凜凛凱凯別别刪删剄刭則则剋克剎刹" +
        "剗刬剛刚剝剥剮剐剴剀創创剷铲剾𠛅劃划劇剧劉刘劊刽劌刿劍剑劏㓥劑剂劚㔉勁劲勑𠡠動动務务勛勋勝胜勞劳勢势勣𪟝勩勚勱劢勳勋勵励勸劝勻匀匭匦匯汇匱匮區区協协卹恤卻却卽即厙厍厠厕厤历厭厌厲厉厴厣參参叄叁叢丛吒咤" +
        "吳吴吶呐呂吕咼呙員员哯𠯟唄呗唓𪠳唸念問问啓启啞哑啟启啢唡喎㖞喚唤喪丧喫吃喬乔單单喲哟嗆呛嗇啬嗊唝嗎吗嗚呜嗩唢嗰𠮶嗶哔嗹𪡏嘆叹嘍喽嘓啯嘔呕嘖啧嘗尝嘜唛嘩哗嘪𪡃嘮唠嘯啸嘰叽嘳𪡞嘵哓嘸呒嘺𪡀嘽啴噁恶噅𠯠噓嘘" +
        "噚㖊噝咝噞𪡋噠哒噥哝噦哕噯嗳噲哙噴喷噸吨噹当嚀咛嚇吓嚌哜嚐尝嚕噜嚙啮嚛𪠸嚥咽嚦呖嚧𠰷嚨咙嚮向嚲亸嚳喾嚴严嚶嘤嚽𪢕囀啭囁嗫囂嚣囃𠱞囅冁囈呓囉啰囌苏囑嘱囒𪢠囪囱圇囵國国圍围園园圓圆圖图團团圞𪢮垻坝埡垭埨𫭢" +
        "埬𪣆埰采執执堅坚堊垩堖垴堚𪣒堝埚堯尧報报場场塊块塋茔塏垲塒埘塗涂塚冢塢坞塤埙塵尘塸𫭟塹堑塿𪣻墊垫墜坠墠𫮃墮堕墰坛墲𪢸墳坟墶垯墻墙墾垦壇坛壈𡒄壋垱壎埙壓压壗𡋤壘垒壙圹壚垆壜坛壞坏壟垄壠垅壢坜壣𪤚壩坝壪塆" +
        "壯壮壺壶壼壸壽寿夠够夢梦夥伙夾夹奐奂奧奥奩奁奪夺奬奖奮奋奼姹妝妆姍姗姦奸娙𫰛娛娱婁娄婡𫝫婦妇婭娅媈𫝨媧娲媯妫媰㛀媼媪媽妈嫋袅嫗妪嫵妩嫺娴嫻娴嫿婳嬀妫嬃媭嬇𫝬嬈娆嬋婵嬌娇嬙嫱嬡嫒嬣𪥰嬤嬷嬦𫝩嬪嫔嬰婴嬸婶" +
        "嬻𪥿孃娘孄𫝮孆𫝭孇𪥫孋㛤孌娈孎𡠟孫孙學学孻𡥧孾𪧀孿孪宮宫寀采寠𪧘寢寝實实寧宁審审寫写寬宽寵宠寶宝將将專专尋寻對对導导尷尴屆届屍尸屓屃屜屉屢屡層层屨屦屩𪨗屬属岡冈峯峰峴岘島岛峽峡崍崃崑昆崗岗崙仑崢峥崬岽" +
        "嵐岚嵗岁嵼𡶴嵽𫶇嵾㟥嶁嵝嶄崭嶇岖嶈𡺃嶔嵚嶗崂嶘𡺄嶠峤嶢峣嶧峄嶨峃嶮崄嶸嵘嶹𫝵嶺岭嶼屿嶽岳巊𪩎巋岿巒峦巔巅巖岩巗𪨷巘𪩘巰巯巹卺帥帅師师帳帐帶带幀帧幃帏幓㡎幗帼幘帻幝𪩷幟帜幣币幩𪩸幫帮幬帱幹干幾几庫库廁厕" +
        "廂厢廄厩廈厦廎庼廕荫廚厨廝厮廞𫷷廟庙廠厂廡庑廢废廣广廧𪪞廩廪廬庐廳厅弒弑弔吊弳弪張张強强彃𪪼彄𫸩彆别彈弹彌弥彎弯彔录彙汇彠彟彥彦彫雕彲彨彷彷彿佛後后徑径從从徠徕復复徵征徹彻徿𪫌恆恒恥耻悅悦悞悮悵怅悶闷" +
        "悽凄惡恶惱恼惲恽惻恻愛爱愜惬愨悫愴怆愷恺愻𢙏愾忾慄栗態态慍愠慘惨慚惭慟恸慣惯慤悫慪怄慫怂慮虑慳悭慶庆慺㥪慼戚慾欲憂忧憊惫憐怜憑凭憒愦憖慭憚惮憢𢙒憤愤憫悯憮怃憲宪憶忆憸𪫺憹𢙐懀𢙓懇恳應应懌怿懍懔懎𢠁懞蒙" +
        "懟怼懣懑懤㤽懨恹懲惩懶懒懷怀懸悬懺忏懼惧懾慑戀恋戇戆戔戋戧戗戩戬戰战戱戯戲戏戶户拋抛挩捝挱挲挾挟捨舍捫扪捱挨捲卷掃扫掄抡掆㧏掗挜掙挣掚𪭵掛挂採采揀拣揚扬換换揮挥揯搄損损搖摇搗捣搵揾搶抢摋𢫬摐𪭢摑掴摜掼" +
        "摟搂摯挚摳抠摶抟摺折摻掺撈捞撊𪭾撏挦撐撑撓挠撝㧑撟挢撣掸撥拨撧𪮖撫抚撲扑撳揿撻挞撾挝撿捡擁拥擄掳擇择擊击擋挡擓㧟擔担據据擟𪭧擠挤擣捣擫𢬍擬拟擯摈擰拧擱搁擲掷擴扩擷撷擺摆擻擞擼撸擽㧰擾扰攄摅攆撵攋𪮶攏拢" +
        "攔拦攖撄攙搀攛撺攜携攝摄攢攒攣挛攤摊攪搅攬揽敎教敓敚敗败敘叙敵敌數数斂敛斃毙斅𢽾斆敩斕斓斬斩斷断斸𣃁於于旂旗旣既昇升時时晉晋晛𬀪晝昼暈晕暉晖暐𬀩暘旸暢畅暫暂曄晔曆历曇昙曉晓曊𪰶曏向曖暧曠旷曥𣆐曨昽曬晒" +
        "書书會会朥𦛨朧胧朮术東东枴拐柵栅柺拐査查桱𣐕桿杆梔栀梖𪱷梘枧梜𬂩條条梟枭梲棁棄弃棊棋棖枨棗枣棟栋棡㭎棧栈棲栖棶梾椏桠椲㭏楇𣒌楊杨楓枫楨桢業业極极榘矩榦干榪杩榮荣榲榅榿桤構构槍枪槓杠槤梿槧椠槨椁槫𣏢槮椮" +
        "槳桨槶椢槼椝樁桩樂乐樅枞樑梁樓楼標标樞枢樠𣗊樢㭤樣样樤𣔌樧榝樫㭴樳桪樸朴樹树樺桦樿椫橈桡橋桥機机橢椭橫横橯𣓿檁檩檉柽檔档檜桧檟槚檢检檣樯檭𣘴檮梼檯台檳槟檵𪲛檸柠檻槛櫃柜櫅𪲎櫍𬃊櫓橹櫚榈櫛栉櫝椟櫞橼櫟栎" +
        "櫠𪲮櫥橱櫧槠櫨栌櫪枥櫫橥櫬榇櫱蘖櫳栊櫸榉櫻樱欄栏欅榉欇𪳍權权欍𣐤欏椤欐𪲔欑𪴙欒栾欓𣗋欖榄欘𣚚欞棂欽钦歎叹歐欧歟欤歡欢歲岁歷历歸归歿殁殘残殞殒殢𣨼殤殇殨㱮殫殚殭僵殮殓殯殡殰㱩殲歼殺杀殻壳殼壳毀毁毆殴毊𪵑" +
        "毿毵氂牦氈毡氌氇氣气氫氢氬氩氭𣱝氳氲氾泛汎泛汙污決决沒没沖冲況况泝溯洩泄洶汹浹浃浿𬇙涇泾涗涚涼凉淒凄淚泪淥渌淨净淩凌淪沦淵渊淶涞淺浅渙涣減减渢沨渦涡測测渾浑湊凑湋𣲗湞浈湧涌湯汤溈沩準准溝沟溡𪶄溫温溮浉" +
        "溳涢溼湿滄沧滅灭滌涤滎荥滙汇滬沪滯滞滲渗滷卤滸浒滻浐滾滚滿满漁渔漊溇漍𬇹漚沤漢汉漣涟漬渍漲涨漵溆漸渐漿浆潁颍潑泼潔洁潕𣲘潙沩潚㴋潛潜潣𫞗潤润潯浔潰溃潷滗潿涠澀涩澅𣶩澆浇澇涝澐沄澗涧澠渑澤泽澦滪澩泶澫𬇕" +
        "澬𫞚澮浍澱淀澾㳠濁浊濃浓濄㳡濆𣸣濕湿濘泞濚溁濛蒙濜浕濟济濤涛濧㳔濫滥濰潍濱滨濺溅濼泺濾滤濿𪵱瀂澛瀃𣽷瀅滢瀆渎瀇㲿瀉泻瀋沈瀏浏瀕濒瀘泸瀝沥瀟潇瀠潆瀦潴瀧泷瀨濑瀰弥瀲潋瀾澜灃沣灄滠灍𫞝灑洒灒𪷽灕漓灘滩灙𣺼" +
        "灝灏灡㳕灣湾灤滦灧滟灩滟災灾為为烏乌烴烃無无煇𪸩煉炼煒炜煙烟煢茕煥焕煩烦煬炀煱㶽熂𪸕熅煴熉𤈶熌𤇄熒荧熓𤆡熗炝熚𤇹熡𤋏熰𬉼熱热熲颎熾炽燀𬊤燁烨燈灯燉炖燒烧燖𬊈燙烫燜焖營营燦灿燬毁燭烛燴烩燶㶶燻熏燼烬燾焘" +
        "爃𫞡爄𤇃爇𦶟爍烁爐炉爖𤇭爛烂爥𪹳爧𫞠爭争爲为爺爷爾尔牀床牆墙牘牍牴牴牽牵犖荦犛牦犞𪺭犢犊犧牺狀状狹狭狽狈猌𪺽猙狰猶犹猻狲獁犸獃呆獄狱獅狮獊𪺷獎奖獨独獩𤞃獪狯獫猃獮狝獰狞獱㺍獲获獵猎獷犷獸兽獺獭獻献獼猕" +
        "玀猡玁𤞤珼𫞥現现琱雕琺珐琿珲瑋玮瑒玚瑣琐瑤瑶瑩莹瑪玛瑲玱瑻𪻲瑽𪻐璉琏璊𫞩璕𬍤璗𬍡璝𪻺璡琎璣玑璦瑷璫珰璯㻅環环璵玙璸瑸璼𫞨璽玺璾𫞦璿璇瓄𪻨瓅𬍛瓊琼瓏珑瓔璎瓕𤦀瓚瓒瓛𤩽甌瓯甕瓮產产産产甦苏甯宁畝亩畢毕畫画" +
        "異异畵画當当畼𪽈疇畴疊叠痙痉痠酸痮𪽪痾疴瘂痖瘋疯瘍疡瘓痪瘞瘗瘡疮瘧疟瘮瘆瘱𪽷瘲疭瘺瘘瘻瘘療疗癆痨癇痫癉瘅癐𤶊癒愈癘疠癟瘪癡痴癢痒癤疖癥症癧疬癩癞癬癣癭瘿癮瘾癰痈癱瘫癲癫發发皁皂皚皑皟𤾀皰疱皸皲皺皱盃杯" +
        "盜盗盞盏盡尽監监盤盘盧卢盨𪾔盪荡眝𪾣眞真眥眦眾众睍𪾢睏困睜睁睞睐瞘眍瞜䁖瞞瞒瞤𥆧瞭瞭瞶瞆瞼睑矇蒙矉𪾸矑𪾦矓眬矚瞩矯矫硃朱硜硁硤硖硨砗硯砚碕埼碙𥐻碩硕碭砀碸砜確确碼码碽䂵磑硙磚砖磠硵磣碜磧碛磯矶磽硗磾䃅" +
        "礄硚礆硷礎础礐𬒈礒𥐟礙碍礦矿礪砺礫砾礬矾礮𪿫礱砻祇祇祕秘祿禄禍祸禎祯禕祎禡祃禦御禪禅禮礼禰祢禱祷禿秃秈籼稅税稈秆稏䅉稜棱稟禀種种稱称穀谷穇䅟穌稣積积穎颖穠秾穡穑穢秽穩稳穫获穭穞窩窝窪洼窮穷窯窑窵窎窶窭" +
        "窺窥竄窜竅窍竇窦竈灶竊窃竚𥩟竪竖竱𫁟競竞筆笔筍笋筧笕筴䇲箇个箋笺箏筝節节範范築筑篋箧篔筼篘𥬠篠筿篢𬕂篤笃篩筛篳筚篸𥮾簀箦簂𫂆簍篓簑蓑簞箪簡简簢𫂃簣篑簫箫簹筜簽签簾帘籃篮籅𥫣籋𥬞籌筹籔䉤籙箓籛篯籜箨籟籁" +
        "籠笼籤签籩笾籪簖籬篱籮箩籲吁粵粤糉粽糝糁糞粪糧粮糰团糲粝糴籴糶粜糹纟糺𫄙糾纠紀纪紂纣紃𬘓約约紅红紆纡紇纥紈纨紉纫紋纹納纳紐纽紓纾純纯紕纰紖纼紗纱紘纮紙纸級级紛纷紜纭紝纴紞𬘘紟𫄛紡纺紬䌷紮扎細细紱绂紲绁" +
        "紳绅紵纻紹绍紺绀紼绋紿绐絀绌絁𫄟終终絃弦組组絅䌹絆绊絍𫟃絎绗結结絕绝絙𫄠絛绦絝绔絞绞絡络絢绚絥𫄢給给絧𫄡絨绒絪𬘡絰绖統统絲丝絳绛絶绝絹绢絺𫄨綀𦈌綁绑綃绡綄𬘫綆绠綇𦈋綈绨綉绣綋𫟄綌绤綎𬘩綏绥綐䌼綑捆經经" +
        "綖𫄧綜综綝𬘭綞缍綟𫄫綠绿綡𫟅綢绸綣绻綧𬘯綪𬘬綫线綬绶維维綯绹綰绾綱纲網网綳绷綴缀綵彩綸纶綹绺綺绮綻绽綽绰綾绫綿绵緄绲緇缁緊紧緋绯緍𦈏緑绿緒绪緓绬緔绱緗缃緘缄緙缂線线緝缉緞缎緟𫟆締缔緡缗緣缘緤𫄬緦缌編编" +
        "緩缓緬缅緮𫄭緯纬緰𦈕緱缑緲缈練练緶缏緷𦈉緸𦈑緹缇緻致緼缊縈萦縉缙縊缢縋缒縍𫄰縎𦈔縐绉縑缣縕缊縗缞縛缚縝缜縞缟縟缛縣县縧绦縫缝縬𦈚縭缡縮缩縯𬙂縰𫄳縱纵縲缧縳䌸縴纤縵缦縶絷縷缕縸𫄲縹缥縺𦈐總总績绩繂𫄴繃绷" +
        "繅缫繆缪繈𫄶繏𦈝繐𰬸繒缯繓𦈛織织繕缮繚缭繞绕繟𦈎繡绣繢缋繨𫄤繩绳繪绘繫系繬𫄱繭茧繮缰繯缳繰缲繳缴繶𫄷繷𫄣繸䍁繹绎繻𦈡繼继繽缤繾缱繿䍀纁𫄸纆𬙊纇颣纈缬纊纩續续纍累纏缠纓缨纔才纕𬙋纖纤纗𫄹纘缵纚𫄥纜缆缽钵" +
        "罃䓨罈坛罌罂罎坛罰罚罵骂罷罢羅罗羆罴羈羁羋芈羣群羥羟羨羡義义羵𫅗羶膻習习翫玩翬翚翹翘翽翙耬耧耮耢聖圣聞闻聯联聰聪聲声聳耸聵聩聶聂職职聹聍聻𫆏聽听聾聋肅肃脅胁脈脉脛胫脣唇脥𣍰脩修脫脱脹胀腎肾腖胨腡脶腦脑" +
        "腪𣍯腫肿腳脚腸肠膃腽膕腘膚肤膞䏝膠胶膢𦝼膩腻膹𪱥膽胆膾脍膿脓臉脸臍脐臏膑臗𣎑臘腊臚胪臟脏臠脔臢臜臥卧臨临臺台與与興兴舉举舊旧舘馆艙舱艣𫇛艤舣艦舰艫舻艱艰艷艳芻刍苧苎茲兹荊荆莊庄莖茎莢荚莧苋菕𰰨華华菴庵" +
        "菸烟萇苌萊莱萬万萴荝萵莴葉叶葒荭葝𫈎葤荮葦苇葯药葷荤蒍𫇭蒐搜蒓莼蒔莳蒕蒀蒞莅蒭𫇴蒼苍蓀荪蓆席蓋盖蓧𦰏蓮莲蓯苁蓴莼蓽荜蔄𬜬蔔卜蔘参蔞蒌蔣蒋蔥葱蔦茑蔭荫蔯𫈟蔿𫇭蕁荨蕆蒇蕎荞蕒荬蕓芸蕕莸蕘荛蕝𫈵蕢蒉蕩荡蕪芜" +
        "蕭萧蕳𫈉蕷蓣蕽𫇽薀蕰薆𫉁薈荟薊蓟薌芗薑姜薔蔷薘荙薟莶薦荐薩萨薳䓕薴苧薵䓓薹苔薺荠藉藉藍蓝藎荩藝艺藥药藪薮藭䓖藴蕴藶苈藷𫉄藹蔼藺蔺蘀萚蘄蕲蘆芦蘇苏蘊蕴蘋苹蘚藓蘞蔹蘟𦻕蘢茏蘭兰蘺蓠蘿萝虆蔂虉𬟁處处虛虚虜虏" +
        "號号虧亏虯虬蛺蛱蛻蜕蜆蚬蝀𬟽蝕蚀蝟猬蝦虾蝨虱蝸蜗螄蛳螞蚂螢萤螮䗖螻蝼螿螀蟂𫋇蟄蛰蟈蝈蟎螨蟘𫋌蟜𫊸蟣虮蟬蝉蟯蛲蟲虫蟳𫊻蟶蛏蟻蚁蠀𧏗蠁蚃蠅蝇蠆虿蠍蝎蠐蛴蠑蝾蠔蚝蠙𧏖蠟蜡蠣蛎蠦𫊮蠨蟏蠱蛊蠶蚕蠻蛮蠾𧑏衆众衊蔑" +
        "術术衕同衚胡衛卫衝冲衹衹袞衮裊袅裏里補补裝装裡里製制複复褌裈褘袆褲裤褳裢褸褛褻亵襀𫌀襇裥襉裥襏袯襓𫋹襖袄襗𫋷襘𫋻襝裣襠裆襤褴襪袜襬摆襯衬襰𧝝襲袭襴襕襵𫌇覆覆覈核見见覎觃規规覓觅視视覘觇覛𫌪覡觋覥觍覦觎" +
        "親亲覬觊覯觏覲觐覷觑覹𫌭覺觉覼𫌨覽览覿觌觀观觴觞觶觯觸触訁讠訂订訃讣計计訊讯訌讧討讨訏𬣙訐讦訑𫍙訒讱訓训訕讪訖讫託托記记訛讹訜𫍛訝讶訞𫍚訟讼訢䜣訣诀訥讷訨𫟞訩讻訪访設设許许訴诉訶诃診诊註注証证詀𧮪詁诂" +
        "詆诋詊𫟟詎讵詐诈詑𫍡詒诒詓𫍜詔诏評评詖诐詗诇詘诎詛诅詝𬣞詞词詠咏詡诩詢询詣诣試试詩诗詪𬣳詫诧詬诟詭诡詮诠詰诘話话該该詳详詵诜詷𫍣詼诙詿诖誂𫍥誄诔誅诛誆诓誇夸誋𫍪誌志認认誑诳誒诶誕诞誘诱誚诮語语誠诚誡诫" +
        "誣诬誤误誥诰誦诵誨诲說说誫𫍨説说誰谁課课誳𫍮誴𫟡誶谇誷𫍬誹诽誺𫍧誼谊誾訚調调諂谄諄谆談谈諉诿請请諍诤諏诹諑诼諒谅諓𬣡論论諗谂諛谀諜谍諝谞諞谝諟𬤊諡谥諢诨諣𫍩諤谔諥𫍳諦谛諧谐諫谏諭谕諮咨諯𫍱諰𫍰諱讳諲𬤇" +
        "諳谙諴𫍯諶谌諷讽諸诸諺谚諼谖諾诺謀谋謁谒謂谓謄誊謅诌謆𫍸謉𫍷謊谎謎谜謏𫍲謐谧謔谑謖谡謗谤謙谦謚谥講讲謝谢謠谣謡谣謨谟謫谪謬谬謭谫謯𫍹謱𫍴謳讴謸𫍵謹谨謾谩譁哗譂𫟠譅𰶎譆𫍻證证譊𫍢譎谲譏讥譑𫍤譓𬤝譖谮識识" +
        "譙谯譚谭譜谱譞𫍽譟噪譨𫍦譫谵譭毁譯译議议譴谴護护譸诪譽誉譾谫讀读讅谉變变讋詟讌䜩讎雠讒谗讓让讕谰讖谶讚赞讜谠讞谳豈岂豎竖豐丰豔艳豬猪豵𫎆豶豮貓猫貗𫎌貙䝙貝贝貞贞貟贠負负財财貢贡貧贫貨货販贩貪贪貫贯責责" +
        "貯贮貰贳貲赀貳贰貴贵貶贬買买貸贷貺贶費费貼贴貽贻貿贸賀贺賁贲賂赂賃赁賄贿賅赅資资賈贾賊贼賑赈賒赊賓宾賕赇賙赒賚赉賜赐賝𫎩賞赏賟𧹖賠赔賡赓賢贤賣卖賤贱賦赋賧赕質质賫赍賬账賭赌賰䞐賴赖賵赗賺赚賻赙購购賽赛" +
        "賾赜贃𧹗贄贽贅赘贇赟贈赠贉𫎫贊赞贋赝贍赡贏赢贐赆贑𫎬贓赃贔赑贖赎贗赝贚𫎦贛赣贜赃赬赪趕赶趙赵趨趋趲趱跡迹踐践踰逾踴踊蹌跄蹔𫏐蹕跸蹟迹蹠跖蹣蹒蹤踪蹳𫏆蹺跷蹻𫏋躂跶躉趸躊踌躋跻躍跃躎䟢躑踯躒跞躓踬躕蹰躘𨀁" +
        "躚跹躝𨅬躡蹑躥蹿躦躜躪躏軀躯軉𨉗車车軋轧軌轨軍军軏𫐄軑轪軒轩軔轫軕𫐅軗𨐅軛轭軜𫐇軝𬨂軟软軤轷軨𫐉軫轸軬𫐊軲轱軷𫐈軸轴軹轵軺轺軻轲軼轶軾轼軿𫐌較较輄𨐈輅辂輇辁輈辀載载輊轾輋𪨶輒辄輓挽輔辅輕轻輖𫐏輗𫐐輛辆" +
        "輜辎輝辉輞辋輟辍輢𫐎輥辊輦辇輨𫐑輩辈輪轮輬辌輮𫐓輯辑輳辏輶𬨎輷𫐒輸输輻辐輼辒輾辗輿舆轀辒轂毂轄辖轅辕轆辘轇𫐖轉转轊𫐕轍辙轎轿轐𫐗轔辚轗𫐘轟轰轠𫐙轡辔轢轹轣𫐆轤轳辦办辭辞辮辫辯辩農农迴回逕迳這这連连週周" +
        "進进遊游運运過过達达違违遙遥遜逊遞递遠远遡溯適适遱𫐷遲迟遷迁選选遺遗遼辽邁迈還还邇迩邊边邏逻邐逦郟郏郵邮鄆郓鄉乡鄒邹鄔邬鄖郧鄟𫑘鄧邓鄩𬩽鄭郑鄰邻鄲郸鄳𫑡鄴邺鄶郐鄺邝酇酂酈郦醃腌醖酝醜丑醞酝醟蒏醣糖醫医" +
        "醬酱醱酦醲𬪩醶𫑷釀酿釁衅釃酾釅酽釋释釐厘釒钅釓钆釔钇釕钌釗钊釘钉釙钋釚𫟲針针釟𫓥釣钓釤钐釦扣釧钏釨𫓦釩钒釲𫟳釳𨰿釴𬬩釵钗釷钍釹钕釺钎釾䥺釿𬬱鈀钯鈁钫鈃钘鈄钭鈅钥鈆𫓪鈇𫓧鈈钚鈉钠鈋𨱂鈍钝鈎钩鈐钤鈑钣鈒钑" +
        "鈔钞鈕钮鈖𫟴鈗𫟵鈛𫓨鈞钧鈠𨱁鈡钟鈣钙鈥钬鈦钛鈧钪鈮铌鈯𨱄鈰铈鈲𨱃鈳钶鈴铃鈷钴鈸钹鈹铍鈺钰鈽钸鈾铀鈿钿鉀钾鉁𨱅鉅巨鉆钻鉈铊鉉铉鉊𬬿鉋铇鉍铋鉑铂鉔𫓬鉕钷鉗钳鉚铆鉛铅鉝𫟷鉞钺鉠𫓭鉢钵鉤钩鉥𬬸鉦钲鉧𬭁鉬钼鉭钽" +
        "鉮𬬹鉳锫鉶铏鉷𫟹鉸铰鉺铒鉻铬鉽𫟸鉾𫓴鉿铪銀银銁𫓲銂𫟻銃铳銅铜銈𫓯銊𫓰銍铚銏𫟶銑铣銓铨銖铢銘铭銚铫銛铦銜衔銠铑銣铷銥铱銦铟銨铵銩铥銪铕銫铯銬铐銱铞銳锐銶𨱇銷销銹锈銻锑銼锉鋁铝鋂𰾄鋃锒鋅锌鋇钡鋉𨱈鋌铤鋏铗" +
        "鋐𬭎鋒锋鋗𫓶鋙铻鋝锊鋟锓鋠𫓵鋣铘鋤锄鋥锃鋦锔鋨锇鋩铓鋪铺鋭锐鋮铖鋯锆鋰锂鋱铽鋶锍鋸锯鋹𬬮鋼钢錀𬬭錁锞錂𨱋錄录錆锖錇锫錈锩錏铔錐锥錒锕錕锟錘锤錙锱錚铮錛锛錜𫓻錝𫓽錞𬭚錟锬錠锭錡锜錢钱錤𫓹錥𫓾錦锦錨锚錩锠" +
        "錫锡錮锢錯错録录錳锰錶表錸铼錼镎錽𫓸鍀锝鍁锨鍃锪鍄𨱉鍅钫鍆钔鍇锴鍈锳鍉𫔂鍊炼鍋锅鍍镀鍒𫔄鍔锷鍘铡鍚钖鍛锻鍠锽鍤锸鍥锲鍩锘鍬锹鍭𬭤鍮𨱎鍰锾鍵键鍶锶鍺锗鍼针鍾钟鎂镁鎄锿鎇镅鎈𫟿鎊镑鎌镰鎍𫔅鎓𬭩鎔镕鎖锁鎘镉" +
        "鎙𫔈鎚锤鎛镈鎝𨱏鎞𫔇鎡镃鎢钨鎣蓥鎦镏鎧铠鎩铩鎪锼鎬镐鎭镇鎮镇鎯𨱍鎰镒鎲镋鎳镍鎵镓鎶鿔鎷𨰾鎸镌鎿镎鏃镞鏆𨱌鏇旋鏈链鏉𨱒鏌镆鏍镙鏏𬭬鏐镠鏑镝鏗铿鏘锵鏚𬭭鏜镗鏝镘鏞镛鏟铲鏡镜鏢镖鏤镂鏥𫔊鏦𫓩鏨錾鏰镚鏵铧鏷镤" +
        "鏹镪鏺䥽鏻𬭸鏽锈鏾𫔌鐃铙鐄𨱑鐇𫔍鐈𫓱鐋铴鐍𫔎鐎𨱓鐏𨱔鐐镣鐒铹鐓镦鐔镡鐘钟鐙镫鐝镢鐠镨鐥䦅鐦锎鐧锏鐨镄鐩𬭼鐪𫓺鐫镌鐮镰鐯䦃鐲镯鐳镭鐵铁鐶镮鐸铎鐺铛鐼𫔁鐽𫟼鐿镱鑀𰾭鑄铸鑉𫠁鑊镬鑌镔鑑鉴鑒鉴鑔镲鑕锧鑞镴鑠铄" +
        "鑣镳鑥镥鑪𬬻鑭镧鑰钥鑱镵鑲镶鑴𫔔鑷镊鑹镩鑼锣鑽钻鑾銮鑿凿钁镢钂镋長长門门閂闩閃闪閆闫閈闬閉闭開开閌闶閍𨸂閎闳閏闰閐𨸃閑闲閒闲間间閔闵閗𫔯閘闸閝𫠂閞𫔰閡阂閣阁閤合閥阀閨闺閩闽閫阃閬阆閭闾閱阅閲阅閵𫔴閶阊" +
        "閹阉閻阎閼阏閽阍閾阈閿阌闃阒闆板闇暗闈闱闉𬮱闊阔闋阕闌阑闍阇闐阗闑𫔶闒阘闓闿闔阖闕阙闖闯關关闞阚闠阓闡阐闢辟闤阛闥闼阪阪陘陉陝陕陞升陣阵陰阴陳陈陸陆陽阳隉陧隊队階阶隑𬮿隕陨際际隤𬯎隨随險险隮𬯀隯陦隱隐" +
        "隴陇隸隶隻只雋隽雖虽雙双雛雏雜杂雞鸡離离難难雲云電电霑沾霢霡霣𫕥霧雾霼𪵣霽霁靂雳靄霭靆叇靈灵靉叆靚靓靜静靝靔靦腼靧𫖃靨靥鞏巩鞝绱鞦秋鞽鞒鞾𫖇韁缰韃鞑韆千韉鞯韋韦韌韧韍韨韓韩韙韪韚𫠅韛𫖔韜韬韝鞲韞韫韠𫖒" +
        "韻韵響响頁页頂顶頃顷項项順顺頇顸須须頊顼頌颂頍𫠆頎颀頏颃預预頑顽頒颁頓顿頔𬱖頗颇領领頜颌頠𬱟頡颉頤颐頦颏頫𫖯頭头頮颒頰颊頲颋頴颕頵𫖳頷颔頸颈頹颓頻频頽颓顂𩓋顃𩖖顅𫖶顆颗題题額额顎颚顏颜顒颙顓颛顔颜顗𫖮" +
        "願愿顙颡顛颠類类顢颟顣𫖹顥颢顧顾顫颤顬颥顯显顰颦顱颅顳颞顴颧風风颭飐颮飑颯飒颰𩙥颱台颳刮颶飓颷𩙪颸飔颺飏颻飖颼飕颾𩙫飀飗飄飘飆飙飈飚飋𫗋飛飞飠饣飢饥飣饤飥饦飦𫗞飩饨飪饪飫饫飭饬飯饭飱飧飲饮飴饴飵𫗢飶𫗣" +
        "飼饲飽饱飾饰飿饳餃饺餄饸餅饼餈糍餉饷養养餌饵餎饹餏饻餑饽餒馁餓饿餔𫗦餕馂餖饾餗𫗧餘余餚肴餛馄餜馃餞饯餡馅餦𫗠餧𫗪館馆餪𫗬餫𫗥餬糊餭𫗮餱糇餳饧餵喂餶馉餷馇餸𩠌餺馎餼饩餾馏餿馊饁馌饃馍饅馒饈馐饉馑饊馓饋馈" +
        "饌馔饑饥饒饶饗飨饘𫗴饜餍饞馋饟𫗵饠𫗩饢馕馬马馭驭馮冯馯𫘛馱驮馳驰馴驯馹驲馼𫘜駁驳駃𫘝駉𬳶駊𫘟駎𩧨駐驻駑驽駒驹駓𬳵駔驵駕驾駘骀駙驸駚𩧫駛驶駝驼駞𫘞駟驷駡骂駢骈駤𫘠駧𩧲駩𩧴駪𬳽駫𫘡駭骇駰骃駱骆駶𩧺駸骎駻𫘣" +
        "駼𬳿駿骏騁骋騂骍騃𫘤騄𫘧騅骓騉𫘥騊𫘦騌骔騍骒騎骑騏骐騑𬴂騔𩨀騖骛騙骗騚𩨊騜𫘩騝𩨃騞𬴃騟𩨈騠𫘨騤骙騧䯄騪𩨄騫骞騭骘騮骝騰腾騱𫘬騴𫘫騵𫘪騶驺騷骚騸骟騻𫘭騼𫠋騾骡驀蓦驁骜驂骖驃骠驄骢驅驱驊骅驋𩧯驌骕驍骁驎𬴊" +
        "驏骣驓𫘯驕骄驗验驙𫘰驚惊驛驿驟骤驢驴驤骧驥骥驦骦驨𫘱驪骊驫骉骯肮髏髅髒脏體体髕髌髖髋髮发鬆松鬍胡鬖𩭹鬚须鬠𫘽鬢鬓鬥斗鬧闹鬨哄鬩阋鬮阄鬱郁鬹鬶魎魉魘魇魚鱼魛鱽魟𫚉魢鱾魥𩽹魦𫚌魨鲀魯鲁魴鲂魵𫚍魷鱿魺鲄魽𫠐" +
        "鮀𬶍鮁鲅鮃鲆鮄𫚒鮅𫚑鮆𫚖鮈𬶋鮊鲌鮋鲉鮍鲏鮎鲇鮐鲐鮑鲍鮒鲋鮓鲊鮚鲒鮜鲘鮝鲞鮞鲕鮟𩽾鮠𬶏鮡𬶐鮣䲟鮤𫚓鮦鲖鮪鲔鮫鲛鮭鲑鮮鲜鮯𫚗鮰𫚔鮳鲓鮵𫚛鮶鲪鮸𩾃鮺鲝鮿𫚚鯀鲧鯁鲠鯄𩾁鯆𫚙鯇鲩鯉鲤鯊鲨鯒鲬鯔鲻鯕鲯鯖鲭鯗鲞鯛鲷" +
        "鯝鲴鯞𫚡鯡鲱鯢鲵鯤鲲鯧鲳鯨鲸鯪鲮鯫鲰鯬𫚞鯰鲶鯱𩾇鯴鲺鯶𩽼鯷鳀鯻𬶟鯽鲫鯾𫚣鯿鳊鰁鳈鰂鲗鰃鳂鰆䲠鰈鲽鰉鳇鰊𬶠鰋𫚢鰌䲡鰍鳅鰏鲾鰐鳄鰑𫚊鰒鳆鰓鳃鰕𫚥鰛鳁鰜鳒鰟鳑鰠鳋鰣鲥鰤𫚕鰥鳏鰦𫚤鰧䲢鰨鳎鰩鳐鰫𫚦鰭鳍鰮鳁鰱鲢" +
        "鰲鳌鰳鳓鰵鳘鰶𬶭鰷鲦鰹鲣鰺鲹鰻鳗鰼鳛鰽𫚧鰾鳔鱀𬶨鱂鳉鱄𫚋鱅鳙鱆𫠒鱇𩾌鱈鳕鱉鳖鱊𫚪鱒鳟鱔鳝鱖鳜鱗鳞鱘鲟鱚𬶮鱝鲼鱟鲎鱠鲙鱢𫚫鱣鳣鱤鳡鱧鳢鱨鲿鱭鲚鱮𫚈鱯鳠鱲𫚭鱷鳄鱸鲈鱺鲡鳥鸟鳧凫鳩鸠鳬凫鳲鸤鳳凤鳴鸣鳶鸢鳷𫛛" +
        "鳼𪉃鳽𫛚鳾䴓鴀𫛜鴃𫛞鴅𫛝鴆鸩鴇鸨鴉鸦鴐𫛤鴒鸰鴔𫛡鴕鸵鴗𫁡鴛鸳鴜𪉈鴝鸲鴞鸮鴟鸱鴣鸪鴥𫛣鴦鸯鴨鸭鴮𫛦鴯鸸鴰鸹鴲𪉆鴳𫛩鴴鸻鴷䴕鴻鸿鴽𫛪鴿鸽鵁䴔鵂鸺鵃鸼鵊𫛥鵏𬷕鵐鹀鵑鹃鵒鹆鵓鹁鵚𪉍鵜鹈鵝鹅鵟𫛭鵠鹄鵡鹉鵧𫛨鵩𫛳" +
        "鵪鹌鵫𫛱鵬鹏鵮鹐鵯鹎鵰雕鵲鹊鵷鹓鵾鹍鶄䴖鶇鸫鶉鹑鶊鹒鶌𫛵鶒𫛶鶓鹋鶖鹙鶗𫛸鶘鹕鶚鹗鶠𬸘鶡鹖鶥鹛鶦𫛷鶩鹜鶪䴗鶬鸧鶭𫛯鶯莺鶰𫛫鶱𬸣鶲鹟鶴鹤鶹鹠鶺鹡鶻鹘鶼鹣鶿鹚鷀鹚鷁鹢鷂鹞鷄鸡鷅𫛽鷉䴘鷊鹝鷐𫜀鷓鹧鷔𪉑鷖鹥鷗鸥" +
        "鷙鸷鷚鹨鷟𬸦鷣𫜃鷤𫛴鷥鸶鷦鹪鷨𪉊鷩𫜁鷫鹔鷭𬸪鷯鹩鷲鹫鷳鹇鷴鹇鷷𫜄鷸鹬鷹鹰鷺鹭鷽鸴鷿𬸯鸂㶉鸇鹯鸊䴙鸋𫛢鸌鹱鸏鹲鸑𬸚鸕鸬鸗𫛟鸘鹴鸚鹦鸛鹳鸝鹂鸞鸾鹵卤鹹咸鹺鹾鹼碱鹽盐麗丽麥麦麨𪎊麩麸麪面麫面麬𤿲麯曲麲𪎉麳𪎌" +
        "麴曲麵面麷𫜑麼么麽么黃黄黌黉點点黨党黲黪黴霉黶黡黷黩黽黾黿鼋鼂鼌鼉鼍鼕冬鼴鼹齊齐齋斋齎赍齏齑齒齿齔龀齕龁齗龂齘𬹼齙龅齜龇齟龃齠龆齡龄齣出齦龈齧啮齩𫜪齪龊齬龉齭𫜭齮𬺈齯𫠜齰𫜬齲龋齴𫜮齶腭齷龌齼𬺓齾𫜰龍龙" +
        "龎厐龐庞龑䶮龓𫜲龔龚龕龛龜龟龭𩨎龯𨱆鿁䜤鿓鿒";



        // 初始化映射表
        for (let i = 0; i < S2T_STR.length; i += 2) {
            S2T_MAP[S2T_STR[i]] = S2T_STR[i + 1];
        }

        for (let i = 0; i < T2S_STR.length; i += 2) {
            T2S_MAP[T2S_STR[i]] = T2S_STR[i + 1];
        }

        console.log('[LRR Checker] OpenCC maps initialized:', Object.keys(S2T_MAP).length, 'simplified characters');
    })();

})();
