// ==UserScript==
// @name         EhSearchEnhancer
// @namespace    com.xioxin.EhSearchEnhancer
// @version      2.3.6
// @description  E-Hentai搜索页增强脚本 - 多选、批量操作、磁链显示、反查、下载历史记录等功能
// @author       AkiraShe
// @match        *://e-hentai.org/*
// @match        *://exhentai.org/*
// @grant        GM_xmlhttpRequest
// @connect      hath.network
// @connect      *.hath.network
// @license      MIT
// @homepage     https://github.com/AkiraShe/eh-enhancements
// ==/UserScript==

/*
 * 参考实现：
 * 1. 隐藏已查看画廊 - E-Hentai & ExHentai Fade or hide viewed galleries
 *    https://sleazyfork.org/en/scripts/36314-e-hentai-exhentai-fade-or-hide-viewed-galleries
 * 
 * 2. 种子信息悬浮菜单布局 - EhAria2下载助手 (AriaEh.user.js)
 *    https://github.com/SchneeHertz/EH-UserScripts/tree/master/AriaEh
 */

(function () {
    'use strict';

    if (!document.body) return;

    const magnetCache = new Map();
    const downloadInfoCache = new Map();
    const injectingSet = new Set(); // 正在注入的 torrentUrl 集合，防止重复调用

    let downloadCacheEnabled = false;
    let downloadCacheTimeoutMinutes = 60; // 默认超时时长（分钟）

    const DEFAULT_DOWNLOAD_CACHE_TIMEOUT_MINUTES = 60;
    const DOWNLOAD_CACHE_MAX_ENTRIES = 200;
    let downloadCachePersistTimer = null;
    let downloadCacheDirty = false;
    let downloadCacheLoaded = false;
    let toastContainer = null;
    let toastStyleInjected = false;

    console.log('[EhMagnet] 脚本初始化开始');

    const ensureToastStyles = () => {
        if (toastStyleInjected) return;
        toastStyleInjected = true;
        const style = document.createElement('style');
        style.textContent = `
            .eh-magnet-toast-container {
                position: fixed;
                top: 20px;
                right: 10px;
                display: flex;
                flex-direction: column;
                gap: 8px;
                z-index: 100050;
                pointer-events: none;
            }
            .eh-magnet-toast {
                min-width: 200px;
                max-width: 340px;
                padding: 10px 14px;
                border-radius: 6px;
                color: #fff;
                font-size: 13px;
                box-shadow: 0 8px 18px rgba(0,0,0,0.25);
                opacity: 0;
                transform: translateX(20px);
                transition: opacity .2s ease, transform .2s ease;
                pointer-events: auto;
                white-space: pre-line;
            }
            .eh-magnet-toast[data-visible="1"] {
                opacity: 1;
                transform: translateX(0);
            }
            .eh-magnet-toast[data-type="info"] { background: rgba(76,126,243,0.95); }
            .eh-magnet-toast[data-type="success"] { background: rgba(43,164,113,0.95); }
            .eh-magnet-toast[data-type="warn"] { background: rgba(230,162,60,0.95); }
            .eh-magnet-toast[data-type="error"] { background: rgba(216,74,69,0.95); }
        `;
        document.head.appendChild(style);
    };

    const getElementBottomOffset = (element) => {
        if (!element || !element.isConnected) return null;
        const style = window.getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden') return null;
        const rect = element.getBoundingClientRect();
        if (rect.height < 4) return null;
        return rect.bottom;
    };

    const updateToastContainerPosition = () => {
        if (!toastContainer) return;
        let computedTop = 20;

        const blockBottom = getElementBottomOffset(document.querySelector('.jh-block-toast-container'));
        if (blockBottom) {
            computedTop = Math.max(computedTop, blockBottom + 16);
        }

        const progressBottom = getElementBottomOffset(document.getElementById('eh-magnet-progress'));
        if (progressBottom) {
            computedTop = Math.max(computedTop, progressBottom + 12);
        }

        toastContainer.style.top = `${computedTop}px`;
    };

    const ensureToastContainer = () => {
        ensureToastStyles();
        if (toastContainer && toastContainer.isConnected) return toastContainer;
        toastContainer = document.createElement('div');
        toastContainer.className = 'eh-magnet-toast-container';
        document.body.appendChild(toastContainer);
        updateToastContainerPosition();
        return toastContainer;
    };

    const showToast = (message, options = {}) => {
        if (!message) return;
        const { type = 'info', duration = 2600 } = options;
        const container = ensureToastContainer();
        updateToastContainerPosition();
        const toast = document.createElement('div');
        toast.className = 'eh-magnet-toast';
        toast.dataset.type = type;
        toast.textContent = message;
        container.appendChild(toast);
        requestAnimationFrame(() => {
            toast.dataset.visible = '1';
        });
        setTimeout(() => {
            toast.dataset.visible = '0';
            setTimeout(() => toast.remove(), 300);
        }, duration);
    };

    const toastInfo = (message, options = {}) => showToast(message, { ...options, type: 'info' });
    const toastSuccess = (message, options = {}) => showToast(message, { ...options, type: 'success' });
    const toastWarn = (message, options = {}) => showToast(message, { ...options, type: 'warn' });
    const toastError = (message, options = {}) => showToast(message, { ...options, type: 'error' });

    /**
     * 显示自定义确认对话框（支持多个按钮）
     * @param {Object} options - 对话框配置
     * @param {string} options.title - 标题
     * @param {string} options.message - 消息内容
     * @param {Array} options.buttons - 按钮配置数组，例如：[{text: '确定', value: 'ok', primary: true}, ...]
     * @returns {Promise<string|null>} 返回被点击按钮的 value，如果关闭对话框则返回 null
     */
    const showConfirmDialog = ({ title = '确认', message = '', buttons = [] }) => {
        return new Promise((resolve) => {
            // 创建遮罩层
            const overlay = document.createElement('div');
            overlay.style.cssText = `
                position: fixed;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background: rgba(0, 0, 0, 0.5);
                z-index: 999999;
                display: flex;
                align-items: center;
                justify-content: center;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            `;

            // 创建对话框容器
            const dialog = document.createElement('div');
            dialog.style.cssText = `
                background: white;
                border-radius: 8px;
                box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
                max-width: 480px;
                width: 90%;
                overflow: hidden;
                animation: dialogFadeIn 0.2s ease-out;
            `;

            // 添加动画
            const style = document.createElement('style');
            style.textContent = `
                @keyframes dialogFadeIn {
                    from {
                        opacity: 0;
                        transform: scale(0.9);
                    }
                    to {
                        opacity: 1;
                        transform: scale(1);
                    }
                }
            `;
            document.head.appendChild(style);

            // 创建标题栏
            const titleBar = document.createElement('div');
            titleBar.style.cssText = `
                padding: 16px 20px;
                border-bottom: 1px solid #e0e0e0;
                font-size: 16px;
                font-weight: 600;
                color: #333;
            `;
            titleBar.textContent = title;

            // 创建内容区
            const content = document.createElement('div');
            content.style.cssText = `
                padding: 20px;
                color: #555;
                font-size: 14px;
                line-height: 1.6;
                white-space: pre-wrap;
            `;
            content.textContent = message;

            // 创建按钮容器
            const buttonContainer = document.createElement('div');
            buttonContainer.style.cssText = `
                padding: 16px 20px;
                border-top: 1px solid #e0e0e0;
                display: flex;
                gap: 10px;
                justify-content: flex-end;
            `;

            // 关闭对话框的函数
            const closeDialog = (value) => {
                overlay.style.animation = 'dialogFadeOut 0.2s ease-in';
                setTimeout(() => {
                    overlay.remove();
                    style.remove();
                }, 200);
                resolve(value);
            };

            // 创建按钮
            buttons.forEach((btnConfig) => {
                const button = document.createElement('button');
                button.textContent = btnConfig.text || '按钮';
                button.style.cssText = `
                    padding: 8px 16px;
                    border: none;
                    border-radius: 4px;
                    font-size: 14px;
                    cursor: pointer;
                    transition: all 0.2s;
                    min-width: 80px;
                    font-weight: 500;
                `;

                if (btnConfig.primary) {
                    button.style.background = '#4CAF50';
                    button.style.color = 'white';
                    button.addEventListener('mouseenter', () => {
                        button.style.background = '#45a049';
                    });
                    button.addEventListener('mouseleave', () => {
                        button.style.background = '#4CAF50';
                    });
                } else if (btnConfig.danger) {
                    button.style.background = '#f44336';
                    button.style.color = 'white';
                    button.addEventListener('mouseenter', () => {
                        button.style.background = '#da190b';
                    });
                    button.addEventListener('mouseleave', () => {
                        button.style.background = '#f44336';
                    });
                } else {
                    button.style.background = '#e0e0e0';
                    button.style.color = '#333';
                    button.addEventListener('mouseenter', () => {
                        button.style.background = '#d0d0d0';
                    });
                    button.addEventListener('mouseleave', () => {
                        button.style.background = '#e0e0e0';
                    });
                }

                button.addEventListener('click', () => {
                    closeDialog(btnConfig.value);
                });

                buttonContainer.appendChild(button);
            });

            // 组装对话框
            dialog.appendChild(titleBar);
            dialog.appendChild(content);
            dialog.appendChild(buttonContainer);
            overlay.appendChild(dialog);

            // 点击遮罩层关闭（可选）
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) {
                    closeDialog(null);
                }
            });

            // 添加到页面
            document.body.appendChild(overlay);

            // 添加淡出动画样式
            style.textContent += `
                @keyframes dialogFadeOut {
                    from {
                        opacity: 1;
                        transform: scale(1);
                    }
                    to {
                        opacity: 0;
                        transform: scale(0.9);
                    }
                }
            `;
        });
    };

    // 检查元素是否在可视区域（扩大预加载范围）
    const isInViewport = (element) => {
        const rect = element.getBoundingClientRect();
        const viewHeight = window.innerHeight || document.documentElement.clientHeight;
        const preloadRange = 300; // 增加预加载范围到300px
        return (
            rect.top >= -preloadRange && 
            rect.bottom <= viewHeight + preloadRange
        );
    };
    
    const delay = (ms = 0) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
    const randomInRange = (min, max) => {
        const start = Number.isFinite(min) ? min : 0;
        const end = Number.isFinite(max) ? max : start;
        if (end <= start) return start;
        return Math.floor(Math.random() * (end - start + 1)) + start;
    };

    const HIGHLIGHT_CONTAINER_SELECTOR = '.gl5t, .gl1t, .gl1e, .gl1c, .gl1d, .gl1m, .gl1o, .gl1b, tr';

    const resolveHighlightTarget = (element) => {
        if (!element || !(element instanceof Element)) return null;
        if (typeof element.matches === 'function' && element.matches(HIGHLIGHT_CONTAINER_SELECTOR)) {
            return element;
        }
        if (typeof element.closest === 'function') {
            const container = element.closest(HIGHLIGHT_CONTAINER_SELECTOR);
            if (container) return container;
        }
        return null;
    };

    // ==================== 通用并发控制函数 ====================
    // 获取随机延迟（基于 refreshIntervalMin 和 refreshIntervalMax）
    const getRandomInterval = () => {
        const min = parseInt(localStorage.getItem('REFRESH_INTERVAL_MIN_PREF_KEY') || '1200');
        const max = parseInt(localStorage.getItem('REFRESH_INTERVAL_MAX_PREF_KEY') || '2000');
        return Math.floor(Math.random() * (max - min + 1)) + min;
    };

    const executeWithConcurrencyLimit = async (tasks, concurrency = null, onProgress = null) => {
        if (!tasks?.length) return [];
        const maxConcurrent = Math.max(1, concurrency || refreshConcurrent || 1);
        const results = new Array(tasks.length);
        let completed = 0;
        let taskIndex = 0;
        
        const executeNext = async () => {
            // 从任务队列中取出下一个任务索引
            const idx = taskIndex++;
            if (idx >= tasks.length) return;
            
            try {
                results[idx] = await tasks[idx]();
            } catch (err) {
                results[idx] = { error: err };
            } finally {
                completed++;
                onProgress?.(completed, tasks.length);
            }
            
            // 循环执行下一个任务（这样可以确保序列化）
            return executeNext();
        };
        
        // 并发启动 maxConcurrent 个 worker
        const workers = [];
        for (let i = 0; i < Math.min(maxConcurrent, tasks.length); i++) {
            workers.push(executeNext());
        }
        
        // 等待所有 worker 完成
        await Promise.all(workers);
        return results;
    };
    
    // 种子请求队列控制
    const magnetRequestQueue = {
        queue: [],
        running: 0,
        maxConcurrent: 1, // 降低到1，测试是否脚本导致封禁
        minInterval: 1500, // 最小间隔（基准值）
        minIntervalRange: [1200, 2000], // 随机间隔范围：1.2秒到2秒
        lastRequestTime: 0,
        totalTasks: 0, // 总任务数
        completedTasks: 0, // 已完成任务数
        
        // 获取随机间隔时间
        getRandomInterval() {
            const [min, max] = this.minIntervalRange;
            return Math.floor(Math.random() * (max - min + 1)) + min;
        },
        
        // 提升任务优先级到最高（鼠标悬停时插队）
        promoteTask(cacheKey) {
            if (!cacheKey) return;
            const task = this.queue.find(t => t.cacheKey === cacheKey);
            if (task) {
                const oldPriority = task.priority;
                task.priority = 100; // 最高优先级
                this.queue.sort((a, b) => b.priority - a.priority);
                const position = this.queue.indexOf(task) + 1;
                console.log(`[EhMagnet] 🚀 任务插队: 优先级 ${oldPriority} → 100，当前排队位置: ${position}/${this.queue.length}，正在执行: ${this.running}`);
            } else {
                console.log(`[EhMagnet] ⚠️ 任务已在处理或已完成: ${cacheKey}`);
            }
        },
        
        async execute(fn, priority = 0, cacheKey = null, relatedElement = null) {
            // 当队列空闲且没有运行中的任务时，重置计数，避免累计到下一批
            // 注意：必须严格判断 running === 0 和 queue.length === 0
            // 即使 completedTasks < totalTasks，也要重置（防止新批次任务被累计计数）
            if (this.running === 0 && this.queue.length === 0) {
                this.totalTasks = 0;
                this.completedTasks = 0;
            }
            this.totalTasks++;
            return new Promise((resolve, reject) => {
                const highlightElement = resolveHighlightTarget(relatedElement);
                this.queue.push({ fn, resolve, reject, priority, cacheKey, highlightElement });
                this.queue.sort((a, b) => b.priority - a.priority); // 高优先级在前
                this.process();
            });
        },
        
        async process() {
            // 动态重新排序：根据当前可视区域调整优先级（每10次处理才检查一次，减少开销）
            if (this.completedTasks % 10 === 0 && this.queue.length > 0) {
                this.queue.forEach(task => {
                    // 如果任务有关联的 DOM 元素（种子请求），重新计算优先级
                    if (task.highlightElement && isInViewport(task.highlightElement)) {
                        // 提升为高优先级
                        if (task.priority < 10) {
                            task.priority = 10;
                        }
                    }
                });
                
                // 重新排序（高优先级在前）
                this.queue.sort((a, b) => b.priority - a.priority);
            }
            
            // 尝试启动多个并发任务直到达到 maxConcurrent 限制
            while (this.running < this.maxConcurrent && this.queue.length > 0) {
                // 检查请求间隔（仅在补充任务时需要间隔，初始批量启动时跳过）
                // 如果已有任务运行且距离上次启动时间太短，延迟处理
                if (this.running > 0 && this.lastRequestTime > 0) {
                    const now = Date.now();
                    const timeSinceLastRequest = now - this.lastRequestTime;
                    const randomInterval = this.getRandomInterval();
                    if (timeSinceLastRequest < randomInterval) {
                        // 只有在补充单个任务时才延迟，不影响初始批量启动
                        setTimeout(() => this.process(), randomInterval - timeSinceLastRequest);
                        return;
                    }
                }
                
                const task = this.queue.shift();
                this.running++;
                const currentRunning = this.running;  // 捕获当前值用于日志
                this.lastRequestTime = Date.now();
                
                console.log(`[EhMagnet] 🚀 启动任务 | 当前并发: ${currentRunning}/${this.maxConcurrent} | 队列剩余: ${this.queue.length}`);
                
                // 给关联元素添加加载标记
                if (task.highlightElement) {
                    task.highlightElement.style.outline = '2px solid #4CAF50';
                    task.highlightElement.style.outlineOffset = '2px';
                }

                // 异步执行任务（不阻塞循环）
                (async () => {
                    try {
                        const result = await task.fn();
                        task.resolve(result);
                    } catch (err) {
                        task.reject(err);
                    } finally {
                        // 移除加载标记
                        if (task.highlightElement) {
                            task.highlightElement.style.outline = '';
                            task.highlightElement.style.outlineOffset = '';
                        }
                        
                        this.running--;
                        this.completedTasks++;
                        
                        // 更新进度提示
                        this.updateProgress();
                        
                        // 任务完成后，等待间隔再处理下一个任务
                        const randomInterval = this.getRandomInterval();
                        setTimeout(() => this.process(), randomInterval);
                    }
                })();
                
                // 初始批量启动时：快速连续启动到 maxConcurrent，无需等待
                // 只有第一个任务设置 lastRequestTime，后续任务检查间隔会在下次补充时生效
                if (this.running === 1) {
                    // 第一个任务启动后，重置时间戳，允许后续任务快速启动
                    this.lastRequestTime = 0;
                }
            }
        },
        
        updateProgress() {
            // 安全检查：确保 document.body 存在
            if (!document.body) {
                console.warn('[EhMagnet] document.body 不存在，跳过进度更新');
                return;
            }
            
            try {
                // 查找或创建进度提示元素
                let progressEl = document.getElementById('eh-magnet-progress');
                if (!progressEl) {
                    progressEl = document.createElement('div');
                    progressEl.id = 'eh-magnet-progress';
                    progressEl.style.cssText = `
                        position: fixed;
                        top: 10px;
                        right: 10px;
                        background: rgba(0, 0, 0, 0.85);
                        color: white;
                        padding: 8px 12px;
                        border-radius: 4px;
                        font-size: 12px;
                        z-index: 10000;
                        box-shadow: 0 2px 8px rgba(0,0,0,0.3);
                    `;
                    document.body.appendChild(progressEl);
                }
                
                // 仅在 showGlobalProgress 为 true 时显示全局进度
                if (this.showGlobalProgress !== false) {
                    if (this.completedTasks < this.totalTasks) {
                        const percent = Math.round((this.completedTasks / this.totalTasks) * 100);
                        progressEl.innerHTML = `⏳ 加载种子信息: ${this.completedTasks}/${this.totalTasks} (${percent}%)`;
                        progressEl.style.display = 'block';
                        updateToastContainerPosition();
                    } else {
                        progressEl.innerHTML = `✅ 种子加载完成: ${this.totalTasks}项`;
                        progressEl.style.display = 'block';
                        updateToastContainerPosition();
                        // 3秒后隐藏
                        setTimeout(() => {
                            if (progressEl) {
                                progressEl.style.display = 'none';
                                updateToastContainerPosition();
                            }
                        }, 3000);
                    }
                } else {
                    progressEl.style.display = 'none';
                    updateToastContainerPosition();
                }
            } catch (err) {
                console.warn('[EhMagnet] 更新进度提示失败:', err);
            }
        }
    };
    let magnetGroupSeq = 0;
    const downloadedGalleries = new Map();
    const downloadedMagnets = new Map();
    const galleryDownloadedMagnets = new Map();
    const ignoredGalleries = new Map();
    const ignoredMagnets = new Map();
    const galleryIgnoredMagnets = new Map();
    const legacyDownloadedGalleries = new Set();
    const tempHiddenGalleries = new Set();
    let tempHiddenStateLoaded = false;
    let galleryInjectionPending = false;
    let galleryInjectionDone = false;
    // 多选时排除选项（拆分为4个独立控制）
    let excludeDownloadedOnSelect = true;  // 排除已下载
    let excludeIgnoredOnSelect = true;      // 排除已忽略
    let excludeNoSeedsOnSelect = true;      // 排除无种子
    let excludeOutdatedOnSelect = true;     // 排除种子过时
    
    // 兼容性：保留旧的 excludeDownloaded 变量（已下载+已忽略的组合）
    let excludeDownloaded = true;
    let enableDebugLog = false;
    let abdmPort = 15151; // AB Download Manager 默认端口
    let autoRefreshEnabled = false; // 默认关闭自动刷新
    let hoverRefreshEnabled = true; // 默认开启鼠标悬停刷新
    let refreshConcurrent = 1; // 刷新并发数
    let refreshIntervalMin = 1200; // 刷新间隔最小值（毫秒）
    let refreshIntervalMax = 2000; // 刷新间隔最大值（毫秒）
    let lastCheckboxIndex = null;
    const EXCLUDE_PREF_KEY = 'eh_magnet_exclude_downloaded';
    const EXCLUDE_DOWNLOADED_SELECT_KEY = 'eh_magnet_exclude_downloaded_select';
    const EXCLUDE_IGNORED_SELECT_KEY = 'eh_magnet_exclude_ignored_select';
    const EXCLUDE_NO_SEEDS_SELECT_KEY = 'eh_magnet_exclude_no_seeds_select';
    const EXCLUDE_OUTDATED_PREF_KEY = 'eh_magnet_exclude_outdated';
    const LOG_PREF_KEY = 'eh_magnet_enable_logs';
    const SEARCH_INFINITE_SCROLL_PREF_KEY = 'eh_magnet_search_infinite_scroll';
    const ABDM_PORT_PREF_KEY = 'eh_magnet_abdm_port';
    const AUTO_REFRESH_PREF_KEY = 'eh_magnet_auto_refresh';
    const HOVER_REFRESH_PREF_KEY = 'eh_magnet_hover_refresh';
    const REFRESH_CONCURRENT_PREF_KEY = 'eh_magnet_refresh_concurrent';
    const REFRESH_INTERVAL_MIN_PREF_KEY = 'eh_magnet_refresh_interval_min';
    const REFRESH_INTERVAL_MAX_PREF_KEY = 'eh_magnet_refresh_interval_max';
    const DOWNLOAD_CACHE_STORAGE_KEY = 'eh_magnet_download_cache';
    const DOWNLOAD_CACHE_PREF_KEY = 'eh_magnet_download_cache_enabled';
    const DOWNLOAD_CACHE_TIMEOUT_PREF_KEY = 'eh_magnet_download_cache_timeout_min';
    const AUTO_FETCH_BATCH_QUERY_PREF_KEY = 'eh_magnet_auto_fetch_batch_query';
    
    // IndexedDB 配置
    const IDB_NAME = 'EhSearchMagnetDB';
    const IDB_VERSION = 2;  // 升级版本以支持标记存储
    const IDB_STORES = {
        recentBatches: 'recent_batches',
        downloadCache: 'download_cache',
        downloadedGalleries: 'downloaded_galleries',
        ignoredGalleries: 'ignored_galleries',
        downloadedMagnets: 'downloaded_magnets',
        ignoredMagnets: 'ignored_magnets'
    };
    let idbDatabase = null;
    let idbSupported = false;
    const STATE_REVISION_KEY = 'eh_magnet_state_revision';
    const STORAGE_VERSION = 2;
    const TEMP_HIDDEN_STORAGE_KEY = 'eh_magnet_temp_hidden_galleries';
    const SELECTION_EXPORT_VERSION = 1;
    const TEMP_HIDDEN_CLASS = 'eh-magnet-temp-hidden';
    const LOLICON_SCROLL_TRIGGER_CLASS = 'LOLICON-infinite-scroll-trigger';
    let lastKnownStateRevision = 0;
    let lastStateSyncTime = 0;
    let stateSyncScheduled = false;

    const sizeUnitMap = {
        '': 1,
        k: 1024,
        m: 1024 * 1024,
        g: 1024 * 1024 * 1024,
        t: 1024 * 1024 * 1024 * 1024,
        p: 1024 * 1024 * 1024 * 1024 * 1024,
    };

    const formatTimestampForFilename = (date = new Date()) => {
        const pad = (value) => String(value).padStart(2, '0');
        return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
    };

    const getMenuSurfaceStyles = () => {
        const computed = window.getComputedStyle(document.body);
        const background = computed.backgroundColor || '#1f1f1f';
        const color = computed.color || '#fff';
        const borderColor = color || '#fff';
        return { background, color, borderColor };
    };

    const getMenuHoverBackground = () => 'rgba(255, 255, 255, 0.12)';

    const applyMenuSurfaceStyle = (menu, options = {}) => {
        const {
            minWidth = '160px',
            padding = '8px',
            zIndex = '10000',
        } = options;
        const { background, color, borderColor } = getMenuSurfaceStyles();
        menu.style.background = background;
        menu.style.color = color;
        menu.style.border = `1px solid ${borderColor}`;
        menu.style.boxShadow = '0 4px 16px rgba(0,0,0,0.4)';
        menu.style.borderRadius = '6px';
        if (minWidth !== null) menu.style.minWidth = minWidth;
        menu.style.padding = padding;
        menu.style.zIndex = zIndex;
        menu.style.fontSize = '13px';
        menu.style.lineHeight = '1.5';
    };

    const ensureTempHideStyles = () => {
        if (tempHideStyleInjected) return;
        tempHideStyleInjected = true;
        const style = document.createElement('style');
        style.textContent = `
            .${TEMP_HIDDEN_CLASS} {
                display: none !important;
            }
        `;
        document.head.appendChild(style);
    };

    const loadTempHiddenGalleries = () => {
        if (tempHiddenStateLoaded) return;
        tempHiddenStateLoaded = true;
        try {
            const raw = sessionStorage.getItem(TEMP_HIDDEN_STORAGE_KEY);
            if (!raw) return;
            const parsed = JSON.parse(raw);
            const list = Array.isArray(parsed?.galleries)
                ? parsed.galleries
                : (Array.isArray(parsed) ? parsed : []);
            list.forEach((gid) => {
                if (!gid) return;
                tempHiddenGalleries.add(String(gid));
            });
        } catch (err) {
            console.warn('加载临时隐藏状态失败', err);
        }
    };

    const persistTempHiddenGalleries = () => {
        try {
            if (!tempHiddenGalleries.size) {
                sessionStorage.removeItem(TEMP_HIDDEN_STORAGE_KEY);
                return;
            }
            const payload = {
                version: 1,
                galleries: Array.from(tempHiddenGalleries),
            };
            sessionStorage.setItem(TEMP_HIDDEN_STORAGE_KEY, JSON.stringify(payload));
        } catch (err) {
            console.warn('保存临时隐藏状态失败', err);
        }
    };

    let tooltipStyleInjected = false;
    let tooltipHideTimer = null;
    let tooltipAnchor = null;
    let tooltipData = null;
   let tooltipTitle = '';
   let tooltipElement = null;
   let tooltipListenersBound = false;
    let tempHideStyleInjected = false;

    let enableSearchInfiniteScroll = false;
    let autoFetchBatchQuery = false;
    let isCopyingMagnets = false; // 标志：正在复制磁链，禁用其他刷新操作
    let searchInfiniteScrollInitialized = false;
    let searchInfiniteScrollObserver = null;
    let searchInfiniteScrollSentinel = null;
    let searchInfiniteScrollContainer = null;
    let searchInfiniteScrollNextUrl = '';
    let searchInfiniteScrollLoading = false;
    let searchInfiniteScrollStyleInjected = false;

    const isArchiveKey = (value) => typeof value === 'string' && value.startsWith('archive://');

    const withDebugLog = (logger) => {
        if (!enableDebugLog) return;
        try {
            logger();
        } catch (err) {
            try {
                console.warn('[EhMagnet] 日志输出失败', err);
            } catch (_) {
                // 忽略备用日志中的异常
            }
        }
    };

    const getAriaEhAPI = () => {
        // 先尝试从unsafeWindow获取（Tampermonkey需要）
        if (typeof unsafeWindow !== 'undefined' && unsafeWindow.AriaEhAPI) {
            return unsafeWindow.AriaEhAPI;
        }
        // 再尝试从window获取
        if (typeof window !== 'undefined' && window.AriaEhAPI) {
            return window.AriaEhAPI;
        }
        return null;
    };

    const isAriaEhBridgeAvailable = () => {
        const api = getAriaEhAPI();
        // 检查API对象是否存在且有必要的方法
        if (!api || typeof api.enqueueTasks !== 'function') {
            return false;
        }
        // 尝试一个实际的检查来确认API真的可用
        try {
            // 检查AriaEh是否真的在运行（检查其核心功能）
            if (typeof api.isConfigured === 'function') {
                api.isConfigured(); // 调用一次来验证
                return true;
            }
            return true;
        } catch (err) {
            // 如果调用失败，说明AriaEh脚本未运行
            return false;
        }
    };

    const isAriaEhBridgeConfigured = () => {
        const api = getAriaEhAPI();
        if (!api) return false;
        if (typeof api.isConfigured === 'function') {
            try {
                return !!api.isConfigured();
            } catch (err) {
                console.warn('检测 EhAria2 配置状态失败', err);
                return false;
            }
        }
        if (typeof api.getPreferences === 'function') {
            try {
                const prefs = api.getPreferences();
                return Boolean(prefs?.rpc);
            } catch (err) {
                console.warn('读取 EhAria2 偏好失败', err);
            }
        }
        return false;
    };

    // ==================== IndexedDB 相关函数 ====================

    /**
     * 初始化IndexedDB数据库
     */
    const initIndexedDB = () => {
        return new Promise((resolve, reject) => {
            if (!('indexedDB' in window)) {
                idbSupported = false;
                console.warn('[EhMagnet] 浏览器不支持IndexedDB');
                resolve(null);
                return;
            }

            const request = indexedDB.open(IDB_NAME, IDB_VERSION);

            request.onerror = () => {
                idbSupported = false;
                console.warn('[EhMagnet] IndexedDB打开失败:', request.error);
                resolve(null);
            };

            request.onsuccess = () => {
                idbSupported = true;
                idbDatabase = request.result;
                console.log('[EhMagnet] IndexedDB初始化成功');
                resolve(idbDatabase);
            };

            request.onupgradeneeded = (e) => {
                const db = e.target.result;
                
                // 创建最近下载记录存储
                if (!db.objectStoreNames.contains(IDB_STORES.recentBatches)) {
                    const batchStore = db.createObjectStore(IDB_STORES.recentBatches, { keyPath: 'id' });
                    batchStore.createIndex('timestamp', 'timestamp', { unique: false });
                    console.log('[EhMagnet] 创建recent_batches存储');
                }

                // 创建下载缓存存储
                if (!db.objectStoreNames.contains(IDB_STORES.downloadCache)) {
                    const cacheStore = db.createObjectStore(IDB_STORES.downloadCache, { keyPath: 'magnet' });
                    cacheStore.createIndex('timestamp', 'timestamp', { unique: false });
                    console.log('[EhMagnet] 创建download_cache存储');
                }

                // 创建已下载画廊存储
                if (!db.objectStoreNames.contains(IDB_STORES.downloadedGalleries)) {
                    const dgStore = db.createObjectStore(IDB_STORES.downloadedGalleries, { keyPath: 'gid' });
                    dgStore.createIndex('timestamp', 'timestamp', { unique: false });
                    console.log('[EhMagnet] 创建downloaded_galleries存储');
                }

                // 创建已忽略画廊存储
                if (!db.objectStoreNames.contains(IDB_STORES.ignoredGalleries)) {
                    const igStore = db.createObjectStore(IDB_STORES.ignoredGalleries, { keyPath: 'gid' });
                    igStore.createIndex('timestamp', 'timestamp', { unique: false });
                    console.log('[EhMagnet] 创建ignored_galleries存储');
                }

                // 创建已下载磁链存储
                if (!db.objectStoreNames.contains(IDB_STORES.downloadedMagnets)) {
                    const dmStore = db.createObjectStore(IDB_STORES.downloadedMagnets, { keyPath: 'href' });
                    dmStore.createIndex('gid', 'gid', { unique: false });
                    dmStore.createIndex('timestamp', 'timestamp', { unique: false });
                    console.log('[EhMagnet] 创建downloaded_magnets存储');
                }

                // 创建已忽略磁链存储
                if (!db.objectStoreNames.contains(IDB_STORES.ignoredMagnets)) {
                    const imStore = db.createObjectStore(IDB_STORES.ignoredMagnets, { keyPath: 'href' });
                    imStore.createIndex('gid', 'gid', { unique: false });
                    imStore.createIndex('timestamp', 'timestamp', { unique: false });
                    console.log('[EhMagnet] 创建ignored_magnets存储');
                }
            };
        });
    };

    /**
     * 保存最近下载记录到IndexedDB
     */
    const saveRecentBatchesToIDB = async (batches) => {
        if (!idbSupported || !idbDatabase) return false;

        try {
            const tx = idbDatabase.transaction(IDB_STORES.recentBatches, 'readwrite');
            const store = tx.objectStore(IDB_STORES.recentBatches);

            // 清空旧数据
            await new Promise((resolve, reject) => {
                const clearReq = store.clear();
                clearReq.onsuccess = resolve;
                clearReq.onerror = reject;
            });

            // 插入新数据
            for (const batch of batches) {
                await new Promise((resolve, reject) => {
                    const addReq = store.add(batch);
                    addReq.onsuccess = resolve;
                    addReq.onerror = reject;
                });
            }

            // 等待事务完成
            await new Promise((resolve, reject) => {
                tx.oncomplete = resolve;
                tx.onerror = reject;
            });

            console.log(`[EhMagnet] 已保存${batches.length}个批次到IndexedDB`);
            return true;
        } catch (err) {
            console.error('[EhMagnet] IndexedDB保存最近下载失败:', err);
            return false;
        }
    };

    /**
     * 从IndexedDB读取最近下载记录
     */
    const loadRecentBatchesFromIDB = async () => {
        if (!idbSupported || !idbDatabase) return null;

        try {
            const tx = idbDatabase.transaction(IDB_STORES.recentBatches, 'readonly');
            const store = tx.objectStore(IDB_STORES.recentBatches);

            return new Promise((resolve, reject) => {
                const request = store.getAll();
                request.onsuccess = () => {
                    console.log(`[EhMagnet] 从IndexedDB读取${request.result.length}个批次`);
                    resolve(request.result);
                };
                request.onerror = () => reject(request.error);
            });
        } catch (err) {
            console.error('[EhMagnet] IndexedDB读取最近下载失败:', err);
            return null;
        }
    };

    /**
     * 保存下载缓存到IndexedDB
     */
    const saveDownloadCacheToIDB = async (cacheData) => {
        if (!idbSupported || !idbDatabase) return false;

        try {
            const tx = idbDatabase.transaction(IDB_STORES.downloadCache, 'readwrite');
            const store = tx.objectStore(IDB_STORES.downloadCache);

            // 清空旧数据
            await new Promise((resolve, reject) => {
                const clearReq = store.clear();
                clearReq.onsuccess = resolve;
                clearReq.onerror = reject;
            });

            // 插入新数据
            for (const [magnet, data] of cacheData) {
                await new Promise((resolve, reject) => {
                    const addReq = store.add({ magnet, ...data });
                    addReq.onsuccess = resolve;
                    addReq.onerror = reject;
                });
            }

            // 等待事务完成
            await new Promise((resolve, reject) => {
                tx.oncomplete = resolve;
                tx.onerror = reject;
            });

            console.log(`[EhMagnet] 已保存${cacheData.size}条缓存到IndexedDB`);
            return true;
        } catch (err) {
            console.error('[EhMagnet] IndexedDB保存缓存失败:', err);
            return false;
        }
    };

    /**
     * 从IndexedDB读取下载缓存
     */
    const loadDownloadCacheFromIDB = async () => {
        if (!idbSupported || !idbDatabase) return null;

        try {
            const tx = idbDatabase.transaction(IDB_STORES.downloadCache, 'readonly');
            const store = tx.objectStore(IDB_STORES.downloadCache);

            return new Promise((resolve, reject) => {
                const request = store.getAll();
                request.onsuccess = () => {
                    const cacheMap = new Map();
                    for (const item of request.result) {
                        const { magnet, ...data } = item;
                        cacheMap.set(magnet, data);
                    }
                    console.log(`[EhMagnet] 从IndexedDB读取${cacheMap.size}条缓存`);
                    resolve(cacheMap);
                };
                request.onerror = () => reject(request.error);
            });
        } catch (err) {
            console.error('[EhMagnet] IndexedDB读取缓存失败:', err);
            return null;
        }
    };

    /**
     * 保存已下载画廊到IndexedDB
     */
    const saveDownloadedGalleriesToIDB = async (data) => {
        if (!idbSupported || !idbDatabase) return false;
        try {
            const tx = idbDatabase.transaction(IDB_STORES.downloadedGalleries, 'readwrite');
            const store = tx.objectStore(IDB_STORES.downloadedGalleries);
            
            // 对于已下载数据，全量替换以确保删除正确
            await new Promise((resolve, reject) => {
                const clearReq = store.clear();
                clearReq.onsuccess = resolve;
                clearReq.onerror = reject;
            });
            
            for (const [gid, timestamp] of Object.entries(data)) {
                await new Promise((resolve, reject) => {
                    const addReq = store.add({ gid: String(gid), timestamp });
                    addReq.onsuccess = resolve;
                    addReq.onerror = reject;
                });
            }
            await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = reject; });
            console.log(`[EhMagnet] 已更新${Object.keys(data).length}个已下载画廊到IndexedDB`);
            return true;
        } catch (err) {
            console.error('[EhMagnet] 保存已下载画廊失败:', err);
            return false;
        }
    };

    const loadDownloadedGalleriesFromIDB = async () => {
        if (!idbSupported || !idbDatabase) return null;
        try {
            const tx = idbDatabase.transaction(IDB_STORES.downloadedGalleries, 'readonly');
            const store = tx.objectStore(IDB_STORES.downloadedGalleries);
            return new Promise((resolve, reject) => {
                const request = store.getAll();
                request.onsuccess = () => {
                    const result = {};
                    for (const item of request.result) {
                        result[item.gid] = item.timestamp;
                    }
                    console.log(`[EhMagnet] 从IndexedDB读取${Object.keys(result).length}个已下载画廊`);
                    resolve(result);
                };
                request.onerror = () => reject(request.error);
            });
        } catch (err) {
            console.error('[EhMagnet] 读取已下载画廊失败:', err);
            return null;
        }
    };

    /**
     * 保存已下载磁链到IndexedDB - 增量更新版本
     * 仅更新有变化的记录，避免全量替换带来的性能问题
     */
    const saveDownloadedMagnetsToIDB = async (newData) => {
        if (!idbSupported || !idbDatabase) {
            console.warn('[EhMagnet] IndexedDB不可用，跳过磁链保存');
            return false;
        }
        
        const startTime = performance.now();
        try {
            // 第1步：读取现有数据
            const existingData = await loadDownloadedMagnetsFromIDB();
            if (!existingData) {
                console.warn('[EhMagnet] 无法读取现有磁链数据，回退到全量替换');
                return await addOrUpdateToIDB(IDB_STORES.downloadedMagnets, newData, true);
            }

            // 第2步：计算差异
            const existingSet = new Set(existingData.map(item => item.href));
            const newSet = new Set(newData.map(item => item.href));
            
            // 需要新增的
            const toAdd = newData.filter(item => !existingSet.has(item.href));
            // 需要删除的（存在于旧数据但不在新数据中）
            const toDelete = existingData
                .filter(item => !newSet.has(item.href))
                .map(item => item.href);

            // 第3步：执行增量操作
            let addResult = { success: true, count: 0 };
            let deleteResult = { success: true, count: 0 };

            if (toAdd.length > 0) {
                addResult = await addOrUpdateToIDB(IDB_STORES.downloadedMagnets, toAdd, true);
                if (!addResult.success) {
                    console.error('[EhMagnet] 新增磁链失败，但继续处理');
                }
            }

            if (toDelete.length > 0) {
                deleteResult = await deleteFromIDB(IDB_STORES.downloadedMagnets, toDelete);
                if (!deleteResult.success) {
                    console.error('[EhMagnet] 删除磁链失败，但继续处理');
                }
            }

            // 第4步：日志和统计
            const elapsed = performance.now() - startTime;
            console.log(`[EhMagnet] 磁链增量更新完成 | 总计${newData.length}条 | +${addResult.count} -${deleteResult.count} | 耗时${elapsed.toFixed(2)}ms`);
            
            return addResult.success || deleteResult.success || (toAdd.length === 0 && toDelete.length === 0);
        } catch (err) {
            console.error('[EhMagnet] 保存已下载磁链失败:', err);
            toastError(`磁链保存失败: ${err?.message || '未知错误'}`);
            return false;
        }
    };

    const loadDownloadedMagnetsFromIDB = async () => {
        if (!idbSupported || !idbDatabase) return null;
        try {
            const tx = idbDatabase.transaction(IDB_STORES.downloadedMagnets, 'readonly');
            const store = tx.objectStore(IDB_STORES.downloadedMagnets);
            return new Promise((resolve, reject) => {
                const request = store.getAll();
                request.onsuccess = () => {
                    console.log(`[EhMagnet] 从IndexedDB读取${request.result.length}条已下载磁链`);
                    resolve(request.result);
                };
                request.onerror = () => reject(request.error);
            });
        } catch (err) {
            console.error('[EhMagnet] 读取已下载磁链失败:', err);
            return null;
        }
    };

    const saveIgnoredGalleriesToIDB = async (data) => {
        if (!idbSupported || !idbDatabase) return false;
        try {
            const tx = idbDatabase.transaction(IDB_STORES.ignoredGalleries, 'readwrite');
            const store = tx.objectStore(IDB_STORES.ignoredGalleries);
            
            // 对已忽略的数据，先清空再添加以确保删除正确
            await new Promise((resolve, reject) => {
                const clearReq = store.clear();
                clearReq.onsuccess = resolve;
                clearReq.onerror = reject;
            });
            
            for (const [gid, timestamp] of Object.entries(data)) {
                await new Promise((resolve, reject) => {
                    const addReq = store.add({ gid: String(gid), timestamp });
                    addReq.onsuccess = resolve;
                    addReq.onerror = reject;
                });
            }
            await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = reject; });
            console.log(`[EhMagnet] 已更新${Object.keys(data).length}个已忽略画廊到IndexedDB`);
            return true;
        } catch (err) {
            console.error('[EhMagnet] 保存已忽略画廊失败:', err);
            return false;
        }
    };

    const loadIgnoredGalleriesFromIDB = async () => {
        if (!idbSupported || !idbDatabase) return null;
        try {
            const tx = idbDatabase.transaction(IDB_STORES.ignoredGalleries, 'readonly');
            const store = tx.objectStore(IDB_STORES.ignoredGalleries);
            return new Promise((resolve, reject) => {
                const request = store.getAll();
                request.onsuccess = () => {
                    const result = {};
                    for (const item of request.result) {
                        result[item.gid] = item.timestamp;
                    }
                    console.log(`[EhMagnet] 从IndexedDB读取${Object.keys(result).length}个已忽略画廊`);
                    resolve(result);
                };
                request.onerror = () => reject(request.error);
            });
        } catch (err) {
            console.error('[EhMagnet] 读取已忽略画廊失败:', err);
            return null;
        }
    };

    // ==================== IndexedDB 操作队列去重机制 ====================

    /**
     * 操作队列去重类：合并短时间内的相同操作，防止高频重复调用
     * 适用场景：批量复制、快速点击、频繁更新
     */
    class DebouncedIDBOperation {
        constructor(operationName, debounceMs = 100) {
            this.operationName = operationName;
            this.debounceMs = debounceMs;
            this.pendingData = null;
            this.debounceTimer = null;
            this.isExecuting = false;
            this.operationFunc = null;
        }

        /**
         * 设置操作函数
         * @param {Function} func - 实际执行的操作函数，接收合并后的数据
         */
        setOperation(func) {
            this.operationFunc = func;
        }

        /**
         * 添加数据到队列（自动去重和合并）
         * @param {Array|Object} data - 要添加的数据
         * @param {Function} mergeFunc - 合并函数，接收旧数据和新数据，返回合并结果
         */
        enqueue(data, mergeFunc = null) {
            // 合并待处理数据
            if (this.pendingData === null) {
                this.pendingData = Array.isArray(data) ? [...data] : data;
            } else if (mergeFunc) {
                this.pendingData = mergeFunc(this.pendingData, data);
            } else if (Array.isArray(this.pendingData) && Array.isArray(data)) {
                // 默认合并策略：数组去重
                const merged = new Map();
                
                // 先加入旧数据
                this.pendingData.forEach(item => {
                    const key = item.href || item.gid || JSON.stringify(item);
                    merged.set(key, item);
                });
                
                // 新数据覆盖旧数据
                data.forEach(item => {
                    const key = item.href || item.gid || JSON.stringify(item);
                    merged.set(key, item);
                });
                
                this.pendingData = Array.from(merged.values());
            } else {
                this.pendingData = data;
            }

            // 重置防抖计时器
            if (this.debounceTimer) {
                clearTimeout(this.debounceTimer);
            }

            this.debounceTimer = setTimeout(async () => {
                await this.flush();
            }, this.debounceMs);

            const queueSize = Array.isArray(this.pendingData) ? this.pendingData.length : 1;
            console.log(`[EhMagnet] 📋 操作入队: ${this.operationName} | 待处理数据: ${queueSize}条 | 防抖延迟: ${this.debounceMs}ms`);
        }

        /**
         * 立即执行待处理的操作
         */
        async flush() {
            if (this.isExecuting || !this.operationFunc || this.pendingData === null) {
                return;
            }

            this.isExecuting = true;
            const data = this.pendingData;
            this.pendingData = null;

            try {
                const startTime = performance.now();
                const queueSize = Array.isArray(data) ? data.length : 1;
                console.log(`[EhMagnet] 🚀 执行去重操作: ${this.operationName} | 批量数据: ${queueSize}条`);
                
                await this.operationFunc(data);
                
                const elapsed = performance.now() - startTime;
                console.log(`[EhMagnet] ✅ 去重操作完成: ${this.operationName} | 耗时${elapsed.toFixed(2)}ms`);
            } catch (err) {
                console.error(`[EhMagnet] ❌ 去重操作失败: ${this.operationName} |`, err);
            } finally {
                this.isExecuting = false;
            }
        }

        /**
         * 清空队列
         */
        clear() {
            if (this.debounceTimer) {
                clearTimeout(this.debounceTimer);
                this.debounceTimer = null;
            }
            this.pendingData = null;
        }

        /**
         * 获取队列状态
         */
        getStatus() {
            return {
                operationName: this.operationName,
                hasPending: this.pendingData !== null,
                pendingSize: Array.isArray(this.pendingData) ? this.pendingData.length : (this.pendingData ? 1 : 0),
                isExecuting: this.isExecuting,
            };
        }
    }

    // 创建操作队列实例（磁链和画廊操作）
    const debouncedSaveMagnets = new DebouncedIDBOperation('saveDownloadedMagnets', 100);
    const debouncedIgnoreMagnets = new DebouncedIDBOperation('saveIgnoredMagnets', 100);
    const debouncedSaveGalleries = new DebouncedIDBOperation('saveDownloadedGalleries', 150);
    const debouncedIgnoreGalleries = new DebouncedIDBOperation('saveIgnoredGalleries', 150);

    // 设置队列操作函数（在基础原语定义后配置）
    // 这些函数会在 initIndexedDB 完成后才调用

    // ==================== IndexedDB 增量操作基础原语 ====================

    /**
     * 通用增量操作函数：add/update 单条或批量记录
     * @param {string} storeName - store名称
     * @param {Array|Object} items - 单条或批量数据
     * @param {boolean} isUpsert - true使用put(更新或插入)，false使用add(仅插入)
     * @returns {Promise<{success: boolean, count: number, error: Error|null}>}
     */
    const addOrUpdateToIDB = async (storeName, items, isUpsert = true) => {
        if (!idbSupported || !idbDatabase) {
            console.warn('[EhMagnet] IndexedDB不可用，跳过操作');
            return { success: false, count: 0, error: new Error('IndexedDB不可用') };
        }
        
        // 标准化输入：统一为数组
        const itemArray = Array.isArray(items) ? items : [items];
        if (!itemArray.length) {
            return { success: true, count: 0, error: null };
        }

        try {
            const tx = idbDatabase.transaction(storeName, 'readwrite');
            const store = tx.objectStore(storeName);
            let successCount = 0;

            // 操作每条记录
            for (const item of itemArray) {
                await new Promise((resolve, reject) => {
                    const req = isUpsert ? store.put(item) : store.add(item);
                    req.onsuccess = () => {
                        successCount++;
                        resolve();
                    };
                    req.onerror = reject;
                });
            }

            // 等待事务完成
            await new Promise((resolve, reject) => {
                tx.oncomplete = resolve;
                tx.onerror = reject;
            });

            console.log(`[EhMagnet] ✅ 增量操作成功: ${storeName} | ${isUpsert ? 'upsert' : 'add'} ${successCount}/${itemArray.length}条`);
            return { success: true, count: successCount, error: null };
        } catch (err) {
            const errMsg = `IndexedDB增量操作失败: ${storeName} | ${err?.message || String(err)}`;
            console.error(`[EhMagnet] ❌ ${errMsg}`);
            toastError(`数据保存失败: ${err?.message || '未知错误'}`);
            return { success: false, count: 0, error: err };
        }
    };

    /**
     * 通用删除函数：按键值或gid索引删除
     * @param {string} storeName - store名称
     * @param {string|number|Array} keys - 单个键值、gid或键值数组
     * @param {string} indexName - 索引名称(可选，用于按gid删除时)
     * @returns {Promise<{success: boolean, count: number, error: Error|null}>}
     */
    const deleteFromIDB = async (storeName, keys, indexName = null) => {
        if (!idbSupported || !idbDatabase) {
            console.warn('[EhMagnet] IndexedDB不可用，跳过删除');
            return { success: false, count: 0, error: new Error('IndexedDB不可用') };
        }

        const keyArray = Array.isArray(keys) ? keys : [keys];
        if (!keyArray.length) {
            return { success: true, count: 0, error: null };
        }

        try {
            const tx = idbDatabase.transaction(storeName, 'readwrite');
            const store = tx.objectStore(storeName);
            let deleteCount = 0;

            for (const key of keyArray) {
                if (indexName) {
                    // 按索引查找后删除
                    const index = store.index(indexName);
                    await new Promise((resolve, reject) => {
                        const req = index.getAll(key);
                        req.onsuccess = () => {
                            const matchedRecords = req.result;
                            let pendingDeletes = 0;
                            
                            matchedRecords.forEach(record => {
                                const delReq = store.delete(store.getKeyPath ? record[store.getKeyPath()] : record);
                                delReq.onsuccess = () => {
                                    deleteCount++;
                                    pendingDeletes--;
                                    if (pendingDeletes === 0) resolve();
                                };
                                delReq.onerror = reject;
                                pendingDeletes++;
                            });
                            
                            if (pendingDeletes === 0) resolve();
                        };
                        req.onerror = reject;
                    });
                } else {
                    // 直接按主键删除
                    await new Promise((resolve, reject) => {
                        const req = store.delete(key);
                        req.onsuccess = () => {
                            deleteCount++;
                            resolve();
                        };
                        req.onerror = reject;
                    });
                }
            }

            // 等待事务完成
            await new Promise((resolve, reject) => {
                tx.oncomplete = resolve;
                tx.onerror = reject;
            });

            console.log(`[EhMagnet] ✅ 删除成功: ${storeName} | 删除${deleteCount}条`);
            return { success: true, count: deleteCount, error: null };
        } catch (err) {
            const errMsg = `IndexedDB删除失败: ${storeName} | ${err?.message || String(err)}`;
            console.error(`[EhMagnet] ❌ ${errMsg}`);
            toastError(`数据删除失败: ${err?.message || '未知错误'}`);
            return { success: false, count: 0, error: err };
        }
    };

    /**
     * 批量事务处理：在一个事务中执行多个add/delete操作
     * 相比多个独立事务，性能提升30-50%，且保证原子性
     * @param {Array} operations - 操作数组，每项: {type: 'add'|'delete', storeName, data, keys}
     * @returns {Promise<{success: boolean, results: Array}>}
     */
    const batchUpdateToIDB = async (operations) => {
        if (!idbSupported || !idbDatabase || !operations.length) {
            return { success: false, results: [], error: new Error('参数无效或IndexedDB不可用') };
        }

        try {
            // 第1步：收集所有涉及的store名称
            const storeNames = [...new Set(operations.map(op => op.storeName))];
            
            // 第2步：创建一个包含所有store的事务
            const tx = idbDatabase.transaction(storeNames, 'readwrite');
            const results = [];

            // 第3步：在单个事务中执行所有操作
            for (const operation of operations) {
                const { type, storeName, data, keys } = operation;
                const store = tx.objectStore(storeName);

                try {
                    if (type === 'add' || type === 'put') {
                        // put操作：存在则更新，不存在则新增
                        const itemArray = Array.isArray(data) ? data : [data];
                        for (const item of itemArray) {
                            await new Promise((resolve, reject) => {
                                const req = store.put(item);
                                req.onsuccess = () => resolve();
                                req.onerror = reject;
                            });
                        }
                        results.push({ type, storeName, success: true, count: itemArray.length });
                    } else if (type === 'delete') {
                        // delete操作：删除指定键值
                        const keyArray = Array.isArray(keys) ? keys : [keys];
                        let deleteCount = 0;
                        for (const key of keyArray) {
                            await new Promise((resolve, reject) => {
                                const req = store.delete(key);
                                req.onsuccess = () => {
                                    deleteCount++;
                                    resolve();
                                };
                                req.onerror = reject;
                            });
                        }
                        results.push({ type, storeName, success: true, count: deleteCount });
                    }
                } catch (err) {
                    console.error(`[EhMagnet] 批量事务中的操作失败: ${type} on ${storeName}`, err);
                    results.push({ type, storeName, success: false, error: err });
                }
            }

            // 第4步：等待整个事务完成
            await new Promise((resolve, reject) => {
                tx.oncomplete = resolve;
                tx.onerror = reject;
            });

            const successCount = results.filter(r => r.success).length;
            console.log(`[EhMagnet] ✅ 批量事务完成: ${successCount}/${results.length}个操作成功`);
            return { success: true, results };
        } catch (err) {
            console.error('[EhMagnet] 批量事务失败:', err);
            toastError(`批量操作失败: ${err?.message || '未知错误'}`);
            return { success: false, results: [], error: err };
        }
    };

    /**
     * 保存已忽略磁链到IndexedDB - 增量更新版本
     * 仅更新有变化的记录，避免全量替换带来的性能问题
     */
    const saveIgnoredMagnetsToIDB = async (newData) => {
        if (!idbSupported || !idbDatabase) {
            console.warn('[EhMagnet] IndexedDB不可用，跳过忽略磁链保存');
            return false;
        }
        
        const startTime = performance.now();
        try {
            // 第1步：读取现有数据
            const existingData = await loadIgnoredMagnetsFromIDB();
            if (!existingData) {
                console.warn('[EhMagnet] 无法读取现有忽略磁链数据，回退到全量替换');
                return await addOrUpdateToIDB(IDB_STORES.ignoredMagnets, newData, true);
            }

            // 第2步：计算差异
            const existingSet = new Set(existingData.map(item => item.href));
            const newSet = new Set(newData.map(item => item.href));
            
            // 需要新增的
            const toAdd = newData.filter(item => !existingSet.has(item.href));
            // 需要删除的（存在于旧数据但不在新数据中）
            const toDelete = existingData
                .filter(item => !newSet.has(item.href))
                .map(item => item.href);

            // 第3步：执行增量操作
            let addResult = { success: true, count: 0 };
            let deleteResult = { success: true, count: 0 };

            if (toAdd.length > 0) {
                addResult = await addOrUpdateToIDB(IDB_STORES.ignoredMagnets, toAdd, true);
                if (!addResult.success) {
                    console.error('[EhMagnet] 新增忽略磁链失败，但继续处理');
                }
            }

            if (toDelete.length > 0) {
                deleteResult = await deleteFromIDB(IDB_STORES.ignoredMagnets, toDelete);
                if (!deleteResult.success) {
                    console.error('[EhMagnet] 删除忽略磁链失败，但继续处理');
                }
            }

            // 第4步：日志和统计
            const elapsed = performance.now() - startTime;
            console.log(`[EhMagnet] 忽略磁链增量更新完成 | 总计${newData.length}条 | +${addResult.count} -${deleteResult.count} | 耗时${elapsed.toFixed(2)}ms`);
            
            return addResult.success || deleteResult.success || (toAdd.length === 0 && toDelete.length === 0);
        } catch (err) {
            console.error('[EhMagnet] 保存已忽略磁链失败:', err);
            toastError(`忽略磁链保存失败: ${err?.message || '未知错误'}`);
            return false;
        }
    };

    // 删除单个忽略的 magnet 从 IndexedDB（同步触发，不等待完成）

    const loadIgnoredMagnetsFromIDB = async () => {
        if (!idbSupported || !idbDatabase) return null;
        try {
            const tx = idbDatabase.transaction(IDB_STORES.ignoredMagnets, 'readonly');
            const store = tx.objectStore(IDB_STORES.ignoredMagnets);
            return new Promise((resolve, reject) => {
                const request = store.getAll();
                request.onsuccess = () => {
                    console.log(`[EhMagnet] 从IndexedDB读取${request.result.length}条已忽略磁链`);
                    resolve(request.result);
                };
                request.onerror = () => reject(request.error);
            });
        } catch (err) {
            console.error('[EhMagnet] 读取已忽略磁链失败:', err);
            return null;
        }
    };

    const injectTooltipStyles = () => {
        if (tooltipStyleInjected) return;
        tooltipStyleInjected = true;
        const style = document.createElement('style');
        style.textContent = `
            .eh-magnet-tooltip {
                backdrop-filter: saturate(180%) blur(18px);
            }
            .eh-magnet-tooltip table {
                border-collapse: collapse;
                border-spacing: 0;
                max-width: 480px;
                font-size: 11px;
            }
            .eh-magnet-tooltip th {
                font-weight: 600;
                padding: 4px 6px;
                text-align: center;
            }
            .eh-magnet-tooltip td {
                padding: 4px 6px;
                white-space: nowrap;
            }
            .eh-magnet-tooltip tbody tr:hover td {
                background: rgba(255,255,255,0.08);
            }
            .eh-magnet-tooltip .eh-magnet-highlight {
                font-weight: 600;
                color: #ffffff;
                background: rgba(92, 13, 18, 0.8);
                padding: 0 4px;
                border-radius: 4px;
            }
            .eh-magnet-tooltip .eh-magnet-name span {
                font-weight: 600;
            }
            .eh-magnet-copy-inline {
                cursor: pointer;
                user-select: none;
                font-size: 15px;
                padding: 0;
                border-radius: 4px;
                border: 1px solid currentColor;
                background: transparent;
                line-height: 1;
                width: 32px;
                height: 24px;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                box-sizing: border-box;
                flex-shrink: 0;
            }
            .eh-magnet-copy-inline:hover {
                background: rgba(255,255,255,0.12);
            }
            .eh-magnet-checkbox {
                width: 16px;
                height: 16px;
                flex: 0 0 16px;
                cursor: pointer;
            }
            .eh-magnet-downloaded-flag {
                display: inline-flex;
                align-items: center;
                font-size: 11px;
                gap: 2px;
                color: rgba(92, 13, 18, 0.9);
                cursor: pointer;
            }
            .eh-magnet-downloaded-flag:hover {
                opacity: 0.85;
            }
            .eh-magnet-ignored-flag {
                display: inline-flex;
                align-items: center;
                font-size: 11px;
                gap: 2px;
                cursor: pointer;
                color: rgba(140, 140, 140, 0.9);
                transition: opacity 0.15s ease, color 0.15s ease;
            }
            .eh-magnet-ignored-flag[data-active="false"] {
                opacity: 0.4;
            }
            .eh-magnet-ignored-flag[data-active="true"] {
                opacity: 1;
                color: rgba(96, 96, 96, 1);
            }
            .eh-magnet-ignore-toggle {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                width: 20px;
                height: 20px;
                margin-right: 4px;
                border-radius: 4px;
                cursor: pointer;
                user-select: none;
                font-size: 12px;
                line-height: 1;
                transition: background 0.2s ease, opacity 0.2s ease;
                opacity: 0.45;
            }
            .eh-magnet-ignore-toggle[data-active="true"] {
                opacity: 1;
                background: rgba(92, 13, 18, 0.15);
            }
            .eh-magnet-ignore-toggle:hover {
                opacity: 1;
                background: rgba(255,255,255,0.12);
            }
            .eh-gallery-ignore-badge {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                width: 18px;
                height: 18px;
                margin-right: 4px;
                cursor: pointer;
                user-select: none;
                font-size: 12px;
                line-height: 1;
                transition: opacity 0.2s ease, background 0.2s ease;
                border-radius: 4px;
                opacity: 0;
                pointer-events: none;
            }
            .gl5t:hover .eh-gallery-ignore-badge,
            .eh-gallery-ignore-badge[data-active="true"] {
                opacity: 1;
                pointer-events: auto;
            }
            .eh-gallery-ignore-badge[data-active="true"] {
                opacity: 1;
                background: rgba(92, 13, 18, 0.18);
            }
            .eh-gallery-ignore-badge:hover {
                opacity: 1;
                background: rgba(255,255,255,0.12);
            }
            .eh-gallery-posted-row {
                display: flex;
                align-items: center;
                gap: 6px;
            }
            .eh-recent-downloads-overlay {
                position: fixed;
                inset: 0;
                background: rgba(0, 0, 0, 0.55);
                display: none;
                align-items: center;
                justify-content: center;
                z-index: 10050;
                padding: 16px;
                box-sizing: border-box;
            }
            .eh-recent-downloads-overlay[data-visible="true"] {
                display: flex;
            }
            .eh-recent-downloads-dialog {
                background: ${window.getComputedStyle(document.body).backgroundColor || '#1f1f1f'};
                color: ${window.getComputedStyle(document.body).color || '#fff'};
                width: min(560px, 92vw);
                max-height: 80vh;
                display: flex;
                flex-direction: column;
                border-radius: 10px;
                border: 1px solid rgba(255, 255, 255, 0.15);
                box-shadow: 0 20px 45px rgba(0, 0, 0, 0.55);
                overflow: hidden;
                margin: auto;
                position: relative;
            }
            .eh-recent-downloads-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 14px 18px;
                font-size: 13px;
                font-weight: 600;
                border-bottom: 1px solid rgba(255,255,255,0.12);
            }
            .eh-recent-downloads-actions {
                display: flex;
                flex-wrap: wrap;
                gap: 8px;
                padding: 12px 18px;
                border-bottom: 1px solid rgba(255,255,255,0.08);
            }
            .eh-recent-downloads-body {
                padding: 14px 18px 18px;
                overflow-y: auto;
                flex: 1;
                display: flex;
                flex-direction: column;
                gap: 10px;
            }
            .eh-recent-downloads-empty {
                text-align: center;
                padding: 36px 0;
                font-size: 12px;
                opacity: 0.72;
            }
            .eh-recent-batch {
                border: 1px solid rgba(255,255,255,0.14);
                border-radius: 8px;
                padding: 10px 12px;
                display: flex;
                flex-direction: column;
                gap: 6px;
            }
            .eh-recent-batch-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                gap: 12px;
                font-size: 12px;
            }
            .eh-recent-batch-meta {
                display: flex;
                flex-direction: row;
                flex-wrap: wrap;
                gap: 8px;
                align-items: center;
                font-size: 12px;
            }
            .eh-recent-batch-header-actions {
                display: flex;
                gap: 6px;
                flex-wrap: wrap;
            }
            .eh-recent-batch-items {
                display: flex;
                flex-direction: column;
                gap: 6px;
            }
            .eh-recent-batch-item {
                display: flex;
                align-items: center;
                gap: 8px;
                font-size: 12px;
            }
            .eh-recent-batch-item-info {
                flex: 1;
                min-width: 0;
            }
            .eh-recent-batch-item-info .eh-recent-batch-name {
                display: block;
                font-weight: 600;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            .eh-recent-batch-item-info .eh-recent-batch-meta {
                display: block;
                font-size: 11px;
                opacity: 0.7;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            .eh-recent-batch-item-info .eh-recent-batch-magnet {
                display: block;
                margin-top: 2px;
                font-size: 10px;
                opacity: 0.85;
                white-space: normal;
                word-break: break-all;
                line-height: 1.35;
            }
            .eh-recent-batch-item-info .eh-recent-batch-magnet[data-type="torrent"] {
                white-space: normal;
                overflow: visible;
                text-overflow: clip;
                word-break: break-all;
            }
            .eh-recent-batch-item-info .eh-recent-batch-magnet[data-type="archive"] {
                white-space: normal;
                overflow: visible;
                text-overflow: clip;
                word-break: break-all;
            }
            .eh-recent-batch-item-actions {
                display: flex;
                gap: 4px;
                flex-shrink: 0;
            }
            .eh-recent-downloads-dialog button {
                padding: 4px 8px;
                cursor: pointer;
                background: rgba(255,255,255,0.08);
                border: 1px solid rgba(255,255,255,0.18);
                border-radius: 4px;
                color: inherit;
                font-size: 12px;
                line-height: 1.2;
            }
            .eh-recent-downloads-dialog button:hover {
                background: rgba(255,255,255,0.16);
            }
            .eh-recent-downloads-dialog button:disabled {
                opacity: 0.5;
                cursor: not-allowed;
            }
            .eh-recent-downloads-close {
                background: transparent;
                border: none;
                color: inherit;
                font-size: 18px;
                line-height: 1;
                cursor: pointer;
            }
            .eh-recent-batch-item-actions a {
                padding: 4px 8px;
                background: rgba(255,255,255,0.04);
                border: 1px solid rgba(255,255,255,0.18);
                border-radius: 4px;
                color: inherit;
                font-size: 12px;
                text-decoration: none;
            }
            .eh-recent-batch-item-actions a:hover {
                background: rgba(255,255,255,0.12);
            }
        `;
        document.head.appendChild(style);
    };

    const parseSizeToBytes = (sizeText = '') => {
        const match = sizeText.trim().match(/([\d.]+)\s*([kmgtp]?)(?:i)?b/i);
        if (!match) return 0;
        const value = parseFloat(match[1]);
        if (Number.isNaN(value)) return 0;
        const unit = (match[2] || '').toLowerCase();
        return value * (sizeUnitMap[unit] || 1);
    };

    const parseInteger = (text = '') => {
        const match = String(text).trim().match(/-?\d+(?:\.\d+)?/);
        if (!match) return Number.NaN;
        const value = Number(match[0]);
        return Number.isNaN(value) ? Number.NaN : value;
    };

    const parseGalleryInfo = (href = '') => {
        const match = href.match(/\/g\/(\d+)\/(\w+)\//);
        if (!match) return null;
        return {
            gid: match[1],
            token: match[2],
            href,
        };
    };

    const parseGalleryInfoFromTorrentUrl = (url = '') => {
        try {
            const parsed = new URL(url, window.location.origin);
            const gid = parsed.searchParams.get('gid');
            const token = parsed.searchParams.get('token') || parsed.searchParams.get('t');
            if (!gid || !token) return null;
            return {
                gid,
                token,
                href: `https://${parsed.host}/g/${gid}/${token}/`,
            };
        } catch (err) {
            console.warn('解析画廊信息失败', err);
            return null;
        }
    };

    const sanitizeFileName = (name, fallback = 'gallery') => {
        const trimmed = (name || '').replace(/[\u0000-\u001f]+/g, '').trim();
        const cleaned = trimmed.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim();
        const result = cleaned || fallback;
        return result.length > 240 ? result.slice(0, 240).trim() : result;
    };

    const buildArchiveFileName = (title, dltype = 'org') => {
        const baseTitle = sanitizeFileName(title, 'gallery');
        const zipped = baseTitle.toLowerCase().endsWith('.zip') ? baseTitle : `${baseTitle}.zip`;
        if (dltype === 'res' && !/resample|重采样|重採樣|重采樣|重新采样/i.test(zipped)) {
            return zipped.replace(/\.zip$/i, ' (Resample).zip');
        }
        return zipped;
    };

    const extractPopupUrl = (text = '') => {
        const match = text.match(/popUp\('\s*([^']+?)\s*'/i);
        if (!match) return '';
        return match[1].replace(/&amp;/g, '&');
    };

    const extractUrlFromOnclick = (text = '') => {
        if (!text) return '';
        const popup = extractPopupUrl(text);
        if (popup) return popup;
        const match = text.match(/['"]\s*(https?:\/\/[^'"\s]+\.torrent[^'"\s]*)\s*['"]/i)
            || text.match(/['"]\s*([^'"\s]+\.torrent[^'"\s]*)\s*['"]/i);
        if (!match) return '';
        return match[1].replace(/&amp;/g, '&');
    };

    const toAbsoluteUrl = (url) => {
        if (!url) return '';
        try {
            return new URL(url, window.location.origin).toString();
        } catch (err) {
            return url;
        }
    };

    const normalizeTorrentCacheKey = (url) => {
        if (!url) return '';
        const absolute = toAbsoluteUrl(url);
        if (!absolute) return '';
        try {
            const parsed = new URL(absolute);
            parsed.hash = '';
            return parsed.toString();
        } catch (err) {
            return absolute;
        }
    };

    const getMagnetCacheKey = (url) => normalizeTorrentCacheKey(url) || (url || '');

    const resolveGalleryInfo = (dataset, fallback) => buildGalleryInfoFromDataset(dataset) || fallback || null;

    const buildGalleryInfoFromDataset = (dataset) => {
        if (!dataset) return null;
        const {
            galleryGid: gid,
            galleryToken: token,
            galleryHref: href,
            galleryTitle: title,
        } = dataset;
        if (!gid) return null;
        return {
            gid,
            token: token || '',
            href: href || '',
            title: title || '',
        };
    };

    const normalizeTimestampValue = (value) => {
        if (value == null) return 0;

        if (typeof value === 'number') {
            if (!Number.isFinite(value) || value <= 0) return 0;
            if (value >= 1e12) return value;
            if (value >= 1e10) return value;
            return value * 1000;
        }

        if (typeof value === 'string') {
            const trimmed = value.trim();
            if (!trimmed) return 0;

            const numeric = Number(trimmed);
            if (Number.isFinite(numeric) && numeric > 0) {
                if (numeric >= 1e12) return numeric;
                if (numeric >= 1e10) return numeric;
                return numeric * 1000;
            }

            const parsed = Date.parse(trimmed);
            if (Number.isFinite(parsed)) return parsed;

            const relativeMatch = trimmed.match(/^(\d+)\s*(分钟|分鐘|分|小时|小時|时|天|日|周|週|星期|月|年)(前|后)$/);
            if (relativeMatch) {
                const amount = Number(relativeMatch[1]);
                if (Number.isFinite(amount)) {
                    const unit = relativeMatch[2];
                    const direction = relativeMatch[3];
                    
                    // 只处理"前"（过去）的相对时间，忽略"后"（未来）的时间
                    if (direction === '后') {
                        return 0; // 返回0表示无效时间戳
                    }
                    
                    const unitMsMap = {
                        分钟: 60 * 1000,
                        分鐘: 60 * 1000,
                        分: 60 * 1000,
                        小时: 60 * 60 * 1000,
                        小時: 60 * 60 * 1000,
                        时: 60 * 60 * 1000,
                        天: 24 * 60 * 60 * 1000,
                        日: 24 * 60 * 60 * 1000,
                        周: 7 * 24 * 60 * 60 * 1000,
                        週: 7 * 24 * 60 * 60 * 1000,
                        星期: 7 * 24 * 60 * 60 * 1000,
                        月: 30 * 24 * 60 * 60 * 1000,
                        年: 365 * 24 * 60 * 60 * 1000,
                    };
                    const unitMs = unitMsMap[unit];
                    if (unitMs) {
                        const diff = amount * unitMs;
                        const base = Date.now();
                        const result = base - diff; // 只计算过去的时间
                        return result;
                    }
                }
            }

            const dayMatch = trimmed.match(/^(今天|昨日|昨天|前天|明天|後天|后天)\s*(\d{1,2})(?:[:：](\d{1,2}))?(?:[:：](\d{1,2}))?/);
            if (dayMatch) {
                const label = dayMatch[1];
                const hour = Number(dayMatch[2]) || 0;
                const minute = Number(dayMatch[3]) || 0;
                const second = Number(dayMatch[4]) || 0;
                const now = new Date();
                const base = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
                const offsets = {
                    今天: 0,
                    昨日: -1,
                    昨天: -1,
                    前天: -2,
                    明天: 1,
                    後天: 2,
                    后天: 2,
                };
                const offsetDays = offsets[label] ?? 0;
                base.setDate(base.getDate() + offsetDays);
                base.setHours(hour, minute, second, 0);
                return base.getTime();
            }
        }

        return 0;
    };

    const formatDownloadTooltip = (rawTimestamp) => {
        // 标准化时间戳
        let timestamp = rawTimestamp;
        if (typeof rawTimestamp === 'string') {
            timestamp = normalizeTimestampValue(rawTimestamp);
        }
        
        if (!timestamp || timestamp <= 0) {
            return '';
        }
        
        // 显示具体日期和时间
        const date = new Date(timestamp);
        if (Number.isNaN(date.getTime())) {
            return '';
        }
        
        const pad = (value) => String(value).padStart(2, '0');
        const month = date.getMonth() + 1;
        const day = date.getDate();
        const hours = date.getHours();
        const minutes = String(date.getMinutes()).padStart(2, '0');
        
        // 格式：MM-DD HH:mm（例如：11-03 23:57）
        return `${pad(month)}-${pad(day)} ${hours}:${minutes}`;
    };

    const cloneMagnetItems = (items = []) => items.map((item) => ({ ...(item || {}) }));

    const getDownloadCacheTimeoutMs = () => {
        const minutes = Number.isFinite(downloadCacheTimeoutMinutes)
            ? downloadCacheTimeoutMinutes
            : DEFAULT_DOWNLOAD_CACHE_TIMEOUT_MINUTES;
        if (minutes <= 0) return 0;
        return minutes * 60 * 1000;
    };

    const schedulePersistDownloadCache = () => {
        if (!downloadCacheDirty) return;
        if (downloadCachePersistTimer) return;
        downloadCachePersistTimer = setTimeout(() => {
            downloadCachePersistTimer = null;
            persistDownloadCache();
        }, 500);
    };

    const persistDownloadCache = () => {
        if (!downloadCacheDirty) return;
        try {
            const payload = Array.from(downloadInfoCache.entries()).map(([key, entry]) => ({
                key,
                cachedAt: entry.cachedAt,
                gallery: entry.gallery || null,
                magnets: entry.magnets || [],
            }));
            localStorage.setItem(DOWNLOAD_CACHE_STORAGE_KEY, JSON.stringify(payload));
            downloadCacheDirty = false;
        } catch (err) {
            console.warn('[EhMagnet] 保存下载信息缓存失败', err);
        }
    };

    const trimDownloadCache = () => {
        if (downloadInfoCache.size <= DOWNLOAD_CACHE_MAX_ENTRIES) return;
        const entries = Array.from(downloadInfoCache.entries())
            .sort((a, b) => (a[1]?.cachedAt || 0) - (b[1]?.cachedAt || 0));
        while (entries.length > DOWNLOAD_CACHE_MAX_ENTRIES) {
            const [key] = entries.shift();
            if (key) {
                downloadInfoCache.delete(key);
            } else {
                break;
            }
        }
        downloadCacheDirty = true;
    };

    const setDownloadCacheEntry = (torrentUrl, magnets = [], galleryInfo = null) => {
        if (!downloadCacheEnabled) return;
        const key = getMagnetCacheKey(torrentUrl);
        if (!key) return;
        const entry = {
            magnets: cloneMagnetItems(magnets),
            gallery: galleryInfo ? { ...galleryInfo } : null,
            cachedAt: Date.now(),
        };
        downloadInfoCache.set(key, entry);
        trimDownloadCache();
        downloadCacheDirty = true;
        schedulePersistDownloadCache();
    };

    const removeDownloadCacheEntry = (torrentUrl) => {
        const key = getMagnetCacheKey(torrentUrl);
        if (!key) return;
        if (downloadInfoCache.delete(key)) {
            downloadCacheDirty = true;
            schedulePersistDownloadCache();
        }
    };

    const getCachedDownloadInfo = (torrentUrl) => {
        if (!downloadCacheEnabled) return null;
        const key = getMagnetCacheKey(torrentUrl);
        if (!key) return null;
        const entry = downloadInfoCache.get(key);
        if (!entry) return null;
        const timeout = getDownloadCacheTimeoutMs();
        if (timeout > 0 && Date.now() - entry.cachedAt > timeout) {
            downloadInfoCache.delete(key);
            downloadCacheDirty = true;
            schedulePersistDownloadCache();
            return null;
        }
        return {
            magnets: cloneMagnetItems(entry.magnets || []),
            gallery: entry.gallery ? { ...entry.gallery } : null,
            cachedAt: entry.cachedAt,
        };
    };

    const loadDownloadInfoCache = (force = false) => {
        if (downloadCacheLoaded && !force) return;
        downloadInfoCache.clear();
        downloadCacheLoaded = true;
        downloadCacheDirty = false;
        if (downloadCachePersistTimer) {
            clearTimeout(downloadCachePersistTimer);
            downloadCachePersistTimer = null;
        }
        try {
            const raw = localStorage.getItem(DOWNLOAD_CACHE_STORAGE_KEY);
            if (!raw) return;
            const entries = JSON.parse(raw);
            if (!Array.isArray(entries)) return;
            const timeout = getDownloadCacheTimeoutMs();
            const now = Date.now();
            entries.forEach((item) => {
                if (!item || typeof item !== 'object') return;
                const key = typeof item.key === 'string' ? item.key : '';
                if (!key) return;
                if (!Array.isArray(item.magnets)) return;
                const cachedAt = Number(item.cachedAt) || 0;
                if (timeout > 0 && cachedAt > 0 && (now - cachedAt) > timeout) {
                    return;
                }
                const gallery = item.gallery && typeof item.gallery === 'object'
                    ? { ...item.gallery }
                    : null;
                downloadInfoCache.set(key, {
                    magnets: cloneMagnetItems(item.magnets),
                    gallery,
                    cachedAt: cachedAt || now,
                });
            });
            trimDownloadCache();
            if (downloadCacheDirty) {
                schedulePersistDownloadCache();
            }
        } catch (err) {
            console.warn('[EhMagnet] 加载下载信息缓存失败', err);
        }
    };


    const downloadStorageKey = 'eh_magnet_downloaded';
    const downloadMagnetStorageKey = 'eh_magnet_downloaded_items';
    const ignoreStorageKey = 'eh_magnet_ignored';
    const ignoreMagnetStorageKey = 'eh_magnet_ignored_items';
    const storageVersionKey = 'eh_magnet_storage_version';
    const STATE_SYNC_STORAGE_KEYS = new Set([
        downloadStorageKey,
        downloadMagnetStorageKey,
        ignoreStorageKey,
        ignoreMagnetStorageKey,
        DOWNLOAD_CACHE_STORAGE_KEY,
        STATE_REVISION_KEY,
    ]);
    const persistExcludePreference = () => {
        try {
            localStorage.setItem(EXCLUDE_PREF_KEY, String(excludeDownloaded));
            localStorage.setItem(EXCLUDE_DOWNLOADED_SELECT_KEY, String(excludeDownloadedOnSelect));
            localStorage.setItem(EXCLUDE_IGNORED_SELECT_KEY, String(excludeIgnoredOnSelect));
            localStorage.setItem(EXCLUDE_NO_SEEDS_SELECT_KEY, String(excludeNoSeedsOnSelect));
            localStorage.setItem(EXCLUDE_OUTDATED_PREF_KEY, String(excludeOutdatedOnSelect));
            localStorage.setItem(AUTO_REFRESH_PREF_KEY, String(autoRefreshEnabled));
            localStorage.setItem(HOVER_REFRESH_PREF_KEY, String(hoverRefreshEnabled));
            localStorage.setItem(REFRESH_CONCURRENT_PREF_KEY, String(refreshConcurrent));
            localStorage.setItem(REFRESH_INTERVAL_MIN_PREF_KEY, String(refreshIntervalMin));
            localStorage.setItem(REFRESH_INTERVAL_MAX_PREF_KEY, String(refreshIntervalMax));
            localStorage.setItem(DOWNLOAD_CACHE_PREF_KEY, String(downloadCacheEnabled));
            localStorage.setItem(DOWNLOAD_CACHE_TIMEOUT_PREF_KEY, String(downloadCacheTimeoutMinutes));
        } catch (err) {
            console.warn('保存排除选项失败', err);
        }
    };

    const persistLogPreference = () => {
        try {
            localStorage.setItem(LOG_PREF_KEY, String(enableDebugLog));
        } catch (err) {
            console.warn('保存日志开关失败', err);
        }
    };

    const persistSearchInfiniteScrollPreference = () => {
        try {
            localStorage.setItem(SEARCH_INFINITE_SCROLL_PREF_KEY, String(enableSearchInfiniteScroll));
        } catch (err) {
            console.warn('保存无限滚动开关失败', err);
        }
    };

    const persistAutoFetchBatchQueryPreference = () => {
        try {
            localStorage.setItem(AUTO_FETCH_BATCH_QUERY_PREF_KEY, String(autoFetchBatchQuery));
        } catch (err) {
            console.warn('保存自动获取批量查询设置失败', err);
        }
    };

    const persistAbdmPortPreference = () => {
        try {
            localStorage.setItem(ABDM_PORT_PREF_KEY, String(abdmPort));
        } catch (err) {
            console.warn('保存 AB Download Manager 端口失败', err);
        }
    };

    const loadAbdmPortPreference = () => {
        try {
            const stored = localStorage.getItem(ABDM_PORT_PREF_KEY);
            if (stored !== null) {
                const parsed = parseInt(stored, 10);
                if (!isNaN(parsed) && parsed > 0 && parsed <= 65535) {
                    abdmPort = parsed;
                }
            }
        } catch (err) {
            console.warn('加载 AB Download Manager 端口失败', err);
        }
    };

    const loadLogPreference = () => {
        try {
            const stored = localStorage.getItem(LOG_PREF_KEY);
            if (stored !== null) {
                enableDebugLog = stored === 'true';
            }
        } catch (err) {
            console.warn('加载日志开关失败', err);
        }
    };

    const loadSearchInfiniteScrollPreference = () => {
        try {
            const stored = localStorage.getItem(SEARCH_INFINITE_SCROLL_PREF_KEY);
            if (stored !== null) {
                enableSearchInfiniteScroll = stored === 'true';
            }
        } catch (err) {
            console.warn('加载无限滚动开关失败', err);
        }
    };

    const loadAutoFetchBatchQueryPreference = () => {
        try {
            const stored = localStorage.getItem(AUTO_FETCH_BATCH_QUERY_PREF_KEY);
            if (stored !== null) {
                autoFetchBatchQuery = stored === 'true';
            }
        } catch (err) {
            console.warn('加载自动获取批量查询设置失败', err);
        }
    };

    const parseStateRevisionValue = (value) => {
        const num = Number(value);
        if (!Number.isFinite(num) || num < 0) return 0;
        return Math.floor(num);
    };

    const readStateRevision = () => {
        try {
            return parseStateRevisionValue(localStorage.getItem(STATE_REVISION_KEY));
        } catch (err) {
            console.warn('读取状态版本失败', err);
            return 0;
        }
    };

    const writeStateRevision = (value) => {
        try {
            localStorage.setItem(STATE_REVISION_KEY, String(value));
        } catch (err) {
            console.warn('写入状态版本失败', err);
        }
    };

    const bumpStateRevision = () => {
        const current = Math.max(lastKnownStateRevision, readStateRevision());
        const next = current >= Number.MAX_SAFE_INTEGER ? 1 : current + 1;
        writeStateRevision(next);
        lastKnownStateRevision = next;
        lastStateSyncTime = Date.now();
    };

    const loadDownloadedState = async () => {
        try {
            // 【修复】不清空内存，改为增量合并，避免多页面并发时的数据丢失
            const storedVersion = Number(localStorage.getItem(storageVersionKey) || '1');

            // 优先从IndexedDB读取
            if (idbSupported && idbDatabase) {
                try {
                    const galleries = await loadDownloadedGalleriesFromIDB();
                    const magnets = await loadDownloadedMagnetsFromIDB();
                    
                    // 【修复】合并而不是替换 - 仅添加内存中没有的数据
                    if (galleries && Object.keys(galleries).length > 0) {
                        Object.entries(galleries).forEach(([gid, timestamp]) => {
                            const gidStr = String(gid);
                            if (!downloadedGalleries.has(gidStr)) {
                                downloadedGalleries.set(gidStr, timestamp);
                                legacyDownloadedGalleries.add(gidStr);
                            }
                        });
                    }
                    
                    if (magnets && magnets.length > 0) {
                        magnets.forEach(item => {
                            // 【修复】仅添加内存中没有的磁链
                            if (!downloadedMagnets.has(item.href)) {
                                downloadedMagnets.set(item.href, {
                                    gid: item.gid ? String(item.gid) : '',
                                    timestamp: item.timestamp,
                                    autoGenerated: item.autoGenerated === true,
                                });
                                if (item.gid) {
                                    ensureDownloadedSet(item.gid).add(item.href);
                                }
                            }
                        });
                    }
                    
                    if ((galleries && Object.keys(galleries).length > 0) || (magnets && magnets.length > 0)) {
                        console.log('[EhMagnet] 从IndexedDB加载已下载状态');
                        // 数据加载完成
                    } else {
                        throw new Error('IndexedDB为空');
                    }
                } catch (err) {
                    console.warn('[EhMagnet] IndexedDB读取失败，降级到localStorage:', err);
                    // 继续执行下面的localStorage逻辑
                }
            }


            const excludePref = localStorage.getItem(EXCLUDE_PREF_KEY);
                if (excludePref !== null) {
                    excludeDownloaded = excludePref === 'true';
                }
                const excludeDownloadedSelectPref = localStorage.getItem(EXCLUDE_DOWNLOADED_SELECT_KEY);
                if (excludeDownloadedSelectPref !== null) {
                excludeDownloadedOnSelect = excludeDownloadedSelectPref === 'true';
            }
            const excludeIgnoredSelectPref = localStorage.getItem(EXCLUDE_IGNORED_SELECT_KEY);
            if (excludeIgnoredSelectPref !== null) {
                excludeIgnoredOnSelect = excludeIgnoredSelectPref === 'true';
            }
            const excludeNoSeedsSelectPref = localStorage.getItem(EXCLUDE_NO_SEEDS_SELECT_KEY);
            if (excludeNoSeedsSelectPref !== null) {
                excludeNoSeedsOnSelect = excludeNoSeedsSelectPref === 'true';
            }
            const excludeOutdatedPref = localStorage.getItem(EXCLUDE_OUTDATED_PREF_KEY);
            if (excludeOutdatedPref !== null) {
                excludeOutdatedOnSelect = excludeOutdatedPref === 'true';
            }
            
            // 加载自动刷新配置
            const autoRefreshPref = localStorage.getItem(AUTO_REFRESH_PREF_KEY);
            if (autoRefreshPref !== null) {
                autoRefreshEnabled = autoRefreshPref === 'true';
            }
            const hoverRefreshPref = localStorage.getItem(HOVER_REFRESH_PREF_KEY);
            if (hoverRefreshPref !== null) {
                hoverRefreshEnabled = hoverRefreshPref === 'true';
            }
            const concurrentPref = localStorage.getItem(REFRESH_CONCURRENT_PREF_KEY);
            if (concurrentPref !== null) {
                refreshConcurrent = Math.max(1, parseInt(concurrentPref) || 1);
            }
            const intervalMinPref = localStorage.getItem(REFRESH_INTERVAL_MIN_PREF_KEY);
            if (intervalMinPref !== null) {
                refreshIntervalMin = Math.max(500, parseInt(intervalMinPref) || 1200);
            }
            const intervalMaxPref = localStorage.getItem(REFRESH_INTERVAL_MAX_PREF_KEY);
            if (intervalMaxPref !== null) {
                refreshIntervalMax = Math.max(refreshIntervalMin, parseInt(intervalMaxPref) || 2000);
            }

            const downloadCachePref = localStorage.getItem(DOWNLOAD_CACHE_PREF_KEY);
            if (downloadCachePref !== null) {
                downloadCacheEnabled = downloadCachePref === 'true';
            }
            const downloadCacheTimeoutPref = localStorage.getItem(DOWNLOAD_CACHE_TIMEOUT_PREF_KEY);
            if (downloadCacheTimeoutPref !== null) {
                const minutes = parseInt(downloadCacheTimeoutPref, 10);
                if (Number.isFinite(minutes) && minutes >= 1) {
                    downloadCacheTimeoutMinutes = minutes;
                }
            }
            
            // 应用配置到队列
            magnetRequestQueue.maxConcurrent = refreshConcurrent;
            magnetRequestQueue.minIntervalRange = [refreshIntervalMin, refreshIntervalMax];

            if (storedVersion < STORAGE_VERSION) {
                try {
                    if (!legacyDownloadedGalleries.size) {
                        localStorage.setItem(storageVersionKey, String(STORAGE_VERSION));
                    } else {
                        const entries = [];
                        legacyDownloadedGalleries.forEach((gid) => {
                            entries.push({
                                href: '',
                                gid,
                                timestamp: downloadedGalleries.get(gid) || Date.now(),
                            });
                            ensureDownloadedSet(gid);
                        });
                        localStorage.setItem(downloadMagnetStorageKey, JSON.stringify(entries));
                        localStorage.setItem(storageVersionKey, String(STORAGE_VERSION));
                    }
                } catch (err) {
                    console.warn('迁移下载标记失败', err);
                }
            }

            loadDownloadInfoCache(true);
        } catch (err) {
            console.warn('加载状态失败', err);
        }
    };

    const loadIgnoredState = async () => {
        try {
            // 【修复】不清空内存，改为增量合并，避免多页面并发时的数据丢失
            
            // 优先从IndexedDB读取
            if (idbSupported && idbDatabase) {
                try {
                    const galleries = await loadIgnoredGalleriesFromIDB();
                    const magnets = await loadIgnoredMagnetsFromIDB();
                    
                    // 【修复】合并而不是替换 - 仅添加内存中没有的数据
                    if (galleries && Object.keys(galleries).length > 0) {
                        Object.entries(galleries).forEach(([gid, timestamp]) => {
                            const gidStr = String(gid);
                            if (!ignoredGalleries.has(gidStr)) {
                                ignoredGalleries.set(gidStr, timestamp);
                            }
                        });
                    }
                    
                    if (magnets && magnets.length > 0) {
                        magnets.forEach(item => {
                            // 【修复】仅添加内存中没有的磁链
                            if (!ignoredMagnets.has(item.href)) {
                                ignoredMagnets.set(item.href, {
                                    gid: item.gid ? String(item.gid) : '',
                                    timestamp: item.timestamp,
                                });
                                if (item.gid) {
                                    const set = ensureIgnoredSet(item.gid);
                                    set.add(item.href);
                                    ignoredGalleries.set(String(item.gid), item.timestamp);
                                }
                            }
                        });
                    }
                    
                    if ((galleries && Object.keys(galleries).length > 0) || (magnets && magnets.length > 0)) {
                        console.log('[EhMagnet] 从IndexedDB加载已忽略状态');
                        return;
                    }
                } catch (err) {
                    console.warn('[EhMagnet] IndexedDB读取失败，降级到localStorage');
                }
            }
            
        } catch (err) {
            console.warn('[EhMagnet] 加载忽略状态失败', err);
        }
    };

    const persistDownloadedState = async () => {
        try {
            const payload = {};
            downloadedGalleries.forEach((timestamp, gid) => {
                payload[gid] = timestamp;
            });

            const magnetPayload = Array.from(downloadedMagnets.entries()).map(([href, info]) => ({
                href,
                gid: info.gid,
                timestamp: info.timestamp,
                autoGenerated: info.autoGenerated === true,
            }));

            // 异步保存到IndexedDB
            if (idbSupported && idbDatabase) {
                try {
                    // 使用去重队列替代直接调用，高频操作时自动合并
                    debouncedSaveGalleries.enqueue(payload);
                    debouncedSaveMagnets.enqueue(magnetPayload);
                    console.log('[EhMagnet] 已下载状态已保存到IndexedDB');
                } catch (err) {
                    console.warn('[EhMagnet] 保存到IndexedDB失败:', err);
                }
            }

            localStorage.setItem(storageVersionKey, String(STORAGE_VERSION));
            bumpStateRevision();
            
            // 触发全局下载状态变化事件
            try {
                const event = new CustomEvent('eh-magnet-download-changed', { 
                    detail: { action: 'refresh' },
                    bubbles: true 
                });
                document.dispatchEvent(event);
            } catch (err) {}
        } catch (err) {
            console.warn('[EhMagnet] 保存下载标记失败', err);
        }
    };

    const persistIgnoredState = async () => {
        try {
            const payload = {};
            ignoredGalleries.forEach((timestamp, gid) => {
                payload[gid] = timestamp;
            });

            const magnetPayload = Array.from(ignoredMagnets.entries()).map(([href, info]) => ({
                href,
                gid: info.gid,
                timestamp: info.timestamp,
            }));

            // 异步保存到IndexedDB
            if (idbSupported && idbDatabase) {
                try {
                    // 使用去重队列替代直接调用，高频操作时自动合并
                    debouncedIgnoreGalleries.enqueue(payload);
                    debouncedIgnoreMagnets.enqueue(magnetPayload);
                    console.log('[EhMagnet] 已忽略状态已保存到IndexedDB');
                } catch (err) {
                    console.warn('[EhMagnet] 保存到IndexedDB失败:', err);
                }
            }

            bumpStateRevision();
        } catch (err) {
            console.warn('[EhMagnet] 保存忽略标记失败', err);
        }
    };

    const cleanupDownloadIgnoreConflicts = (options = {}) => {
        const { persist = true } = options || {};
        let downloadChanged = false;

        ignoredMagnets.forEach((info, href) => {
            if (!href) return;
            if (downloadedMagnets.has(href)) {
                downloadedMagnets.delete(href);
                downloadChanged = true;
            }
            const gid = info?.gid ? String(info.gid) : '';
            if (gid && galleryDownloadedMagnets.has(gid)) {
                const set = galleryDownloadedMagnets.get(gid);
                if (set?.has(href)) {
                    set.delete(href);
                    if (!set.size) {
                        galleryDownloadedMagnets.delete(gid);
                    }
                    downloadChanged = true;
                }
            }
        });

        ignoredGalleries.forEach((ignoredTs, gid) => {
            if (!gid) return;
            if (downloadedGalleries.has(gid)) {
                downloadedGalleries.delete(gid);
                downloadChanged = true;
            }
            if (galleryDownloadedMagnets.has(gid)) {
                const set = galleryDownloadedMagnets.get(gid);
                if (set?.size) {
                    set.forEach((href) => {
                        downloadedMagnets.delete(href);
                    });
                    galleryDownloadedMagnets.delete(gid);
                    downloadChanged = true;
                }
            }
        });

        if (downloadChanged && persist) {
            persistDownloadedState();
        }
        return downloadChanged;
    };


    const isGalleryDownloaded = (galleryInfo) => {
        if (!galleryInfo?.gid) return false;
        if (galleryDownloadedMagnets.has(String(galleryInfo.gid))) {
            return galleryDownloadedMagnets.get(String(galleryInfo.gid)).size > 0;
        }
        if (downloadedGalleries.has(String(galleryInfo.gid))) return true;
        return legacyDownloadedGalleries.has(String(galleryInfo.gid));
    };

    const isMagnetDownloaded = (magnetHref) => {
        if (!magnetHref) return false;
        return downloadedMagnets.has(magnetHref);
    };

    const ensureDownloadedSet = (gid) => {
        if (!gid) return null;
        const key = String(gid);
        if (!galleryDownloadedMagnets.has(key)) {
            galleryDownloadedMagnets.set(key, new Set());
        }
        return galleryDownloadedMagnets.get(key);
    };

    const pruneAutoGeneratedDownloadsForGallery = (gid) => {
        if (!gid) return false;
        const key = String(gid);
        const set = galleryDownloadedMagnets.get(key);
        if (!set || !set.size) return false;
        const entries = Array.from(set);
        const hasManualEntry = entries.some((href) => {
            const meta = downloadedMagnets.get(href);
            return meta && meta.autoGenerated === false;
        });
        if (hasManualEntry) return false;
        let changed = set.size > 0;
        entries.forEach((href) => {
            if (downloadedMagnets.delete(href)) changed = true;
            set.delete(href);
        });
        galleryDownloadedMagnets.delete(key);
        return changed;
    };

    const ensureIgnoredSet = (gid) => {
        if (!gid) return null;
        const key = String(gid);
        if (!galleryIgnoredMagnets.has(key)) {
            galleryIgnoredMagnets.set(key, new Set());
        }
        return galleryIgnoredMagnets.get(key);
    };

    const isArchiveFallbackElement = (element) => {
        if (!element) return false;
        if (element.dataset && element.dataset.archiveFallback === 'true') return true;
        if (typeof element.closest === 'function') {
            const row = element.closest('.eh-magnet-item');
            if (row && row.dataset.archiveFallback === 'true') return true;
        }
        return false;
    };

    const isInTempHiddenContainer = (element) => {
        if (!element || typeof element.closest !== 'function') return false;
        return Boolean(element.closest(`.${TEMP_HIDDEN_CLASS}, [data-eh-block-hidden="1"]`));
    };

    const shouldSkipSelectionForBox = (box, info = null, magnetHref = '') => {
        if (!box) return false;
        if (isInTempHiddenContainer(box)) return true;
        
        // Pending 状态仅用于表示尚未加载种子信息，不影响已下载/已忽略判定
        const isPendingInfo = box.dataset.pendingInfo === 'true';
        
        const row = typeof box.closest === 'function' ? box.closest('.eh-magnet-item') : null;
        const container = row?.closest('.eh-magnet-links') || null;
        const resolvedInfo = info || buildGalleryInfoFromDataset(box.dataset) || buildGalleryInfoFromDataset(row?.dataset);
        const href = magnetHref
            || box.dataset.magnetValue
            || row?.dataset.magnetValue
            || '';
        const gid = resolvedInfo?.gid || box.dataset.galleryGid;
        
        // 使用新的4个独立排除选项
        const isDownloaded = href && isMagnetDownloaded(href) || (gid && isGalleryDownloaded({ gid }));
        const isIgnored = href && isMagnetIgnored(href, resolvedInfo) || (gid && isGalleryIgnored({ gid }));
        
        const isArchiveFallback = isArchiveFallbackElement(box);
        const outdatedDataset = (value) => value === 'true';
        const isMagnetOutdated = outdatedDataset(box.dataset.magnetOutdated)
            || outdatedDataset(row?.dataset?.magnetOutdated)
            || outdatedDataset(container?.dataset?.magnetOutdated)
            || Boolean(resolvedInfo?.isOutdated)
            || Boolean(info?.isOutdated);
        
        // 种子过时：归档回退 且 magnetOutdated='true'
        const isOutdated = isArchiveFallback && isMagnetOutdated;
        // 无种子：归档回退 且 magnetOutdated 不是 'true'
        const hasNoSeeds = isArchiveFallback && !isMagnetOutdated;
        
        // 【两层优先级过滤逻辑】
        // 原理：已下载/已忽略是主维度（优先级高），无种子/种子过时是细节维度
        // 规则：
        // 1. 如果画廊是"已下载"，用"已下载"的勾选状态判断
        // 2. 如果画廊是"已忽略"，用"已忽略"的勾选状态判断
        // 3. 否则（未下载），检查细节维度（只有同时满足属性且被排除时才排除）
        
        if (isDownloaded) {
            // 如果是已下载，返回排除状态（excludeDownloadedOnSelect=false表示被勾选，返回false选中）
            return excludeDownloadedOnSelect;
        }
        
        if (isIgnored) {
            // 如果是已忽略，返回排除状态
            return excludeIgnoredOnSelect;
        }
        
        // 到这里：既不是已下载也不是已忽略（未下载状态）
        // 检查细节维度：只排除那些匹配属性且被排除的
        if (!isPendingInfo && hasNoSeeds && excludeNoSeedsOnSelect) {
            return true;
        }
        
        if (!isPendingInfo && isOutdated && excludeOutdatedOnSelect) {
            return true;
        }
        
        // 其他情况（有种子、待获取信息等）都选中
        return false;
    };

    const isGalleryIgnored = (galleryInfoOrId) => {
        if (!galleryInfoOrId) return false;
        const gid = typeof galleryInfoOrId === 'string'
            ? galleryInfoOrId
            : (galleryInfoOrId?.gid ? String(galleryInfoOrId.gid) : '');
        if (!gid) return false;
        const set = galleryIgnoredMagnets.get(gid);
        if (set && set.size) return true;
        return ignoredGalleries.has(gid);
    };

    const isMagnetIgnored = (magnetHref, galleryInfo) => {
        if (magnetHref && ignoredMagnets.has(magnetHref)) return true;
        const gid = galleryInfo?.gid ? String(galleryInfo.gid) : '';
        if (!gid) return false;
        const set = galleryIgnoredMagnets.get(gid);
        if (set) return !!magnetHref && set.has(magnetHref);
        return ignoredGalleries.has(gid);
    };

    const markMagnetDownloaded = (magnetHref, galleryInfo, options = {}) => {
        if (!magnetHref) return;
        const { silent = false, skipPersist = false, autoGenerated = false } = options || {};
        const gid = galleryInfo?.gid ? String(galleryInfo.gid) : '';
        withDebugLog(() => console.log('[EhMagnet] markMagnetDownloaded:init', {
            magnetHref,
            gid,
            galleryInfo,
        }));
        downloadedMagnets.set(magnetHref, {
            gid,
            timestamp: Date.now(),
            autoGenerated: autoGenerated === true,
        });
        let ignoredCleared = false;
        if (gid) {
            ensureDownloadedSet(gid).add(magnetHref);
            downloadedGalleries.set(gid, Date.now());
        }
        if (magnetHref && ignoredMagnets.has(magnetHref)) {
            unmarkMagnetIgnored(magnetHref, galleryInfo, { silent: true, skipPersist: true });
            ignoredCleared = true;
        }
        if (gid && ignoredGalleries.has(gid)) {
            const normalizedInfo = {
                gid,
                token: galleryInfo?.token || '',
                href: galleryInfo?.href || '',
            };
            const ignoredSet = galleryIgnoredMagnets.get(gid);
            if (ignoredSet) {
                ignoredSet.forEach((href) => {
                    unmarkMagnetIgnored(href, normalizedInfo, { silent: true, skipPersist: true });
                });
            }
            ignoredGalleries.delete(gid);
            galleryIgnoredMagnets.delete(gid);
            ignoredCleared = true;
        }
        if (!skipPersist) {
            persistDownloadedState();
            if (ignoredCleared) persistIgnoredState();
        }
        if (!silent) updateStatusFlags();
        if (gid) refreshGalleryPostedBadges(gid);
        withDebugLog(() => console.log('[EhMagnet] markMagnetDownloaded:done', {
            magnetHref,
            gid,
            downloaded: isMagnetDownloaded(magnetHref),
            galleryDownloaded: gid ? isGalleryDownloaded({ gid }) : null,
        }));
    };

    const markGalleryDownloaded = (galleryInfo, options = {}) => {
        if (!galleryInfo?.gid) return;
        const { silent = false, skipPersist = false } = options || {};
        const gid = String(galleryInfo.gid);
        ensureDownloadedSet(gid);
        downloadedGalleries.set(gid, Date.now());
        legacyDownloadedGalleries.add(gid);
        let ignoredCleared = false;
        const ignoredSet = galleryIgnoredMagnets.get(gid);
        if (ignoredSet && ignoredSet.size) {
            ignoredSet.forEach((href) => {
                if (ignoredMagnets.has(href)) {
                    ignoredMagnets.delete(href);
                }
            });
            galleryIgnoredMagnets.delete(gid);
            ignoredCleared = true;
        }
        if (ignoredGalleries.has(gid)) {
            ignoredGalleries.delete(gid);
            ignoredCleared = true;
        }
        if (!skipPersist) {
            persistDownloadedState();
            if (ignoredCleared) persistIgnoredState();
        }
        if (!silent) updateStatusFlags();
        refreshGalleryPostedBadges(gid);
    };

    const unmarkMagnetDownloaded = (magnetHref, galleryInfo, options = {}) => {
        if (!magnetHref) return;
        const { silent = false, skipPersist = false } = options || {};
        const gid = galleryInfo?.gid ? String(galleryInfo.gid) : '';
        withDebugLog(() => console.log('[EhMagnet] unmarkMagnetDownloaded:init', {
            magnetHref,
            gid,
            galleryInfo,
        }));
        let stateChanged = false;
        if (downloadedMagnets.delete(magnetHref)) {
            stateChanged = true;
            // IndexedDB 删除通过 persistDownloadedState() 的全量替换自动处理
        }

        if (gid) {
            let hasManualMarks = false;
            let latestManualTs = 0;
            const set = galleryDownloadedMagnets.get(gid);
            if (set) {
                if (set.delete(magnetHref)) stateChanged = true;
                const remaining = Array.from(set);
                remaining.forEach((href) => {
                    const meta = downloadedMagnets.get(href);
                    if (!meta) return;
                    if (meta.autoGenerated === false) {
                        hasManualMarks = true;
                        const ts = normalizeTimestampValue(meta.timestamp);
                        if (ts && ts > latestManualTs) latestManualTs = ts;
                    }
                });
                if (!hasManualMarks && remaining.length) {
                    if (pruneAutoGeneratedDownloadsForGallery(gid)) stateChanged = true;
                }
                if (!set.size) {
                    galleryDownloadedMagnets.delete(gid);
                }
            } else if (downloadedGalleries.has(gid)) {
                if (pruneAutoGeneratedDownloadsForGallery(gid)) stateChanged = true;
            }

            if (!hasManualMarks && !galleryDownloadedMagnets.has(gid)) {
                if (downloadedGalleries.delete(gid)) stateChanged = true;
            } else if (hasManualMarks) {
                const prevTs = normalizeTimestampValue(downloadedGalleries.get(gid));
                const nextTs = latestManualTs || Date.now();
                if (!prevTs || prevTs !== nextTs) {
                    downloadedGalleries.set(gid, nextTs);
                    stateChanged = true;
                }
            }
        }
        if (gid) legacyDownloadedGalleries.delete(gid);
        if (!skipPersist && stateChanged) persistDownloadedState();
        if (!silent) updateStatusFlags();
        if (gid) refreshGalleryPostedBadges(gid);
        withDebugLog(() => console.log('[EhMagnet] unmarkMagnetDownloaded:done', {
            magnetHref,
            gid,
            downloaded: isMagnetDownloaded(magnetHref),
            galleryDownloaded: gid ? isGalleryDownloaded({ gid }) : null,
        }));
    };

    const markMagnetIgnored = (magnetHref, galleryInfo, options = {}) => {
        if (!magnetHref) return false;
        const { silent = false, skipPersist = false } = options || {};
        const gid = galleryInfo?.gid ? String(galleryInfo.gid) : '';
        let removedDownloaded = false;

        withDebugLog(() => console.log('[EhMagnet] markMagnetIgnored:init', {
            magnetHref,
            gid,
            galleryInfo,
        }));

        ignoredMagnets.set(magnetHref, {
            gid,
            timestamp: Date.now(),
        });

        if (gid) {
            const set = ensureIgnoredSet(gid);
            set.add(magnetHref);
            ignoredGalleries.set(gid, Date.now());
            if (downloadedGalleries.has(gid)) {
                downloadedGalleries.delete(gid);
                legacyDownloadedGalleries.delete(gid);
                removedDownloaded = true;
            }
            if (galleryDownloadedMagnets.has(gid)) {
                galleryDownloadedMagnets.delete(gid);
                removedDownloaded = true;
            }
        }

        if (magnetHref && downloadedMagnets.has(magnetHref)) {
            unmarkMagnetDownloaded(magnetHref, galleryInfo, { silent: true, skipPersist: true });
            removedDownloaded = true;
        }

        if (!skipPersist) {
            persistIgnoredState();
            if (removedDownloaded) persistDownloadedState();
        }

        if (!silent) updateStatusFlags();
        if (gid) refreshGalleryPostedBadges(gid);
        withDebugLog(() => console.log('[EhMagnet] markMagnetIgnored:done', {
            magnetHref,
            gid,
            removedDownloaded,
            ignoredGallery: gid ? isGalleryIgnored({ gid }) : null,
            ignoredMagnet: isMagnetIgnored(magnetHref, galleryInfo),
        }));
        return removedDownloaded;
    };

    const unmarkMagnetIgnored = (magnetHref, galleryInfo, options = {}) => {
        if (!magnetHref) return;
        const { silent = false, skipPersist = false } = options || {};
        if (ignoredMagnets.delete(magnetHref)) {
            // IndexedDB 删除通过 persistIgnoredState() 的全量替换自动处理
        }
        const gid = galleryInfo?.gid ? String(galleryInfo.gid) : '';
        withDebugLog(() => console.log('[EhMagnet] unmarkMagnetIgnored:init', {
            magnetHref,
            gid,
            galleryInfo,
        }));
        if (gid && galleryIgnoredMagnets.has(gid)) {
            const set = galleryIgnoredMagnets.get(gid);
            set.delete(magnetHref);
            if (!set.size) {
                galleryIgnoredMagnets.delete(gid);
                ignoredGalleries.delete(gid);
            }
        }
        if (!skipPersist) persistIgnoredState();
        if (!silent) updateStatusFlags();
        if (gid) refreshGalleryPostedBadges(gid);
        withDebugLog(() => console.log('[EhMagnet] unmarkMagnetIgnored:done', {
            magnetHref,
            gid,
            ignoredGallery: gid ? isGalleryIgnored({ gid }) : null,
            ignoredMagnet: isMagnetIgnored(magnetHref, galleryInfo),
        }));
    };

    const markGalleryIgnored = (galleryInfo) => {
        if (!galleryInfo?.gid) return;
        const gid = String(galleryInfo.gid);
        ignoredGalleries.set(gid, Date.now());
        let downloadChanged = false;
        const rows = document.querySelectorAll(`.eh-magnet-item[data-gallery-gid="${escapeForSelector(gid)}"]`);
        console.log('[EhMagnet] markGalleryIgnored 找到', rows.length, '个磁链行，gid:', gid);
        rows.forEach((row) => {
            const magnetHref = row.dataset.magnetValue || row.querySelector('.eh-magnet-checkbox')?.dataset.magnetValue;
            if (!magnetHref) return;
            const info = buildGalleryInfoFromDataset(row.dataset) || galleryInfo;
            const removed = markMagnetIgnored(magnetHref, info, { silent: true, skipPersist: true });
            if (removed) downloadChanged = true;
        });
        console.log('[EhMagnet] markGalleryIgnored 完成，galleryIgnoredMagnets.get(gid):', galleryIgnoredMagnets.get(gid)?.size || 0);
        persistIgnoredState();
        if (downloadChanged) persistDownloadedState();
        updateStatusFlags();
        clearGallerySelections(gid);
        refreshGalleryIgnoreButtons();
        refreshGalleryPostedBadges(gid);
        
        // 触发事件通知EH Highlight Duplicate
        try {
            const event = new CustomEvent('eh-magnet-ignore-changed', { 
                detail: { gid, action: 'mark', source: 'eh-magnet' },
                bubbles: true 
            });
            document.dispatchEvent(event);
        } catch (err) {}
    };

    const unmarkGalleryIgnored = (galleryInfo, options = {}) => {
        if (!galleryInfo?.gid) return;
        const { silent = false } = options || {};
        const gid = String(galleryInfo.gid);
        
        console.log('[EhMagnet] unmarkGalleryIgnored 开始', { gid });
        
        // 删除画廊级别的忽略标记
        ignoredGalleries.delete(gid);
        
        // 清理该画廊下所有磁链的忽略记录
        const magnetSet = galleryIgnoredMagnets.get(gid);
        if (magnetSet && magnetSet.size > 0) {
            console.log('[EhMagnet] 清理 galleryIgnoredMagnets，共', magnetSet.size, '个磁链');
            magnetSet.forEach(href => {
                ignoredMagnets.delete(href);
                // IndexedDB 删除通过 persistIgnoredState() 的全量替换自动处理
            });
            galleryIgnoredMagnets.delete(gid);
        }
        
        // 同时清理页面上的磁链标记
        const rows = document.querySelectorAll(`.eh-magnet-item[data-gallery-gid="${escapeForSelector(gid)}"]`);
        console.log('[EhMagnet] 找到', rows.length, '个磁链行');
        rows.forEach((row) => {
            const magnetHref = row.dataset.magnetValue || row.querySelector('.eh-magnet-checkbox')?.dataset.magnetValue;
            if (!magnetHref) return;
            const info = buildGalleryInfoFromDataset(row.dataset) || galleryInfo;
            unmarkMagnetIgnored(magnetHref, info, { silent: true, skipPersist: true });
        });
        
        persistIgnoredState();
        
        console.log('[EhMagnet] unmarkGalleryIgnored 完成', {
            gid,
            ignoredGalleries_has: ignoredGalleries.has(gid),
            galleryIgnoredMagnets_has: galleryIgnoredMagnets.has(gid)
        });
        if (!silent) {
            updateStatusFlags();
            refreshGalleryIgnoreButtons();
        }
        refreshGalleryPostedBadges(gid);
        
        // 触发事件通知EH Highlight Duplicate
        try {
            const event = new CustomEvent('eh-magnet-ignore-changed', { 
                detail: { gid, action: 'unmark', source: 'eh-magnet' },
                bubbles: true 
            });
            document.dispatchEvent(event);
        } catch (err) {}
    };

    const createDownloadedFlagElement = (magnetHref, galleryInfo) => {
        const flag = document.createElement('span');
        flag.className = 'eh-magnet-downloaded-flag';
        flag.textContent = '✅';
        
        // 获取下载时间
        let downloadTime = null;
        if (magnetHref && downloadedMagnets.has(magnetHref)) {
            downloadTime = normalizeTimestampValue(downloadedMagnets.get(magnetHref)?.timestamp);
        }
        if (!downloadTime && galleryInfo?.gid && downloadedGalleries.has(String(galleryInfo.gid))) {
            downloadTime = normalizeTimestampValue(downloadedGalleries.get(String(galleryInfo.gid)));
        }
        
        // 格式化时间显示（使用相对时间格式："今天 23:57"、"昨天"等）
        const formatted = downloadTime ? formatDownloadTooltip(downloadTime) : '';
        flag.title = formatted ? `已下载 (${formatted})\n点击取消标记` : '点击以取消已下载标记';
        flag.style.cursor = 'pointer';
        if (galleryInfo?.gid) {
            flag.dataset.galleryGid = galleryInfo.gid;
            flag.dataset.galleryToken = galleryInfo.token || '';
            flag.dataset.galleryHref = galleryInfo.href || '';
        }
        if (magnetHref) flag.dataset.magnetValue = magnetHref;
        let downloaded = false;
        if (magnetHref) downloaded = isMagnetDownloaded(magnetHref);
        if (!downloaded && galleryInfo?.gid) {
            downloaded = isGalleryDownloaded(galleryInfo);
            if (downloaded && magnetHref) {
                ensureMagnetDownloadRecord(magnetHref, galleryInfo, {
                    timestamp: downloadTime,
                    autoGenerated: true,
                    persist: false,
                });
            }
        }
        flag.style.display = downloaded ? 'inline-flex' : 'none';
        flag.addEventListener('click', (event) => {
            event.stopPropagation();
            const info = resolveGalleryInfo(flag.dataset, galleryInfo);
            unmarkMagnetDownloaded(flag.dataset.magnetValue, info);
            const row = flag.closest('.eh-magnet-item');
            const checkbox = row?.querySelector('.eh-magnet-checkbox') || null;
            const entryInfo = info
                || buildGalleryInfoFromDataset(row?.dataset)
                || buildGalleryInfoFromDataset(checkbox?.dataset)
                || null;
            syncEntryFlagDisplay({
                row,
                checkbox,
                info: entryInfo,
                element: flag,
                magnetHref: flag.dataset.magnetValue || row?.dataset.magnetValue || checkbox?.dataset.magnetValue || '',
                archiveKey: row?.dataset.archiveKey || checkbox?.dataset.archiveKey || '',
                isArchiveFallback: row?.dataset.archiveFallback === 'true'
                    || checkbox?.dataset.archiveFallback === 'true',
            });
            const gid = entryInfo?.gid || flag.dataset.galleryGid;
            if (gid) {
                refreshGalleryPostedBadges(gid);
            }
        });
        return flag;
    };

    const createIgnoredFlagElement = (magnetHref, galleryInfo) => {
        const flag = document.createElement('span');
        flag.className = 'eh-magnet-ignored-flag';
        flag.textContent = '🚫';
        flag.title = '点击以取消忽略';
        flag.style.cursor = 'pointer';
        if (galleryInfo?.gid) {
            flag.dataset.galleryGid = galleryInfo.gid;
            flag.dataset.galleryToken = galleryInfo.token || '';
            flag.dataset.galleryHref = galleryInfo.href || '';
        }
        if (magnetHref) flag.dataset.magnetValue = magnetHref;
        
        const isIgnored = isMagnetIgnored(magnetHref, galleryInfo);
        flag.style.display = isIgnored ? 'inline-flex' : 'none';
        flag.dataset.active = isIgnored ? 'true' : 'false';
        flag.addEventListener('click', (event) => {
            event.stopPropagation();
            const info = resolveGalleryInfo(flag.dataset, galleryInfo);
            
            // 检查是画廊级忽略还是单个磁力链接忽略
            const magnetHref = flag.dataset.magnetValue;
            const isGalleryIgnored = info?.gid && ignoredGalleries.has(String(info.gid));
            const isMagnetIgnored = magnetHref && ignoredMagnets.has(magnetHref);
            
            if (isGalleryIgnored && !isMagnetIgnored) {
                // 画廊级忽略（可能来自Highlight），取消整个画廊的忽略
                unmarkGalleryIgnored(info);
            } else {
                // 单个磁力链接忽略
                unmarkMagnetIgnored(magnetHref, info);
            }
        });
        return flag;
    };

    const createArchiveFallbackRow = (container, options = {}) => {
        if (!container) return null;
        const { galleryInfo = null, dltype = 'org', message = '⚠️ 仅找到过时种子，将改用存档下载', title = '', isOutdatedFallback = false, isPendingInfo = false } = options;
        let resolvedGalleryInfo = galleryInfo?.gid
            ? galleryInfo
            : (container && buildGalleryInfoFromDataset(container.dataset)) || null;
        // 使用画廊的 gid 作为 groupId，确保同一画廊的回退项有相同的分组
        const groupId = resolvedGalleryInfo?.gid 
            ? `eh-archive-group-${resolvedGalleryInfo.gid}`
            : `eh-archive-group-${++magnetGroupSeq}`;
        const archiveKey = resolvedGalleryInfo?.gid ? `archive://${resolvedGalleryInfo.gid}/${dltype}` : '';
        let archiveTitle = title || resolvedGalleryInfo?.title || '';
        if (!archiveTitle && resolvedGalleryInfo?.gid) {
            const galleryAnchor = document.querySelector(`a[href*="/g/${resolvedGalleryInfo.gid}/"]`);
            if (galleryAnchor?.textContent) {
                archiveTitle = galleryAnchor.textContent.trim();
            }
        }
        if (!archiveTitle && typeof document !== 'undefined') {
            const detailTitle = document.querySelector('#gd2 #gn')?.textContent?.trim();
            if (detailTitle) archiveTitle = detailTitle;
        }
        if (resolvedGalleryInfo && archiveTitle && !resolvedGalleryInfo.title) {
            resolvedGalleryInfo = { ...resolvedGalleryInfo, title: archiveTitle };
        }
        const archiveFileName = buildArchiveFileName(archiveTitle || resolvedGalleryInfo?.title || '', dltype);
        const datasetName = archiveFileName || '存档下载';
        if (container instanceof HTMLElement) {
            if (archiveTitle) container.dataset.archiveTitle = archiveTitle;
            container.dataset.archiveFilename = archiveFileName;
            if (archiveTitle) container.dataset.galleryTitle = archiveTitle;
        }
        const row = document.createElement('div');
        row.className = 'eh-magnet-item eh-magnet-archive-fallback';
        row.style.display = 'flex';
        row.style.alignItems = 'center';
        row.style.gap = '6px';
        row.style.padding = '4px 0';
        row.dataset.archiveFallback = 'true';
        row.dataset.magnetGroup = groupId;
        row.dataset.magnetTimestamp = String(Date.now());
        row.dataset.archiveDltype = dltype;
        row.dataset.magnetName = datasetName;
        if (isPendingInfo) {
            row.dataset.pendingInfo = 'true';
        }
        if (archiveKey) {
            row.dataset.magnetValue = archiveKey;
            row.dataset.archiveKey = archiveKey;
        }
        if (resolvedGalleryInfo?.gid) {
            row.dataset.galleryGid = resolvedGalleryInfo.gid;
            row.dataset.galleryToken = resolvedGalleryInfo.token || '';
            row.dataset.galleryHref = resolvedGalleryInfo.href || '';
        }
        if (archiveTitle) row.dataset.galleryTitle = archiveTitle;
        if (archiveTitle) row.dataset.archiveTitle = archiveTitle;
        row.dataset.archiveFilename = archiveFileName;

        // 只在搜索页显示复选框
        const showCheckbox = isSearchPage();
        
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'eh-magnet-checkbox';
        checkbox.dataset.archiveFallback = 'true';
        checkbox.dataset.magnetGroup = groupId;
        checkbox.dataset.magnetTimestamp = row.dataset.magnetTimestamp;
        checkbox.dataset.magnetName = datasetName;
        checkbox.dataset.archiveDltype = dltype;
        if (!showCheckbox) checkbox.style.display = 'none'; // 画廊页隐藏复选框
        if (isOutdatedFallback) {
            checkbox.dataset.magnetOutdated = 'true';
        }
        // Pending状态需要在checkbox和row上都标记，确保各种选择逻辑都能识别
        if (isPendingInfo) {
            checkbox.dataset.pendingInfo = 'true';
        }
        if (archiveKey) {
            checkbox.dataset.magnetValue = archiveKey;
            checkbox.dataset.archiveKey = archiveKey;
        }
        if (resolvedGalleryInfo?.gid) {
            checkbox.dataset.galleryGid = resolvedGalleryInfo.gid;
            checkbox.dataset.galleryToken = resolvedGalleryInfo.token || '';
            checkbox.dataset.galleryHref = resolvedGalleryInfo.href || '';
        }
        if (archiveTitle) checkbox.dataset.galleryTitle = archiveTitle;
        if (archiveTitle) checkbox.dataset.archiveTitle = archiveTitle;
        checkbox.dataset.archiveFilename = archiveFileName;
        checkbox.addEventListener('change', () => {
            const info = buildGalleryInfoFromDataset(checkbox.dataset) || resolvedGalleryInfo;
            const key = checkbox.dataset.magnetValue || checkbox.dataset.archiveKey || '';
            if (checkbox.checked) {
                if (key) selectedMagnets.add(key);
                if (info?.gid) selectedGalleries.set(info.gid, info);
            } else {
                if (key) selectedMagnets.delete(key);
                if (info?.gid) selectedGalleries.delete(info.gid);
            }
            updateSelectToggleState();
            const index = Array.from(document.querySelectorAll('.eh-magnet-checkbox')).indexOf(checkbox);
            if (index >= 0) lastCheckboxIndex = index;
        });

        // 添加shift多选支持（与磁链复选框相同的逻辑）
        // 【修复】按DOM顺序（即calculateMagnetScoreGlobal的排序）选择第一个有效项，而不是按时间戳重新排序
        checkbox.addEventListener('click', (event) => {
            if (!event.shiftKey || !checkbox.checked) {
                return;
            }

            const allCheckboxes = Array.from(document.querySelectorAll('.eh-magnet-checkbox'));
            const currentIndex = allCheckboxes.indexOf(checkbox);
            const anchorIndex = (lastCheckboxIndex !== null && lastCheckboxIndex >= 0)
                ? lastCheckboxIndex
                : allCheckboxes.findIndex((box) => box.checked && box !== checkbox);

            if (anchorIndex === -1 || anchorIndex === currentIndex) {
                updateSelectToggleState();
                return;
            }

            const start = Math.min(anchorIndex, currentIndex);
            const end = Math.max(anchorIndex, currentIndex);

            const processedGroups = new Set();

            for (let i = start; i <= end; i += 1) {
                const targetBox = allCheckboxes[i];
                const group = targetBox.dataset.magnetGroup || '__ungrouped';
                if (processedGroups.has(group)) continue;
                processedGroups.add(group);

                const sameGroupBoxes = allCheckboxes.filter((candidate) => candidate.dataset.magnetGroup === group);
                if (!sameGroupBoxes.length) continue;

                sameGroupBoxes.forEach((candidate) => {
                    if (candidate.checked) {
                        candidate.checked = false;
                        if (candidate.dataset.magnetValue) {
                            selectedMagnets.delete(candidate.dataset.magnetValue);
                        }
                        const infoCandidate = buildGalleryInfoFromDataset(candidate.dataset);
                        if (infoCandidate?.gid) selectedGalleries.delete(infoCandidate.gid);
                    }
                });

                // 按DOM顺序选择第一个有效项（而不是按时间戳排序后选择最新的）
                // 这样与磁链列表的显示顺序和评分排序保持一致
                const targetBox_toSelect = sameGroupBoxes.find((box) => {
                    const infoData = buildGalleryInfoFromDataset(box.dataset);
                    const candidateKey = box.dataset.magnetValue || box.dataset.archiveKey || '';
                    return !shouldSkipSelectionForBox(box, infoData, candidateKey);
                });

                if (targetBox_toSelect) {
                    targetBox_toSelect.checked = true;
                    if (targetBox_toSelect.dataset.magnetValue) selectedMagnets.add(targetBox_toSelect.dataset.magnetValue);
                    const infoLatest = buildGalleryInfoFromDataset(targetBox_toSelect.dataset);
                    if (infoLatest?.gid) selectedGalleries.set(infoLatest.gid, infoLatest);
                }
            }

            lastCheckboxIndex = currentIndex;
            updateSelectToggleState();
        });

        const sendButton = document.createElement('button');
        sendButton.type = 'button';
        sendButton.textContent = '📥';
        sendButton.dataset.archiveFallback = 'true';
        sendButton.dataset.magnetName = datasetName;
        sendButton.dataset.archiveDltype = dltype;
        if (archiveKey) {
            sendButton.dataset.magnetValue = archiveKey;
            sendButton.dataset.archiveKey = archiveKey;
        }
        if (resolvedGalleryInfo?.gid) {
            sendButton.dataset.galleryGid = resolvedGalleryInfo.gid;
            sendButton.dataset.galleryToken = resolvedGalleryInfo.token || '';
            sendButton.dataset.galleryHref = resolvedGalleryInfo.href || '';
        }
        if (archiveTitle) sendButton.dataset.galleryTitle = archiveTitle;
        if (archiveTitle) sendButton.dataset.archiveTitle = archiveTitle;
        sendButton.dataset.archiveFilename = archiveFileName;
        attachSendButtonBehavior(sendButton);

        const label = document.createElement('span');
        label.textContent = message;
        label.style.fontSize = '11px';
        label.style.flex = '1';
        label.style.lineHeight = '1.4';

        let ignoredFlag = null;
        let downloadedFlag = null;
        if (archiveKey) {
            ignoredFlag = createIgnoredFlagElement(archiveKey, galleryInfo);
            downloadedFlag = createDownloadedFlagElement(archiveKey, galleryInfo);
        }

        row.appendChild(checkbox);
        row.appendChild(sendButton);
        if (ignoredFlag) row.appendChild(ignoredFlag);
        if (downloadedFlag) row.appendChild(downloadedFlag);
        row.appendChild(label);

        container.appendChild(row);
        return row;
    };

    const updateRowStatusFlags = (row) => {
        if (!row) return;
        const checkbox = row.querySelector('.eh-magnet-checkbox');
        const info = buildGalleryInfoFromDataset(row.dataset)
            || buildGalleryInfoFromDataset(checkbox?.dataset);
        const magnetHref = row.dataset.magnetValue || checkbox?.dataset.magnetValue || '';
        const archiveKey = row.dataset.archiveKey || checkbox?.dataset.archiveKey || '';
        const effectiveKey = magnetHref || archiveKey;
        const isArchive = row.dataset.archiveFallback === 'true' || checkbox?.dataset.archiveFallback === 'true';

        const ignoredFlag = row.querySelector('.eh-magnet-ignored-flag');
        const ignored = ignoredFlag
            ? (isArchive
                ? isGalleryIgnored(info) || (effectiveKey ? isMagnetIgnored(effectiveKey, info) : false)
                : (effectiveKey ? isMagnetIgnored(effectiveKey, info) : false))
            : false;
        if (ignoredFlag) {
            ignoredFlag.style.display = ignored ? 'inline-flex' : 'none';
        }

        const downloadedFlag = row.querySelector('.eh-magnet-downloaded-flag');
        if (downloadedFlag) {
            let downloaded = false;
            let downloadTime = null;
            if (effectiveKey && downloadedMagnets.has(effectiveKey)) {
                downloaded = true;
                downloadTime = Number(downloadedMagnets.get(effectiveKey)?.timestamp) || null;
            }
            if ((!downloaded || !downloadTime) && info?.gid && isGalleryDownloaded(info)) {
                downloaded = true;
                if (effectiveKey) {
                    ensureMagnetDownloadRecord(effectiveKey, info, {
                        autoGenerated: true,
                        persist: false,
                    });
                    if (downloadedMagnets.has(effectiveKey)) {
                        downloadTime = Number(downloadedMagnets.get(effectiveKey)?.timestamp) || null;
                    }
                }
                if (!downloadTime && downloadedGalleries.has(String(info.gid))) {
                    downloadTime = Number(downloadedGalleries.get(String(info.gid))) || null;
                }
            }
            if (ignored) downloaded = false;
            downloadedFlag.style.display = downloaded ? 'inline-flex' : 'none';
            const formatted = downloadTime ? formatDownloadTooltip(downloadTime) : '';
            downloadedFlag.title = downloaded
                ? (formatted ? `已下载 (${formatted})\n点击取消标记` : '点击取消标记')
                : '点击以标记为已下载';
        }

        const magnetToggle = row.querySelector('.eh-magnet-downloaded-flag')
            || row.querySelector('.eh-magnet-downloaded-toggle');
        if (magnetToggle && typeof magnetToggle.setAttribute === 'function') {
            const downloaded = magnetToggle.style.display !== 'none';
            magnetToggle.setAttribute('aria-pressed', downloaded ? 'true' : 'false');
        }

        withDebugLog(() => console.log('[EhMagnet] syncEntryFlagDisplay', {
            key: effectiveKey,
            gid: info?.gid,
            isArchive,
            magnetIgnored: effectiveKey ? isMagnetIgnored(effectiveKey, info) : null,
            galleryIgnored: info?.gid ? isGalleryIgnored(info) : null,
        }));

        // 注意：不再在这里自动取消勾选！
        // updateStatusFlags() 现在只用于更新UI标志，不干预用户的手动选择
        // 取消勾选应该只在具体的操作完成后进行（如复制、标记、忽略等）
        // "多选时包含"设置只在批量操作时（全选、反选、多选菜单）应用
    };

    const updateStatusFlags = () => {
        const rows = document.querySelectorAll('.eh-magnet-item');
        rows.forEach((row) => updateRowStatusFlags(row));

        updateSelectToggleState();
        refreshGalleryIgnoreButtons();
    };

    const reloadStateCachesAndRefresh = (reason = 'external') => {
        withDebugLog(() => console.log('[EhMagnet] 重新同步下载/忽略状态', {
            reason,
            previousRevision: lastKnownStateRevision,
        }));
        
        // 异步加载状态
        (async () => {
            await loadDownloadedState();
            await loadIgnoredState();
            if (downloadCacheEnabled) {
                applyDownloadCacheToVisibleGalleries({ forceRebuild: true });
            }
            lastKnownStateRevision = readStateRevision();
            lastStateSyncTime = Date.now();
            updateStatusFlags();
        })();
    };

    const scheduleStateSync = (reason = 'external', { force = false } = {}) => {
        if (stateSyncScheduled) return;
        stateSyncScheduled = true;
        setTimeout(() => {
            stateSyncScheduled = false;
            const revision = readStateRevision();
            if (!force && revision === lastKnownStateRevision) {
                return;
            }
            reloadStateCachesAndRefresh(reason);
        }, 120);
    };

    const normalizeDateString = (text = '') => text
        .replace(/年|\/|-/g, '/').replace(/月/g, '/').replace(/日/g, '')
        .replace(/时|時/g, ':').replace(/分/g, '').replace(/秒/g, '')
        .replace(/[　\s]+/g, ' ').trim();

    const parseDateToTimestamp = (text = '') => {
        const trimmed = normalizeDateString(text);
        if (!trimmed) return 0;

        const now = new Date();
        let year = now.getFullYear();
        let month = now.getMonth() + 1;
        let day = now.getDate();
        let hour = 0;
        let minute = 0;

        let matched = trimmed.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?$/);
        if (matched) {
            year = Number(matched[1]);
            month = Number(matched[2]);
            day = Number(matched[3]);
            if (matched[4]) hour = Number(matched[4]);
            if (matched[5]) minute = Number(matched[5]);
        } else {
            matched = trimmed.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?(?:\s+(\d{1,2}):(\d{2}))?$/);
            if (matched) {
                month = Number(matched[1]);
                day = Number(matched[2]);
                if (matched[3]) year = Number(matched[3]);
                if (matched[4]) hour = Number(matched[4]);
                if (matched[5]) minute = Number(matched[5]);
            } else {
                matched = trimmed.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
                if (matched) {
                    year = Number(matched[1]);
                    month = Number(matched[2]);
                    day = Number(matched[3]);
                }
            }
        }

        const date = new Date(year, month - 1, day, hour, minute, 0, 0);
        if (Number.isNaN(date.getTime())) return 0;

        if (!trimmed.includes('/') || trimmed.split('/')[0].length <= 2) {
            const diff = date.getTime() - now.getTime();
            if (diff > 1000 * 60 * 60 * 24 * 45) {
                date.setFullYear(date.getFullYear() - 1);
            }
        }

        return date.getTime();
    };

    const extractMagnetFromHref = (href = '') => {
        if (!href) return '';
        if (href.startsWith('magnet:?')) return href;
        const match = href.match(/([0-9a-f]{40})/i);
        return match ? `magnet:?xt=urn:btih:${match[1].toLowerCase()}` : '';
    };

    const extractMagnetFilename = (href = '') => {
        if (!href) return '';
        const match = href.match(/[?&]dn=([^&]+)/i);
        if (!match) return '';
        try {
            return decodeURIComponent(match[1].replace(/\+/g, ' '));
        } catch (err) {
            return match[1];
        }
    };

    const splitLabelValue = (text) => {
        const normalized = text.replace(/\s+/g, ' ').trim();
        let index = normalized.indexOf(':');
        const cnIndex = normalized.indexOf('：');
        if (index === -1 || (cnIndex !== -1 && cnIndex < index)) index = cnIndex;
        if (index === -1) {
            return { hasLabel: false, label: '', value: normalized };
        }
        const label = normalized.slice(0, index).trim();
        const value = normalized.slice(index + 1).trim();
        return { hasLabel: true, label, value };
    };

    const parseMetadataFromTable = (table) => {
        const info = {
            postedLabel: '',
            postedValue: '',
            sizeLabel: '',
            sizeValue: '',
            uploaderLabel: '',
            uploaderValue: '',
            filename: '',
            sizeBytes: 0,
            seeders: '',
            downloads: '',
            completes: '',
            isOutdated: false,
            postedTimestamp: 0,
            postedFull: '',
            torrentUrl: '',
        };
        if (!table) return info;

        const cells = Array.from(table.querySelectorAll('td'));
        const filenameCandidates = [];

        cells.forEach((cell) => {
            const text = cell.textContent.replace(/\s+/g, ' ').trim();
            if (!text) return;
            const { hasLabel, label, value } = splitLabelValue(text);
            if (hasLabel) {
                const lowerLabel = label.toLowerCase();
                if (lowerLabel === 'posted') {
                    info.postedLabel = text;
                    info.postedValue = value;
                    info.postedFull = value;
                    return;
                }
                if (lowerLabel === 'size') {
                    info.sizeLabel = text;
                    info.sizeValue = value;
                    return;
                }
                if (lowerLabel === 'uploader' || label.includes('上传者') || label.includes('上傳者')) {
                    info.uploaderLabel = text;
                    info.uploaderValue = value;
                    return;
                }
                if (label.includes('做种') || lowerLabel === 'seeders' || lowerLabel === 'seeds') {
                    info.seeders = parseInteger(value || text);
                    return;
                }
                if (label.includes('下载') || lowerLabel === 'downloads') {
                    info.downloads = parseInteger(value || text);
                    return;
                }
                if (label.includes('完成') || lowerLabel === 'completes' || lowerLabel === 'completed') {
                    info.completes = parseInteger(value || text);
                    return;
                }
                if (lowerLabel === '过时种子' || lowerLabel === 'outdated') {
                    info.isOutdated = true;
                    return;
                }
                if (lowerLabel === 'seeds' || lowerLabel === 'seeders' || lowerLabel === 'peers' || lowerLabel === 'downloads' || lowerLabel === 'hash') {
                    return;
                }
            }
            if (!text.includes(':') && !text.includes('：')) {
                filenameCandidates.push(text);
            }
        });

        if (!info.isOutdated) {
            const outdatedFlag = table.querySelector('span[style*="color:red"], span[style*="color: red"], span[style*="#f00"], span[style*="rgb(255, 0, 0)"]');
            if (outdatedFlag) info.isOutdated = true;
        }

        if (!info.isOutdated) {
            const container = table.closest('div');
            if (container) {
                const prev = container.previousElementSibling;
                if (prev && /过时种子|outdated/i.test(prev.textContent || '')) {
                    info.isOutdated = true;
                }
            }
        }

        if (!info.torrentUrl || !info.filename) {
            const filenameAnchor = table.querySelector('a[href*=".torrent"], a[href*="/torrent/"], a[href*=".zip"], a[href*=".rar"], a[href*=".7z"], a[href*=".tar"], a[onclick*=".torrent"]');
            if (filenameAnchor) {
                const anchorText = filenameAnchor.textContent.replace(/\s+/g, ' ').trim();
                if (!info.filename && anchorText) info.filename = anchorText;
                let torrentHref = filenameAnchor.getAttribute('href') || '';
                const onclickHref = extractUrlFromOnclick(filenameAnchor.getAttribute('onclick') || '');
                if (onclickHref) {
                    torrentHref = onclickHref;
                } else if (!torrentHref || torrentHref === '#') {
                    torrentHref = extractPopupUrl(filenameAnchor.getAttribute('onclick') || '');
                }
                if (torrentHref) info.torrentUrl = toAbsoluteUrl(torrentHref);
            }
        }

        if (!info.filename && filenameCandidates.length) {
            info.filename = filenameCandidates.reduce((longest, current) => (current.length > longest.length ? current : longest), filenameCandidates[0]);
        }

        if (!info.filename) {
            let sibling = table.nextElementSibling;
            if (sibling && sibling.tagName === 'P') {
                info.filename = sibling.textContent.replace(/\s+/g, ' ').trim();
            } else if (table.parentElement) {
                const p = table.parentElement.querySelector('p');
                if (p) info.filename = p.textContent.replace(/\s+/g, ' ').trim();
            }
        }

        if (!info.sizeValue && info.sizeLabel) {
            const { value } = splitLabelValue(info.sizeLabel);
            info.sizeValue = value;
        }

        if (!info.postedValue && info.postedLabel) {
            const { value } = splitLabelValue(info.postedLabel);
            info.postedValue = value;
        }

        if (!info.postedFull) info.postedFull = info.postedValue;
        info.postedTimestamp = parseDateToTimestamp(info.postedFull || info.postedLabel || '');

        info.sizeBytes = parseSizeToBytes(info.sizeValue);
        return info;
    };

    const selectedMagnets = new Set();
    const selectedGalleries = new Map();
    const galleryIgnoreButtons = new Map();

    const escapeForSelector = (value) => {
        if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(value);
        return String(value).replace(/([!"#$%&'()*+,./:;<=>?@[\\\]^`{|}~\s])/g, '\\$1');
    };

    const resolveGalleryContainerElement = (element) => {
        if (!element) return null;
        const selectors = ['.gl1t', '.gl1d', '.gl1c', '.gl1m', '.gl1e', '.gl1o', '.gl1b', 'tr'];
        for (let i = 0; i < selectors.length; i += 1) {
            const container = element.closest(selectors[i]);
            if (container) return container;
        }
        return null;
    };

    const setGalleryTempHiddenState = (gid, hidden) => {
        if (!gid) return false;
        ensureTempHideStyles();
        const normalized = String(gid);
        let changed = false;
        const anchorSelector = `a[href*="/g/${escapeForSelector(normalized)}/"]`;
        const anchors = document.querySelectorAll(anchorSelector);
        anchors.forEach((anchor) => {
            const container = resolveGalleryContainerElement(anchor);
            if (!container) return;
            // 避免操作 LOLICON 的无限滚动触发器
            if (container.classList && container.classList.contains(LOLICON_SCROLL_TRIGGER_CLASS)) {
                return;
            }
            if (hidden) {
                if (!container.classList.contains(TEMP_HIDDEN_CLASS)) {
                    container.classList.add(TEMP_HIDDEN_CLASS);
                    changed = true;
                }
            } else if (container.classList.contains(TEMP_HIDDEN_CLASS)) {
                container.classList.remove(TEMP_HIDDEN_CLASS);
                changed = true;
            }
        });
        const magnetContainers = document.querySelectorAll(`.eh-magnet-links[data-gallery-gid="${escapeForSelector(normalized)}"]`);
        magnetContainers.forEach((container) => {
            // 避免操作 LOLICON 的无限滚动触发器
            if (container.classList && container.classList.contains(LOLICON_SCROLL_TRIGGER_CLASS)) {
                return;
            }
            if (hidden) {
                if (!container.classList.contains(TEMP_HIDDEN_CLASS)) {
                    container.classList.add(TEMP_HIDDEN_CLASS);
                    changed = true;
                }
            } else if (container.classList.contains(TEMP_HIDDEN_CLASS)) {
                container.classList.remove(TEMP_HIDDEN_CLASS);
                changed = true;
            }
        });
        if (hidden) {
            clearGallerySelections(normalized);
        }
        return changed;
    };

    const applyTemporaryHiddenState = () => {
        if (!tempHiddenGalleries.size) return;
        ensureTempHideStyles();
        // 暂时断开 MutationObserver，避免临时隐藏操作触发不必要的扫描
        const wasObserverActive = !observerDisconnected;
        if (wasObserverActive && typeof observer !== 'undefined' && observer) {
            observer.disconnect();
            observerDisconnected = true;
        }
        tempHiddenGalleries.forEach((gid) => {
            setGalleryTempHiddenState(gid, true);
        });
        // 重新连接 MutationObserver
        if (wasObserverActive && typeof observer !== 'undefined' && observer) {
            setTimeout(() => {
                if (observerDisconnected) {
                    observer.observe(document.body, { childList: true, subtree: true });
                    observerDisconnected = false;
                }
            }, 100);
        }
    };

    const hideGalleriesByIds = (ids = []) => {
        if (!ids || !ids.length) {
            return { hiddenCount: 0, alreadyHidden: 0, total: 0 };
        }
        ensureTempHideStyles();
        // 暂时断开 MutationObserver，避免隐藏操作触发不必要的扫描
        const wasObserverActive = !observerDisconnected;
        if (wasObserverActive && typeof observer !== 'undefined' && observer) {
            observer.disconnect();
            observerDisconnected = true;
        }
        const uniqueIds = Array.from(new Set(ids.map((id) => (id ? String(id) : '').trim()).filter(Boolean)));
        let hiddenCount = 0;
        let alreadyHidden = 0;
        uniqueIds.forEach((gid) => {
            if (tempHiddenGalleries.has(gid)) {
                alreadyHidden += 1;
            } else {
                tempHiddenGalleries.add(gid);
                hiddenCount += 1;
            }
            setGalleryTempHiddenState(gid, true);
        });
        persistTempHiddenGalleries();
        // 重新连接 MutationObserver
        if (wasObserverActive && typeof observer !== 'undefined' && observer) {
            setTimeout(() => {
                if (observerDisconnected) {
                    observer.observe(document.body, { childList: true, subtree: true });
                    observerDisconnected = false;
                }
            }, 100);
        }
        const summary = {
            hiddenCount,
            alreadyHidden,
            total: uniqueIds.length,
        };
        withDebugLog(() => console.log('[EhMagnet] hideGalleriesByIds', summary));
        return summary;
    };

    const clearTemporaryHiddenGalleries = () => {
        if (!tempHiddenGalleries.size) return 0;
        ensureTempHideStyles();
        // 暂时断开 MutationObserver，避免恢复显示操作触发不必要的扫描
        const wasObserverActive = !observerDisconnected;
        if (wasObserverActive && typeof observer !== 'undefined' && observer) {
            observer.disconnect();
            observerDisconnected = true;
        }
        tempHiddenGalleries.forEach((gid) => {
            setGalleryTempHiddenState(gid, false);
        });
        const count = tempHiddenGalleries.size;
        tempHiddenGalleries.clear();
        persistTempHiddenGalleries();
        // 重新连接 MutationObserver
        if (wasObserverActive && typeof observer !== 'undefined' && observer) {
            setTimeout(() => {
                if (observerDisconnected) {
                    observer.observe(document.body, { childList: true, subtree: true });
                    observerDisconnected = false;
                }
            }, 100);
        }
        withDebugLog(() => console.log('[EhMagnet] clearTemporaryHiddenGalleries', { count }));
        return count;
    };

    const clearGallerySelections = (gid) => {
        if (!gid) return;
        selectedGalleries.delete(gid);
        const selectorGid = escapeForSelector(gid);
        document.querySelectorAll(`.eh-magnet-checkbox[data-gallery-gid="${selectorGid}"]`).forEach((box) => {
            if (box.checked) box.checked = false;
            if (box.dataset.magnetValue) selectedMagnets.delete(box.dataset.magnetValue);
        });
    };

    const isFallbackOnlyGallery = (gid) => {
        if (!gid) return true; // 默认为回退状态
        const selectorGid = escapeForSelector(gid);
        const container = document.querySelector(`.eh-magnet-links[data-gallery-gid="${selectorGid}"]`);
        if (!container) return true; // 没有容器说明还未加载，默认隐藏按钮
        const items = container.querySelectorAll('.eh-magnet-item');
        if (!items.length) return true; // 没有项目，默认隐藏
        return Array.from(items).every((item) => item.dataset.archiveFallback === 'true');
    };

    const applyFallbackBadgeDisplay = (button) => {
        if (!button) return;
        const state = button.dataset.state || 'default';
        const hovered = button.dataset.hovered === 'true';

        // 默认状态：只在悬停时显示；其他状态保持常亮
        if (state === 'default' && !hovered) {
            button.style.opacity = '0';
        } else {
            button.style.opacity = '';
        }
        button.style.pointerEvents = 'auto';
    };

    const updateGalleryIgnoreButtonState = (button, gid) => {
        const normalizedGid = String(gid);
        const isIgnored = isGalleryIgnored(normalizedGid);
        const isMarked = downloadedGalleries.has(normalizedGid);
        const fallbackOnly = isFallbackOnlyGallery(normalizedGid);
        
        // 确定当前状态：忽略 > 标记 > 默认
        let state = 'default';
        if (isIgnored) {
            state = 'ignored';
        } else if (isMarked) {
            state = 'marked';
        }
        
        // 仅在 DEBUG 模式下输出详细日志，减少控制台刷屏
        withDebugLog(() => console.log('[EhMagnet] updateGalleryIgnoreButtonState:', { gid: normalizedGid, isIgnored, isMarked, state }));
        
        button.dataset.state = state;
        button.dataset.fallbackOnly = fallbackOnly ? 'true' : 'false';
        
        // 根据状态设置显示
        if (state === 'ignored') {
            button.textContent = '⛔';
            button.title = '点击标记为已下载';
            button.dataset.active = 'true';
            button.setAttribute('aria-pressed', 'true');
        } else if (state === 'marked') {
            button.textContent = '✅';
            const meta = getGalleryDownloadMeta(normalizedGid);
            const formatted = formatDownloadTooltip(meta.timestamp);
            button.title = formatted
                ? `已下载 (${formatted})\n点击取消标记`
                : '点击取消标记';
            button.dataset.active = 'true';
            button.setAttribute('aria-pressed', 'true');
        } else {
            button.textContent = '⛔';
            button.title = '点击忽略该画廊';
            button.dataset.active = 'false';
            button.setAttribute('aria-pressed', 'false');
        }
        
        applyFallbackBadgeDisplay(button);
    };

    const getGalleryDownloadMeta = (gid) => {
        const normalizedGid = String(gid);
        let latest = 0;

        const galleryTimestamp = normalizeTimestampValue(downloadedGalleries.get(normalizedGid));
        if (galleryTimestamp) latest = Math.max(latest, galleryTimestamp);

        const magnetSet = galleryDownloadedMagnets.get(normalizedGid);
        if (magnetSet && magnetSet.size) {
            magnetSet.forEach((href) => {
                const info = downloadedMagnets.get(href);
                if (!info) return;
                const ts = normalizeTimestampValue(info.timestamp);
                if (ts) latest = Math.max(latest, ts);
            });
        } else {
            downloadedMagnets.forEach((info) => {
                if (info?.gid && String(info.gid) === normalizedGid) {
                    const ts = normalizeTimestampValue(info.timestamp);
                    if (ts) latest = Math.max(latest, ts);
                }
            });
        }

        if (!latest && legacyDownloadedGalleries.has(normalizedGid)) {
            latest = Date.now();
        }

        return {
            downloaded: latest > 0,
            timestamp: latest,
        };
    };

    const getGalleryContainersForBadges = () => {
        const unique = new Set();
        const result = [];
        const push = (el) => {
            if (!el) return;
            if (unique.has(el)) return;
            unique.add(el);
            result.push(el);
        };

        document.querySelectorAll('.gl1t, .gl1e, .gl1c, .gl1d, .gl1m, .gl1o, .gl1b').forEach(push);
        document.querySelectorAll('.gl5t, .gl5e, .gl5c, .gl5m, .gl5o, .gl5b').forEach((cell) => {
            const block = cell.closest('.gl1t, .gl1e, .gl1c, .gl1d, .gl1m, .gl1o, .gl1b, tr') || cell.closest('tr') || cell;
            push(block);
        });
        return result;
    };

    const findGalleryPostedNode = (block) => {
        if (!block) return null;
        const selectors = ['[id^="posted_"]', '.posted'];
        for (let i = 0; i < selectors.length; i += 1) {
            const node = block.querySelector(selectors[i]);
            if (node) return node;
        }
        const postedCell = block.querySelector('.gl5t, .gl5e, .gl5c, .gl5m, .gl5o, .gl5b');
        if (postedCell) {
            for (let i = 0; i < selectors.length; i += 1) {
                const node = postedCell.querySelector(selectors[i]);
                if (node) return node;
            }
            return postedCell;
        }
        return null;
    };

    const resolveGalleryBlockFromElement = (element) => {
        if (!element) return null;
        const containerSelector = '.gl1t, .gl1e, .gl1c, .gl1d, .gl1m, .gl1o, .gl1b, tr';
        return element.closest(containerSelector) || element.closest('.gl5t') || element;
    };

    const ensureMagnetDownloadRecord = (magnetHref, galleryInfo, options = {}) => {
        if (!magnetHref || !galleryInfo?.gid) return false;
        const gid = String(galleryInfo.gid);
        const { timestamp, persist = true, autoGenerated = false } = options || {};
        const normalizedAuto = autoGenerated === true;
        if (downloadedMagnets.has(magnetHref)) {
            const existing = downloadedMagnets.get(magnetHref) || {};
            let nextTimestamp = normalizeTimestampValue(timestamp);
            if (!nextTimestamp || nextTimestamp <= 0) {
                nextTimestamp = normalizeTimestampValue(existing.timestamp) || Date.now();
            }
            const existingAuto = existing.autoGenerated === true;
            const autoFlag = existing.autoGenerated === false
                ? false
                : (existingAuto || normalizedAuto);
            const existingTs = normalizeTimestampValue(existing.timestamp) || 0;
            const needsUpdate = existing.gid !== gid || existingAuto !== autoFlag || existingTs !== nextTimestamp;
            if (needsUpdate) {
                downloadedMagnets.set(magnetHref, {
                    gid,
                    timestamp: nextTimestamp,
                    autoGenerated: autoFlag,
                });
                if (persist) {
                    persistDownloadedState();
                }
            }
            ensureDownloadedSet(gid).add(magnetHref);
            return false;
        }

        let baseTimestamp = normalizeTimestampValue(timestamp);
        if (!baseTimestamp || baseTimestamp <= 0) {
            baseTimestamp = normalizeTimestampValue(downloadedGalleries.get(gid)) || Date.now();
        }
        // 最终验证：确保 baseTimestamp 是有效的正数
        if (!baseTimestamp || baseTimestamp <= 0) {
            console.warn('[EhMagnet] 时间戳无效，使用当前时间:', { magnetHref, originalTimestamp: timestamp, baseTimestamp });
            baseTimestamp = Date.now();
        }
        downloadedMagnets.set(magnetHref, {
            gid,
            timestamp: baseTimestamp,
            autoGenerated: normalizedAuto,
        });
        ensureDownloadedSet(gid).add(magnetHref);
        if (persist) {
            persistDownloadedState();
        }
        return true;
    };

    const removeGalleryDownloadRecords = (gid, options = {}) => {
        if (!gid) return false;
        const normalizedGid = String(gid);
        let changed = false;

        if (downloadedGalleries.delete(normalizedGid)) changed = true;
        if (legacyDownloadedGalleries.delete(normalizedGid)) changed = true;

        const set = galleryDownloadedMagnets.get(normalizedGid);
        if (set && set.size) {
            set.forEach((href) => {
                if (downloadedMagnets.delete(href)) changed = true;
            });
            galleryDownloadedMagnets.delete(normalizedGid);
            changed = true;
        } else {
            downloadedMagnets.forEach((info, href) => {
                if (info?.gid && String(info.gid) === normalizedGid) {
                    downloadedMagnets.delete(href);
                    changed = true;
                }
            });
        }

        if (changed && options.persist) {
            persistDownloadedState();
        }
        return changed;
    };

    let legacyGalleryBadgeCleanupDone = false;
    const cleanupLegacyGalleryBadges = () => {
        if (!legacyGalleryBadgeCleanupDone) {
            document.querySelectorAll('.eh-gallery-downloaded-badge').forEach((node) => {
                try {
                    node.remove();
                } catch (err) {
                    withDebugLog(() => console.warn('清理旧版已下载徽标失败', err));
                }
            });
            legacyGalleryBadgeCleanupDone = true;
        }
    };

    const refreshGalleryPostedBadges = (gid) => {
        if (!gid) return;
        cleanupLegacyGalleryBadges();
        const normalizedGid = String(gid);

        const selectorGid = escapeForSelector(normalizedGid);
        document
            .querySelectorAll(`.eh-gallery-ignore-badge[data-gallery-gid="${selectorGid}"]`)
            .forEach((button) => updateGalleryIgnoreButtonState(button, normalizedGid));

        document
            .querySelectorAll(`.eh-magnet-item[data-gallery-gid="${selectorGid}"]`)
            .forEach((row) => updateRowStatusFlags(row));
    };

    const refreshGalleryIgnoreButtons = () => {
        const blocks = document.querySelectorAll('.gl1t');
        blocks.forEach((galleryBlock) => {
            const postedNode = galleryBlock.querySelector('.gl5t > div > div[id^="posted_"]');
            const galleryLink = galleryBlock.querySelector('.glname a[href*="/g/"]');
            const galleryInfo = parseGalleryInfo(galleryLink?.href || '');
            if (postedNode && galleryInfo?.gid) {
                ensureGalleryIgnoreToggle(postedNode, galleryInfo);
            }
        });

        galleryIgnoreButtons.forEach((button, gid) => {
            if (!button.isConnected) {
                galleryIgnoreButtons.delete(gid);
                return;
            }
            updateGalleryIgnoreButtonState(button, gid);
        });
    };

    const ensureGalleryIgnoreToggle = (postedNode, galleryInfo) => {
        if (!postedNode || !galleryInfo?.gid) return;
        const gid = String(galleryInfo.gid);
        let button = galleryIgnoreButtons.get(gid);
        if (!button || !button.isConnected) {
            button = document.createElement('button');
            button.type = 'button';
            button.className = 'eh-gallery-ignore-badge';
            button.textContent = '⛔';
            button.style.border = 'none';
            button.style.background = 'transparent';
            button.style.padding = '0';
            button.style.marginRight = '4px';
            button.style.cursor = 'pointer';
            const info = {
                gid,
                token: galleryInfo.token || '',
                href: galleryInfo.href || '',
            };
            button.addEventListener('click', (event) => {
                console.log('[EhMagnet] ⛔ 按钮被点击', { gid: info.gid, state: button.dataset.state });
                event.stopPropagation();
                event.preventDefault();
                
                const state = button.dataset.state || 'default';
                const gidStr = String(info.gid);
                
                console.log('[EhMagnet] 当前状态:', state, 'gid:', gidStr);
                
                if (state === 'ignored') {
                    // 取消忽略
                    unmarkGalleryIgnored(info);
                    // 取消状态后，立即隐藏按钮
                    button.dataset.hovered = 'false';
                    updateGalleryIgnoreButtonState(button, info.gid);
                } else if (state === 'marked') {
                    // 删除该画廊的所有已下载磁链（包括不在页面上可见的）
                    const galleryMagnets = galleryDownloadedMagnets.get(gidStr) || new Set();
                    galleryMagnets.forEach(magnetHref => {
                        unmarkMagnetDownloaded(magnetHref, info, { silent: true, skipPersist: true });
                    });
                    
                    // 同时处理页面上的磁链（以防有遗漏）
                    const magnetRows = document.querySelectorAll(`.eh-magnet-item[data-gallery-gid="${escapeForSelector(gidStr)}"]`);
                    const resolveRowInfo = (row, checkbox) => {
                        const infoFromDataset = buildGalleryInfoFromDataset(row.dataset)
                            || buildGalleryInfoFromDataset(checkbox?.dataset);
                        if (infoFromDataset?.gid) return infoFromDataset;
                        return info;
                    };
                    magnetRows.forEach((row) => {
                        const checkbox = row.querySelector('.eh-magnet-checkbox');
                        const rowInfo = resolveRowInfo(row, checkbox);
                        const magnetKey = row.dataset.magnetValue
                            || row.dataset.archiveKey
                            || checkbox?.dataset.magnetValue
                            || checkbox?.dataset.archiveKey
                            || '';
                        if (!magnetKey || galleryMagnets.has(magnetKey)) return;  // 避免重复删除
                        unmarkMagnetDownloaded(magnetKey, rowInfo, { silent: true, skipPersist: true });
                    });
                    removeGalleryDownloadRecords(gidStr);
                    persistDownloadedState();
                    refreshGalleryPostedBadges(gidStr);
                    updateStatusFlags();
                    // 取消状态后，立即隐藏按钮
                    button.dataset.hovered = 'false';
                    updateGalleryIgnoreButtonState(button, info.gid);
                } else {
                    // 默认状态：点击后标记为忽略
                    markGalleryIgnored(info);
                    // 忽略状态常亮显示，不需要隐藏
                    updateGalleryIgnoreButtonState(button, info.gid);
                }
            });
            button.dataset.hovered = 'false';
        }
        galleryIgnoreButtons.set(gid, button);
        button.dataset.galleryGid = gid;
        button.dataset.galleryToken = galleryInfo.token || '';
        button.dataset.galleryHref = galleryInfo.href || '';
        const parent = postedNode.parentElement;
        if (!(parent instanceof HTMLElement)) return;
        parent.style.display = 'flex';
        parent.style.alignItems = 'center';
        parent.style.gap = '6px';

        let infoRow = parent.querySelector(':scope > .eh-gallery-info-row');
        if (!infoRow) {
            infoRow = document.createElement('div');
            infoRow.className = 'eh-gallery-info-row';
            infoRow.style.display = 'flex';
            infoRow.style.alignItems = 'center';
            infoRow.style.gap = '6px';
            const nodesToMove = Array.from(parent.children).filter((node) => (
                node instanceof HTMLElement && (node.classList.contains('cs') || node.classList.contains('ct1'))
            ));
            parent.insertBefore(infoRow, parent.firstChild);
            nodesToMove.forEach((node) => infoRow.appendChild(node));
        }

        if (button.parentElement !== infoRow) {
            infoRow.insertBefore(button, infoRow.firstChild);
        }
        button.style.marginRight = '4px';
        button.style.marginLeft = '0';
        button.style.position = 'static';

        if (postedNode.parentElement !== parent) {
            parent.appendChild(postedNode);
        }
        // 只在鼠标悬停按钮自身时显示
        if (button.dataset.fallbackListenerAttached !== 'true') {
            const handleMouseEnter = () => {
                button.dataset.hovered = 'true';
                applyFallbackBadgeDisplay(button);
            };
            const handleMouseLeave = () => {
                button.dataset.hovered = 'false';
                applyFallbackBadgeDisplay(button);
            };
            button.addEventListener('mouseenter', handleMouseEnter);
            button.addEventListener('mouseleave', handleMouseLeave);
            button.dataset.fallbackListenerAttached = 'true';
        }
        updateGalleryIgnoreButtonState(button, gid);
    };
    const ensureGalleryActionMenuButton = (block, galleryInfo, galleryTitle, enrichedGalleryInfo) => {
        if (!block || !galleryInfo?.gid) return;
        const ignoreButton = block.querySelector('.eh-gallery-ignore-badge');
        if (!ignoreButton) return;
        if (ignoreButton.previousElementSibling?.classList.contains('eh-gallery-action-menu-btn')) {
            return;
        }

        const gidStr = String(galleryInfo.gid);
        const effectiveInfo = enrichedGalleryInfo?.gid
            ? { ...enrichedGalleryInfo, gid: String(enrichedGalleryInfo.gid) }
            : {
                gid: gidStr,
                token: galleryInfo.token || '',
                href: galleryInfo.href || '',
                title: galleryTitle || '',
            };

        const menuButton = document.createElement('button');
        menuButton.type = 'button';
        menuButton.className = 'eh-gallery-action-menu-btn';
        menuButton.style.border = 'none';
        menuButton.style.background = 'transparent';
        menuButton.style.padding = '0';
        menuButton.style.marginRight = '4px';
        menuButton.style.cursor = 'pointer';
        menuButton.style.fontSize = '14px';
        menuButton.style.position = 'relative';
        menuButton.dataset.galleryGid = gidStr;

        menuButton.textContent = '⚙️';
        menuButton.title = '点击打开功能菜单';

        const createMenu = () => {
            const menu = document.createElement('div');
            menu.className = 'eh-gallery-action-menu';
            menu.style.position = 'absolute';
            menu.style.top = '20px';
            menu.style.left = '0';
            applyMenuSurfaceStyle(menu, {
                minWidth: null,
                padding: '6px 0',
                zIndex: '10000',
            });
            menu.style.whiteSpace = 'nowrap';

            const isMarked = downloadedGalleries.has(gidStr);

            // AB Download Manager 归档下载菜单项
            const abdmItem = document.createElement('div');
            abdmItem.style.padding = '6px 14px';
            abdmItem.style.cursor = 'pointer';
            abdmItem.style.fontSize = '13px';
            abdmItem.style.fontWeight = '600';
            abdmItem.style.textAlign = 'left';
            abdmItem.textContent = '📤 发送到AB DM（归档）';
            abdmItem.title = '发送此画廊到AB Download Manager进行归档下载（消耗GP）';
            abdmItem.addEventListener('mouseenter', () => {
                abdmItem.style.background = getMenuHoverBackground();
            });
            abdmItem.addEventListener('mouseleave', () => {
                abdmItem.style.background = '';
            });
            abdmItem.addEventListener('click', async (e) => {
                e.stopPropagation();
                menu.remove();

                // 从最近下载中查询该画廊的信息
                const recentBatches = await loadRecentBatches();
                let recentEntry = null;
                for (const batch of recentBatches || []) {
                    const found = batch.entries.find(e => e.gallery?.gid === gidStr);
                    if (found) {
                        recentEntry = found;
                        break;
                    }
                }

                // 获取标题（优先从最近下载获取，然后从 effectiveInfo，最后从 DOM）
                let titleText = recentEntry?.name || effectiveInfo?.title || galleryInfo.title;
                if (!titleText) {
                    // 尝试从 DOM 中提取标题
                    const galleryLink = document.querySelector(`.gl1t[href*="/g/${gidStr}/"], .gl3t a[href*="/g/${gidStr}/"]`);
                    if (galleryLink) {
                        const galleryBlock = galleryLink.closest('.gl1e, .gl3t');
                        if (galleryBlock) {
                            const titleElement = galleryBlock.querySelector('.gl1t');
                            if (titleElement) {
                                titleText = titleElement.textContent.trim();
                            } else {
                                const imgElement = galleryBlock.querySelector('.gl3t a img');
                                if (imgElement) {
                                    titleText = imgElement.title || imgElement.alt || '';
                                }
                            }
                        }
                    }
                }
                if (!titleText) titleText = '未知';

                // 准备条目用于预检
                const entryToPrecheck = {
                    name: titleText,
                    gid: gidStr,
                    token: galleryInfo.token || effectiveInfo?.token || '',
                    href: galleryInfo.href || effectiveInfo?.href || `https://e-hentai.org/g/${gidStr}/`,
                    gallery: {
                        gid: gidStr,
                        token: galleryInfo.token || effectiveInfo?.token || '',
                        href: galleryInfo.href || effectiveInfo?.href || `https://e-hentai.org/g/${gidStr}/`,
                    },
                };

                if (!entryToPrecheck.token) {
                    toastError('无法获取画廊 token，无法进行归档');
                    return;
                }

                // 打开预检对话框
                await showArchivePreCheckDialog([entryToPrecheck], async (readyItems) => {
                    // 检查 AB DM 是否可用
                    const isAvailable = await checkAbdmAvailable();
                    if (!isAvailable) {
                        toastError(`AB Download Manager 未运行或端口 ${abdmPort} 不可用\n请确保 AB Download Manager 已启动`);
                        return;
                    }

                    toastInfo('正在获取归档下载链接...');

                    try {
                        const archiveInfo = await fetchArchiveDownloadInfo({
                            gid: gidStr,
                            token: galleryInfo.token || effectiveInfo?.token || '',
                            pageLink: galleryInfo.href || effectiveInfo?.href || '',
                        });

                        await sendToAbdm([{
                            link: archiveInfo.downloadUrl,
                            downloadPage: galleryInfo.href || effectiveInfo?.href || '',
                            headers: {
                                'Cookie': document.cookie,
                                'User-Agent': navigator.userAgent,
                            },
                            suggestedName: archiveInfo.fileName,
                        }]);

                        // 标记为已下载
                        markGalleryDownloaded({ gid: gidStr });
                    
                    // 记录到最近下载
                    const nowText = formatOperationTime(new Date());
                    const archiveKey = `archive://${gidStr}/org`;
                    const galleryHref = galleryInfo.href || effectiveInfo?.href || `https://e-hentai.org/g/${gidStr}/`;
                    
                    // 优先使用各种来源的标题
                    let galleryTitle = archiveInfo.title || galleryInfo.title || effectiveInfo?.title || '';
                    
                    // 如果标题仍然为空，尝试从 DOM 中提取
                    if (!galleryTitle) {
                        const galleryLink = document.querySelector(`.gl1t[href*="/g/${gidStr}/"], .gl3t a[href*="/g/${gidStr}/"]`);
                        if (galleryLink) {
                            const galleryBlock = galleryLink.closest('.gl1e, .gl3t');
                            if (galleryBlock) {
                                const titleElement = galleryBlock.querySelector('.gl1t');
                                if (titleElement) {
                                    galleryTitle = titleElement.textContent.trim();
                                } else {
                                    const imgElement = galleryBlock.querySelector('.gl3t a img');
                                    if (imgElement) {
                                        galleryTitle = imgElement.title || imgElement.alt || '';
                                    }
                                }
                            }
                        }
                    }
                    
                    const entry = resolveRecentEntry({
                        archiveKey,
                        archiveDltype: 'org',
                        isArchive: true,
                        href: archiveKey,
                    }, {
                        gid: gidStr,
                        token: galleryInfo.token || effectiveInfo?.token || '',
                        href: galleryHref,
                        title: galleryTitle,
                    }, {
                        name: galleryTitle,
                        downloadUrl: archiveInfo.downloadUrl,
                        operationText: nowText,
                    });
                    
                    if (entry) {
                        recordRecentBatch([entry], { source: '单个下载', operationText: nowText });
                    }
                    
                    toastSuccess('已发送到 AB Download Manager');

                } catch (err) {
                    toastError(`获取归档下载链接失败：${err.message || err}`);
                    console.error('[EhMagnet] AB DM 归档下载失败', err);
                }
                });
            });

            const markItem = document.createElement('div');
            markItem.style.padding = '6px 14px';
            markItem.style.cursor = 'pointer';
            markItem.style.fontSize = '13px';
            markItem.style.fontWeight = '600';
            markItem.style.textAlign = 'left';
            markItem.innerHTML = isMarked ? '&nbsp;✓&nbsp;&nbsp;取消标记' : '📌&nbsp;标记此画廊';
            markItem.title = isMarked ? '取消标记此画廊' : '标记此画廊为已下载';
            const hoverBg = getMenuHoverBackground();
            markItem.addEventListener('mouseenter', () => {
                markItem.style.background = hoverBg;
            });
            markItem.addEventListener('mouseleave', () => {
                markItem.style.background = '';
            });
            markItem.addEventListener('click', (e) => {
                e.stopPropagation();

                const currentBlock = menuButton.closest('.gl5t');
                const magnetRows = document.querySelectorAll(`.eh-magnet-item[data-gallery-gid="${escapeForSelector(gidStr)}"]`);

                const resolveRowInfo = (row, checkbox) => {
                    const info = buildGalleryInfoFromDataset(row.dataset)
                        || buildGalleryInfoFromDataset(checkbox?.dataset)
                        || effectiveInfo;
                    if (info && info.gid) return info;
                    return {
                        gid: gidStr,
                        token: galleryInfo.token || '',
                        href: galleryInfo.href || '',
                        title: galleryTitle || effectiveInfo?.title || '',
                    };
                };

                const toggleRows = (handler) => {
                    magnetRows.forEach((row) => {
                        const checkbox = row.querySelector('.eh-magnet-checkbox');
                        const rowInfo = resolveRowInfo(row, checkbox);
                        const magnetKey = row.dataset.magnetValue
                            || row.dataset.archiveKey
                            || checkbox?.dataset.magnetValue
                            || checkbox?.dataset.archiveKey
                            || '';
                        if (!magnetKey) return;
                        handler(magnetKey, rowInfo);
                    });
                };

                if (isMarked) {
                    toggleRows((href, info) => {
                        unmarkMagnetDownloaded(href, info, { silent: true, skipPersist: true });
                    });
                    removeGalleryDownloadRecords(gidStr);
                    persistDownloadedState();
                    refreshGalleryPostedBadges(gidStr);

                    const statusButton = currentBlock?.querySelector('.eh-gallery-ignore-badge');
                    if (statusButton) {
                        statusButton.dataset.hovered = 'false';
                        updateGalleryIgnoreButtonState(statusButton, galleryInfo.gid);
                    }
                } else {
                    if (isGalleryIgnored(galleryInfo.gid)) {
                        unmarkGalleryIgnored(effectiveInfo);
                    }

                    downloadedGalleries.set(gidStr, Date.now());
                    toggleRows((href, info) => {
                        markMagnetDownloaded(href, info, { silent: true, skipPersist: true });
                    });
                    persistIgnoredState();
                    persistDownloadedState();
                    refreshGalleryPostedBadges(gidStr);

                    const statusButton = currentBlock?.querySelector('.eh-gallery-ignore-badge');
                    if (statusButton) {
                        updateGalleryIgnoreButtonState(statusButton, galleryInfo.gid);
                    }
                    
                    // 标记画廊后，取消所有该画廊行的复选框勾选
                    magnetRows.forEach((row) => {
                        const checkbox = row.querySelector('.eh-magnet-checkbox');
                        if (checkbox && checkbox.checked) {
                            checkbox.checked = false;
                            const magnetKey = row.dataset.magnetValue
                                || row.dataset.archiveKey
                                || checkbox?.dataset.magnetValue
                                || checkbox?.dataset.archiveKey
                                || '';
                            if (magnetKey) {
                                selectedMagnets.delete(magnetKey);
                            }
                        }
                    });
                    if (gidStr) {
                        selectedGalleries.delete(gidStr);
                    }
                    rebuildSelectionSets();
                    updateSelectToggleState();
                }

                updateStatusFlags();
                menu.remove();
            });

            const isIgnored = isGalleryIgnored(effectiveInfo);
            const ignoreItem = document.createElement('div');
            ignoreItem.style.padding = '6px 14px';
            ignoreItem.style.cursor = 'pointer';
            ignoreItem.style.fontSize = '13px';
            ignoreItem.style.fontWeight = '600';
            ignoreItem.style.textAlign = 'left';
            ignoreItem.innerHTML = isIgnored ? '&nbsp;✓&nbsp;&nbsp;取消忽略' : '🚫&nbsp;忽略此画廊';
            ignoreItem.title = isIgnored ? '取消忽略此画廊' : '忽略此画廊，不再显示';
            ignoreItem.addEventListener('mouseenter', () => {
                ignoreItem.style.background = hoverBg;
            });
            ignoreItem.addEventListener('mouseleave', () => {
                ignoreItem.style.background = '';
            });
            ignoreItem.addEventListener('click', (e) => {
                e.stopPropagation();

                const currentBlock = menuButton.closest('.gl5t');
                const currentlyIgnored = isGalleryIgnored(effectiveInfo);

                if (currentlyIgnored) {
                    unmarkGalleryIgnored(effectiveInfo);
                } else {
                    if (
                        downloadedGalleries.has(gidStr)
                        || galleryDownloadedMagnets.has(gidStr)
                    ) {
                        removeGalleryDownloadRecords(gidStr);
                        persistDownloadedState();
                    }
                    markGalleryIgnored(effectiveInfo);
                }

                refreshGalleryPostedBadges(gidStr);

                const statusButton = currentBlock?.querySelector('.eh-gallery-ignore-badge');
                if (statusButton) {
                    updateGalleryIgnoreButtonState(statusButton, galleryInfo.gid);
                }

                menu.remove();
            });

            const refreshItem = document.createElement('div');
            refreshItem.style.padding = '6px 14px';
            refreshItem.style.cursor = 'pointer';
            refreshItem.style.fontSize = '13px';
            refreshItem.style.fontWeight = '600';
            refreshItem.style.textAlign = 'left';
            refreshItem.textContent = '🔃 刷新此画廊';
            refreshItem.title = '刷新此画廊以获取最新种子信息';
            refreshItem.addEventListener('mouseenter', () => {
                refreshItem.style.background = hoverBg;
            });
            refreshItem.addEventListener('mouseleave', () => {
                refreshItem.style.background = '';
            });
            refreshItem.addEventListener('click', (e) => {
                e.stopPropagation();

                const torrentLink = block.querySelector('.gldown a[href*="gallerytorrents.php"]');
                if (torrentLink) {
                    console.log('[EhMagnet] 手动获取下载信息:', torrentLink.href);
                    injectMagnets(block, torrentLink.href, effectiveInfo, 100);
                } else {
                    toastWarn('该画廊没有种子链接');
                }

                menu.remove();
            });

            const refreshAllItem = document.createElement('div');
            refreshAllItem.style.padding = '6px 14px';
            refreshAllItem.style.cursor = 'pointer';
            refreshAllItem.style.fontSize = '13px';
            refreshAllItem.style.fontWeight = '600';
            refreshAllItem.style.textAlign = 'left';
            refreshAllItem.textContent = '🔄 刷新全部画廊';
            refreshAllItem.title = '刷新当前页面的所有画廊';
            refreshAllItem.addEventListener('mouseenter', () => {
                refreshAllItem.style.background = hoverBg;
            });
            refreshAllItem.addEventListener('mouseleave', () => {
                refreshAllItem.style.background = '';
            });
            refreshAllItem.addEventListener('click', (e) => {
                e.stopPropagation();

                console.log('[EhMagnet] 开始手动刷新所有画廊...');
                const allBlocks = document.querySelectorAll('.gl5t[data-eh-magnet-attached="1"]');
                let queuedCount = 0;
                allBlocks.forEach((candidate) => {
                    const candidateTorrent = candidate.querySelector('.gldown a[href*="gallerytorrents.php"]');
                    if (candidateTorrent && !magnetCache.has(getMagnetCacheKey(candidateTorrent.href))) {
                        const galleryContainer = candidate.closest('.gl1t');
                        const galleryLink = galleryContainer?.querySelector('.glname a[href*="/g/"]');
                        const parsedGalleryInfo = parseGalleryInfo(galleryLink?.href || '');
                        const parsedTitle = galleryContainer?.querySelector('.glname a')?.textContent?.trim() || '';
                        const localEnrichedInfo = parsedGalleryInfo ? { ...parsedGalleryInfo, title: parsedTitle } : null;
                        injectMagnets(candidate, candidateTorrent.href, localEnrichedInfo, 50);
                        queuedCount += 1;
                    }
                });
                if (queuedCount > 0) {
                    toastSuccess(`已添加 ${queuedCount} 个画廊到刷新队列`);
                } else {
                    toastInfo('所有画廊的下载信息均已准备就绪');
                }

                menu.remove();
            });

            const refreshForceItem = document.createElement('div');
            refreshForceItem.style.padding = '6px 14px';
            refreshForceItem.style.cursor = 'pointer';
            refreshForceItem.style.fontSize = '13px';
            refreshForceItem.style.fontWeight = '600';
            refreshForceItem.style.textAlign = 'left';
            refreshForceItem.textContent = '⚡ 强制刷新此画廊';
            refreshForceItem.title = '强制刷新，忽略缓存，立即获取最新信息';
            refreshForceItem.addEventListener('mouseenter', () => {
                refreshForceItem.style.background = hoverBg;
            });
            refreshForceItem.addEventListener('mouseleave', () => {
                refreshForceItem.style.background = '';
            });
            refreshForceItem.addEventListener('click', (e) => {
                e.stopPropagation();

                const torrentLink = block.querySelector('.gldown a[href*="gallerytorrents.php"]');
                if (torrentLink) {
                    injectMagnets(block, torrentLink.href, effectiveInfo, 120, {
                        forceNetwork: true,
                        forceRebuild: true,
                    });
                    toastInfo('已强制刷新当前画廊的下载信息', { duration: 3600 });
                } else {
                    toastWarn('该画廊没有种子链接');
                }

                menu.remove();
            });

            const refreshAllForceItem = document.createElement('div');
            refreshAllForceItem.style.padding = '6px 14px';
            refreshAllForceItem.style.cursor = 'pointer';
            refreshAllForceItem.style.fontSize = '13px';
            refreshAllForceItem.style.fontWeight = '600';
            refreshAllForceItem.style.textAlign = 'left';
            refreshAllForceItem.textContent = '⚡ 强制刷新全部画廊';
            refreshAllForceItem.title = '强制刷新所有画廊，忽略缓存';
            refreshAllForceItem.addEventListener('mouseenter', () => {
                refreshAllForceItem.style.background = hoverBg;
            });
            refreshAllForceItem.addEventListener('mouseleave', () => {
                refreshAllForceItem.style.background = '';
            });
            refreshAllForceItem.addEventListener('click', (e) => {
                e.stopPropagation();

                const allBlocks = document.querySelectorAll('.gl5t[data-eh-magnet-attached="1"]');
                let refreshedCount = 0;
                allBlocks.forEach((candidate) => {
                    const candidateTorrent = candidate.querySelector('.gldown a[href*="gallerytorrents.php"]');
                    if (!candidateTorrent) {
                        return;
                    }
                    const galleryContainer = candidate.closest('.gl1t');
                    const galleryLink = galleryContainer?.querySelector('.glname a[href*="/g/"]');
                    const parsedGalleryInfo = parseGalleryInfo(galleryLink?.href || '');
                    const parsedTitle = galleryContainer?.querySelector('.glname a')?.textContent?.trim() || '';
                    const localEnrichedInfo = parsedGalleryInfo ? { ...parsedGalleryInfo, title: parsedTitle } : null;
                    injectMagnets(candidate, candidateTorrent.href, localEnrichedInfo, 60, {
                        forceNetwork: true,
                        forceRebuild: true,
                    });
                    refreshedCount += 1;
                });

                if (refreshedCount > 0) {
                    toastInfo(`已强制刷新 ${refreshedCount} 个画廊的下载信息`, { duration: 3600 });
                } else {
                    toastWarn('未找到可刷新的画廊');
                }

                menu.remove();
            });

            const separator1 = document.createElement('div');
            separator1.style.height = '1px';
            separator1.style.background = '#e0e0e0';
            separator1.style.margin = '4px 0';

            const autoRefreshRow = document.createElement('div');
            autoRefreshRow.style.display = 'flex';
            autoRefreshRow.style.alignItems = 'center';
            autoRefreshRow.style.padding = '6px 14px';
            autoRefreshRow.style.fontSize = '13px';
            autoRefreshRow.style.fontWeight = '600';
            autoRefreshRow.style.cursor = 'pointer';
            autoRefreshRow.style.textAlign = 'left';
            autoRefreshRow.title = '页面加载时自动扫描并获取搜索结果中的种子磁链信息';
            autoRefreshRow.addEventListener('mouseenter', () => {
                autoRefreshRow.style.background = hoverBg;
            });
            autoRefreshRow.addEventListener('mouseleave', () => {
                autoRefreshRow.style.background = '';
            });
            const autoRefreshCheckbox = document.createElement('input');
            autoRefreshCheckbox.type = 'checkbox';
            autoRefreshCheckbox.checked = autoRefreshEnabled;
            autoRefreshCheckbox.style.marginRight = '8px';
            const autoRefreshLabel = document.createElement('span');
            autoRefreshLabel.textContent = '自动扫描种子';
            autoRefreshLabel.title = '页面加载时自动扫描并获取搜索结果中的种子磁链信息';
            autoRefreshRow.appendChild(autoRefreshCheckbox);
            autoRefreshRow.appendChild(autoRefreshLabel);
            const applyAutoRefreshSetting = () => {
                autoRefreshEnabled = autoRefreshCheckbox.checked;
                persistExcludePreference();
                console.log('[EhMagnet] 自动刷新已', autoRefreshEnabled ? '开启' : '关闭');

                if (autoRefreshEnabled) {
                    console.log('[EhMagnet] 重新扫描页面，加载未加载的画廊...');
                    const attachedBlocks = document.querySelectorAll('.gl5t[data-eh-magnet-attached="1"]');
                    attachedBlocks.forEach((candidate) => {
                        const candidateTorrent = candidate.querySelector('.gldown a[href*="gallerytorrents.php"]');
                        if (candidateTorrent && !magnetCache.has(getMagnetCacheKey(candidateTorrent.href))) {
                            const galleryContainer = candidate.closest('.gl1t');
                            const galleryLink = galleryContainer?.querySelector('.glname a[href*="/g/"]');
                            const parsedGalleryInfo = parseGalleryInfo(galleryLink?.href || '');
                            const parsedTitle = galleryContainer?.querySelector('.glname a')?.textContent?.trim() || '';
                            const localEnrichedInfo = parsedGalleryInfo ? { ...parsedGalleryInfo, title: parsedTitle } : null;
                            const inViewport = isInViewport(candidate);
                            const priority = inViewport ? 10 : 5;
                            console.log('[EhMagnet] 补充加载:', candidateTorrent.href);
                            injectMagnets(candidate, candidateTorrent.href, localEnrichedInfo, priority);
                        }
                    });
                }
            };

            autoRefreshCheckbox.addEventListener('change', (event) => {
                event.stopPropagation();
                applyAutoRefreshSetting();
            });

            autoRefreshRow.addEventListener('click', (e) => {
                if (e.target === autoRefreshCheckbox) {
                    return;
                }
                autoRefreshCheckbox.checked = !autoRefreshCheckbox.checked;
                applyAutoRefreshSetting();
            });

            const hoverRefreshRow = document.createElement('div');
            hoverRefreshRow.style.display = 'flex';
            hoverRefreshRow.style.alignItems = 'center';
            hoverRefreshRow.style.padding = '6px 14px';
            hoverRefreshRow.style.fontSize = '13px';
            hoverRefreshRow.style.fontWeight = '600';
            hoverRefreshRow.style.cursor = 'pointer';
            hoverRefreshRow.style.textAlign = 'left';
            hoverRefreshRow.title = '当鼠标悬停在搜索结果上时，自动刷新该画廊的种子磁链信息';
            hoverRefreshRow.addEventListener('mouseenter', () => {
                hoverRefreshRow.style.background = hoverBg;
            });
            hoverRefreshRow.addEventListener('mouseleave', () => {
                hoverRefreshRow.style.background = '';
            });
            const hoverRefreshCheckbox = document.createElement('input');
            hoverRefreshCheckbox.type = 'checkbox';
            hoverRefreshCheckbox.checked = hoverRefreshEnabled;
            hoverRefreshCheckbox.style.marginRight = '8px';
            const hoverRefreshLabel = document.createElement('span');
            hoverRefreshLabel.textContent = '鼠标悬停刷新种子信息';
            hoverRefreshLabel.title = '当鼠标悬停在搜索结果上时，自动刷新该画廊的种子磁链信息';
            hoverRefreshRow.appendChild(hoverRefreshCheckbox);
            hoverRefreshRow.appendChild(hoverRefreshLabel);
            const applyHoverRefreshSetting = () => {
                hoverRefreshEnabled = hoverRefreshCheckbox.checked;
                persistExcludePreference();
                console.log('[EhMagnet] 鼠标悬停刷新已', hoverRefreshEnabled ? '开启' : '关闭');
            };

            hoverRefreshCheckbox.addEventListener('change', (event) => {
                event.stopPropagation();
                applyHoverRefreshSetting();
            });

            hoverRefreshRow.addEventListener('click', (e) => {
                if (e.target === hoverRefreshCheckbox) {
                    return;
                }
                hoverRefreshCheckbox.checked = !hoverRefreshCheckbox.checked;
                applyHoverRefreshSetting();
            });

            const downloadCacheRow = document.createElement('div');
            downloadCacheRow.style.display = 'flex';
            downloadCacheRow.style.alignItems = 'center';
            downloadCacheRow.style.padding = '6px 14px';
            downloadCacheRow.style.fontSize = '13px';
            downloadCacheRow.style.fontWeight = '600';
            downloadCacheRow.style.cursor = 'pointer';
            downloadCacheRow.style.textAlign = 'left';
            downloadCacheRow.title = '启用后，将缓存获取到的种子磁链信息，避免重复请求。达到超时时间后自动清除缓存';
            const downloadCacheCheckbox = document.createElement('input');
            downloadCacheCheckbox.type = 'checkbox';
            downloadCacheCheckbox.dataset.setting = 'download-cache';
            downloadCacheCheckbox.checked = downloadCacheEnabled;
            downloadCacheCheckbox.style.marginRight = '8px';
            const downloadCacheLabel = document.createElement('span');
            downloadCacheLabel.textContent = '缓存种子信息';
            downloadCacheLabel.title = '启用后，将缓存获取到的种子磁链信息，避免重复请求。达到超时时间后自动清除缓存';
            downloadCacheRow.appendChild(downloadCacheCheckbox);
            downloadCacheRow.appendChild(downloadCacheLabel);
            const applyDownloadCacheSetting = () => {
                downloadCacheEnabled = downloadCacheCheckbox.checked;
                if (downloadCacheEnabled) {
                    loadDownloadInfoCache(true);
                }
                persistExcludePreference();
                syncSettingsMenuControls();
                if (downloadCacheEnabled) {
                    applyDownloadCacheToVisibleGalleries({ forceRebuild: true });
                }
                console.log('[EhMagnet] 下载信息缓存已', downloadCacheEnabled ? '开启' : '关闭');
            };

            downloadCacheCheckbox.addEventListener('change', (event) => {
                event.stopPropagation();
                applyDownloadCacheSetting();
            });

            downloadCacheRow.addEventListener('click', (e) => {
                if (e.target === downloadCacheCheckbox) {
                    return;
                }
                downloadCacheCheckbox.checked = !downloadCacheCheckbox.checked;
                applyDownloadCacheSetting();
            });

            const downloadCacheTimeoutRow = document.createElement('div');
            downloadCacheTimeoutRow.style.display = 'flex';
            downloadCacheTimeoutRow.style.alignItems = 'center';
            downloadCacheTimeoutRow.style.padding = '4px 14px 6px';
            downloadCacheTimeoutRow.style.paddingLeft = '32px';
            downloadCacheTimeoutRow.style.gap = '8px';
            downloadCacheTimeoutRow.style.fontSize = '12px';
            downloadCacheTimeoutRow.style.textAlign = 'left';
            downloadCacheTimeoutRow.title = '种子信息缓存的有效期。超过这个时间后，缓存的信息会被清除，下次访问时会重新获取';
            const downloadCacheTimeoutLabel = document.createElement('span');
            downloadCacheTimeoutLabel.textContent = '缓存超时(分钟):';
            downloadCacheTimeoutLabel.title = '种子信息缓存的有效期。超过这个时间后，缓存的信息会被清除，下次访问时会重新获取';
            const downloadCacheTimeoutInput = document.createElement('input');
            downloadCacheTimeoutInput.type = 'number';
            downloadCacheTimeoutInput.min = '1';
            downloadCacheTimeoutInput.max = '1440';
            downloadCacheTimeoutInput.step = '1';
            downloadCacheTimeoutInput.dataset.setting = 'download-cache-timeout';
            downloadCacheTimeoutInput.value = downloadCacheTimeoutMinutes;
            downloadCacheTimeoutInput.style.width = '64px';
            downloadCacheTimeoutInput.style.padding = '2px 6px';
            downloadCacheTimeoutInput.style.border = '1px solid #ccc';
            downloadCacheTimeoutInput.style.borderRadius = '3px';
            downloadCacheTimeoutInput.disabled = !downloadCacheEnabled;
            downloadCacheTimeoutInput.addEventListener('change', () => {
                let value = parseInt(downloadCacheTimeoutInput.value, 10);
                if (!Number.isFinite(value) || value < 1) {
                    value = DEFAULT_DOWNLOAD_CACHE_TIMEOUT_MINUTES;
                }
                downloadCacheTimeoutMinutes = value;
                downloadCacheTimeoutInput.value = downloadCacheTimeoutMinutes;
                persistExcludePreference();
                loadDownloadInfoCache(true);
            });
            downloadCacheTimeoutRow.appendChild(downloadCacheTimeoutLabel);
            downloadCacheTimeoutRow.appendChild(downloadCacheTimeoutInput);

            const concurrentRow = document.createElement('div');
            concurrentRow.style.display = 'flex';
            concurrentRow.style.alignItems = 'center';
            concurrentRow.style.gap = '8px';
            concurrentRow.style.padding = '6px 14px';
            concurrentRow.style.fontSize = '13px';
            concurrentRow.style.fontWeight = '600';
            concurrentRow.style.textAlign = 'left';
            concurrentRow.title = '控制批量操作中同时进行的请求数。值越大越快，但容易导致服务器限流。建议设置为 3-5。';
            const concurrentLabel = document.createElement('span');
            concurrentLabel.textContent = '最大并发数:';
            concurrentLabel.style.flex = '1';
            concurrentLabel.title = '控制批量操作中同时进行的请求数。值越大越快，但容易导致服务器限流。建议设置为 3-5。';
            const concurrentInput = document.createElement('input');
            concurrentInput.type = 'number';
            concurrentInput.value = refreshConcurrent;
            concurrentInput.min = '1';
            concurrentInput.max = '10';
            concurrentInput.style.width = '60px';
            concurrentInput.style.padding = '2px 6px';
            concurrentInput.style.border = '1px solid #ccc';
            concurrentInput.style.borderRadius = '3px';
            concurrentInput.addEventListener('change', () => {
                const value = parseInt(concurrentInput.value) || 0;
                refreshConcurrent = Math.max(1, Math.min(10, value));
                concurrentInput.value = refreshConcurrent;
                magnetRequestQueue.maxConcurrent = refreshConcurrent;
                persistExcludePreference();
                console.log(`[EhMagnet] 刷新并发数: ${refreshConcurrent}`);
            });
            concurrentRow.appendChild(concurrentLabel);
            concurrentRow.appendChild(concurrentInput);

            const intervalMinRow = document.createElement('div');
            intervalMinRow.style.display = 'flex';
            intervalMinRow.style.alignItems = 'center';
            intervalMinRow.style.gap = '8px';
            intervalMinRow.style.padding = '6px 14px';
            intervalMinRow.style.fontSize = '13px';
            intervalMinRow.style.fontWeight = '600';
            intervalMinRow.style.textAlign = 'left';
            intervalMinRow.title = '相邻请求之间的最小延迟（毫秒）。用于防止被服务器限流。实际延迟会在最小值和最大值之间随机选择。';
            const intervalMinLabel = document.createElement('span');
            intervalMinLabel.textContent = '请求最小间隔(ms):';
            intervalMinLabel.style.flex = '1';
            intervalMinLabel.title = '相邻请求之间的最小延迟（毫秒）。用于防止被服务器限流。实际延迟会在最小值和最大值之间随机选择。';
            const intervalMinInput = document.createElement('input');
            intervalMinInput.type = 'number';
            intervalMinInput.value = refreshIntervalMin;
            intervalMinInput.min = '500';
            intervalMinInput.step = '100';
            intervalMinInput.style.width = '60px';
            intervalMinInput.style.padding = '2px 6px';
            intervalMinInput.style.border = '1px solid #ccc';
            intervalMinInput.style.borderRadius = '3px';
            intervalMinInput.addEventListener('change', () => {
                const value = parseInt(intervalMinInput.value) || 0;
                refreshIntervalMin = Math.max(500, value);
                intervalMinInput.value = refreshIntervalMin;
                if (refreshIntervalMax < refreshIntervalMin) {
                    refreshIntervalMax = refreshIntervalMin;
                }
                magnetRequestQueue.minIntervalRange = [refreshIntervalMin, refreshIntervalMax];
                persistExcludePreference();
                console.log(`[EhMagnet] 刷新间隔最小值(ms): ${refreshIntervalMin}`);
            });
            intervalMinRow.appendChild(intervalMinLabel);
            intervalMinRow.appendChild(intervalMinInput);

            const intervalMaxRow = document.createElement('div');
            intervalMaxRow.style.display = 'flex';
            intervalMaxRow.style.alignItems = 'center';
            intervalMaxRow.style.gap = '8px';
            intervalMaxRow.style.padding = '6px 14px';
            intervalMaxRow.style.fontSize = '13px';
            intervalMaxRow.style.fontWeight = '600';
            intervalMaxRow.style.textAlign = 'left';
            intervalMaxRow.title = '相邻请求之间的最大延迟（毫秒）。实际延迟会在最小值和最大值之间随机选择，避免规律性请求被检测。';
            const intervalMaxLabel = document.createElement('span');
            intervalMaxLabel.textContent = '请求最大间隔(ms):';
            intervalMaxLabel.style.flex = '1';
            intervalMaxLabel.title = '相邻请求之间的最大延迟（毫秒）。实际延迟会在最小值和最大值之间随机选择，避免规律性请求被检测。';
            const intervalMaxInput = document.createElement('input');
            intervalMaxInput.type = 'number';
            intervalMaxInput.value = refreshIntervalMax;
            intervalMaxInput.min = '500';
            intervalMaxInput.step = '100';
            intervalMaxInput.style.width = '60px';
            intervalMaxInput.style.padding = '2px 6px';
            intervalMaxInput.style.border = '1px solid #ccc';
            intervalMaxInput.style.borderRadius = '3px';
            intervalMaxInput.addEventListener('change', () => {
                const value = parseInt(intervalMaxInput.value) || 0;
                refreshIntervalMax = Math.max(refreshIntervalMin, value);
                intervalMaxInput.value = refreshIntervalMax;
                magnetRequestQueue.minIntervalRange = [refreshIntervalMin, refreshIntervalMax];
                persistExcludePreference();
                console.log(`[EhMagnet] 刷新间隔最大值(ms): ${refreshIntervalMax}`);
            });
            intervalMaxRow.appendChild(intervalMaxLabel);
            intervalMaxRow.appendChild(intervalMaxInput);

            const downloadSettingsRow = document.createElement('div');
            downloadSettingsRow.style.display = 'flex';
            downloadSettingsRow.style.alignItems = 'center';
            downloadSettingsRow.style.padding = '6px 14px';
            downloadSettingsRow.style.fontSize = '13px';
            downloadSettingsRow.style.fontWeight = '600';
            downloadSettingsRow.style.cursor = 'pointer';
            downloadSettingsRow.style.textAlign = 'left';
            const downloadSettingsLabel = document.createElement('span');
            downloadSettingsLabel.textContent = '🔧 网络操作设置';
            downloadSettingsLabel.style.flex = '0';
            downloadSettingsLabel.title = '配置所有批量操作（查询、下载、验证等）的并发数和请求间隔';
            const downloadSettingsArrow = document.createElement('span');
            downloadSettingsArrow.textContent = '▸';
            downloadSettingsArrow.style.fontSize = '12px';
            downloadSettingsArrow.style.marginLeft = '8px';
            downloadSettingsRow.appendChild(downloadSettingsLabel);
            downloadSettingsRow.appendChild(downloadSettingsArrow);

            const downloadSettingsWrapper = document.createElement('div');
            downloadSettingsWrapper.style.display = 'none';
            downloadSettingsWrapper.style.flexDirection = 'column';
            downloadSettingsWrapper.style.gap = '0';
            downloadSettingsWrapper.style.padding = '4px 12px 10px';
            downloadSettingsWrapper.style.margin = '4px 6px 0';
            downloadSettingsWrapper.style.background = 'rgba(255,255,255,0.04)';
            downloadSettingsWrapper.style.borderRadius = '6px';
            downloadSettingsWrapper.style.border = '1px solid rgba(255,255,255,0.08)';
            downloadSettingsWrapper.style.maxHeight = '60vh';
            downloadSettingsWrapper.style.overflowY = 'auto';
            downloadSettingsWrapper.style.width = 'calc(100% - 12px)';

            // 种子信息相关设置
            downloadSettingsWrapper.appendChild(autoRefreshRow);
            downloadSettingsWrapper.appendChild(hoverRefreshRow);
            downloadSettingsWrapper.appendChild(downloadCacheRow);
            downloadSettingsWrapper.appendChild(downloadCacheTimeoutRow);

            const submenuSeparator1 = document.createElement('div');
            submenuSeparator1.style.height = '1px';
            submenuSeparator1.style.background = '#e0e0e0';
            submenuSeparator1.style.opacity = '0.18';
            submenuSeparator1.style.margin = '6px 0';
            downloadSettingsWrapper.appendChild(submenuSeparator1);

            // 批量操作相关设置
            downloadSettingsWrapper.appendChild(concurrentRow);
            downloadSettingsWrapper.appendChild(intervalMinRow);
            downloadSettingsWrapper.appendChild(intervalMaxRow);

            let downloadSettingsHideTimer = null;

            const showDownloadSettings = () => {
                if (downloadSettingsHideTimer) {
                    clearTimeout(downloadSettingsHideTimer);
                    downloadSettingsHideTimer = null;
                }
                downloadSettingsWrapper.style.display = 'flex';
                downloadSettingsArrow.textContent = '▾';
                downloadSettingsRow.style.background = hoverBg;
            };

            const hideDownloadSettings = () => {
                downloadSettingsWrapper.style.display = 'none';
                downloadSettingsArrow.textContent = '▸';
                downloadSettingsRow.style.background = '';
            };

            const scheduleDownloadSettingsHide = () => {
                if (downloadSettingsHideTimer) {
                    clearTimeout(downloadSettingsHideTimer);
                }
                downloadSettingsHideTimer = setTimeout(() => {
                    hideDownloadSettings();
                    downloadSettingsHideTimer = null;
                }, 160);
            };

            downloadSettingsRow.addEventListener('mouseenter', () => {
                showDownloadSettings();
            });
            downloadSettingsRow.addEventListener('mouseleave', (event) => {
                const related = event.relatedTarget;
                if (related && (downloadSettingsRow.contains(related) || downloadSettingsWrapper.contains(related))) {
                    return;
                }
                scheduleDownloadSettingsHide();
            });
            downloadSettingsRow.addEventListener('click', (event) => {
                event.stopPropagation();
                if (downloadSettingsWrapper.style.display === 'none') {
                    showDownloadSettings();
                } else {
                    hideDownloadSettings();
                }
            });

            downloadSettingsWrapper.addEventListener('mouseenter', () => {
                if (downloadSettingsHideTimer) {
                    clearTimeout(downloadSettingsHideTimer);
                    downloadSettingsHideTimer = null;
                }
                downloadSettingsRow.style.background = hoverBg;
            });
            downloadSettingsWrapper.addEventListener('mouseleave', (event) => {
                const related = event.relatedTarget;
                if (related && (downloadSettingsRow.contains(related) || downloadSettingsWrapper.contains(related))) {
                    return;
                }
                scheduleDownloadSettingsHide();
            });

            const keepDownloadSettingsOpen = (event) => {
                event.stopPropagation();
                if (downloadSettingsHideTimer) {
                    clearTimeout(downloadSettingsHideTimer);
                    downloadSettingsHideTimer = null;
                }
            };

            [
                autoRefreshCheckbox,
                hoverRefreshCheckbox,
                downloadCacheCheckbox,
                downloadCacheTimeoutInput,
                concurrentInput,
                intervalMinInput,
                intervalMaxInput,
            ].forEach((input) => {
                if (!input) return;
                input.addEventListener('click', keepDownloadSettingsOpen);
                input.addEventListener('change', keepDownloadSettingsOpen);
            });

            downloadSettingsWrapper.querySelectorAll('div').forEach((row) => {
                row.addEventListener('click', keepDownloadSettingsOpen);
            });

            // 单画廊操作组
            menu.appendChild(markItem);
            menu.appendChild(ignoreItem);
            menu.appendChild(refreshItem);
            menu.appendChild(refreshForceItem);
            
            // 分隔线
            const separatorLine1 = document.createElement('div');
            separatorLine1.style.height = '1px';
            separatorLine1.style.backgroundColor = '#999';
            separatorLine1.style.margin = '4px 0';
            menu.appendChild(separatorLine1);
            
            // 全局操作组
            menu.appendChild(refreshAllItem);
            menu.appendChild(refreshAllForceItem);
            
            // 分隔线
            const separatorLine2 = document.createElement('div');
            separatorLine2.style.height = '1px';
            separatorLine2.style.backgroundColor = '#999';
            separatorLine2.style.margin = '4px 0';
            menu.appendChild(separatorLine2);
            
            // 其他功能
            menu.appendChild(abdmItem);
            menu.appendChild(separator1);
            menu.appendChild(downloadSettingsRow);
            menu.appendChild(downloadSettingsWrapper);

            return menu;
        };

        menuButton.addEventListener('click', (e) => {
            e.stopPropagation();

            document.querySelectorAll('.eh-gallery-action-menu').forEach((m) => m.remove());

            const menu = createMenu();
            menuButton.appendChild(menu);

            const closeMenu = (ev) => {
                if (!menuButton.contains(ev.target)) {
                    menu.remove();
                    document.removeEventListener('click', closeMenu);
                }
            };
            setTimeout(() => {
                document.addEventListener('click', closeMenu);
            }, 0);
        });

        ignoreButton.parentElement.insertBefore(menuButton, ignoreButton);
    };

    let ignoreToggleButton = null;
    let ignoreToggleButtonBottom = null;
    let moreActionsButtonTop = null;
    let moreActionsButtonBottom = null;
    let settingsButtonTop = null;
    let settingsButtonBottom = null;
    let selectionSummaryTop = null;
    let selectionSummaryBottom = null;
    let selectionIncludeDownloadedToggle = null;
    let selectionIncludeIgnoredToggle = null;
    let selectionIncludeNoSeedsToggle = null;
    let selectionIncludeOutdatedToggle = null;
    let settingsMenu = null;
    let recentOverlay = null;
    let recentDialog = null;

    const syncSelectionMenuToggles = () => {
        if (selectionIncludeDownloadedToggle) {
            // 勾选表示"包含"，所以 checked = !exclude
            selectionIncludeDownloadedToggle.checked = !excludeDownloadedOnSelect;
        }
        if (selectionIncludeIgnoredToggle) {
            selectionIncludeIgnoredToggle.checked = !excludeIgnoredOnSelect;
        }
        if (selectionIncludeNoSeedsToggle) {
            selectionIncludeNoSeedsToggle.checked = !excludeNoSeedsOnSelect;
        }
        if (selectionIncludeOutdatedToggle) {
            selectionIncludeOutdatedToggle.checked = !excludeOutdatedOnSelect;
        }
    };

    const syncSettingsMenuControls = () => {
        if (!settingsMenu || !settingsMenu.isConnected) return;
        const logCheckbox = settingsMenu.querySelector('input[data-setting="enable-log"]');
        if (logCheckbox) logCheckbox.checked = enableDebugLog;
        const infiniteCheckbox = settingsMenu.querySelector('input[data-setting="search-infinite-scroll"]');
        if (infiniteCheckbox) infiniteCheckbox.checked = enableSearchInfiniteScroll;
        const downloadCacheCheckbox = settingsMenu.querySelector('input[data-setting="download-cache"]');
        if (downloadCacheCheckbox) downloadCacheCheckbox.checked = downloadCacheEnabled;
        const downloadCacheTimeoutInput = settingsMenu.querySelector('input[data-setting="download-cache-timeout"]');
        if (downloadCacheTimeoutInput) {
            downloadCacheTimeoutInput.value = downloadCacheTimeoutMinutes;
            downloadCacheTimeoutInput.disabled = !downloadCacheEnabled;
        }
        syncSelectionMenuToggles();
    };

    const RECENT_BATCH_STORAGE_KEY = 'eh_magnet_recent_batches';
    const RECENT_BATCH_LIMIT_KEY = 'eh_magnet_recent_batch_limit';
    const DEFAULT_RECENT_BATCH_LIMIT = 100;
    let recentBatchLimit = DEFAULT_RECENT_BATCH_LIMIT;

    const normalizeRecentEntry = (entry) => {
        if (!entry || typeof entry !== 'object') return null;
        return {
            magnet: entry.magnet || '',
            archiveKey: entry.archiveKey || '',
            archiveDltype: entry.archiveDltype || '',
            isArchive: Boolean(entry.isArchive),
            torrentHref: entry.torrentHref || '',
            downloadUrl: entry.downloadUrl || '', // 保留实际下载链接
            name: entry.name || '',
            size: entry.size || '',
            postedTime: entry.postedTime || '',
            uploader: entry.uploader || '',
            gallery: entry.gallery && typeof entry.gallery === 'object'
                ? {
                    gid: entry.gallery.gid || '',
                    href: entry.gallery.href || '',
                    token: entry.gallery.token || '',
                }
                : null,
        };
    };

    const normalizeRecentBatch = (batch) => {
        if (!batch || typeof batch !== 'object') return null;
        const now = Date.now();
        let timestamp = Number(batch.timestamp);
        if (!Number.isFinite(timestamp)) timestamp = now;
        const maxFuture = now + (5 * 60 * 1000);
        if (timestamp > maxFuture || timestamp < 0) timestamp = now;
        let operationText = '';
        if (typeof batch.operationText === 'string' && batch.operationText.trim()) {
            operationText = batch.operationText.trim();
        } else {
            operationText = formatOperationTime(new Date(timestamp));
        }
        const entries = Array.isArray(batch.entries)
            ? batch.entries.map((entry) => normalizeRecentEntry(entry)).filter(Boolean)
            : [];
        return {
            id: batch.id || `${timestamp}-${Math.random().toString(16).slice(2, 8)}`,
            timestamp,
            operationText,
            source: batch.source || '搜索页',
            entries,
        };
    };

    const clampRecentBatchLimit = (value) => {
        const number = Number(value);
        if (!Number.isFinite(number)) return DEFAULT_RECENT_BATCH_LIMIT;
        return Math.min(999, Math.max(1, Math.trunc(number)));
    };

    const loadRecentBatchLimit = () => {
        const stored = Number(localStorage.getItem(RECENT_BATCH_LIMIT_KEY));
        if (Number.isFinite(stored)) {
            recentBatchLimit = clampRecentBatchLimit(stored);
        } else {
            recentBatchLimit = DEFAULT_RECENT_BATCH_LIMIT;
        }
    };

    const persistRecentBatchLimit = (value) => {
        try {
            localStorage.setItem(RECENT_BATCH_LIMIT_KEY, String(clampRecentBatchLimit(value)));
        } catch (err) {
            console.warn('保存最近下载记录上限失败', err);
        }
    };

    const loadRecentBatches = async () => {
        loadRecentBatchLimit();
        try {
            let batches = null;

            // 优先从IndexedDB读取
            if (idbSupported && idbDatabase) {
                try {
                    batches = await loadRecentBatchesFromIDB();
                    if (batches && batches.length > 0) {
                        console.log('[EhMagnet] 从IndexedDB加载最近下载记录成功');
                        return batches.slice(0, recentBatchLimit);
                    }
                } catch (err) {
                    console.warn('[EhMagnet] 从IndexedDB读取失败，尝试localStorage', err);
                }
            }

            // 降级：从localStorage读取
            const raw = localStorage.getItem(RECENT_BATCH_STORAGE_KEY);
            if (!raw) return [];
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) return [];
            const normalized = parsed
                .map((item) => normalizeRecentBatch(item))
                .filter((item) => item && item.entries && item.entries.length);
            if (normalized.length !== parsed.length) {
                await persistRecentBatches(normalized);
            }
            return normalized.slice(0, recentBatchLimit);
        } catch (err) {
            console.warn('[EhMagnet] 加载最近下载记录失败', err);
            return [];
        }
    };

    // 统一的画廊信息获取函数（同步版本，用于兼容旧代码）
    // 优先从缓存（最近下载）获取，缺失时实时抓取
    const queryFromRecentBatches = (gid) => {
        if (!gid) return null;
        const gidStr = String(gid);
        
        // 同步获取最后一次加载的批次（从localStorage或内存缓存）
        let batches = [];
        try {
            const raw = localStorage.getItem(RECENT_BATCH_STORAGE_KEY);
            if (raw) {
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed)) {
                    batches = parsed
                        .map((item) => normalizeRecentBatch(item))
                        .filter((item) => item && item.entries && item.entries.length);
                }
            }
        } catch (err) {
            console.warn('[EhMagnet] 同步查询最近下载失败', err);
        }
        
        for (const batch of batches) {
            for (const entry of batch.entries) {
                if (String(entry.gallery?.gid || '') === gidStr) {
                    return {
                        gid: entry.gallery.gid,
                        token: entry.gallery.token,
                        href: entry.gallery.href,
                        title: entry.name || '',
                        size: entry.size || '',
                        cost: entry.cost || '',
                        postedTime: entry.postedTime || '',
                        batchOperationText: batch.operationText || '',
                        archiveUrl: entry.archiveUrl || '',
                        archiveDltype: entry.archiveDltype || '',
                        source: 'cache'
                    };
                }
            }
        }
        
        return null;
    };

    // 实时抓取画廊归档信息（从画廊页面）
    const fetchGalleryArchiveInfo = async (gid, token) => {
        if (!gid || !token) return null;
        
        try {
            const galleryUrl = `https://e-hentai.org/g/${gid}/${token}/`;
            const response = await fetch(galleryUrl);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            
            const html = await response.text();
            const doc = new DOMParser().parseFromString(html, 'text/html');
            
            // 提取标题
            const titleEl = doc.querySelector('h1 a') || doc.querySelector('h1.gname');
            const title = titleEl?.textContent?.trim() || '未知';
            
            // 查找归档链接和费用信息
            let archiveUrl = '';
            let archiveDltype = 'org';
            let cost = '';
            
            const archiveLinks = Array.from(doc.querySelectorAll('a, div')).filter(el => {
                const text = el.textContent || '';
                return text.includes('ownload') || text.includes('rchive');
            });
            
            for (const el of archiveLinks) {
                const text = el.textContent || '';
                const href = el.getAttribute('href') || el.onclick?.toString?.() || '';
                
                // 查找原始版本链接
                if (text.includes('Original') && !archiveUrl) {
                    if (el.tagName === 'A') {
                        archiveUrl = el.getAttribute('href') || '';
                    }
                    archiveDltype = 'org';
                    // 查找费用
                    const costMatch = text.match(/(\d+)\s*GP/);
                    if (costMatch) cost = costMatch[1];
                }
                
                // 查找重采样版本链接
                if (text.includes('Resample') && !href.includes('Original')) {
                    if (el.tagName === 'A') {
                        archiveUrl = el.getAttribute('href') || '';
                    }
                    archiveDltype = 'res';
                    const costMatch = text.match(/(\d+)\s*GP/);
                    if (costMatch) cost = costMatch[1];
                }
            }
            
            return {
                gid,
                token,
                href: galleryUrl,
                title,
                archiveUrl,
                archiveDltype: archiveUrl ? archiveDltype : '',
                cost,
                source: 'fetched'
            };
        } catch (err) {
            console.warn(`[EhMagnet] 抓取画廊 ${gid} 信息失败:`, err);
            return null;
        }
    };

    // 获取画廊归档信息（统一接口，支持缓存和实时抓取）
    const getGalleryArchiveInfo = async (gid, token, options = {}) => {
        const { preferCache = true, forceRefresh = false } = options;
        
        if (!gid || !token) return null;
        
        // 如果不强制刷新且优先使用缓存，先查询缓存
        if (!forceRefresh && preferCache) {
            const cached = queryFromRecentBatches(gid);
            if (cached && cached.archiveUrl) {
                return cached;
            }
        }
        
        // 实时抓取
        const fetched = await fetchGalleryArchiveInfo(gid, token);
        if (fetched) {
            return fetched;
        }
        
        // 降级：返回缓存（即使不完整）
        if (preferCache) {
            const cached = queryFromRecentBatches(gid);
            if (cached) {
                return { ...cached, incomplete: true };
            }
        }
        
        return null;
    };

    const persistRecentBatches = async (batches) => {
        try {
            const trimmed = Array.isArray(batches)
                ? batches
                    .map((batch) => normalizeRecentBatch(batch))
                    .filter((batch) => batch && batch.entries && batch.entries.length)
                    .slice(0, recentBatchLimit)
                : [];

            // 优先使用IndexedDB保存
            if (idbSupported && idbDatabase) {
                const idbSuccess = await saveRecentBatchesToIDB(trimmed);
                if (idbSuccess) {
                    console.log('[EhMagnet] 最近下载记录已保存到IndexedDB');
                    return;
                }
            }

            // 降级：使用localStorage
            console.log('[EhMagnet] 使用localStorage保存最近下载记录（IndexedDB不可用）');
            localStorage.setItem(RECENT_BATCH_STORAGE_KEY, JSON.stringify(trimmed));
        } catch (err) {
            console.warn('[EhMagnet] 保存最近下载记录失败', err);
        }
    };

    const formatBatchTimestamp = (timestamp) => {
        if (!timestamp) return '时间未知';
        const date = new Date(timestamp);
        if (Number.isNaN(date.getTime())) return '时间未知';
        const pad = (value) => String(value).padStart(2, '0');
        const month = date.getMonth() + 1;
        const day = date.getDate();
        const hours = date.getHours();
        const minutes = String(date.getMinutes()).padStart(2, '0');
        // 使用简短格式：MM-DD HH:mm
        return `${pad(month)}-${pad(day)} ${hours}:${minutes}`;
    };

    const formatOperationTime = (date) => {
        if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
            return formatBatchTimestamp(Date.now());
        }
        const pad = (value) => String(value).padStart(2, '0');
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    };

    const createBatchEntry = (entries, context = {}) => {
        const baseDate = Number.isFinite(context.timestamp) ? new Date(context.timestamp) : new Date();
        const now = Date.now();
        let timestamp = baseDate.getTime();
        if (!Number.isFinite(timestamp)) timestamp = now;
        const maxFuture = now + (5 * 60 * 1000);
        if (timestamp > maxFuture || timestamp < 0) timestamp = now;
        let operationText = context.operationText;
        if (!operationText || typeof operationText !== 'string' || !operationText.trim()) {
            operationText = formatOperationTime(new Date(timestamp));
        }
        return {
            id: `${timestamp}-${Math.random().toString(16).slice(2, 8)}`,
            timestamp,
            operationText,
            source: context.source || '搜索页',
            entries: entries.map((entry) => ({
                magnet: entry.magnet || '',
                archiveKey: entry.archiveKey || '',
                archiveDltype: entry.archiveDltype || '',
                isArchive: Boolean(entry.isArchive),
                torrentHref: entry.torrentHref || '',
                downloadUrl: entry.downloadUrl || '', // 保存实际下载链接
                name: entry.name || '',
                size: entry.size || '',
                postedTime: entry.postedTime || '',
                uploader: entry.uploader || '',
                gallery: entry.gallery || null,
            })),
        };
    };

    const appendRecentBatch = (batch) => {
        if (!batch || !batch.entries || !batch.entries.length) return;
        
        // 异步处理IndexedDB保存，但同时立即从localStorage加载
        (async () => {
            try {
                const batches = await loadRecentBatches();
                const normalized = { ...batch };
                if (!Number.isFinite(normalized.timestamp)) {
                    normalized.timestamp = Date.now();
                }
                const updated = [normalized, ...batches].slice(0, recentBatchLimit);
                await persistRecentBatches(updated);
            } catch (err) {
                console.warn('[EhMagnet] appendRecentBatch异步保存失败:', err);
            }
        })();
    };

    const ensureRecentDialog = () => {
        if (recentOverlay && document.body.contains(recentOverlay)) return { overlay: recentOverlay, dialog: recentDialog };

        recentOverlay = document.createElement('div');
        recentOverlay.className = 'eh-recent-downloads-overlay';
        recentOverlay.dataset.visible = 'false';

        recentDialog = document.createElement('div');
        recentDialog.className = 'eh-recent-downloads-dialog';

        const header = document.createElement('div');
        header.className = 'eh-recent-downloads-header';
        const title = document.createElement('span');
        title.textContent = '最近下载';
        const closeButton = document.createElement('button');
        closeButton.type = 'button';
        closeButton.className = 'eh-recent-downloads-close';
        closeButton.textContent = '×';
        closeButton.addEventListener('click', () => hideRecentDialog());
        header.appendChild(title);
        header.appendChild(closeButton);

        const actions = document.createElement('div');
        actions.className = 'eh-recent-downloads-actions';

        const exportAllButton = document.createElement('button');
        exportAllButton.type = 'button';
        exportAllButton.textContent = '导出全部 CSV';
        exportAllButton.addEventListener('click', async () => await exportBatchesToCsv());

        const exportAllSelectionButton = document.createElement('button');
        exportAllSelectionButton.type = 'button';
        exportAllSelectionButton.textContent = '导出全部选择到剪贴板';
        exportAllSelectionButton.addEventListener('click', () => exportAllRecentSelectionToClipboard());

        const clearButton = document.createElement('button');
        clearButton.type = 'button';
        clearButton.textContent = '清空记录';
        clearButton.addEventListener('click', async () => {
            if (window.confirm('确认清空全部最近下载记录？')) {
                await persistRecentBatches([]);
                await renderRecentDialogBody();
            }
        });

        actions.appendChild(exportAllButton);
        actions.appendChild(exportAllSelectionButton);
        actions.appendChild(clearButton);

        const body = document.createElement('div');
        body.className = 'eh-recent-downloads-body';
        body.dataset.role = 'recent-body';

        recentDialog.appendChild(header);
        recentDialog.appendChild(actions);
        recentDialog.appendChild(body);

        recentOverlay.appendChild(recentDialog);
        recentOverlay.addEventListener('click', (event) => {
            if (event.target === recentOverlay) hideRecentDialog();
        });

        document.body.appendChild(recentOverlay);
        return { overlay: recentOverlay, dialog: recentDialog };
    };

    const hideRecentDialog = () => {
        if (!recentOverlay) return;
        recentOverlay.dataset.visible = 'false';
    };

    const buildBatchCsv = (batch) => {
        if (!batch || !batch.entries || !batch.entries.length) return '';
        const header = ['操作时间', '来源', '名称', '体积', '下载链接', '画廊 GID', '画廊链接', '上传时间', '上传者'];
        const rows = batch.entries.map((entry) => {
            const downloadLink = entry.downloadUrl || entry.magnet || '';
            return [
                batch.operationText || formatBatchTimestamp(batch.timestamp),
                batch.source || '',
                entry.name || '',
                entry.size || '',
                downloadLink, // 优先使用实际下载链接
                entry.gallery?.gid || '',
                entry.gallery?.href || '',
                entry.postedTime || '',
                entry.uploader || '',
            ];
        });
        return [header, ...rows]
            .map((line) => line.map((cell) => {
                const text = cell == null ? '' : String(cell);
                if (text.includes(',') || text.includes('"') || text.includes('\n')) {
                    return `"${text.replace(/"/g, '""')}"`;
                }
                return text;
            }).join(','))
            .join('\n');
    };

    const downloadCsv = (filename, csvContent) => {
        if (!csvContent) {
            toastWarn('没有可导出的数据');
            return;
        }
        const BOM = '\uFEFF';
        const blob = new Blob([BOM + csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    };

    const exportBatchToCsv = (batch) => {
        if (!batch) return;
        const csvContent = buildBatchCsv(batch);
        downloadCsv(`eh-download-${batch.id}.csv`, csvContent);
    };

    const exportBatchesToCsv = async () => {
        const batches = await loadRecentBatches();
        if (!batches || !batches.length) {
            toastWarn('没有可导出的记录');
            return;
        }
        const header = ['操作时间', '来源', '名称', '体积', '下载链接', '画廊 GID', '画廊链接', '上传时间', '上传者'];
        const rows = batches.flatMap((batch) => batch.entries.map((entry) => [
            batch.operationText || formatBatchTimestamp(batch.timestamp),
            batch.source || '',
            entry.name || '',
            entry.size || '',
            entry.downloadUrl || entry.magnet || '', // 优先使用实际下载链接
            entry.gallery?.gid || '',
            entry.gallery?.href || '',
            entry.postedTime || '',
            entry.uploader || '',
        ]));
        const csvContent = [header, ...rows]
            .map((line) => line.map((cell) => {
                const text = cell == null ? '' : String(cell);
                if (text.includes(',') || text.includes('"') || text.includes('\n')) {
                    return `"${text.replace(/"/g, '""')}"`;
                }
                return text;
            }).join(','))
            .join('\n');
        downloadCsv('eh-download-all.csv', csvContent);
    };

    const renderRecentDialogBody = async () => {
        const { overlay } = ensureRecentDialog();
        const body = overlay.querySelector('[data-role="recent-body"]');
        if (!body) return;
        body.innerHTML = '';
        const batches = await loadRecentBatches();
        if (!batches || !batches.length) {
            const empty = document.createElement('div');
            empty.className = 'eh-recent-downloads-empty';
            empty.textContent = '暂无记录';
            body.appendChild(empty);
            return;
        }

        const truncateMiddle = (text, maxLen = 90) => {
            // 对于 URL，优先保留完整的关键标识符（如 hash、GID 等）
            if (!text || text.length <= maxLen) return text;
            
            // 提取可能的关键标识符（hash、GID等）
            const hashMatch = text.match(/\/([a-f0-9]{40,64})(?:[/?]|$)/i);
            const gidMatch = text.match(/\b(\d{7,8})\b/);
            
            if (hashMatch) {
                // 如果找到 hash，确保完整显示 hash
                const hash = hashMatch[1];
                const hashStart = text.indexOf(hash);
                const hashEnd = hashStart + hash.length;
                
                // 如果整个 URL 加上 hash 都能显示，就全显示
                if (text.length <= maxLen + 10) return text;
                
                // 否则显示前缀 + ... + hash 部分
                const prefixLen = Math.max(20, Math.floor((maxLen - hash.length - 5) / 2));
                const suffixLen = Math.floor((maxLen - hash.length - 5) / 2);
                
                // 确保至少显示到 hash 开始前
                const prefix = text.slice(0, Math.min(prefixLen, hashStart));
                const suffix = text.slice(Math.max(hashEnd, text.length - suffixLen));
                
                return prefix.length > 0 && suffix.length > 0 
                    ? `${prefix}...${hash}...${suffix}`
                    : text.length <= maxLen + 20 ? text : `${text.slice(0, maxLen)}...`;
            }
            
            // 如果没有特殊标识符，使用原来的截断方式
            const keep = Math.max(5, Math.floor((maxLen - 3) / 2));
            return `${text.slice(0, keep)}...${text.slice(-keep)}`;
        };

        const summarizeBatchTypes = (entries = []) => {
            const summary = { magnet: 0, torrent: 0, archive: 0 };
            entries.forEach((entry) => {
                if (entry.isArchive || entry.archiveKey) {
                    summary.archive += 1;
                } else if (entry.torrentHref) {
                    summary.torrent += 1;
                } else {
                    summary.magnet += 1;
                }
            });
            return summary;
        };

        const formatTypeSummary = (entries = []) => {
            const summary = summarizeBatchTypes(entries);
            const parts = [];
            if (summary.magnet) parts.push(`磁链${summary.magnet}`);
            if (summary.torrent) parts.push(`种链${summary.torrent}`);
            if (summary.archive) parts.push(`归档${summary.archive}`);
            return parts.length ? parts.join(' | ') : `${entries.length} 条`;
        };

        // 按倒序排列批次，最新的在上面
        batches.reverse().forEach((batch) => {
            const batchEl = document.createElement('div');
            batchEl.className = 'eh-recent-batch';

            const header = document.createElement('div');
            header.className = 'eh-recent-batch-header';

            const meta = document.createElement('div');
            meta.className = 'eh-recent-batch-meta';
            const entryCount = batch.entries.length;
            const timeText = batch.timestamp ? formatBatchTimestamp(batch.timestamp) : '时间未知';
            const sourceText = batch.source || '未知来源';
            const typeSummary = formatTypeSummary(batch.entries);
            meta.textContent = `${timeText} · ${sourceText} · ${typeSummary}`;
            
            const headerActions = document.createElement('div');
            headerActions.className = 'eh-recent-batch-header-actions';
            const exportButton = document.createElement('button');
            exportButton.type = 'button';
            exportButton.textContent = '导出 CSV';
            exportButton.addEventListener('click', () => exportBatchToCsv(batch));
            headerActions.appendChild(exportButton);

            const exportSelectionButton = document.createElement('button');
            exportSelectionButton.type = 'button';
            exportSelectionButton.textContent = '导出选择到剪贴板';
            exportSelectionButton.addEventListener('click', () => exportRecentBatchSelectionToClipboard(batch));
            headerActions.appendChild(exportSelectionButton);

            header.appendChild(meta);
            header.appendChild(headerActions);

            const list = document.createElement('div');
            list.className = 'eh-recent-batch-items';
            batch.entries.forEach((entry) => {
                const item = document.createElement('div');
                item.className = 'eh-recent-batch-item';

                const infoBox = document.createElement('div');
                infoBox.className = 'eh-recent-batch-item-info';
                const name = document.createElement('span');
                name.className = 'eh-recent-batch-name';
                // 对于归档，name 应该是画廊标题，而不是 archiveKey
                const title = entry.name && entry.name !== entry.magnet 
                    ? entry.name 
                    : (entry.isArchive ? '归档下载' : (entry.magnet || '磁力链接'));
                name.textContent = title;
                // 悬浮提示完整文件名
                name.title = title;
                infoBox.appendChild(name);

                const metaLine = document.createElement('span');
                metaLine.className = 'eh-recent-batch-meta';
                const metaParts = [];
                if (entry.postedTime) metaParts.push(entry.postedTime);
                if (entry.size) metaParts.push(entry.size);
                if (entry.uploader) metaParts.push(entry.uploader);
                if (entry.gallery?.gid) metaParts.push(`GID:${entry.gallery.gid}`);
                if (entry.isArchive) metaParts.push('归档下载');
                metaLine.textContent = metaParts.join(' | ');
                infoBox.appendChild(metaLine);

                // 追加完整下载链接行，供溯源使用
                if (entry.downloadUrl || entry.magnet) {
                    const magnetLine = document.createElement('span');
                    magnetLine.className = 'eh-recent-batch-magnet';
                    const magnetType = entry.isArchive ? 'archive'
                        : (entry.torrentHref && entry.magnet === entry.torrentHref ? 'torrent' : 'magnet');
                    magnetLine.dataset.type = magnetType;
                    const displayUrl = entry.downloadUrl || entry.magnet;
                    // torrent 和 archive 链接显示完整 URL，由 CSS word-break 处理换行
                    // magnet 链接保持原有逻辑
                    magnetLine.textContent = displayUrl;
                    magnetLine.title = displayUrl;
                    infoBox.appendChild(magnetLine);
                }

                const actions = document.createElement('div');
                actions.className = 'eh-recent-batch-item-actions';
                const copyLink = document.createElement('a');
                const copyTarget = entry.downloadUrl || entry.magnet || '#';
                copyLink.href = copyTarget;
                copyLink.textContent = entry.isArchive ? '复制归档链接' : '复制';
                copyLink.addEventListener('click', (event) => {
                    event.preventDefault();
                    copyMagnet(copyTarget).catch(() => {
                        toastError('复制失败，请手动复制');
                    });
                });
                actions.appendChild(copyLink);
                if (entry.gallery?.href) {
                    const openLink = document.createElement('a');
                    openLink.href = entry.gallery.href;
                    openLink.textContent = '打开画廊';
                    openLink.target = '_blank';
                    openLink.rel = 'noopener noreferrer';
                    actions.appendChild(openLink);
                }

                item.appendChild(infoBox);
                item.appendChild(actions);
                list.appendChild(item);
            });

            batchEl.appendChild(header);
            batchEl.appendChild(list);
            body.appendChild(batchEl);
        });
    };

    const showRecentDialog = async () => {
        // 确保样式已经注入（包含"最近下载"的样式在 injectTooltipStyles 中）
        injectTooltipStyles();
        
        const { overlay } = ensureRecentDialog();
        await renderRecentDialogBody();
        
        // 确保对话框在DOM中
        if (!document.body.contains(overlay)) {
            document.body.appendChild(overlay);
        }
        
        // 强制重置定位样式，确保正确居中
        overlay.style.position = 'fixed';
        overlay.style.inset = '0';
        overlay.style.top = '0';
        overlay.style.left = '0';
        overlay.style.right = '0';
        overlay.style.bottom = '0';
        overlay.style.zIndex = '10050';
        
        // 强制重排，确保样式正确应用
        overlay.offsetHeight;
        
        // 显示对话框
        overlay.dataset.visible = 'true';
    };

    // 场景 A: 批量查询失败记录对话框
    let batchQueryDialog = null;

    // 获取用户账户资金信息（从 archive 页面爬取）
    const fetchUserFundInfo = async () => {
        try {
            // 需要访问任何一个画廊的 archive 页面来获取账户资金
            const recentBatches = await loadRecentBatches();
            let archiveUrl = null;
            
            // 找到第一个有效的 archive URL
            for (const batch of recentBatches) {
                for (const entry of batch.entries) {
                    if (entry.gallery?.gid && entry.gallery?.token) {
                        archiveUrl = `https://e-hentai.org/archiver.php?gid=${entry.gallery.gid}&token=${entry.gallery.token}`;
                        break;
                    }
                }
                if (archiveUrl) break;
            }
            
            if (!archiveUrl) {
                console.warn('找不到有效的 archive URL');
                return null;
            }
            
            const response = await fetch(archiveUrl, {
                method: 'GET',
                credentials: 'include',
            });
            
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            
            const html = await response.text();
            
            // 从 HTML 中提取 GP 和 Credits
            // 格式: "1,053,007 GP ... 1,064,495 Credits"
            const gpMatch = html.match(/([0-9,]+)\s+GP/);
            const creditsMatch = html.match(/([0-9,]+)\s+Credits/);
            
            if (!gpMatch || !creditsMatch) {
                console.warn('无法从 archive 页面提取资金信息');
                return null;
            }
            
            return {
                gp: gpMatch[1],
                credits: creditsMatch[1],
            };
        } catch (err) {
            console.warn('fetchUserFundInfo 出错:', err);
            return null;
        }
    };

    // 获取单个画廊的归档信息（大小、GP费用）
    const fetchArchiveInfo = async (gid, token) => {
        try {
            if (!gid || !token) {
                throw new Error('缺少 GID 或 token');
            }

            const archiveUrl = `https://e-hentai.org/archiver.php?gid=${gid}&token=${token}`;
            console.log(`[fetchArchiveInfo] 正在获取: ${archiveUrl}`);
            
            const response = await fetch(archiveUrl, {
                method: 'GET',
                credentials: 'include',
            });

            if (!response.ok) throw new Error(`HTTP ${response.status}`);

            const html = await response.text();
            console.log(`[fetchArchiveInfo] 获取到 ${html.length} 字节的内容`);

            // 检查是否是 HTML 页面（未生成好的情况）
            if (!(html.includes('<html') || html.includes('<!DOCTYPE'))) {
                throw new Error('获取到非 HTML 内容');
            }

            // 解析原图大小和费用
            let size = '未知';
            let cost = '未知';

            // 支持中文和英文页面
            // 中文: "预计大小：<strong>92.10 MiB</strong>"
            // 英文: "Estimated Size: &nbsp; <strong>92.10 MiB</strong>"
            let sizeMatch = html.match(/(预计大小|Estimated Size)[：:\s]*(?:&nbsp;)*\s*<strong>([^<]+)<\/strong>/);
            if (sizeMatch) {
                size = sizeMatch[2];
                console.log(`[fetchArchiveInfo] 找到大小: ${size}`);
            } else {
                console.log(`[fetchArchiveInfo] 未找到大小信息，尝试备用正则`);
                // 备用方法：直接查找 strong 标签中的 MiB
                const fallbackSize = html.match(/<strong>([\d.]+\s*MiB)<\/strong>[\s\S]*?<\/div>\s*<div style="width:180px; float:right">/);
                if (fallbackSize) {
                    size = fallbackSize[1];
                    console.log(`[fetchArchiveInfo] 备用方法找到大小: ${size}`);
                }
            }

            // 支持中文和英文的下载费用
            // 中文: "下载费用：<strong>1,449 GP</strong>"
            // 英文: "Download Cost: &nbsp; <strong>1,449 GP</strong>"
            // 注意：可能有多个下载类型（原图、重采样等），我们只要第一个
            const costMatch = html.match(/(下载费用|Download Cost)[：:\s]*(?:&nbsp;)*\s*<strong>([^<]+)<\/strong>/);
            if (costMatch) {
                cost = costMatch[2];
                console.log(`[fetchArchiveInfo] 找到费用: ${cost}`);
            } else {
                console.log(`[fetchArchiveInfo] 未找到费用信息，尝试备用正则`);
                // 备用方法：直接查找第一个 strong 标签中的 GP
                const fallbackCost = html.match(/<strong>([0-9,]+\s*GP)<\/strong>[\s\S]*?Download.*?Archive/);
                if (fallbackCost) {
                    cost = fallbackCost[1];
                    console.log(`[fetchArchiveInfo] 备用方法找到费用: ${cost}`);
                }
            }

            console.log(`[fetchArchiveInfo] 最终结果 - 大小: ${size}, 费用: ${cost}`);
            
            return {
                size,
                cost,
            };
        } catch (err) {
            console.warn(`[fetchArchiveInfo] GID ${gid} 出错:`, err);
            return null;
        }
    };

    const ensureBatchQueryDialog = () => {
        if (batchQueryDialog && document.body.contains(batchQueryDialog)) {
            return batchQueryDialog;
        }

        const dialog = document.createElement('div');
        dialog.className = 'eh-batch-query-dialog';
        dialog.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            z-index: 10051;
            background: #fff;
            border: 2px solid #5C0D12;
            border-radius: 4px;
            padding: 0;
            max-height: 90vh;
            width: 90%;
            max-width: 900px;
            display: flex;
            flex-direction: column;
            box-shadow: 0 4px 12px rgba(0,0,0,0.2);
        `;

        batchQueryDialog = dialog;
        return dialog;
    };

    const showBatchQueryDialog = async (options = {}) => {
        const { autoQuery = false, queryEntries = [] } = options;
        let isAutoClickingFetchAll = false; // 标志：当前是自动点击还是用户点击
        
        injectTooltipStyles();
        
        const dialog = ensureBatchQueryDialog();
        dialog.innerHTML = '';
        
        // 账户资金信息容器
        let fundInfoDiv = null;
        
        // 头部
        const header = document.createElement('div');
        header.style.cssText = `
            padding: 12px 16px;
            border-bottom: 1px solid #ddd;
            display: flex;
            justify-content: space-between;
            align-items: center;
            flex-shrink: 0;
        `;
        
        const titleArea = document.createElement('div');
        titleArea.style.cssText = `
            flex: 1;
        `;
        
        const title = document.createElement('div');
        title.textContent = autoQuery ? '查询所选画廊归档信息' : '批量查询/归档';
        title.style.cssText = `
            font-size: 14px;
            font-weight: 600;
            margin-bottom: 4px;
        `;
        titleArea.appendChild(title);
        
        fundInfoDiv = document.createElement('div');
        fundInfoDiv.style.cssText = `
            font-size: 11px;
            color: #999;
        `;
        fundInfoDiv.textContent = '现有资金: (点击"查询"后显示)';
        titleArea.appendChild(fundInfoDiv);
        
        header.appendChild(titleArea);
        
        const closeBtn = document.createElement('button');
        closeBtn.textContent = '✕';
        closeBtn.style.cssText = `
            background: none;
            border: none;
            cursor: pointer;
            font-size: 18px;
            color: #999;
            padding: 0 4px;
            flex-shrink: 0;
        `;
        closeBtn.addEventListener('click', () => {
            dialog.remove();
        });
        header.appendChild(closeBtn);
        dialog.appendChild(header);

        // 输入区域
        const inputArea = document.createElement('div');
        inputArea.style.cssText = `
            padding: 12px 16px;
            border-bottom: 1px solid #ddd;
            flex-shrink: 0;
            display: ${autoQuery ? 'contents' : 'block'};
        `;
        
        const label = document.createElement('div');
        label.textContent = '输入多行链接、GID或画廊URL（每行一个）：';
        label.style.cssText = `
            font-size: 12px;
            margin-bottom: 8px;
            font-weight: 600;
            display: ${autoQuery ? 'none' : 'block'};
        `;
        inputArea.appendChild(label);
        
        const textarea = document.createElement('textarea');
        textarea.placeholder = '粘贴链接或GID进行查询...\n支持格式：\n- 画廊URL: https://e-hentai.org/g/3694852/xxx/\n- GID: 3694852\n- 磁力链接: magnet:?xt=urn:btih:...\n- 种子链接: https://ehtracker.org/get/.../xxx.torrent';
        textarea.style.cssText = `
            width: 100%;
            height: 80px;
            border: 1px solid #ccc;
            border-radius: 3px;
            padding: 8px;
            font-family: monospace;
            font-size: 12px;
            resize: vertical;
            box-sizing: border-box;
            display: ${autoQuery ? 'none' : 'block'};
        `;
        inputArea.appendChild(textarea);
        
        // 按钮区域（不放在inputArea内，这样可以独立控制显示）
        const buttonArea = document.createElement('div');
        buttonArea.style.cssText = `
            padding: 8px 16px;
            border-bottom: 1px solid #ddd;
            display: flex;
            gap: 8px;
            flex-wrap: wrap;
            flex-shrink: 0;
        `;
        
        const queryBtn = document.createElement('button');
        queryBtn.textContent = '查询';
        queryBtn.style.cssText = `
            padding: 6px 12px;
            background: #5C0D12;
            color: white;
            border: none;
            border-radius: 3px;
            cursor: pointer;
            font-size: 12px;
            font-weight: 600;
            display: ${autoQuery ? 'none' : 'inline-block'};
        `;
        queryBtn.addEventListener('click', async () => await performBatchQuery());
        buttonArea.appendChild(queryBtn);
        
        const clearBtn = document.createElement('button');
        clearBtn.textContent = '清空';
        clearBtn.style.cssText = `
            padding: 6px 12px;
            background: #f0f0f0;
            color: #333;
            border: 1px solid #ccc;
            border-radius: 3px;
            cursor: pointer;
            font-size: 12px;
            display: ${autoQuery ? 'none' : 'inline-block'};
        `;
        clearBtn.addEventListener('click', () => {
            textarea.value = '';
            resultContainer.innerHTML = '';
        });
        buttonArea.appendChild(clearBtn);

        const fetchAllBtn = document.createElement('button');
        fetchAllBtn.textContent = '全部获取';
        fetchAllBtn.style.cssText = `
            padding: 6px 12px;
            background: #f0f0f0;
            color: #333;
            border: 1px solid #ccc;
            border-radius: 3px;
            cursor: pointer;
            font-size: 12px;
        `;
        fetchAllBtn.title = '获取所有记录的归档信息';
        
        fetchAllBtn.addEventListener('click', async () => {
            // 查找所有"获取"相关的按钮
            const allFetchButtons = Array.from(resultContainer.querySelectorAll('button')).filter(btn => 
                btn.title.includes('获取') || btn.title.includes('归档')
            );
            
            // 筛选出未禁用的按钮（可以点击的）
            const fetchButtons = allFetchButtons.filter(btn => !btn.disabled);
            
            if (allFetchButtons.length === 0) {
                // 没有任何查询结果
                if (!isAutoClickingFetchAll) {
                    toastWarn('请先查询记录');
                }
                return;
            }
            
            if (fetchButtons.length === 0) {
                // 有查询结果，但所有项都已获取，只在用户手动点击时提示
                if (!isAutoClickingFetchAll) {
                    toastWarn('所有项目已获取');
                }
                return;
            }
            fetchAllBtn.disabled = true;
            fetchAllBtn.textContent = `获取中(0/${fetchButtons.length})`;
            // 使用并发控制替代顺序点击
            // 构建任务数组，每个任务点击一个按钮并等待
            const fetchTasks = fetchButtons.map((btn) => async () => {
                if (!btn.disabled) {
                    // 先延迟后点击，避免过快
                    await new Promise(r => setTimeout(r, getRandomInterval()));
                    btn.click();
                }
            });
            
            // 执行并发获取
            await executeWithConcurrencyLimit(fetchTasks, null, (completed, total) => {
                fetchAllBtn.textContent = `获取中(${completed}/${total})`;
            });
            
            fetchAllBtn.disabled = false;
            fetchAllBtn.textContent = '全部获取';
            
            // "全部获取"完成后，重置自动点击标志
            if (isAutoClickingFetchAll === true) {
                isAutoClickingFetchAll = false;
            }
        });
        // 自动获取复选框
        const autoFetchContainer = document.createElement('div');
        autoFetchContainer.style.cssText = `
            display: flex;
            align-items: center;
            gap: 6px;
            font-size: 12px;
            color: #666;
            margin-left: auto;
        `;
        
        const autoFetchCheckbox = document.createElement('input');
        autoFetchCheckbox.type = 'checkbox';
        autoFetchCheckbox.id = 'autoFetchCheckbox';
        autoFetchCheckbox.checked = autoFetchBatchQuery; // 使用已保存的状态
        autoFetchCheckbox.style.cssText = `
            cursor: pointer;
        `;
        autoFetchCheckbox.addEventListener('change', () => {
            autoFetchBatchQuery = autoFetchCheckbox.checked;
            persistAutoFetchBatchQueryPreference();
        });
        
        const autoFetchLabel = document.createElement('label');
        autoFetchLabel.htmlFor = 'autoFetchCheckbox';
        autoFetchLabel.textContent = '自动获取归档信息';
        autoFetchLabel.style.cssText = `
            cursor: pointer;
            user-select: none;
        `;
        
        autoFetchContainer.appendChild(autoFetchCheckbox);
        autoFetchContainer.appendChild(autoFetchLabel);
        buttonArea.appendChild(autoFetchContainer);
        
        buttonArea.appendChild(fetchAllBtn);
        
        inputArea.appendChild(buttonArea);
        dialog.appendChild(inputArea);

        // 结果区域
        const resultContainer = document.createElement('div');
        resultContainer.style.cssText = `
            flex: 1;
            overflow-y: auto;
            padding: 12px 16px;
        `;
        dialog.appendChild(resultContainer);

        // 底部操作区域（批量导入等）
        const footerArea = document.createElement('div');
        footerArea.style.cssText = `
            padding: 12px 16px;
            border-top: 1px solid #ddd;
            display: flex;
            gap: 8px;
            flex-shrink: 0;
        `;
        
        const selectedCountSpan = document.createElement('span');
        selectedCountSpan.style.cssText = `
            font-size: 12px;
            color: #666;
            line-height: 32px;
        `;
        footerArea.appendChild(selectedCountSpan);
        
        // 【新增】说明文字 + 两个发送按钮
        const sendLabelSpan = document.createElement('span');
        sendLabelSpan.textContent = '发送所选到：';
        sendLabelSpan.style.cssText = `
            font-size: 12px;
            color: #666;
            line-height: 32px;
            margin-left: auto;
            margin-right: 4px;
        `;
        footerArea.appendChild(sendLabelSpan);
        
        // 【修复】统一按钮样式的基础CSS
        const buttonBaseStyle = `
            min-width: 60px;
            padding: 6px 12px;
            color: white;
            border: none;
            border-radius: 3px;
            cursor: pointer;
            font-size: 12px;
            font-weight: 600;
            text-align: center;
        `;
        
        // Aria2按钮（蓝色）
        const sendToAria2Btn = document.createElement('button');
        sendToAria2Btn.textContent = 'Aria2';
        sendToAria2Btn.style.cssText = buttonBaseStyle + `
            background: #1890FF;
        `;
        
        // 【新增】检测EhAria2是否可用并置灰
        const ariaAvailable = isAriaEhBridgeAvailable();
        const ariaConfigured = ariaAvailable && isAriaEhBridgeConfigured();
        if (!ariaAvailable || !ariaConfigured) {
            sendToAria2Btn.disabled = true;
            sendToAria2Btn.style.opacity = '0.5';
            sendToAria2Btn.style.cursor = 'not-allowed';
            if (!ariaAvailable) {
                sendToAria2Btn.title = 'EhAria2下载助手未安装或未加载';
            } else {
                sendToAria2Btn.title = 'EhAria2下载助手未配置';
            }
        }
        
        sendToAria2Btn.addEventListener('click', async () => {
            // 【修复】使用与AB DM相同的逻辑获取选中项
            const checkboxes = resultContainer.querySelectorAll('input[type="checkbox"]:checked:not([data-select-all])');
            if (checkboxes.length === 0) {
                toastWarn('请选择至少一条记录');
                return;
            }

            const selected = Array.from(checkboxes).map(cb => ({
                name: cb.parentElement.querySelector('div').textContent || '未知',
                archiveKey: cb.dataset.archiveKey,
                archiveDltype: cb.dataset.archiveDltype,
                gid: cb.dataset.gid,
                href: cb.dataset.href,
                token: cb.dataset.token,
                gallery: {
                    gid: cb.dataset.gid,
                    href: cb.dataset.href,
                    token: cb.dataset.token,
                },
            }));

            console.log('[查询归档] 发送所选到Aria2，已选项:', selected);

            // 打开预检对话框，然后发送到Aria2
            await showArchivePreCheckDialog(selected, async (readyItems) => {
                toastInfo(`开始获取 ${readyItems.length} 个画廊的真实下载链接...`);

                try {
                    // 获取Aria2 API实例
                    const api = getAriaEhAPI();
                    if (!api || typeof api.enqueueTasks !== 'function') {
                        toastError('EhAria2下载助手未加载');
                        return;
                    }

                    // 【关键】处理每个项，获取真实下载链接和文件名
                    // 这与AB DM的做法一致，确保获取到正确的链接和文件名
                    const tasks = [];
                    let successCount = 0;
                    let failureCount = 0;

                    for (const item of readyItems) {
                        try {
                            console.log(`[查询归档] 正在处理: ${item.name}`);
                            
                            // 调用fetchArchiveDownloadInfo获取真实链接
                            const archiveInfo = await fetchArchiveDownloadInfo({
                                gid: item.gallery?.gid || item.gid,
                                token: item.gallery?.token || item.token,
                                pageLink: item.gallery?.href || item.href,
                            });

                            if (!archiveInfo || !archiveInfo.downloadUrl) {
                                throw new Error('未能获取下载链接');
                            }

                            // 【关键】直接传递URI和自定义extraOptions，避免EhAria2重写文件名
                            // 这样我们能完全控制文件名
                            // 【修复】从item.name中提取纯标题（GID之前的部分）
                            // item.name格式: "[标题]GID: xxx | 参考大小: xxx | 时间"
                            let resolvedTitle = item.name;
                            if (item.name && item.name.includes('GID')) {
                                // 提取GID之前的纯标题部分
                                resolvedTitle = item.name.split('GID')[0].trim();
                            }
                            
                            const defaultFileName = archiveInfo.fileName || '';
                            
                            // 使用buildArchiveFileName生成更好的文件名
                            const computedFileName = resolvedTitle
                                ? buildArchiveFileName(resolvedTitle, archiveInfo.dltype || 'org')
                                : '';
                            
                            // 优先使用computed的文件名
                            let finalFileName = computedFileName || defaultFileName;
                            
                            // 【重要】使用uri字段而不是archive字段，这样extraOptions中的out字段才会生效
                            // 【修复】添加token，让EhAria2能正确关联任务到画廊
                            tasks.push({
                                gid: item.gallery?.gid || item.gid,
                                token: item.gallery?.token || item.token,
                                name: finalFileName || item.name || '未知',
                                uri: archiveInfo.downloadUrl,
                                type: 'archive',
                                extraOptions: {
                                    out: finalFileName || archiveInfo.fileName,
                                },
                            });

                            console.log(`[查询归档] ✓ ${item.name} - 获取到链接: ${archiveInfo.downloadUrl}, 标题: ${archiveInfo.title || '(空)'}, 文件名: ${finalFileName}`);
                        } catch (err) {
                            failureCount++;
                            console.error(`[查询归档] ❌ ${item.name} 处理失败:`, err);
                        }
                    }

                    if (tasks.length === 0) {
                        toastError('没有可用的下载链接');
                        return;
                    }

                    console.log('[查询归档] 准备发送任务到Aria2:', tasks);
                    toastInfo(`发送 ${tasks.length} 个任务到Aria2...`);

                    // 发送到Aria2
                    const results = await api.enqueueTasks(tasks);

                    // 处理发送结果
                    let sendSuccessCount = 0;
                    results.forEach((res, idx) => {
                        if (res.success) {
                            sendSuccessCount++;
                            console.log(`[查询归档] ✅ ${tasks[idx].name} 发送成功`);
                        } else {
                            failureCount++;
                            console.error(`[查询归档] ❌ ${tasks[idx].name} 发送失败:`, res.error);
                        }
                    });

                    toastSuccess(`成功发送 ${sendSuccessCount}/${tasks.length} 个任务到Aria2${failureCount > 0 ? `，${failureCount}个处理失败` : ''}`);
                    console.log(`[查询归档] 发送完成 - 成功:${sendSuccessCount}, 失败:${failureCount}`);
                    
                    // 【修复】标记为已下载并取消勾选（使用与sendEntriesToAria相同的逻辑）
                    const nowText = formatOperationTime(new Date());
                    const recentEntries = [];
                    
                    results.forEach((res, idx) => {
                        if (res.success && readyItems[idx]) {
                            const item = readyItems[idx];
                            const gid = String(item.gid || item.gallery?.gid);
                            
                            // 标记为已下载（调用markGalleryDownloaded）
                            markGalleryDownloaded({
                                gid: item.gid || item.gallery?.gid,
                                token: item.token || item.gallery?.token,
                                href: item.href || item.gallery?.href,
                            }, { silent: true, skipPersist: false });
                            
                            // 【修复】在DOM中取消对应的checkbox
                            const checkboxesToUncheck = document.querySelectorAll(`.eh-magnet-checkbox[data-gallery-gid="${gid}"]`);
                            checkboxesToUncheck.forEach(cb => {
                                if (cb.checked) {
                                    cb.checked = false;
                                    const magnetKey = cb.dataset.magnetValue || cb.dataset.archiveKey || '';
                                    if (magnetKey) {
                                        selectedMagnets.delete(magnetKey);
                                    }
                                }
                            });
                            
                            // 取消勾选
                            selectedGalleries.delete(gid);
                            
                            // 构建recent entry用于记录
                            const archiveKey = `archive://${gid}/org`;
                            const recentEntry = resolveRecentEntry({
                                href: archiveKey,
                                isArchive: true,
                                archiveKey: archiveKey,
                                archiveDltype: 'org',
                            }, {
                                gid,
                                token: item.token || item.gallery?.token,
                                href: item.href || item.gallery?.href,
                                title: item.name,
                            }, {
                                name: item.name,
                                downloadUrl: tasks[idx].uri,
                                operationText: nowText,
                            });
                            
                            if (recentEntry) {
                                recentEntries.push(recentEntry);
                            }
                        }
                    });
                    
                    if (recentEntries.length) {
                        recordRecentBatch(recentEntries, { source: '查询归档', operationText: nowText });
                    }
                    
                    // 【关键】发送成功后关闭查询窗口（与AB DM行为一致）
                    if (sendSuccessCount > 0) {
                        dialog.remove();
                    }
                } catch (err) {
                    console.error('[查询归档] 发送Aria2异常:', err);
                    toastError(`发送失败: ${err.message}`);
                }
            });
        });
        footerArea.appendChild(sendToAria2Btn);
        
        // AB DM按钮（红色）
        const sendBtn = document.createElement('button');
        sendBtn.textContent = 'AB DM';
        sendBtn.style.cssText = buttonBaseStyle + `
            background: #5C0D12;
        `;
        sendBtn.addEventListener('click', () => {
            sendSelectedToDM();
        });
        footerArea.appendChild(sendBtn);
        
        dialog.appendChild(footerArea);

        // 执行查询逻辑
        const performBatchQuery = async (isAutoMode = false) => {
            let input;
            let queryItems = [];
            
            // 在开始查询时，异步获取账户资金信息（不阻塞查询过程）
            (async () => {
                try {
                    const fundInfo = await fetchUserFundInfo();
                    if (fundInfo) {
                        fundInfoDiv.textContent = `现有资金: ${fundInfo.gp} GP | ${fundInfo.credits} Credits`;
                        fundInfoDiv.style.color = '#333';
                    }
                } catch (err) {
                    console.warn('获取账户资金失败:', err);
                    fundInfoDiv.textContent = '无法获取账户资金信息';
                    fundInfoDiv.style.color = '#d9534f';
                }
            })();
            
            if (isAutoMode && queryEntries.length > 0) {
                // 自动查询模式：直接使用 queryEntries
                queryItems = queryEntries.map(entry => ({
                    type: 'gid-with-token',
                    value: entry.gid,
                    token: entry.token,
                    title: entry.title
                }));
            } else {
                // 手动查询模式：从输入框获取
                input = textarea.value.trim();
                if (!input) {
                    toastWarn('请输入链接或GID');
                    return;
                }

                // 解析输入：支持 GID、画廊URL、磁力链接、种子链接
                const lines = input.split('\n');
            
            lines.forEach(line => {
                line = line.trim();
                if (!line) return;
                
                // 1. 尝试从画廊URL提取GID和token
                const gidTokenFromUrl = line.match(/\/g\/(\d+)\/([a-f0-9]+)\//);
                if (gidTokenFromUrl) {
                    queryItems.push({ 
                        type: 'gid-with-token', 
                        value: gidTokenFromUrl[1],
                        token: gidTokenFromUrl[2]
                    });
                    return;
                }
                
                // 2. 尝试从画廊URL提取GID（不带token的情况）
                const gidFromUrl = line.match(/\/g\/(\d+)\//);
                if (gidFromUrl) {
                    queryItems.push({ type: 'gid', value: gidFromUrl[1] });
                    return;
                }
                
                // 3. 直接输入的纯数字GID
                if (/^\d+$/.test(line)) {
                    queryItems.push({ type: 'gid', value: line });
                    return;
                }
                
                // 4. 磁力链接
                if (line.startsWith('magnet:')) {
                    queryItems.push({ type: 'magnet', value: line });
                    return;
                }
                
                // 5. 种子链接（.torrent）或其他下载链接
                if (line.includes('http') && (line.includes('.torrent') || line.includes('tracker') || line.includes('archiver') || line.includes('hath.network'))) {
                    queryItems.push({ type: 'url', value: line });
                    return;
                }
            });

            }
            
            if (queryItems.length === 0) {
                resultContainer.innerHTML = '<div style="color:#d9534f;">未能识别任何有效的链接或GID</div>';
                return;
            }

            resultContainer.innerHTML = '<div style="text-align:center; color:#999;">正在查询...</div>';

            // 自动查询模式：实时抓取归档信息
            if (isAutoMode && queryItems.some(item => item.type === 'gid-with-token')) {
                const autoQueryItems = queryItems.filter(item => item.type === 'gid-with-token');
                await handleAutoModeQuery(autoQueryItems);
                return;
            }

            // 手动查询模式：优先从最近下载中查询，未找到的画廊需要实时抓取
            const handleManualModeQuery = async () => {
                // 批量查询时加载所有批次（不受recentBatchLimit限制）
                // 优先使用IndexedDB加载所有批次，若不可用则降级到localStorage
                let recentBatches = [];
                try {
                    if (idbSupported && idbDatabase) {
                        // 从IndexedDB加载所有批次（不限制数量）
                        recentBatches = await loadRecentBatchesFromIDB() || [];
                        console.log('[批量查询] 从IndexedDB加载批次数:', recentBatches.length);
                    } else {
                        // 降级：从localStorage加载
                        const raw = localStorage.getItem(RECENT_BATCH_STORAGE_KEY);
                        if (raw) {
                            const parsed = JSON.parse(raw);
                            if (Array.isArray(parsed)) {
                                recentBatches = parsed
                                    .map((item) => normalizeRecentBatch(item))
                                    .filter((item) => item && item.entries && item.entries.length);
                            }
                        }
                        console.log('[批量查询] 从localStorage加载批次数:', recentBatches.length);
                    }
                } catch (err) {
                    console.warn('[批量查询] 加载批次失败:', err);
                }
                const allEntries = [];
                const unfoundGidTokens = []; // 未在缓存中找到的GID+Token对
                
                console.log('[批量查询] 输入项详情:');
                queryItems.forEach((item, idx) => {
                    console.log(`  [${idx}] type: ${item.type}, value: ${item.value}`);
                });
                console.log('[批量查询] 最近下载批次数:', recentBatches.length);
                
                // 输出所有输入的磁链，便于调试
                const magnetItems = queryItems.filter(item => item.type === 'magnet');
                if (magnetItems.length > 0) {
                    console.log('[批量查询] 输入磁链列表:');
                    magnetItems.forEach((item, idx) => {
                        console.log(`  [${idx + 1}] ${item.value}`);
                    });
                }
                
                // 第一步：从最近下载中查询
                recentBatches.forEach((batch, batchIndex) => {
                    console.log(`[批量查询] 批次 ${batchIndex}: 包含 ${batch.entries.length} 条记录`);
                    
                    // 调试：显示该批次中的所有磁链（仅在有输入磁链时）
                    if (magnetItems.length > 0) {
                        const batchMagnets = batch.entries
                            .map(e => e.magnet)
                            .filter(m => m && magnetItems.some(item => item.value === m));
                        if (batchMagnets.length > 0) {
                            console.log(`  [批次 ${batchIndex}] 匹配的磁链: ${batchMagnets.length} 条`);
                        }
                    }
                    
                    batch.entries.forEach((entry, entryIndex) => {
                        const entryGid = entry.gallery?.gid || '';
                        const entryMagnet = entry.magnet || '';
                        const entryUrl = entry.downloadUrl || '';
                        const entryTorrent = entry.torrentHref || '';
                        
                        console.log(`  [记录 ${entryIndex}] GID: ${entryGid}, 名称: ${entry.name}`);
                        
                        // 检查是否匹配任何输入项
                        const matched = queryItems.some(item => {
                            if (item.type === 'gid' && entryGid === item.value) {
                                console.log(`    ✓ 匹配GID: ${entryGid}`);
                                return true;
                            }
                            if (item.type === 'gid-with-token' && entryGid === item.value) {
                                console.log(`    ✓ 匹配GID: ${entryGid}`);
                                return true;
                            }
                            if (item.type === 'magnet') {
                                // 磁力链接完全匹配
                                if (entryMagnet === item.value) {
                                    console.log(`    ✓ 匹配磁力链接`);
                                    return true;
                                }
                                // 提取磁链中的infohash与种链hash进行比对
                                const inputHash = item.value.match(/urn:btih:([a-f0-9]{40})/i)?.[1]?.toLowerCase();
                                const torrentHash = entryTorrent.match(/[a-f0-9]{40}/i)?.[0]?.toLowerCase();
                                const downloadHash = entryUrl.match(/[a-f0-9]{40}/i)?.[0]?.toLowerCase();
                                if (inputHash && (inputHash === torrentHash || inputHash === downloadHash)) {
                                    console.log(`    ✓ 匹配磁链infohash`);
                                    return true;
                                }
                            }
                            if (item.type === 'url') {
                                // 种子链接：提取hash部分进行比对
                                const inputHash = item.value.match(/[a-f0-9]{40}/i)?.[0]?.toLowerCase();
                                const torrentHash = entryTorrent.match(/[a-f0-9]{40}/i)?.[0]?.toLowerCase();
                                const downloadHash = entryUrl.match(/[a-f0-9]{40}/i)?.[0]?.toLowerCase();
                                const entryMagnetHash = entryMagnet.match(/urn:btih:([a-f0-9]{40})/i)?.[1]?.toLowerCase();
                                
                                if (inputHash && (inputHash === torrentHash || inputHash === downloadHash || inputHash === entryMagnetHash)) {
                                    console.log(`    ✓ 匹配URL/磁链 (hash: ${inputHash})`);
                                    return true;
                                }
                                
                                // 也支持完全URL匹配
                                if (entryTorrent === item.value || entryUrl === item.value) {
                                    console.log(`    ✓ 匹配URL (完全匹配)`);
                                    return true;
                                }
                            }
                            return false;
                        });
                        
                        if (matched) {
                            // 检查是否已存在相同的gID
                            const existingCacheIndex = allEntries.findIndex(e => String(e.gallery?.gid) === String(entry.gallery.gid));
                            if (existingCacheIndex >= 0) {
                                // 已存在，跳过（不重复添加批次中的重复项）
                                console.log(`[批量查询] 批次中的重复项: ${entry.gallery.gid}，跳过`);
                            } else {
                                // 添加新项
                                console.log(`[批量查询] 添加缓存项: ${entry.gallery.gid}`);
                                allEntries.push({
                                    ...entry,
                                    batchOperationText: batch.operationText,
                                    duplicateCount: 1,  // 初始值为1
                                });
                            }
                        }
                    });
                });

                // 第一步半：处理用户输入中重复的项
                // 需要处理所有类型的重复（包括同一GID通过不同URL输入）
                const gidDuplicateCount = new Map(); // gid => count（用于检测同一GID的重复）
                const itemQueryCount = new Map(); // value => count（用于检测完全相同的重复）
                
                queryItems.forEach(item => {
                    // 记录完全相同的item重复
                    itemQueryCount.set(item.value, (itemQueryCount.get(item.value) || 0) + 1);
                    
                    // 对于gid-with-token和gid类型，也按GID统计重复
                    if (item.type === 'gid-with-token' || item.type === 'gid') {
                        const gid = item.type === 'gid-with-token' ? item.value : item.value;
                        gidDuplicateCount.set(gid, (gidDuplicateCount.get(gid) || 0) + 1);
                    }
                });
                
                // 处理完全相同的重复项（磁链、URL等）
                itemQueryCount.forEach((count, value) => {
                    if (count > 1) {
                        const item = queryItems.find(q => q.value === value);
                        let entryIndex = -1;
                        
                        if (item.type === 'gid-with-token') {
                            entryIndex = allEntries.findIndex(e => String(e.gallery?.gid) === String(value));
                            console.log(`[批量查询] 用户输入重复的GID: ${value}, 出现${count}次`);
                        } else if (item.type === 'magnet') {
                            // 磁链完全匹配
                            entryIndex = allEntries.findIndex(e => e.magnet === value);
                            // 如果没有完全匹配，尝试通过infohash匹配
                            if (entryIndex < 0) {
                                const inputHash = value.match(/urn:btih:([a-f0-9]{40})/i)?.[1]?.toLowerCase();
                                if (inputHash) {
                                    entryIndex = allEntries.findIndex(e => {
                                        const torrentHash = (e.torrentHref || '').match(/[a-f0-9]{40}/i)?.[0]?.toLowerCase();
                                        const magnetHash = (e.magnet || '').match(/urn:btih:([a-f0-9]{40})/i)?.[1]?.toLowerCase();
                                        return inputHash === torrentHash || inputHash === magnetHash;
                                    });
                                }
                            }
                            console.log(`[批量查询] 用户输入重复的磁链: ${value}, 出现${count}次`);
                        } else if (item.type === 'url') {
                            // 对于URL类型，通过hash匹配（支持与磁链跨匹配）
                            const inputHash = value.match(/[a-f0-9]{40}/i)?.[0]?.toLowerCase();
                            entryIndex = allEntries.findIndex(e => {
                                const entryTorrent = e.torrentHref || '';
                                const torrentHash = entryTorrent.match(/[a-f0-9]{40}/i)?.[0]?.toLowerCase();
                                const magnetHash = (e.magnet || '').match(/urn:btih:([a-f0-9]{40})/i)?.[1]?.toLowerCase();
                                return inputHash && (inputHash === torrentHash || inputHash === magnetHash);
                            });
                            console.log(`[批量查询] 用户输入重复的URL: ${value.substring(0, 50)}..., 出现${count}次`);
                        }
                        
                        if (entryIndex >= 0) {
                            allEntries[entryIndex].duplicateCount = count;
                        }
                    }
                });
                
                // 处理同一GID通过不同URL输入的重复（如两次输入同一画廊URL）
                gidDuplicateCount.forEach((count, gid) => {
                    if (count > 1) {
                        const entryIndex = allEntries.findIndex(e => String(e.gallery?.gid) === String(gid));
                        if (entryIndex >= 0) {
                            allEntries[entryIndex].duplicateCount = count;
                            console.log(`[批量查询] 检测到同一GID ${gid} 通过不同URL重复输入${count}次`);
                        }
                    }
                });

                // 第二步：处理需要获取标题的项
                // 对于gid-with-token、magnet和url类型的项，都需要检查是否需要刷新标题
                const itemsNeedTitle = queryItems.filter(item => {
                    if (item.type === 'gid-with-token') {
                        // 检查是否已在缓存中找到且有非"未知"的标题
                        const cached = allEntries.find(e => String(e.gallery?.gid) === String(item.value));
                        // 如果未找到，或找到但标题是"未知"，则需要获取标题
                        const needsTitle = !cached || cached.name === '未知';
                        console.log(`[批量查询] GID ${item.value} 需要获取标题: ${needsTitle} (cached: ${!!cached})`);
                        return needsTitle;
                    }
                    if (item.type === 'magnet') {
                        // 对于磁链，查找对应的缓存项
                        const cachedEntry = allEntries.find(e => e.magnet === item.value);
                        if (cachedEntry && cachedEntry.gallery?.gid) {
                            // 检查缓存名称是否不正确（如'torrent'）
                            const needsTitle = !cachedEntry.name || cachedEntry.name === 'torrent';
                            console.log(`[批量查询] 磁链 ${item.value.substring(0, 50)}... 对应GID ${cachedEntry.gallery?.gid} 需要刷新标题: ${needsTitle}`);
                            return needsTitle;
                        }
                        return false;
                    }
                    if (item.type === 'url') {
                        // 对于URL类型，需要从缓存中找到对应的GID，然后检查是否需要刷新标题
                        // 查找匹配的缓存项
                        const cachedEntry = allEntries.find(e => {
                            const entryTorrent = e.torrentHref || '';
                            const entryUrl = e.downloadUrl || '';
                            const inputHash = item.value.match(/[a-f0-9]{40}/i)?.[0]?.toLowerCase();
                            const torrentHash = entryTorrent.match(/[a-f0-9]{40}/i)?.[0]?.toLowerCase();
                            const downloadHash = entryUrl.match(/[a-f0-9]{40}/i)?.[0]?.toLowerCase();
                            
                            return inputHash && (inputHash === torrentHash || inputHash === downloadHash);
                        });
                        
                        if (cachedEntry) {
                            // 找到了对应的缓存项，检查是否需要刷新标题
                            const needsTitle = !cachedEntry.name || cachedEntry.name === 'torrent';
                            console.log(`[批量查询] URL ${item.value.substring(0, 50)}... 对应GID ${cachedEntry.gallery?.gid} 需要刷新标题: ${needsTitle}`);
                            return needsTitle;
                        }
                        return false;
                    }
                    return false;
                });

                console.log(`[批量查询] 需要获取标题的项数: ${itemsNeedTitle.length}`);

                if (itemsNeedTitle.length > 0) {
                    resultContainer.innerHTML = '<div style="text-align:center; color:#999;">正在获取画廊基本信息... 0/' + itemsNeedTitle.length + '</div>';
                    
                    // 使用并发控制替代顺序循环获取标题
                    const titleFetchTasks = itemsNeedTitle.map((item) => async () => {
                        try {
                            // 只获取画廊基本信息（标题等），不获取归档成本
                            // 需要用户手动点击"获取"按钮才会查询GP和大小
                            let gid = item.value;
                            let token = item.token;
                            
                            // 对于magnet类型的项，需要从缓存中找到对应的GID和token
                            if (item.type === 'magnet') {
                                const cachedEntry = allEntries.find(e => e.magnet === item.value);
                                if (cachedEntry && cachedEntry.gallery?.gid) {
                                    gid = cachedEntry.gallery?.gid;
                                    token = cachedEntry.gallery?.token;
                                }
                            }
                            
                            // 对于URL类型的项，需要从缓存中找到对应的GID和token
                            if (item.type === 'url') {
                                const cachedEntry = allEntries.find(e => {
                                    const entryTorrent = e.torrentHref || '';
                                    const entryUrl = e.downloadUrl || '';
                                    const inputHash = item.value.match(/[a-f0-9]{40}/i)?.[0]?.toLowerCase();
                                    const torrentHash = entryTorrent.match(/[a-f0-9]{40}/i)?.[0]?.toLowerCase();
                                    const downloadHash = entryUrl.match(/[a-f0-9]{40}/i)?.[0]?.toLowerCase();
                                    
                                    return inputHash && (inputHash === torrentHash || inputHash === downloadHash);
                                });
                                
                                if (cachedEntry) {
                                    gid = cachedEntry.gallery?.gid;
                                    token = cachedEntry.gallery?.token;
                                }
                            }
                            
                            const galleryUrl = `https://e-hentai.org/g/${gid}/${token}/`;
                            console.log(`[批量查询] 正在获取标题: ${galleryUrl}`);
                            const response = await fetch(galleryUrl);
                            
                            let title = '未知';
                            let size = '';
                            let postedTime = '';
                            
                            if (response.ok) {
                                const html = await response.text();
                                const doc = new DOMParser().parseFromString(html, 'text/html');
                                
                                // 优先获取日文标题（gj），如果没有则获取英文标题（gn）
                                let titleEl = doc.querySelector('#gd2 #gj');
                                if (!titleEl || !titleEl.textContent?.trim()) {
                                    titleEl = doc.querySelector('#gd2 #gn');
                                }
                                if (!titleEl || !titleEl.textContent?.trim()) {
                                    titleEl = doc.querySelector('h1 a') || doc.querySelector('h1.gname');
                                }
                                title = titleEl?.textContent?.trim() || '未知';
                                console.log(`[批量查询] 获取到标题: ${title}`);
                                
                                // 获取文件大小 (File Size 或 文件大小)
                                const fileSizeRows = Array.from(doc.querySelectorAll('#gdd table tbody tr'));
                                for (const row of fileSizeRows) {
                                    const cells = row.querySelectorAll('td');
                                    if (cells.length >= 2) {
                                        const label = cells[0].textContent?.trim() || '';
                                        const value = cells[1].textContent?.trim() || '';
                                        
                                        if (label.includes('File Size') || label.includes('文件大小')) {
                                            size = value;
                                            console.log(`[批量查询] 获取到大小: ${size}`);
                                        }
                                        
                                        if (label.includes('Posted') || label.includes('发布于')) {
                                            postedTime = value;
                                            console.log(`[批量查询] 获取到发布时间: ${postedTime}`);
                                        }
                                    }
                                }
                            }
                            
                            // 如果这个GID已在列表中，更新其标题和信息
                            const existingIndex = allEntries.findIndex(e => String(e.gallery?.gid) === String(gid));
                            if (existingIndex >= 0) {
                                console.log(`[批量查询] 更新已有项的标题: ${gid}`);
                                allEntries[existingIndex].name = title;
                                allEntries[existingIndex].size = size;
                                allEntries[existingIndex].postedTime = postedTime;
                                // 注意：不在这里增加duplicateCount，因为它已在第6513行正确设置
                            } else {
                                // 否则添加新项
                                console.log(`[批量查询] 添加新项: ${gid}`);
                                
                                // 检查是否已经在gidDuplicateCount中检测到重复
                                const duplicateCount = gidDuplicateCount.get(String(gid)) || 1;
                                
                                allEntries.push({
                                    gallery: {
                                        gid: gid,
                                        token: token,
                                        href: galleryUrl,
                                    },
                                    name: title,
                                    archiveUrl: '',
                                    archiveDltype: '',
                                    size: size,
                                    postedTime: postedTime,
                                    batchOperationText: '',
                                    source: 'manual-query',
                                    duplicateCount: duplicateCount,  // 使用检测到的重复计数
                                });
                            }
                        } catch (err) {
                            console.warn(`[批量查询] 查询画廊 ${gid} 失败:`, err);
                            // 如果该GID不在列表中，添加一个失败的项
                            const existingIndex = allEntries.findIndex(e => String(e.gallery?.gid) === String(gid));
                            if (existingIndex < 0) {
                                console.log(`[批量查询] 添加失败项: ${gid}`);
                                allEntries.push({
                                    gallery: {
                                        gid: gid,
                                        token: token,
                                        href: `https://e-hentai.org/g/${gid}/${token}/`,
                                    },
                                    name: '未知',
                                    archiveUrl: '',
                                    archiveDltype: '',
                                    postedTime: '',
                                    batchOperationText: '',
                                    source: 'manual-query',
                                });
                            }
                        }
                    });

                    // 执行并发标题获取，使用进度回调更新 UI
                    await executeWithConcurrencyLimit(titleFetchTasks, null, (completed, total) => {
                        resultContainer.innerHTML = '<div style="text-align:center; color:#999;">正在获取画廊基本信息... ' + completed + '/' + total + '</div>';
                    });
                }

                console.log('[批量查询] 匹配结果数:', allEntries.length);
                
                // 调试：输出未找到的磁链（支持infohash匹配）
                if (magnetItems.length > 0) {
                    const unfoundMagnets = magnetItems.filter(item => {
                        // 尝试完全匹配
                        if (allEntries.some(e => e.magnet === item.value)) {
                            return false;
                        }
                        // 尝试通过infohash匹配
                        const inputHash = item.value.match(/urn:btih:([a-f0-9]{40})/i)?.[1]?.toLowerCase();
                        if (inputHash) {
                            return !allEntries.some(e => {
                                const torrentHash = (e.torrentHref || '').match(/[a-f0-9]{40}/i)?.[0]?.toLowerCase();
                                const magnetHash = (e.magnet || '').match(/urn:btih:([a-f0-9]{40})/i)?.[1]?.toLowerCase();
                                return inputHash === torrentHash || inputHash === magnetHash;
                            });
                        }
                        return true;
                    });
                    if (unfoundMagnets.length > 0) {
                        console.log(`[批量查询] 未找到的磁链 (${unfoundMagnets.length} 条):`);
                        unfoundMagnets.forEach((item, idx) => {
                            console.log(`  [${idx + 1}] ${item.value}`);
                        });
                    }
                }

                if (allEntries.length === 0) {
                    resultContainer.innerHTML = '<div style="color:#d9534f;">未找到匹配的记录<br><small style="color:#999;">请检查输入是否正确</small></div>';
                    return;
                }

                // 分离有效和无效（未知）的项
                const validEntries = allEntries.filter(entry => entry.name !== '未知');
                const unknownEntries = allEntries.filter(entry => entry.name === '未知');
                
                // 计算已找到的值（gID和磁链都要考虑，只考虑有效项）
                const foundValues = new Set();
                const foundHashes = new Set(); // 用于存放infohash便于匹配
                validEntries.forEach(entry => {
                    // 收集所有找到的值
                    if (entry.gallery?.gid) foundValues.add(String(entry.gallery.gid));
                    if (entry.magnet) {
                        foundValues.add(entry.magnet);
                        const hash = entry.magnet.match(/urn:btih:([a-f0-9]{40})/i)?.[1]?.toLowerCase();
                        if (hash) foundHashes.add(hash);
                    }
                    if (entry.torrentHref) {
                        const hash = entry.torrentHref.match(/[a-f0-9]{40}/i)?.[0]?.toLowerCase();
                        if (hash) foundHashes.add(hash);
                    }
                });
                
                // 计算被尝试查询过的项（无论成功失败）
                const queriedValues = new Set();
                allEntries.forEach(entry => {
                    if (entry.gallery?.gid) queriedValues.add(String(entry.gallery.gid));
                });
                
                // 未查询到的项 = 查询项 - 已找到的值 - 被尝试查询过的值（支持infohash匹配）
                let unfoundItems = queryItems.filter(item => {
                    // 检查完全匹配
                    if (foundValues.has(item.value) || queriedValues.has(item.value)) {
                        return false;
                    }
                    // 检查infohash匹配
                    if (item.type === 'magnet') {
                        const hash = item.value.match(/urn:btih:([a-f0-9]{40})/i)?.[1]?.toLowerCase();
                        if (hash && foundHashes.has(hash)) return false;
                    } else if (item.type === 'url') {
                        const hash = item.value.match(/[a-f0-9]{40}/i)?.[0]?.toLowerCase();
                        if (hash && foundHashes.has(hash)) return false;
                    }
                    return true;
                });
                
                // 对未查询到的项进行去重和计数
                const unfoundMap = new Map(); // value => { item, count }
                unfoundItems.forEach(item => {
                    if (unfoundMap.has(item.value)) {
                        unfoundMap.get(item.value).count += 1;
                    } else {
                        unfoundMap.set(item.value, { item, count: 1 });
                    }
                });
                unfoundItems = Array.from(unfoundMap.values()).map(entry => ({
                    ...entry.item,
                    duplicateCount: entry.count,
                }));

                // 将所有项传给渲染函数（有效项 + 无效项），但渲染时会特别处理
                const allResultsWithInvalid = [...validEntries, ...unknownEntries];
                // 总数 = 有效项 + 无效项 + 未找到的项
                const totalCount = validEntries.length + unknownEntries.length + unfoundItems.length;
                renderBatchQueryResults(allResultsWithInvalid, resultContainer, selectedCountSpan, fetchAllBtn, autoFetchCheckbox, { value: isAutoClickingFetchAll }, unfoundItems, [], validEntries.length, totalCount);
            };

            // 根据模式执行对应的查询函数
            if (isAutoMode) {
                await handleAutoModeQuery(queryItems);
            } else {
                await handleManualModeQuery();
            }
        };

        // 自动查询模式的处理函数
        const handleAutoModeQuery = async (autoQueryItems) => {
            // 第一步：创建初始的 results 数组（所有项都显示"待获取"）
            const results = autoQueryItems.map((item) => {
                const baseInfo = queryFromRecentBatches(item.value) || {};
                
                // 如果没有发布时间，尝试从当前页面DOM中获取
                if (!baseInfo.postedTime) {
                    const postedElement = document.getElementById(`posted_${item.value}`);
                    if (postedElement) {
                        baseInfo.postedTime = postedElement.textContent.trim();
                    }
                }
                
                return {
                    gallery: {
                        gid: item.value,
                        token: item.token,
                        href: baseInfo.href || `https://e-hentai.org/g/${item.value}/${item.token}/`,
                    },
                    name: baseInfo.title || item.title || '未知',
                    archiveUrl: baseInfo.archiveUrl || '',
                    archiveDltype: baseInfo.archiveDltype || '',
                    size: '待获取',
                    cost: '待获取',
                    postedTime: baseInfo.postedTime || '',
                    batchOperationText: baseInfo.batchOperationText || '',
                    source: 'auto-query',
                    duplicateCount: 1,
                };
            });

            // 第二步：立即渲染初始列表
            if (results.length === 0) {
                resultContainer.innerHTML = '<div style="color:#d9534f;">未能获取任何画廊的归档信息</div>';
                return;
            }
            
            // 设置自动点击标志
            if (autoFetchCheckbox && autoFetchCheckbox.checked) {
                isAutoClickingFetchAll = true;
            }
            
            renderBatchQueryResults(results, resultContainer, selectedCountSpan, fetchAllBtn, autoFetchCheckbox, { value: isAutoClickingFetchAll }, [], [], results.length, results.length);

            // 第三步：后台异步查询并动态更新每个项目的信息
            if (!autoFetchBatchQuery) {
                // 如果未勾选"自动获取"，不需要后台查询
                return;
            }

            // 使用并发控制执行后台查询
            // 构建任务数组，每个任务是一个异步函数
            const tasks = autoQueryItems.map((item, index) => async () => {
                try {
                    // 查询归档信息
                    const archiveInfo = await fetchArchiveInfo(item.value, item.token);
                    
                    // 更新对应位置的结果
                    if (archiveInfo) {
                        results[index].size = archiveInfo.size;
                        results[index].cost = archiveInfo.cost;
                    } else {
                        results[index].size = '待获取';
                        results[index].cost = '待获取';
                    }
                } catch (err) {
                    console.warn(`[自动查询] 查询 ${item.value} 失败:`, err);
                    results[index].size = '失败';
                    results[index].cost = '失败';
                }
                
                // 动态更新 DOM 中的该项信息
                const checkboxes = resultContainer.querySelectorAll(`input[data-gid="${item.value}"]`);
                checkboxes.forEach(checkbox => {
                    const itemDiv = checkbox.closest('div[style*="border-bottom"]');
                    if (itemDiv) {
                        const costSpan = itemDiv.querySelector('span[style*="min-width: 80px"]');
                        if (costSpan) {
                            costSpan.textContent = `${results[index].size} | ${results[index].cost}`;
                            // 改变文字颜色为黑色，表示已获取
                            if (results[index].size !== '失败' && results[index].size !== '待获取') {
                                costSpan.style.color = '#333';
                            } else {
                                costSpan.style.color = '#d9534f';  // 失败时显示红色
                            }
                        }
                        
                        // 同时更新"获取"按钮的样式
                        const fetchBtn = itemDiv.querySelector('button:last-child');
                        if (fetchBtn) {
                            if (results[index].size !== '失败' && results[index].size !== '待获取') {
                                // 成功获取：显示对勾
                                fetchBtn.textContent = '✓';
                                fetchBtn.style.background = '#e8f5e9';
                                fetchBtn.style.cursor = 'default';
                                fetchBtn.disabled = true;
                                fetchBtn.title = '归档信息已获取';
                            } else if (results[index].size === '失败') {
                                // 失败：显示感叹号
                                fetchBtn.textContent = '!';
                                fetchBtn.style.background = '#ffebee';
                                fetchBtn.style.cursor = 'pointer';
                                fetchBtn.disabled = false;
                                fetchBtn.title = '获取失败，点击重试';
                            }
                        }
                    }
                });
            });

            // 执行并发查询，使用进度回调更新 UI（在列表下方显示进度，不覆盖列表）
            const progressDiv = document.createElement('div');
            progressDiv.style.cssText = 'text-align: center; color: #999; padding: 8px; font-size: 12px;';
            progressDiv.textContent = '正在获取 0/' + autoQueryItems.length + '...';
            resultContainer.appendChild(progressDiv);
            
            await executeWithConcurrencyLimit(tasks, null, (completed, total) => {
                progressDiv.textContent = '正在获取 ' + completed + '/' + total + '...';
            });
            
            // 获取完成后移除进度显示
            progressDiv.remove();
        };

        const sendSelectedToDM = async () => {
            const checkboxes = resultContainer.querySelectorAll('input[type="checkbox"]:checked:not([data-select-all])');
            if (checkboxes.length === 0) {
                toastWarn('请选择至少一条记录');
                return;
            }

            const selected = Array.from(checkboxes).map(cb => ({
                name: cb.parentElement.querySelector('div').textContent || '未知',
                archiveKey: cb.dataset.archiveKey,
                archiveDltype: cb.dataset.archiveDltype,
                gid: cb.dataset.gid,
                href: cb.dataset.href,
                token: cb.dataset.token,
                gallery: {
                    gid: cb.dataset.gid,
                    href: cb.dataset.href,
                    token: cb.dataset.token,
                },
            }));

            // 打开预检对话框
            await showArchivePreCheckDialog(selected, async (readyItems) => {
                // 检查 AB DM 是否运行
                const isAvailable = await checkAbdmAvailable();
                if (!isAvailable) {
                    toastError(`AB Download Manager 未运行，请确保已启动`);
                    return;
                }

                toastInfo(`开始获取 ${readyItems.length} 个画廊的归档下载链接...`);

                const downloadItems = [];
                let successCount = 0;
                let failureCount = 0;

                for (const item of readyItems) {
                    try {
                        const archiveInfo = await fetchArchiveDownloadInfo({
                            gid: item.gid,
                            token: item.token,
                            pageLink: item.href,
                        });

                        downloadItems.push({
                            link: archiveInfo.downloadUrl,
                            downloadPage: item.href,
                            suggestedName: archiveInfo.fileName,
                        });
                        successCount++;
                    } catch (err) {
                        console.warn(`获取 GID ${item.gid} 的归档信息失败:`, err);
                        failureCount++;
                    }
                }

                if (downloadItems.length === 0) {
                    toastError('未能获取任何有效的下载链接');
                    return;
                }

                try {
                    await sendToAbdm(downloadItems);
                    toastSuccess(`成功发送 ${successCount} 条记录到AB DM${failureCount > 0 ? `（${failureCount} 条失败）` : ''}`);
                    
                    // 【新增】标记这些画廊为已下载，并取消勾选
                    for (const item of readyItems) {
                        if (item.gid) {
                            console.log(`[performBatchVerification] 标记 GID ${item.gid} 为已下载`);
                            
                            // 【重要】使用 markGalleryDownloaded() 函数，这样会同时：
                            // 1. 更新内存中的已下载状态
                            // 2. 持久化到IndexedDB
                            // 3. 立即调用 updateStatusFlags() 更新所有UI
                            if (typeof markGalleryDownloaded === 'function') {
                                markGalleryDownloaded({ gid: String(item.gid) });
                                console.log(`[performBatchVerification] 使用markGalleryDownloaded标记GID ${item.gid}`);
                            }
                            
                            // 取消勾选对话框中的复选框
                            if (item._checkbox) {
                                item._checkbox.checked = false;
                                selectedGalleries.delete(item.gid);
                                console.log(`[performBatchVerification] 取消勾选对话框中 GID ${item.gid} 的复选框`);
                            }
                            
                            // 【重要】同时取消勾选页面上所有该GID的复选框（画廊级别的复选框）
                            const pageCheckboxes = document.querySelectorAll(`.eh-magnet-checkbox[data-gallery-gid="${item.gid}"]`);
                            pageCheckboxes.forEach((checkbox) => {
                                checkbox.checked = false;
                                selectedMagnets.delete(checkbox.dataset.magnetValue);
                                console.log(`[performBatchVerification] 取消勾选页面中 GID ${item.gid} 的复选框`);
                            });
                        }
                    }
                    
                    console.log(`[performBatchVerification] 已将 ${readyItems.length} 个画廊标记为已下载并取消勾选`);
                    
                    dialog.remove();
                } catch (err) {
                    console.warn('发送到 AB DM 失败:', err);
                    toastError(`发送失败: ${err?.message || err}`);
                }
            });
        };
        
        if (!document.body.contains(dialog)) {
            document.body.appendChild(dialog);
        }
        
        dialog.style.display = 'flex';
        
        // 自动查询模式下，异步获取账户资金信息
        if (autoQuery) {
            (async () => {
                try {
                    const fundInfo = await fetchUserFundInfo();
                    if (fundInfo) {
                        fundInfoDiv.textContent = `现有资金: ${fundInfo.gp} GP | ${fundInfo.credits} Credits`;
                        fundInfoDiv.style.color = '#333';
                    }
                } catch (err) {
                    console.warn('获取账户资金失败:', err);
                    fundInfoDiv.textContent = '无法获取账户资金信息';
                    fundInfoDiv.style.color = '#d9534f';
                }
            })();
        }
        
        // 自动查询：如果是自动模式且有查询条目，则自动触发查询
        if (autoQuery && queryEntries.length > 0) {
            // 延迟执行以确保 DOM 已准备好
            setTimeout(async () => {
                await performBatchQuery(true);
            }, 100);
        }
    };

    // 场景 B: 归档链接预检对话框
    let archivePreCheckDialog = null;

    const ensureArchivePreCheckDialog = () => {
        if (archivePreCheckDialog && document.body.contains(archivePreCheckDialog)) {
            return archivePreCheckDialog;
        }

        const dialog = document.createElement('div');
        dialog.className = 'eh-archive-precheck-dialog';
        dialog.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            z-index: 10051;
            background: #fff;
            border: 2px solid #5C0D12;
            border-radius: 4px;
            padding: 0;
            max-height: 90vh;
            width: 90%;
            max-width: 900px;
            display: flex;
            flex-direction: column;
            box-shadow: 0 4px 12px rgba(0,0,0,0.2);
        `;

        archivePreCheckDialog = dialog;
        return dialog;
    };

    // 提交表单触发归档生成（真正扣 GP）
    const triggerArchiveGeneration = async (gid, token, dltype = 'org') => {
        try {
            if (!gid || !token) {
                throw new Error('缺少 GID 或 token');
            }

            const archiveUrl = `https://e-hentai.org/archiver.php?gid=${gid}&token=${token}`;
            
            // 构建 POST 数据
            const formData = new FormData();
            formData.append('dltype', dltype);
            formData.append('dlcheck', 'Download Original Archive');

            console.log(`[triggerArchiveGeneration] 向 ${archiveUrl} 提交表单 (dltype=${dltype})`);

            const response = await fetch(archiveUrl, {
                method: 'POST',
                credentials: 'include',
                body: formData,
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const html = await response.text();
            console.log(`[triggerArchiveGeneration] 表单提交成功，响应长度: ${html.length}`);
            
            // 检查是否成功提交（如果返回"successfully prepared"说明立即完成了）
            if (html.includes('successfully prepared')) {
                console.log(`[triggerArchiveGeneration] 归档已立即完成`);
                return { triggered: true, readyNow: true };
            }

            // 检查是否是跳转页面（包含 document.location 的 JavaScript 重定向）
            const redirectMatch = html.match(/document\.location\s*=\s*["']([^"']+)["']/);
            if (redirectMatch) {
                const redirectUrl = redirectMatch[1];
                console.log(`[triggerArchiveGeneration] 检测到重定向 URL: ${redirectUrl}`);
                
                // 关键判断：如果 URL 指向 hath.network，说明文件已经准备好了！
                if (redirectUrl.includes('hath.network')) {
                    console.log(`[triggerArchiveGeneration] ✓ 文件已准备好！下载链接: ${redirectUrl}`);
                    return { 
                        triggered: true, 
                        readyNow: true,
                        downloadUrl: redirectUrl,
                    };
                } else {
                    // 其他类型的重定向（不太可能）
                    console.log(`[triggerArchiveGeneration] 检测到其他类型重定向`);
                    return { triggered: true, readyNow: false };
                }
            }

            // 否则表示正在生成
            console.log(`[triggerArchiveGeneration] 归档已触发，正在生成中`);
            return { triggered: true, readyNow: false };
        } catch (err) {
            console.warn(`[triggerArchiveGeneration] GID ${gid} 出错:`, err);
            throw err;
        }
    };

    // 验证单个画廊的归档链接是否准备好
    const verifyArchiveLink = async (gid, token) => {
        try {
            if (!gid || !token) {
                return { status: 'error', message: '缺少 GID 或 token' };
            }

            const archiveUrl = `https://e-hentai.org/archiver.php?gid=${gid}&token=${token}`;
            const response = await fetch(archiveUrl, {
                method: 'GET',
                credentials: 'include',
                timeout: 15000,
            });

            if (!response.ok) {
                return { status: 'error', message: `HTTP ${response.status}` };
            }

            const html = await response.text();

            // 检查是否是有效的 HTML 页面
            if (!(html.includes('<html') || html.includes('<!DOCTYPE'))) {
                return { status: 'waiting', message: '页面还在生成...' };
            }

            // 最重要的判断：检查是否包含"successfully prepared"的成功消息
            // 这表示归档文件已经真正生成好了
            if (html.includes('successfully prepared') || html.includes('ready for download')) {
                // 提取下载文件名
                const filenameMatch = html.match(/<strong>([^<]+\.zip)<\/strong>/);
                const filename = filenameMatch ? filenameMatch[1] : '未知';
                
                // 提取下载链接
                const linkMatch = html.match(/<a href="([^"]+)">Click Here/i);
                const downloadLink = linkMatch ? linkMatch[1] : '';

                return {
                    status: 'ready',
                    message: '已准备好',
                    filename,
                    downloadLink,
                };
            }

            // 其次检查是否在费用页面（表示还在等待用户确认）
            const hasArchiveInfo = html.includes('Download Cost') || 
                                   html.includes('下载费用') ||
                                   html.includes('Estimated Size') ||
                                   html.includes('预计大小');

            if (hasArchiveInfo) {
                // 这是费用确认页面，表示还未开始生成
                return { status: 'waiting', message: '等待确认 / 生成中...' };
            }

            // 都不是的情况
            return { status: 'waiting', message: '页面还在生成...' };
        } catch (err) {
            console.warn(`verifyArchiveLink(${gid}) 出错:`, err);
            return { status: 'error', message: err.message };
        }
    };

    const showArchivePreCheckDialog = async (entries, onConfirm) => {
        injectTooltipStyles();

        const dialog = ensureArchivePreCheckDialog();
        dialog.innerHTML = '';
        
        // 标志：是否处于"初始验证"阶段（用于判断是否自动发送）
        // 用对象包装以便在嵌套函数中修改
        const verificationState = { isInitial: true };

        // 头部
        const header = document.createElement('div');
        header.style.cssText = `
            padding: 12px 16px;
            border-bottom: 1px solid #ddd;
            display: flex;
            justify-content: space-between;
            align-items: center;
            flex-shrink: 0;
        `;

        const title = document.createElement('div');
        title.textContent = '归档下载预检';
        title.style.cssText = `
            font-size: 14px;
            font-weight: 600;
        `;
        header.appendChild(title);

        const closeBtn = document.createElement('button');
        closeBtn.textContent = '✕';
        closeBtn.style.cssText = `
            background: none;
            border: none;
            cursor: pointer;
            font-size: 18px;
            color: #999;
            padding: 0 4px;
        `;
        closeBtn.addEventListener('click', () => {
            dialog.remove();
        });
        header.appendChild(closeBtn);
        dialog.appendChild(header);

        // 结果区域
        const resultContainer = document.createElement('div');
        resultContainer.style.cssText = `
            flex: 1;
            overflow-y: auto;
            padding: 12px 16px;
        `;
        dialog.appendChild(resultContainer);

        // 底部按钮区域
        const footerArea = document.createElement('div');
        footerArea.style.cssText = `
            padding: 12px 16px;
            border-top: 1px solid #ddd;
            display: flex;
            gap: 8px;
            flex-shrink: 0;
        `;

        const confirmBtn = document.createElement('button');
        confirmBtn.textContent = '确认并发送';
        confirmBtn.style.cssText = `
            padding: 6px 12px;
            background: #5C0D12;
            color: white;
            border: none;
            border-radius: 3px;
            cursor: pointer;
            font-size: 12px;
            font-weight: 600;
            margin-left: auto;
        `;
        confirmBtn.addEventListener('click', () => {
            // 检查是否有已准备好的项
            const readyItems = entries.filter(e => e._verifyStatus === 'ready');
            if (readyItems.length === 0) {
                toastWarn('没有已准备好的项');
                return;
            }
            dialog.remove();
            onConfirm(readyItems);
        });
        footerArea.appendChild(confirmBtn);

        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = '取消';
        cancelBtn.style.cssText = `
            padding: 6px 12px;
            background: #f0f0f0;
            color: #333;
            border: 1px solid #ccc;
            border-radius: 3px;
            cursor: pointer;
            font-size: 12px;
        `;
        cancelBtn.addEventListener('click', () => {
            dialog.remove();
        });
        footerArea.appendChild(cancelBtn);

        dialog.appendChild(footerArea);

        if (!document.body.contains(dialog)) {
            document.body.appendChild(dialog);
        }

        dialog.style.display = 'flex';

        // 渲染预检结果
        renderArchivePreCheckResults(entries, resultContainer, confirmBtn);

        // 自动开始验证
        await performBatchVerification(entries, resultContainer, confirmBtn, verificationState);
    };

    const renderArchivePreCheckResults = (entries, container, confirmBtn) => {
        container.innerHTML = '';

        entries.forEach(entry => {
            const item = document.createElement('div');
            item.style.cssText = `
                padding: 10px 8px;
                border-bottom: 1px solid #eee;
                display: flex;
                gap: 12px;
                align-items: center;
            `;

            // 状态指示器
            const statusDiv = document.createElement('div');
            statusDiv.style.cssText = `
                width: 24px;
                height: 24px;
                border-radius: 50%;
                background: #f0f0f0;
                display: flex;
                align-items: center;
                justify-content: center;
                font-size: 12px;
                font-weight: 600;
                flex-shrink: 0;
            `;
            statusDiv.textContent = '⋯';
            statusDiv.className = 'archive-status-indicator';
            item.appendChild(statusDiv);

            // 内容
            const content = document.createElement('div');
            content.style.cssText = `
                flex: 1;
                font-size: 12px;
            `;

            const titleDiv = document.createElement('div');
            titleDiv.style.cssText = `
                font-weight: 600;
                margin-bottom: 3px;
                word-break: break-word;
            `;
            
            // 如果有重复，添加重复数量标识
            let titleText = entry.name || '未知';
            if (entry.duplicateCount && entry.duplicateCount > 1) {
                const dupSpan = document.createElement('span');
                dupSpan.textContent = ` [×${entry.duplicateCount}]`;
                dupSpan.style.cssText = `
                    color: #ff9800;
                    font-weight: bold;
                    margin-left: 4px;
                    cursor: help;
                `;
                dupSpan.title = '输入的地址有重复';
                
                titleDiv.textContent = titleText;
                titleDiv.appendChild(dupSpan);
            } else {
                titleDiv.textContent = titleText;
            }
            
            content.appendChild(titleDiv);

            const infoDiv = document.createElement('div');
            infoDiv.style.cssText = `
                color: #666;
                font-size: 11px;
            `;
            const infoParts = [];
            if (entry.gallery?.gid) infoParts.push(`GID: ${entry.gallery.gid}`);
            infoDiv.textContent = infoParts.join(' | ');
            content.appendChild(infoDiv);

            // 添加参考大小显示（初始为"未知"，将在验证时更新）
            const sizeDiv = document.createElement('div');
            sizeDiv.style.cssText = `
                color: #999;
                font-size: 10px;
                margin-top: 2px;
            `;
            sizeDiv.className = 'archive-size-info';
            sizeDiv.textContent = '参考大小: 未知';
            content.appendChild(sizeDiv);

            item.appendChild(content);

            // 按钮区域
            const buttonsDiv = document.createElement('div');
            buttonsDiv.style.cssText = `
                display: flex;
                gap: 6px;
                flex-shrink: 0;
                align-items: center;
            `;

            const statusText = document.createElement('span');
            statusText.style.cssText = `
                font-size: 11px;
                color: #666;
                min-width: 100px;
                text-align: right;
            `;
            statusText.textContent = '验证中...';
            buttonsDiv.appendChild(statusText);

            const openBtn = document.createElement('button');
            openBtn.textContent = '打开';
            openBtn.style.cssText = `
                padding: 4px 8px;
                background: #f0f0f0;
                border: 1px solid #ccc;
                border-radius: 2px;
                cursor: pointer;
                font-size: 11px;
                white-space: nowrap;
            `;
            openBtn.title = '打开画廊';
            openBtn.addEventListener('click', () => {
                if (entry.gallery?.href) {
                    window.open(entry.gallery.href, '_blank');
                }
            });
            buttonsDiv.appendChild(openBtn);

            const refreshBtn = document.createElement('button');
            refreshBtn.textContent = '刷新';
            refreshBtn.style.cssText = `
                padding: 4px 8px;
                background: #f0f0f0;
                border: 1px solid #ccc;
                border-radius: 2px;
                cursor: pointer;
                font-size: 11px;
                white-space: nowrap;
            `;
            refreshBtn.title = '手动刷新验证状态';
            refreshBtn.addEventListener('click', async () => {
                refreshBtn.disabled = true;
                refreshBtn.textContent = '刷新中...';
                statusText.textContent = '验证中...';
                statusText.style.color = '#666';

                // 用户手动刷新时，禁用自动发送
                verificationState.isInitial = false;

                // 如果已经有缓存的下载链接，直接显示为已准备好
                if (entry._downloadUrl) {
                    console.log(`[refreshBtn] GID ${entry.gallery.gid} 使用缓存的下载链接`);
                    const result = {
                        status: 'ready',
                        message: '已准备好',
                        downloadUrl: entry._downloadUrl,
                    };
                    updateStatusDisplay(statusDiv, statusText, result);
                } else {
                    // 否则重新验证
                    const result = await verifyArchiveLink(entry.gallery.gid, entry.gallery.token);
                    entry._verifyStatus = result.status;
                    entry._verifyInfo = result;
                    updateStatusDisplay(statusDiv, statusText, result);
                }

                refreshBtn.disabled = false;
                refreshBtn.textContent = '刷新';
            });
            buttonsDiv.appendChild(refreshBtn);

            item.appendChild(buttonsDiv);
            item.dataset.entryGid = entry.gallery?.gid || '';
            container.appendChild(item);
        });
    };

    const updateStatusDisplay = (statusDiv, statusText, result) => {
        switch (result.status) {
            case 'ready':
                statusDiv.textContent = '✓';
                statusDiv.style.background = '#e8f5e9';
                statusDiv.style.color = '#2e7d32';
                
                // 显示大小和费用，或者只显示"已准备好"
                if (result.size && result.cost) {
                    statusText.textContent = `${result.size} | ${result.cost}`;
                } else {
                    statusText.textContent = '已准备好';
                }
                statusText.style.color = '#2e7d32';
                break;
            case 'waiting':
                statusDiv.textContent = '⏳';
                statusDiv.style.background = '#fff3e0';
                statusDiv.style.color = '#f57c00';
                statusText.textContent = result.message;
                statusText.style.color = '#f57c00';
                break;
            case 'error':
            default:
                statusDiv.textContent = '✗';
                statusDiv.style.background = '#ffebee';
                statusDiv.style.color = '#c62828';
                statusText.textContent = result.message;
                statusText.style.color = '#c62828';
        }
    };

    // 用于控制验证的取消信号
    let verifyLinkCancelled = false;
    
    // 验证下载链接是否真正准备好（使用 GM_xmlhttpRequest）
    const verifyDownloadLinkReady = async (downloadUrl, maxRetries = 3) => {
        console.log(`[verifyLink] 开始验证下载链接: ${downloadUrl}`);
        verifyLinkCancelled = false;
        
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            // 检查是否被取消
            if (verifyLinkCancelled) {
                console.log(`[verifyLink] 验证已被取消（第${attempt}次尝试时）`);
                return { ready: false, cancelled: true, attempt };
            }
            
            const result = await new Promise((resolve) => {
                if (typeof GM_xmlhttpRequest === 'undefined') {
                    console.warn('[verifyLink] GM_xmlhttpRequest 不可用，使用降级方案');
                    resolve({ ready: true, method: 'fallback', attempt });
                    return;
                }

                GM_xmlhttpRequest({
                    method: 'HEAD',
                    url: downloadUrl,
                    timeout: 10000,
                    headers: {
                        'User-Agent': navigator.userAgent
                    },
                    onload: function(response) {
                        const responseHeaders = response.responseHeaders || '';
                        const contentType = responseHeaders.match(/[Cc]ontent-[Tt]ype:\s*([^\n]+)/)?.[1] || '';
                        const contentLength = responseHeaders.match(/[Cc]ontent-[Ll]ength:\s*(\d+)/)?.[1] || '0';
                        
                        console.log(`[verifyLink] 尝试 ${attempt}/${maxRetries}: Type=${contentType.split(';')[0]}, Size=${parseInt(contentLength)} bytes`);
                        
                        // 检查是否是有效的压缩包
                        const isZip = contentType.toLowerCase().includes('zip') || 
                                     contentType.toLowerCase().includes('octet-stream');
                        const size = parseInt(contentLength);
                        const hasRealSize = size > 500000; // 至少500KB
                        
                        if (isZip && hasRealSize) {
                            console.log(`[verifyLink] ✓ 文件准备好（第${attempt}次尝试）`);
                            resolve({ ready: true, attempt, reason: '压缩包已准备', size });
                        } else if (contentType.toLowerCase().includes('text/html') || size < 100000) {
                            // HTML 页面或文件太小，说明还在等待，返回 waiting 标记
                            console.log(`[verifyLink] ⏳ 还在等待，${attempt}/${maxRetries}...`);
                            resolve({ ready: false, waiting: true, attempt, reason: '文件还在准备' });
                        } else {
                            // 响应成功且有内容
                            console.log(`[verifyLink] ✓ 文件似乎准备好（第${attempt}次尝试）`);
                            resolve({ ready: true, attempt, reason: '响应正常', size });
                        }
                    },
                    onerror: function(error) {
                        console.log(`[verifyLink] 请求出错（第${attempt}次尝试）: ${error}`);
                        resolve({ ready: false, waiting: true, attempt, reason: '请求出错，将重试' });
                    },
                    ontimeout: function() {
                        console.log(`[verifyLink] 请求超时（第${attempt}次尝试）`);
                        resolve({ ready: false, waiting: true, attempt, reason: '请求超时，将重试' });
                    }
                });
            });
            
            // 如果文件准备好，立即返回
            if (result.ready) {
                return result;
            }
            
            // 如果达到最大重试次数，放行（让AB DM处理）
            if (attempt === maxRetries) {
                console.log(`[verifyLink] 达到最大重试次数，放行链接给AB DM处理`);
                return { ready: true, attempt, reason: '达到最大重试次数', allowAnyway: true };
            }
            
            // 如果还在等待，继续下一轮重试
            if (result.waiting) {
                const interval = getRandomInterval();
                console.log(`[verifyLink] 等待 ${interval}ms 后进行第 ${attempt + 1} 次尝试...`);
                await new Promise(r => setTimeout(r, interval));
            }
        }
    };

    const performBatchVerification = async (entries, container, confirmBtn, verificationState) => {
        const indicators = container.querySelectorAll('.archive-status-indicator');
        const statusTexts = container.querySelectorAll('span[style*="min-width: 100px"]');

        // 使用并发控制替代顺序循环处理验证
        // 构建任务数组，每个任务处理一个 entry 的验证
        const verificationTasks = entries.map((entry, i) => async () => {
            const statusDiv = indicators[i];
            const statusText = statusTexts[i];

            if (!statusDiv || !statusText) return;

            try {
                // 第一步：先触发归档生成（提交表单，扣 GP）
                console.log(`[performBatchVerification] 正在为 GID ${entry.gallery.gid} 触发归档生成...`);
                statusText.textContent = '触发生成...';
                statusText.style.color = '#666';

                const triggerResult = await triggerArchiveGeneration(
                    entry.gallery.gid,
                    entry.gallery.token,
                    'org'  // 原始档案
                );

                let verifyResult;

                // 检查是否已立即准备好（从 hath.network 链接判断）
                if (triggerResult.readyNow && triggerResult.downloadUrl) {
                    console.log(`[performBatchVerification] 归档已立即准备好`);
                    verifyResult = {
                        status: 'ready',
                        message: '已准备好',
                        downloadUrl: triggerResult.downloadUrl,
                    };
                    entry._verifyStatus = verifyResult.status;
                    entry._verifyInfo = verifyResult;
                    // 保存下载链接用于后续刷新使用（仅在当前会话有效）
                    entry._downloadUrl = triggerResult.downloadUrl;
                    
                    // 【新增】即使立即准备好，也要进行链接真实性验证
                    console.log(`[performBatchVerification] GID ${entry.gallery.gid} 进行下载链接真实性验证...`);
                    statusText.textContent = '验证链接中...';
                    statusText.style.color = '#FF9800';
                    
                    // 构建完整的下载URL（可能已经是完整URL或相对路径）
                    let fullDownloadUrl = triggerResult.downloadUrl;
                    if (!fullDownloadUrl.startsWith('http')) {
                        // 如果是相对路径，需要加上域名和?start=1
                        fullDownloadUrl = `${fullDownloadUrl}?start=1`;
                    } else if (!fullDownloadUrl.includes('?start=1')) {
                        // 如果已经是完整URL但没有?start=1，添加参数
                        fullDownloadUrl = `${fullDownloadUrl}?start=1`;
                    }
                    
                    const linkVerification = await verifyDownloadLinkReady(fullDownloadUrl);
                    
                    if (!linkVerification.ready) {
                        console.warn(`[performBatchVerification] GID ${entry.gallery.gid} 链接验证未通过: ${linkVerification.reason}`);
                        verifyResult.linkVerifyResult = linkVerification;
                        verifyResult.linkVerifyWarning = `链接验证未通过 (${linkVerification.reason})`;
                        // 【重要】如果链接验证失败，更新状态为 'waiting'，这样就不会自动发送
                        entry._verifyStatus = 'waiting';
                        verifyResult.status = 'waiting';
                        console.log(`[performBatchVerification] 更新 GID ${entry.gallery.gid} 状态为 'waiting'，不会自动发送`);
                    } else {
                        console.log(`[performBatchVerification] GID ${entry.gallery.gid} 链接验证通过（${linkVerification.attempt}次尝试）`);
                        verifyResult.linkVerifyResult = linkVerification;
                    }
                } else {
                    // 第二步：验证生成状态（如果还未完成）
                    console.log(`[performBatchVerification] 开始验证 GID ${entry.gallery.gid}...`);
                    verifyResult = await verifyArchiveLink(entry.gallery.gid, entry.gallery.token);
                    entry._verifyStatus = verifyResult.status;
                    entry._verifyInfo = verifyResult;
                    
                    // 【新增】如果获得了下载链接，进行真实性验证
                    if (verifyResult.downloadUrl && verifyResult.status === 'ready') {
                        console.log(`[performBatchVerification] GID ${entry.gallery.gid} 进行下载链接真实性验证...`);
                        statusText.textContent = '验证链接中...';
                        statusText.style.color = '#FF9800';
                        
                        // 构建完整的下载URL（可能已经是完整URL或相对路径）
                        let fullDownloadUrl = verifyResult.downloadUrl;
                        if (!fullDownloadUrl.startsWith('http')) {
                            // 如果是相对路径，需要加上域名和?start=1
                            fullDownloadUrl = `${fullDownloadUrl}?start=1`;
                        } else if (!fullDownloadUrl.includes('?start=1')) {
                            // 如果已经是完整URL但没有?start=1，添加参数
                            fullDownloadUrl = `${fullDownloadUrl}?start=1`;
                        }
                        
                        const linkVerification = await verifyDownloadLinkReady(fullDownloadUrl);
                        
                        if (!linkVerification.ready) {
                            console.warn(`[performBatchVerification] GID ${entry.gallery.gid} 链接验证未通过: ${linkVerification.reason}`);
                            verifyResult.linkVerifyResult = linkVerification;
                            verifyResult.linkVerifyWarning = `链接验证未通过 (${linkVerification.reason})`;
                            // 【重要】如果链接验证失败，更新状态为 'waiting'，这样就不会自动发送
                            entry._verifyStatus = 'waiting';
                            verifyResult.status = 'waiting';
                            console.log(`[performBatchVerification] 更新 GID ${entry.gallery.gid} 状态为 'waiting'，不会自动发送`);
                        } else {
                            console.log(`[performBatchVerification] GID ${entry.gallery.gid} 链接验证通过（${linkVerification.attempt}次尝试）`);
                            verifyResult.linkVerifyResult = linkVerification;
                        }
                    }

                    // 如果还没准备好，等待一段时间后重新验证（最多重试 5 次）
                    if (verifyResult.status !== 'ready') {
                        for (let retryCount = 0; retryCount < 5; retryCount++) {
                            console.log(`[performBatchVerification] 等待后重试 (${retryCount + 1}/5)...`);
                            statusText.textContent = `生成中 (${retryCount + 1}/5)...`;
                            await new Promise(r => setTimeout(r, getRandomInterval()));

                            verifyResult = await verifyArchiveLink(entry.gallery.gid, entry.gallery.token);
                            entry._verifyStatus = verifyResult.status;
                            entry._verifyInfo = verifyResult;

                            if (verifyResult.status === 'ready') {
                                console.log(`[performBatchVerification] GID ${entry.gallery.gid} 已准备好`);
                                break;
                            }
                        }
                    }
                }

                // 获取并显示参考大小信息
                try {
                    const archiveInfo = await fetchArchiveInfo(entry.gallery.gid, entry.gallery.token);
                    if (archiveInfo && archiveInfo.size) {
                        // 通过 statusDiv 的父容器找到 sizeDiv
                        const itemDiv = statusDiv.closest('div[style*="border-bottom"]');
                        if (itemDiv) {
                            const sizeDiv = itemDiv.querySelector('.archive-size-info');
                            if (sizeDiv) {
                                sizeDiv.textContent = `参考大小: ${archiveInfo.size}`;
                            }
                        }
                    }
                } catch (e) {
                    console.warn(`[performBatchVerification] 获取 GID ${entry.gallery.gid} 参考大小失败:`, e);
                }

                updateStatusDisplay(statusDiv, statusText, verifyResult);
            } catch (err) {
                console.warn(`[performBatchVerification] GID ${entry.gallery.gid} 出错:`, err);
                const errorResult = {
                    status: 'error',
                    message: err.message || '未知错误',
                };
                entry._verifyStatus = 'error';
                entry._verifyInfo = errorResult;
                updateStatusDisplay(statusDiv, statusText, errorResult);
            }

            // 简单延迟以避免过快
            await new Promise(r => setTimeout(r, 500));
        });

        // 执行并发验证，使用进度回调更新 UI
        await executeWithConcurrencyLimit(verificationTasks, null, (completed, total) => {
            // 可以在这里更新全局进度显示
            console.log(`[performBatchVerification] 验证进度: ${completed}/${total}`);
        });

        // 验证完成后，检查是否全部准备好
        if (verificationState && verificationState.isInitial) {
            const allReady = entries.every(e => e._verifyStatus === 'ready');
            if (allReady) {
                console.log('[performBatchVerification] 所有项都已准备好，自动发送');
                confirmBtn.click();
            }
        }
    };

    const renderBatchQueryResults = (entries, container, selectedCountSpan, fetchAllBtnRef, autoFetchCheckboxRef, isAutoClickingFetchAllRef, unfoundItems = [], failedResults = [], validEntriesCount = 0, totalCount = 0) => {
        container.innerHTML = '';
        
        // 调试日志
        console.log('[renderBatchQueryResults] entries 信息:');
        entries.forEach((e, i) => {
            console.log(`  [${i}] ${e.name} - duplicateCount: ${e.duplicateCount}`);
        });
        
        // 定义更新选择计数的函数
        const updateSelectedCount = () => {
            // 不计算已禁用的复选框
            const checked = container.querySelectorAll('input[type="checkbox"]:checked:not([data-select-all]):not([disabled])').length;
            // 显示查询结果统计：已找到/未找到（只统计有有效数据的项）
            // 使用传入的总数，如果没有则计算
            const total = totalCount || (validEntriesCount || entries.length) + unfoundItems.length;
            const foundCount = validEntriesCount || entries.length;
            const unfoundCount = unfoundItems.length;
            
            let statsText = `已选择: ${checked} | 已找到: ${foundCount}/${total}`;
            if (unfoundCount > 0) {
                statsText += ` | 未找到: ${unfoundCount}`;
            }
            selectedCountSpan.textContent = statsText;
        };
        
        // 显示未查询到的链接（如果有）
        if (unfoundItems && unfoundItems.length > 0) {
            const unfoundSection = document.createElement('div');
            unfoundSection.style.cssText = `
                padding: 12px;
                margin-bottom: 12px;
                background: #fff3cd;
                border: 1px solid #ffc107;
                border-radius: 4px;
                font-size: 12px;
            `;
            
            const unfoundHeader = document.createElement('div');
            unfoundHeader.style.cssText = `
                font-weight: 600;
                color: #856404;
                margin-bottom: 6px;
                text-align: center;
            `;
            unfoundHeader.textContent = `⚠️ 未查询到结果 (${unfoundItems.length}/${entries.length + unfoundItems.length})`;
            unfoundSection.appendChild(unfoundHeader);
            
            const unfoundList = document.createElement('div');
            unfoundList.style.cssText = `
                max-height: 150px;
                overflow-y: auto;
                color: #856404;
                line-height: 1.6;
            `;
            
            unfoundItems.forEach((item) => {
                const itemDiv = document.createElement('div');
                itemDiv.style.cssText = `
                    padding: 4px 0;
                    word-break: break-all;
                    font-family: monospace;
                    font-size: 11px;
                    text-align: left;
                `;
                
                // 如果有重复，添加重复计数标识
                if (item.duplicateCount && item.duplicateCount > 1) {
                    itemDiv.textContent = item.value;
                    
                    const dupSpan = document.createElement('span');
                    dupSpan.textContent = ` [×${item.duplicateCount}]`;
                    dupSpan.style.cssText = `
                        color: #ff9800;
                        font-weight: bold;
                        margin-left: 4px;
                        user-select: none;
                        cursor: help;
                    `;
                    dupSpan.title = '输入的地址有重复';
                    
                    itemDiv.appendChild(dupSpan);
                } else {
                    itemDiv.textContent = item.value;
                }
                
                unfoundList.appendChild(itemDiv);
            });
            
            unfoundSection.appendChild(unfoundList);
            container.appendChild(unfoundSection);
        }
        
        // 全选/取消复选框
        const selectAllDiv = document.createElement('div');
        selectAllDiv.style.cssText = `
            padding: 8px;
            border-bottom: 1px solid #eee;
            display: flex;
            align-items: center;
            gap: 8px;
        `;
        
        const selectAllCheckbox = document.createElement('input');
        selectAllCheckbox.type = 'checkbox';
        selectAllCheckbox.checked = true; // 默认选中（因为所有项目都默认选中）
        selectAllCheckbox.dataset.selectAll = 'true';
        selectAllCheckbox.addEventListener('change', (e) => {
            const checkboxes = container.querySelectorAll('input[type="checkbox"]:not([data-select-all])');
            checkboxes.forEach(cb => cb.checked = e.target.checked);
            updateSelectedCount();
        });
        selectAllDiv.appendChild(selectAllCheckbox);
        
        const selectAllLabel = document.createElement('label');
        selectAllLabel.textContent = '全选';
        selectAllLabel.style.cursor = 'pointer';
        selectAllDiv.appendChild(selectAllLabel);
        
        container.appendChild(selectAllDiv);

        // 结果项目
        entries.forEach(entry => {
            const item = document.createElement('div');
            item.style.cssText = `
                padding: 10px 8px;
                border-bottom: 1px solid #eee;
                display: flex;
                gap: 12px;
                align-items: center;
            `;

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.dataset.archiveKey = entry.archiveKey;
            checkbox.dataset.archiveDltype = entry.archiveDltype;
            checkbox.dataset.gid = entry.gallery?.gid || '';
            checkbox.dataset.href = entry.gallery?.href || '';
            checkbox.dataset.token = entry.gallery?.token || '';
            checkbox.style.marginTop = '0';
            checkbox.style.flexShrink = '0';
            
            // 【新增】保存复选框引用到 entry 对象，供后续使用（如标记已下载后取消勾选）
            entry._checkbox = checkbox;
            
            // 特别处理"未知"项（无效查询结果）
            if (entry.name === '未知') {
                checkbox.disabled = true;
                checkbox.checked = false;
                checkbox.style.opacity = '0.4';
                checkbox.style.cursor = 'not-allowed';
                checkbox.title = '查询失败，无法发送。点击"重试"重新获取。';
            } else {
                checkbox.checked = true; // 有效项默认选中
                checkbox.addEventListener('change', updateSelectedCount);
            }
            
            item.appendChild(checkbox);

            const content = document.createElement('div');
            content.style.cssText = `
                flex: 1;
                font-size: 12px;
            `;

            // 标题
            const titleDiv = document.createElement('div');
            titleDiv.style.cssText = `
                font-weight: 600;
                margin-bottom: 3px;
                word-break: break-word;
            `;
            
            // 如果有重复，添加重复数量标识
            let titleText = entry.name || '未知';
            if (entry.duplicateCount && entry.duplicateCount > 1) {
                const dupSpan = document.createElement('span');
                dupSpan.textContent = ` [×${entry.duplicateCount}]`;
                dupSpan.style.cssText = `
                    color: #ff9800;
                    font-weight: bold;
                    margin-left: 4px;
                    cursor: help;
                `;
                dupSpan.title = '输入的地址有重复';
                
                titleDiv.textContent = titleText;
                titleDiv.appendChild(dupSpan);
            } else {
                titleDiv.textContent = titleText;
            }
            
            content.appendChild(titleDiv);

            // 信息行
            const infoDiv = document.createElement('div');
            infoDiv.style.cssText = `
                color: #666;
                font-size: 11px;
            `;
            const infoParts = [];
            if (entry.gallery?.gid) infoParts.push(`GID: ${entry.gallery.gid}`);
            if (entry.size) infoParts.push(`参考大小: ${entry.size}`);
            if (entry.postedTime) infoParts.push(`${entry.postedTime}`);
            if (entry.batchOperationText) infoParts.push(`标记: ${entry.batchOperationText}`);
            infoDiv.textContent = infoParts.join(' | ');
            content.appendChild(infoDiv);

            item.appendChild(content);

            // 按钮区域（右侧）
            const buttonsDiv = document.createElement('div');
            buttonsDiv.style.cssText = `
                display: flex;
                gap: 6px;
                flex-shrink: 0;
                align-items: center;
            `;

            // 归档信息显示区域
            const archiveInfoSpan = document.createElement('span');
            archiveInfoSpan.style.cssText = `
                font-size: 11px;
                color: #666;
                min-width: 80px;
                text-align: right;
            `;
            // 显示成本信息（已获取）或占位符（未获取）
            if (entry.cost && entry.size && entry.cost !== '待获取' && entry.size !== '待获取') {
                archiveInfoSpan.textContent = `${entry.size} | ${entry.cost}`;
                archiveInfoSpan.style.color = '#333';
            } else {
                archiveInfoSpan.textContent = '待获取 | 待获取';
                archiveInfoSpan.style.color = '#ccc';
            }
            buttonsDiv.appendChild(archiveInfoSpan);

            const openBtn = document.createElement('button');
            openBtn.textContent = '打开';
            openBtn.style.cssText = `
                padding: 4px 8px;
                background: #f0f0f0;
                border: 1px solid #ccc;
                border-radius: 2px;
                cursor: pointer;
                font-size: 11px;
                white-space: nowrap;
            `;
            openBtn.title = '打开画廊';
            openBtn.addEventListener('click', () => {
                if (entry.gallery?.href) {
                    window.open(entry.gallery.href, '_blank');
                }
            });
            buttonsDiv.appendChild(openBtn);

            const fetchBtn = document.createElement('button');
            fetchBtn.style.cssText = `
                padding: 4px 8px;
                background: #f0f0f0;
                border: 1px solid #ccc;
                border-radius: 2px;
                cursor: pointer;
                font-size: 11px;
                white-space: nowrap;
            `;
            
            // 如果已经有成本信息（来自自动查询模式），显示✓并禁用按钮
            // 注意：排除"待获取"这样的占位符值
            if (entry.cost && entry.size && entry.cost !== '待获取' && entry.size !== '待获取') {
                fetchBtn.textContent = '✓';
                fetchBtn.style.background = '#e8f5e9';
                fetchBtn.disabled = true;
                fetchBtn.style.cursor = 'default';
                fetchBtn.title = '归档信息已获取';
            } else {
                // 没有成本信息的情况（手动查询或缓存中的项），显示"获取"按钮
                fetchBtn.textContent = '获取';
                fetchBtn.title = '获取归档信息（大小、所需GP）';
                fetchBtn.addEventListener('click', async () => {
                    fetchBtn.disabled = true;
                    fetchBtn.textContent = '获取中...';
                    try {
                        const archiveInfo = await fetchArchiveInfo(entry.gallery.gid, entry.gallery.token);
                        if (archiveInfo) {
                            // 更新右侧的归档信息显示
                            archiveInfoSpan.textContent = `${archiveInfo.size} | ${archiveInfo.cost}`;
                            archiveInfoSpan.style.color = '#333';
                            
                            // 更新左侧的"参考大小"显示
                            const infoParts = [];
                            if (entry.gallery?.gid) infoParts.push(`GID: ${entry.gallery.gid}`);
                            if (archiveInfo.size) infoParts.push(`参考大小: ${archiveInfo.size}`);
                            if (entry.postedTime) infoParts.push(`${entry.postedTime}`);
                            if (entry.batchOperationText) infoParts.push(`标记: ${entry.batchOperationText}`);
                            infoDiv.textContent = infoParts.join(' | ');
                            
                            // 如果这个项原本是"未知"（禁用状态），现在恢复复选框并自动勾选
                            if (checkbox.disabled) {
                                checkbox.disabled = false;
                                checkbox.checked = true;
                                checkbox.style.opacity = '1';
                                checkbox.style.cursor = 'pointer';
                                checkbox.title = '';
                                checkbox.addEventListener('change', updateSelectedCount);
                                updateSelectedCount();  // 更新统计
                            }
                            
                            fetchBtn.textContent = '✓';
                            fetchBtn.style.background = '#e8f5e9';
                            fetchBtn.style.cursor = 'default';
                            fetchBtn.title = '归档信息已获取';
                        } else {
                            archiveInfoSpan.textContent = '获取失败';
                            archiveInfoSpan.style.color = '#d9534f';
                            fetchBtn.textContent = '重试';
                            fetchBtn.disabled = false;
                        }
                    } catch (err) {
                        console.warn('获取归档信息失败:', err);
                        archiveInfoSpan.textContent = '错误';
                        archiveInfoSpan.style.color = '#d9534f';
                        fetchBtn.textContent = '重试';
                        fetchBtn.disabled = false;
                    }
                });
            }
            buttonsDiv.appendChild(fetchBtn);

            item.appendChild(buttonsDiv);
            container.appendChild(item);
        });

        updateSelectedCount();
        
        // 如果勾选了"自动获取"，则在渲染完成后自动点击"全部获取"
        // 但在自动查询模式下，已经在后台异步执行了查询，所以不需要再点击按钮
        if (autoFetchCheckboxRef && autoFetchCheckboxRef.checked && !isAutoClickingFetchAllRef?.value) {
            setTimeout(() => {
                if (fetchAllBtnRef) {
                    fetchAllBtnRef.click();
                }
            }, 300);
        }
    };

    // 在详情页添加AB DM归档按钮
    const injectArchiveButtonOnDetailPage = () => {
        // 首先注入 CSS 样式
        if (!document.getElementById('eh-abdm-archive-button-style')) {
            const style = document.createElement('style');
            style.id = 'eh-abdm-archive-button-style';
            style.textContent = `
                .eh-abdm-archive-button {
                    width: 15px;
                    height: 15px;
                    background: radial-gradient(#4CAF50, #2E7D32);
                    border-radius: 15px;
                    border: 1px #333 solid;
                    box-sizing: border-box;
                    color: #fff;
                    text-align: center;
                    line-height: 15px;
                    cursor: pointer;
                    user-select: none;
                    display: inline-block;
                    margin-left: 8px;
                    vertical-align: middle;
                    font-size: 10px;
                    font-weight: bold;
                    text-decoration: none;
                    transition: all 0.2s ease;
                    position: relative;
                    top: -0.5px;
                }
                .eh-abdm-archive-button:hover {
                    background: radial-gradient(#66BB6A, #1B5E20);
                    box-shadow: 0 0 8px rgba(76, 175, 80, 0.6);
                    transform: scale(1.1);
                }
                .eh-abdm-archive-button:active {
                    transform: scale(0.95);
                }
            `;
            document.head.appendChild(style);
        }

        try {
            // 查找归档下载链接（中文版）
            let archiveLink = Array.from(document.querySelectorAll('a')).find(a => 
                a.textContent.includes('归档下载') && a.getAttribute('onclick')?.includes('archiver.php')
            );
            
            // 如果没找到中文版，查找英文版
            if (!archiveLink) {
                archiveLink = Array.from(document.querySelectorAll('a')).find(a => 
                    a.textContent.includes('Archive Download') && a.getAttribute('onclick')?.includes('archiver.php')
                );
            }

            if (!archiveLink || archiveLink.dataset.abdmInjected) return;

            // 提取 GID 和 token
            const onclickAttr = archiveLink.getAttribute('onclick');
            const archiveUrlMatch = onclickAttr?.match(/popUp\('([^']+)'/);
            if (!archiveUrlMatch) return;

            const archivePageUrl = archiveUrlMatch[1];
            const gidMatch = archivePageUrl.match(/gid=(\d+)/);
            const tokenMatch = archivePageUrl.match(/token=([a-f0-9]+)/);

            if (!gidMatch || !tokenMatch) return;

            const gid = gidMatch[1];
            const token = tokenMatch[1];

            // 创建AB DM归档按钮
            const abdmBtn = document.createElement('a');
            abdmBtn.href = '#';
            abdmBtn.textContent = '🡇';
            abdmBtn.className = 'eh-abdm-archive-button';
            abdmBtn.title = '发送到AB DM（归档）';
            abdmBtn.dataset.abdmInjected = '1';
            
            abdmBtn.addEventListener('click', async (e) => {
                e.preventDefault();
                e.stopPropagation();

                // 从最近下载中查询该画廊的信息
                const recentBatches = await loadRecentBatches();
                let recentEntry = null;
                for (const batch of recentBatches || []) {
                    const found = batch.entries.find(e => e.gallery?.gid === gid);
                    if (found) {
                        recentEntry = found;
                        break;
                    }
                }

                // 获取标题
                const titleElement = document.querySelector('h1[id*="gn"], h1.gn, [id*="gTitle"]');
                let titleText = recentEntry?.name || titleElement?.textContent?.trim() || '未知';

                // 准备条目用于预检
                const entryToPrecheck = {
                    name: titleText,
                    gid: gid,
                    token: token,
                    href: window.location.href,
                    gallery: {
                        gid: gid,
                        token: token,
                        href: window.location.href,
                    },
                };

                // 打开预检对话框
                await showArchivePreCheckDialog([entryToPrecheck], async (readyItems) => {
                    const isAvailable = await checkAbdmAvailable();
                    if (!isAvailable) {
                        toastError(`AB Download Manager 未运行，请确保已启动`);
                        return;
                    }

                    toastInfo('正在获取归档下载链接...');

                    try {
                        const archiveInfo = await fetchArchiveDownloadInfo({
                            gid: gid,
                            token: token,
                            pageLink: window.location.href,
                        });

                        await sendToAbdm([{
                            link: archiveInfo.downloadUrl,
                            downloadPage: window.location.href,
                            suggestedName: archiveInfo.fileName,
                        }]);

                        toastSuccess('已发送到 AB Download Manager');
                    } catch (err) {
                        toastError(`获取归档下载链接失败：${err.message || err}`);
                        console.error('[EhMagnet] AB DM 归档下载失败', err);
                    }
                });
            });

            // 插入到归档下载链接后面
            archiveLink.parentNode.insertBefore(abdmBtn, archiveLink.nextSibling);
        } catch (err) {
            console.warn('[EhMagnet] 注入AB DM归档按钮失败:', err);
        }
    };

    const scan = (root = document) => {
        console.log('[EhMagnet] scan() 开始执行');
        if (!galleryInjectionDone && !galleryInjectionPending) {
            console.log('[EhMagnet] scan() 调用 injectGalleryTorrentLinks()');
            injectGalleryTorrentLinks();
        }

        const blocks = root.querySelectorAll('.gl5t');
        console.log('[EhMagnet] scan() 找到', blocks.length, '个 .gl5t 元素');
        
        // 为每个画廊计算优先级（考虑可视区域 + 页面顺序 + 是否已处理）
        const blocksWithPriority = Array.from(blocks).map((block, index) => {
            let priority = 1; // 默认低优先级
            const inViewport = isInViewport(block);
            const alreadyProcessed = block.dataset.ehMagnetAttached === '1';
            
            // 跳过已处理的画廊
            if (alreadyProcessed) {
                return { block, index, priority: -1, skip: true };
            }
            
            // 可视区域内的画廊 = 最高优先级
            if (inViewport) {
                priority = 10;
            } 
            // 不在可视区域，但根据顺序给予递减的优先级
            else {
                // 前面的画廊优先级稍高（2-5），后面的优先级更低（1）
                priority = Math.max(1, 5 - Math.floor(index / 20));
            }
            
            return { block, index, priority, skip: false };
        }).filter(item => !item.skip); // 过滤掉已处理的
        
        // 按优先级排序，优先级高的先处理
        blocksWithPriority.sort((a, b) => b.priority - a.priority);
        
        blocksWithPriority.forEach(({block, index, priority}) => {
            console.log(`[EhMagnet] scan() 处理第 ${index + 1} 个画廊`);
            if (!(block instanceof HTMLElement) || block.dataset.ehMagnetAttached === '1') {
                console.log(`[EhMagnet] scan() 跳过第 ${index + 1} 个画廊（不是HTMLElement或已处理）`);
                return;
            }
            console.log(`[EhMagnet] scan() 查找种子链接...`);
            const torrentLink = block.querySelector('.gldown a[href*="gallerytorrents.php"]');
            console.log(`[EhMagnet] scan() 种子链接:`, torrentLink?.href || '未找到');
            const galleryContainer = block.closest('.gl1t') || block.closest('tr');
            const galleryLink = galleryContainer?.querySelector('.glname a[href*="/g/"]')
                || galleryContainer?.querySelector('a[href*="/g/"]')
                || galleryContainer?.querySelector('a[href*="/s/"]');
            const galleryInfo = parseGalleryInfo(galleryLink?.href || '');
            const galleryTitle = galleryContainer?.querySelector('.glname a')?.textContent?.trim()
                || block.querySelector('.glname a')?.textContent?.trim()
                || '';
            console.log(`[EhMagnet] scan() galleryTitle:`, galleryTitle);
            if (!torrentLink) {
                console.log(`[EhMagnet] scan() 没有种子链接，创建存档回退`);
                if (!block.dataset.ehMagnetAttached) {
                    console.log(`[EhMagnet] scan() 创建容器...`);
                    const container = document.createElement('div');
                    container.className = 'eh-magnet-links';
                    container.style.marginTop = '4px';
                    container.style.fontSize = '11px';
                    container.style.lineHeight = '1.4';
                    container.style.wordBreak = 'break-all';
                    if (galleryInfo?.gid) {
                        container.dataset.galleryGid = galleryInfo.gid;
                        container.dataset.galleryToken = galleryInfo.token || '';
                        container.dataset.galleryHref = galleryInfo.href || '';
                    }
                    if (galleryTitle) container.dataset.galleryTitle = galleryTitle;
                    console.log(`[EhMagnet] scan() 调用 createArchiveFallbackRow...`);
                    createArchiveFallbackRow(container, {
                        galleryInfo: galleryInfo?.gid
                            ? { ...galleryInfo, title: galleryTitle || galleryInfo.title || '' }
                            : null,
                        message: '⚠️ 未找到种子，将改用存档下载',
                        dltype: 'org',
                        title: galleryTitle,
                    });
                    console.log(`[EhMagnet] scan() createArchiveFallbackRow 完成`);
                    if (galleryInfo?.gid) {
                        console.log(`[EhMagnet] scan() 调用 ensureGalleryIgnoreToggle...`);
                        const postedNode = galleryContainer?.querySelector('.gl5t > div > div[id^="posted_"]')
                            || block.querySelector(':scope > div > div[id^="posted_"]');
                        if (postedNode) {
                            ensureGalleryIgnoreToggle(postedNode, galleryInfo);
                            console.log(`[EhMagnet] scan() ensureGalleryIgnoreToggle 完成`);
                        }
                    }
                    console.log(`[EhMagnet] scan() 插入容器到DOM...`);
                    block.insertAdjacentElement('afterend', container);
                    console.log(`[EhMagnet] scan() 调用 updateStatusFlags...`);
                    updateStatusFlags();
                    console.log(`[EhMagnet] scan() updateStatusFlags 完成`);
                }
                const fallbackEnrichedInfo = galleryInfo?.gid
                    ? { ...galleryInfo, title: galleryTitle || galleryInfo.title || '' }
                    : null;
                ensureGalleryActionMenuButton(block, galleryInfo, galleryTitle, fallbackEnrichedInfo);
                block.dataset.ehMagnetAttached = '1';
                return;
            }

            const postedNode = block.querySelector(':scope > div > div[id^="posted_"]');
            if (postedNode && galleryInfo?.gid) {
                ensureGalleryIgnoreToggle(postedNode, galleryInfo);
            }

            block.dataset.ehMagnetAttached = '1';
            const enrichedGalleryInfo = galleryInfo
                ? { ...galleryInfo, title: galleryTitle || galleryInfo.title || '' }
                : null;
            
            // 添加功能菜单按钮（在 ⛔ 左侧）
            ensureGalleryActionMenuButton(block, galleryInfo, galleryTitle, enrichedGalleryInfo);

            let cacheApplied = false;
            if (downloadCacheEnabled) {
                cacheApplied = renderCachedDownloadInfoForBlock(block, { forceRebuild: false });
            }

            // 如果没有缓存，且没有已存在的磁链容器，创建pending状态的归档回退行
            if (!cacheApplied) {
                const existingContainer = block.nextElementSibling;
                const isExistingMagnetContainer = existingContainer?.classList.contains('eh-magnet-links');
                
                if (!isExistingMagnetContainer) {
                    console.log(`[EhMagnet] scan() 没有缓存，创建pending状态的归档回退行`);
                    const container = document.createElement('div');
                    container.className = 'eh-magnet-links';
                    container.style.marginTop = '4px';
                    container.style.fontSize = '11px';
                    container.style.lineHeight = '1.4';
                    container.style.wordBreak = 'break-all';
                    if (galleryInfo?.gid) {
                        container.dataset.galleryGid = galleryInfo.gid;
                        container.dataset.galleryToken = galleryInfo.token || '';
                        container.dataset.galleryHref = galleryInfo.href || '';
                    }
                    if (galleryTitle) container.dataset.galleryTitle = galleryTitle;
                    
                    createArchiveFallbackRow(container, {
                        galleryInfo: enrichedGalleryInfo,
                        message: 'ℹ️ 请先获取下载信息',
                        dltype: 'org',
                        title: galleryTitle,
                        isPendingInfo: true,
                    });
                    
                    block.insertAdjacentElement('afterend', container);
                    
                    // 添加画廊级忽略切换按钮
                    const postedNodeForPending = galleryContainer?.querySelector('.gl5t > div > div[id^="posted_"]')
                        || block.querySelector(':scope > div > div[id^="posted_"]');
                    if (postedNodeForPending && galleryInfo?.gid) {
                        ensureGalleryIgnoreToggle(postedNodeForPending, galleryInfo);
                    }
                    
                    updateStatusFlags();
                }
            }

            // 立即显示画廊级别的已下载标记（无需等待种子信息）
            if (galleryInfo?.gid && downloadedGalleries.has(String(galleryInfo.gid))) {
                refreshGalleryPostedBadges(galleryInfo.gid);
                console.log(`[EhMagnet] scan() 更新已下载状态 (gid: ${galleryInfo.gid})`);
            }
            
            // 添加鼠标悬停监听（主动浏览时优先加载）
            // 绑定到整个画廊容器，这样鼠标移动到封面也能触发
            const targetElement = galleryContainer || block;
            let hoverTimer = null;
            let lastMouseX = null;
            let lastMouseY = null;
            
            let hasRealMouseMove = false; // 标记是否有真实的鼠标移动
            
            // 使用元素绑定数据存储上次坐标，这样每个画廊独立记录
            if (!targetElement.dataset.lastMouseX) {
                targetElement.dataset.lastMouseX = '';
                targetElement.dataset.lastMouseY = '';
            }
            
            const mouseEnterHandler = (e) => {
                // 检查是否开启了鼠标悬停刷新
                if (!hoverRefreshEnabled) return;
                
                // 如果正在复制磁链，禁用悬停刷新
                if (isCopyingMagnets) return;
                
                const prevX = targetElement.dataset.lastMouseX;
                const prevY = targetElement.dataset.lastMouseY;
                
                // 检查是否是真实的鼠标移动进入
                if (prevX && prevY) {
                    const lastX = parseInt(prevX);
                    const lastY = parseInt(prevY);
                    if (e.clientX !== lastX || e.clientY !== lastY) {
                        // 坐标不同，说明鼠标真正移动了
                        hasRealMouseMove = true;
                    } else {
                        // 坐标相同，可能是滚轮导致的
                        hasRealMouseMove = false;
                    }
                } else {
                    // 首次进入，无法判断，等待 mousemove 确认
                    hasRealMouseMove = false;
                }
                
                // 记录当前鼠标坐标
                targetElement.dataset.lastMouseX = String(e.clientX);
                targetElement.dataset.lastMouseY = String(e.clientY);
                lastMouseX = e.clientX;
                lastMouseY = e.clientY;
                
                // 鼠标进入后，等待一段时间（300ms）才触发
                hoverTimer = setTimeout(() => {
                    // 检查是否有真实的鼠标移动
                    // 如果没有移动（滚轮导致的 mouseenter），则不触发
                    if (!hasRealMouseMove) {
                        console.log('[EhMagnet] 滚轮滚动触发的 mouseenter，已忽略:', torrentLink.href);
                        return;
                    }
                    
                    const cacheKey = getMagnetCacheKey(torrentLink.href);

                    if (!magnetCache.has(cacheKey)) {
                        if (autoRefreshEnabled) {
                            // 自动刷新模式：只需插队
                            magnetRequestQueue.promoteTask(cacheKey);
                        } else {
                            // 手动模式：鼠标悬停时才加载
                            console.log('[EhMagnet] 鼠标悬停触发加载:', torrentLink.href);
                            injectMagnets(block, torrentLink.href, enrichedGalleryInfo, 100);
                        }
                    }
                }, 300); // 悬停 300ms 后触发
            };
            
            const mouseMoveHandler = (e) => {
                // 检测鼠标真正移动（坐标变化）
                if (lastMouseX !== null && (e.clientX !== lastMouseX || e.clientY !== lastMouseY)) {
                    // 标记为真实的鼠标移动
                    hasRealMouseMove = true;
                    // 鼠标真正移动了，重新开始计时
                    if (hoverTimer) {
                        clearTimeout(hoverTimer);
                    }
                    mouseEnterHandler(e);
                }
            };
            
            const mouseLeaveHandler = (e) => {
                // 鼠标离开时取消定时器
                if (hoverTimer) {
                    clearTimeout(hoverTimer);
                    hoverTimer = null;
                }
                
                // 记录离开时的鼠标坐标，用于下次进入时判断
                targetElement.dataset.lastMouseX = String(e.clientX);
                targetElement.dataset.lastMouseY = String(e.clientY);
                
                lastMouseX = null;
                lastMouseY = null;
                hasRealMouseMove = false;
            };
            
            // 标记元素，避免重复绑定
            if (!targetElement.dataset.ehMagnetMouseBound) {
                targetElement.addEventListener('mouseenter', mouseEnterHandler);
                targetElement.addEventListener('mousemove', mouseMoveHandler);
                targetElement.addEventListener('mouseleave', mouseLeaveHandler);
                targetElement.dataset.ehMagnetMouseBound = '1';
            }
            
            // 根据自动刷新设置决定是否立即加载
            if (autoRefreshEnabled) {
                // 使用预先计算的优先级
                if (cacheApplied) {
                    // 已经用缓存渲染过，无需强制联网
                    console.log('[EhMagnet] 自动刷新：已使用缓存，跳过强制刷新', torrentLink.href);
                } else {
                    console.log('[EhMagnet] 自动刷新：加载', torrentLink.href);
                    // 优先使用缓存，如无缓存再联网获取
                    injectMagnets(block, torrentLink.href, enrichedGalleryInfo, priority, { preferCache: true });
                }
            } else {
                console.log('[EhMagnet] 手动模式：跳过自动加载', torrentLink.href);
            }
            // 如果不自动刷新，只在鼠标移动时才会加载（通过 mouseMoveHandler 触发）
        });

        applyTemporaryHiddenState();
    };

    const bindTooltipListeners = (tooltip) => {
        if (tooltipListenersBound) return;
        tooltipListenersBound = true;
        tooltip.addEventListener('mouseenter', () => {
            if (tooltipHideTimer) {
                clearTimeout(tooltipHideTimer);
                tooltipHideTimer = null;
            }
        });
        tooltip.addEventListener('mouseleave', () => hideTooltip(tooltip));
        const reposition = () => {
            if (!tooltipAnchor || !tooltipData || !tooltipTitle) return;
            renderTooltipContent(tooltip, tooltipData, tooltipTitle);
            positionTooltip(tooltip);
        };
        window.addEventListener('scroll', reposition, { passive: true });
        window.addEventListener('resize', reposition);
    };

    const ensureTooltipContainer = () => {
        if (tooltipElement && document.body.contains(tooltipElement)) return tooltipElement;
        injectTooltipStyles();
        tooltipElement = document.createElement('div');
        tooltipElement.className = 'eh-magnet-tooltip';
        tooltipElement.style.position = 'fixed';
        tooltipElement.style.zIndex = '9999';
        tooltipElement.style.padding = '10px';
        tooltipElement.style.borderRadius = '8px';
        tooltipElement.style.boxShadow = '0 4px 12px rgba(0,0,0,0.35)';
        tooltipElement.style.fontSize = '11px';
        tooltipElement.style.lineHeight = '1.4';
        tooltipElement.style.background = window.getComputedStyle(document.body).backgroundColor || '#1f1f1f';
        tooltipElement.style.color = window.getComputedStyle(document.body).color || '#fff';
        tooltipElement.style.border = `1px solid ${window.getComputedStyle(document.body).color || '#fff'}`;
        tooltipElement.style.visibility = 'hidden';
        tooltipElement.style.pointerEvents = 'auto';
        tooltipElement.style.opacity = '0';
        tooltipElement.style.transition = 'opacity 0.15s ease';
        tooltipElement.style.display = 'none';
        document.body.appendChild(tooltipElement);
        bindTooltipListeners(tooltipElement);
        return tooltipElement;
    };

    const injectGalleryTorrentLinks = async (options = {}) => {
        const {
            preferCache = downloadCacheEnabled,
            cacheOnly = false,
            forceNetwork = false,
            forceRebuild = false,
        } = options || {};

        if (galleryInjectionPending) return false;
        if (galleryInjectionDone && !forceRebuild && !forceNetwork && !preferCache) return false;

        const actionPanel = document.querySelector('#gd5');
        if (!actionPanel) return false;
        const torrentAnchor = actionPanel.querySelector('a[href*=\"gallerytorrents.php\"], a[onclick*=\"gallerytorrents.php\"]');
        if (!torrentAnchor) return false;
        const parentRow = torrentAnchor.closest('p');
        if (!parentRow) return false;
        const hostElement = parentRow;

        const adjacent = parentRow.nextElementSibling;
        const existingContainer = adjacent && adjacent.classList.contains('eh-magnet-links')
            ? adjacent
            : null;

        if (parentRow.dataset.ehMagnetAttached === '1'
            && !forceRebuild && !forceNetwork && !preferCache && !existingContainer) {
            return false;
        }

        let torrentUrl = torrentAnchor.getAttribute('href') || '';
        if (!torrentUrl || torrentUrl === '#') {
            torrentUrl = extractPopupUrl(torrentAnchor.getAttribute('onclick') || '');
        }
        if (!torrentUrl) {
            const archiveAnchor = actionPanel.querySelector('a[href*=\"archiver.php\"], a[onclick*=\"archiver.php\"]');
            if (archiveAnchor) {
                torrentUrl = archiveAnchor.getAttribute('href') || extractPopupUrl(archiveAnchor.getAttribute('onclick') || '');
            }
        }
        if (!torrentUrl) return false;

        const cacheKey = getMagnetCacheKey(torrentUrl);

        let resolvedGalleryInfo = parseGalleryInfo(window.location.href) || parseGalleryInfoFromTorrentUrl(torrentUrl);
        let magnets = null;
        let usedCache = false;

        if (!forceNetwork && preferCache) {
            const cached = getCachedDownloadInfo(torrentUrl);
            if (cached) {
                magnets = cloneMagnetItems(cached.magnets || []);
                if (cached.gallery && cached.gallery.gid && (!resolvedGalleryInfo || !resolvedGalleryInfo.gid)) {
                    resolvedGalleryInfo = { ...cached.gallery };
                }
                magnetCache.set(cacheKey, cloneMagnetItems(magnets));
                usedCache = true;
            }
        }

        if (!magnets && cacheOnly) {
            return false;
        }

        galleryInjectionPending = true;
        try {
            if (!magnets) {
                magnets = await getMagnets(torrentUrl, 0, null, {
                    forceNetwork,
                    galleryInfo: resolvedGalleryInfo,
                    preferCache: preferCache && !usedCache,
                });
            }

            if (!Array.isArray(magnets)) {
                magnets = [];
            }

            parentRow.dataset.ehMagnetAttached = '1';
            actionPanel.dataset.ehMagnetAttached = '1';
            galleryInjectionDone = true;

            const container = existingContainer || document.createElement('div');
            container.className = 'eh-magnet-links eh-magnet-gallery';
            container.style.marginTop = '4px';
            container.style.fontSize = '11px';
            container.style.lineHeight = '1.4';
            container.style.wordBreak = 'break-all';
            container.innerHTML = '';

            let galleryTitle = document.querySelector('#gd2 #gn')?.textContent?.trim();
            if (!galleryTitle) {
                const galleryTitleNode = document.querySelector('#gd2 #gn');
                galleryTitle = galleryTitleNode ? galleryTitleNode.textContent.trim() : document.title;
            }
            if (!galleryTitle) {
                galleryTitle = resolvedGalleryInfo?.title || '';
            }
            if (galleryTitle) {
                container.dataset.galleryTitle = galleryTitle;
            } else {
                delete container.dataset.galleryTitle;
            }

            if (resolvedGalleryInfo?.gid) {
                container.dataset.galleryGid = resolvedGalleryInfo.gid;
                container.dataset.galleryToken = resolvedGalleryInfo.token || '';
                container.dataset.galleryHref = resolvedGalleryInfo.href || '';
            } else {
                delete container.dataset.galleryGid;
                delete container.dataset.galleryToken;
                delete container.dataset.galleryHref;
            }

            const hasAnyMagnets = magnets.length > 0;
            const validMagnets = magnets.filter((item) => !item.isOutdated);
            const tooltip = ensureTooltipContainer();


            if (!hasAnyMagnets || !validMagnets.length) {
                const enrichedGalleryInfo = resolvedGalleryInfo?.gid
                    ? { ...resolvedGalleryInfo, title: galleryTitle || resolvedGalleryInfo.title || '' }
                    : null;
                createArchiveFallbackRow(container, {
                    galleryInfo: enrichedGalleryInfo,
                    message: hasAnyMagnets ? '⚠️ 仅找到过时种子，将改用存档下载' : '⚠️ 未找到种子，将改用存档下载',
                    dltype: 'org',
                    title: galleryTitle,
                    isOutdatedFallback: hasAnyMagnets,
                });
                if (!existingContainer) {
                    hostElement.insertAdjacentElement('afterend', container);
                }
                updateStatusFlags();
                return true;
            }

            const groupId = resolvedGalleryInfo?.gid
                ? `eh-magnet-group-${resolvedGalleryInfo.gid}`
                : `eh-magnet-group-${++magnetGroupSeq}`;
            const groupMagnets = [];

            validMagnets
                .slice()
                .sort((a, b) => calculateMagnetScoreGlobal(b) - calculateMagnetScoreGlobal(a))
                .forEach((magnet) => {
                    const row = document.createElement('div');
                    row.className = 'eh-magnet-item';
                    row.style.display = 'flex';
                    row.style.alignItems = 'center';
                    row.style.gap = '6px';
                    const torrentHref = magnet.torrentUrl ? toAbsoluteUrl(magnet.torrentUrl) : '';
                    const torrentName = magnet.filename || magnet.tooltipText || magnet.displayText || magnet.href;
                    row.dataset.magnetValue = magnet.href;
                    row.dataset.magnetName = magnet.filename || magnet.tooltipText || magnet.displayText || magnet.href;
                    row.dataset.magnetTime = magnet.postedFull || magnet.postedValue || '';
                    row.dataset.magnetUploader = magnet.uploaderValue || magnet.uploaderText || '';
                    row.dataset.magnetOutdated = magnet.isOutdated ? 'true' : 'false';
                    if (torrentHref) row.dataset.torrentHref = torrentHref;
                    if (torrentName) row.dataset.torrentName = torrentName;

                    if (resolvedGalleryInfo?.gid) {
                        row.dataset.galleryGid = resolvedGalleryInfo.gid;
                        row.dataset.galleryToken = resolvedGalleryInfo.token || '';
                        row.dataset.galleryHref = resolvedGalleryInfo.href || '';
                    }
                    if (galleryTitle) row.dataset.galleryTitle = galleryTitle;
                    if (Number.isFinite(magnet.sizeBytes) && magnet.sizeBytes > 0) {
                        row.dataset.magnetSize = magnet.sizeValue || '';
                    }

                    const copyInline = document.createElement('button');
                    copyInline.type = 'button';
                    copyInline.textContent = '📥';
                    copyInline.title = '发送到 Aria2';
                    copyInline.className = 'eh-magnet-copy-inline';
                    copyInline.style.display = 'flex';
                    copyInline.style.alignItems = 'center';
                    copyInline.style.justifyContent = 'center';
                    if (resolvedGalleryInfo?.gid) {
                        copyInline.dataset.galleryGid = resolvedGalleryInfo.gid;
                        copyInline.dataset.galleryToken = resolvedGalleryInfo.token || '';
                        copyInline.dataset.galleryHref = resolvedGalleryInfo.href || '';
                    }
                    if (galleryTitle) copyInline.dataset.galleryTitle = galleryTitle;
                    copyInline.dataset.magnetValue = magnet.href;
                    copyInline.dataset.magnetName = row.dataset.magnetName || '';
                    copyInline.dataset.magnetTime = row.dataset.magnetTime || '';
                    copyInline.dataset.magnetUploader = row.dataset.magnetUploader || '';
                    if (torrentHref) copyInline.dataset.torrentHref = torrentHref;
                    if (torrentName) copyInline.dataset.torrentName = row.dataset.torrentName || '';
                    copyInline.dataset.magnetOutdated = magnet.isOutdated ? 'true' : 'false';
                    attachSendButtonBehavior(copyInline);

                    const link = document.createElement('a');
                    link.href = magnet.href;
                    link.textContent = magnet.displayText;
                    link.rel = 'nofollow noopener';
                    link.style.display = 'block';
                    link.dataset.originalMagnet = magnet.href;
                    link.dataset.magnetValue = magnet.href;
                    link.dataset.magnetGroup = groupId;
                    link.dataset.magnetTimestamp = String(magnet.postedTimestamp || 0);
                    link.dataset.magnetName = row.dataset.magnetName || '';
                    link.dataset.magnetTime = row.dataset.magnetTime || '';
                    link.dataset.magnetUploader = row.dataset.magnetUploader || '';
                    if (torrentHref) link.dataset.torrentHref = torrentHref;
                    if (torrentName) link.dataset.torrentName = row.dataset.torrentName || '';
                    if (resolvedGalleryInfo?.gid) {
                        link.dataset.galleryGid = resolvedGalleryInfo.gid;
                        link.dataset.galleryToken = resolvedGalleryInfo.token || '';
                        link.dataset.galleryHref = resolvedGalleryInfo.href || '';
                    }
                    if (galleryTitle) link.dataset.galleryTitle = galleryTitle;
                    link.addEventListener('mouseenter', () => showTooltip(link, tooltip, groupMagnets, galleryTitle));
                    link.addEventListener('mousemove', () => showTooltip(link, tooltip, groupMagnets, galleryTitle));
                    link.addEventListener('mouseleave', () => hideTooltip(tooltip));
                    link.addEventListener('click', (event) => {
                        copyMagnet(link.href).catch((err) => {
                            console.warn('复制失败', err);
                        });
                        const info = resolveGalleryInfo(link.dataset, resolvedGalleryInfo);
                        const magnetHref = link.dataset.magnetValue || link.getAttribute('href') || link.href;
                        markMagnetDownloaded(magnetHref, info);
                        row.dataset.magnetDownloaded = 'true';
                        const downloadedFlagEl = row.querySelector('.eh-magnet-downloaded-flag');
                        if (downloadedFlagEl) {
                            downloadedFlagEl.style.display = 'inline-flex';
                        }
                        const checkbox = row.querySelector('.eh-magnet-checkbox') || null;
                        syncEntryFlagDisplay({
                            row,
                            checkbox,
                            info,
                            magnetHref,
                            isArchiveFallback: row.dataset.archiveFallback === 'true'
                                || checkbox?.dataset.archiveFallback === 'true'
                                || false,
                        });
                        recordMagnetCopy(magnet, info, '单条复制', {
                            link,
                            row,
                            name: link.dataset.magnetName || magnet.filename,
                            postedTime: link.dataset.magnetTime || magnet.postedFull || magnet.postedValue || '',
                            uploader: link.dataset.magnetUploader || magnet.uploaderValue || '',
                            operationText: formatOperationTime(new Date()),
                        });
                    });

                    const ignoredFlag = createIgnoredFlagElement(magnet.href, resolvedGalleryInfo);
                    const downloadedFlag = createDownloadedFlagElement(magnet.href, resolvedGalleryInfo);

                    row.appendChild(copyInline);
                    row.appendChild(ignoredFlag);
                    row.appendChild(downloadedFlag);
                    row.appendChild(link);
                    container.appendChild(row);
                    groupMagnets.push({ ...magnet });
                });

            if (resolvedGalleryInfo?.gid) {
                container.dataset.galleryGid = resolvedGalleryInfo.gid;
                container.dataset.galleryToken = resolvedGalleryInfo.token || '';
                container.dataset.galleryHref = resolvedGalleryInfo.href || '';
            }

            if (!existingContainer) {
                hostElement.insertAdjacentElement('afterend', container);
            }
            updateStatusFlags();
            return true;
        } catch (err) {
            console.warn('Failed to inject gallery magnets:', err);
            return false;
        } finally {
            galleryInjectionPending = false;
        }
    };

    // ===================== 磁力链接评分函数（全局作用域） =====================
    // 用于在搜索页面和悬浮菜单中进行一致的排序
    const isCompressedFilename = (filename) => {
        if (!filename) return false;
        const lowerName = filename.toLowerCase();
        return /\.(zip|rar|7z|tar|gz)$/i.test(lowerName);
    };
    
    const calculateMagnetScoreGlobal = (magnet) => {
        const now = Date.now();
        const maxAge = 365 * 24 * 60 * 60 * 1000; // 1年的毫秒数
        const magnetAge = Math.max(0, now - magnet.postedTimestamp);
        const ageBonus = Math.max(0, (maxAge - magnetAge) / 1000000); // 时间衰减权重
        const isCompressed = isCompressedFilename(magnet.filename);
        
        let score = 0;
        
        // 有做种的情况（绝对优先）
        if (magnet.seeders > 0) {
            score += 10000000;                     // 有做种：+10000000分
            score += (isCompressed ? 1000000 : 0); // 压缩包：+1000000分（绝对优势）
            score += (magnet.seeders || 0) * 10000; // 做种数量：每个+10000分
            score += (magnet.completes || 0) * 100; // 完成数量：每个+100分
        } else {
            // 无做种的情况（压缩包优先）
            score += (isCompressed ? 100000 : 0);  // 压缩包：+100000分（优先，但远低于有做种）
            score += (magnet.completes > 0 ? 1000 : 0); // 有完成：+1000分
            score += (magnet.completes || 0) * 10;      // 完成数量：每个+10分
        }
        
        score += (magnet.sizeBytes || 0) / (1024 * 1024 * 100); // 文件大小：每MB+0.01分
        score += ageBonus;                                       // 发布时间：衰减权重
        
        return score;
    };
    // ===================== 磁力链接评分函数END =====================

    const renderTooltipContent = (tooltip, magnetGroup, galleryTitle) => {
        const maxSize = Math.max(...magnetGroup.map((item) => item.sizeBytes || 0));
        const maxSeed = Math.max(...magnetGroup.map((item) => item.seeders || 0));
        const maxPeer = Math.max(...magnetGroup.map((item) => item.peers || 0));
        const maxDownload = Math.max(...magnetGroup.map((item) => item.completes || 0));
        
        const sortedGroup = magnetGroup
            .slice()
            .sort((a, b) => calculateMagnetScoreGlobal(b) - calculateMagnetScoreGlobal(a));
        
        const rows = sortedGroup
            .map((item) => {
                const highlight = (value, max) => (value === max && max > 0 ? 'eh-magnet-highlight' : '');
                const size = item.sizeValue || '';
                const timeText = item.postedFull || item.postedValue || '';
                const seed = Number.isFinite(item.seeders) ? item.seeders : '';
                const peer = Number.isFinite(item.peers) ? item.peers : '';
                const download = Number.isFinite(item.completes) ? item.completes : '';
                const nameLink = `<span>${item.filename || galleryTitle || '磁力链接'}</span>`;
                return `
                    <tr>
                        <td class="eh-magnet-name">${nameLink}</td>
                        <td><span class="${highlight(item.sizeBytes, maxSize)}">${size}</span></td>
                        <td><span>${timeText}</span></td>
                        <td><span class="${highlight(seed, maxSeed)}">${seed}</span></td>
                        <td><span class="${highlight(peer, maxPeer)}">${peer}</span></td>
                        <td><span class="${highlight(download, maxDownload)}">${download}</span></td>
                    </tr>`;
            })
            .join('');

        tooltip.innerHTML = `
            <table>
                <thead>
                    <tr>
                        <th>名称</th>
                        <th>体积</th>
                        <th>时间</th>
                        <th><span title="正在做种 Seeds">📤</span></th>
                        <th><span title="正在下载 Peers">📥</span></th>
                        <th><span title="下载完成 Downloads">✔️</span></th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        `;
    };

    const positionTooltip = (tooltip) => {
        if (!tooltipAnchor || !tooltip) return;

        const padding = 12;
        const fixedOffsetY = 12;
        const anchorRect = tooltipAnchor.getBoundingClientRect();

        tooltip.style.visibility = 'hidden';
        tooltip.style.opacity = '0';
        tooltip.style.display = 'block';

        const tooltipWidth = tooltip.offsetWidth;
        const tooltipHeight = tooltip.offsetHeight;

        let left = anchorRect.left;
        let top = anchorRect.bottom + fixedOffsetY;

        if (left + tooltipWidth + padding > window.innerWidth) {
            left = window.innerWidth - tooltipWidth - padding;
        }
        if (left < padding) {
            left = padding;
        }

        if (top + tooltipHeight > window.innerHeight - padding) {
            top = anchorRect.top - tooltipHeight - fixedOffsetY;
        }
        if (top < padding) {
            top = padding;
        }

        tooltip.style.left = `${left}px`;
        tooltip.style.top = `${top}px`;
        tooltip.style.visibility = 'visible';
        tooltip.style.opacity = '1';
        tooltip.style.display = 'block';
    };

    const showTooltip = (anchorEl, tooltip, magnetGroup, galleryTitle) => {
        if (!magnetGroup?.length || !anchorEl) return;
        if (tooltipHideTimer) {
            clearTimeout(tooltipHideTimer);
            tooltipHideTimer = null;
        }

        tooltipAnchor = anchorEl;
        tooltipData = magnetGroup;
        tooltipTitle = galleryTitle;

        renderTooltipContent(tooltip, magnetGroup, galleryTitle);
        positionTooltip(tooltip);
    };

    const hideTooltip = (tooltip) => {
        if (!tooltip) return;
        if (tooltipHideTimer) clearTimeout(tooltipHideTimer);
        tooltipHideTimer = setTimeout(() => {
            tooltip.style.opacity = '0';
            tooltip.style.visibility = 'hidden';
            tooltip.style.display = 'none';
            tooltipAnchor = null;
            tooltipData = null;
            tooltipTitle = '';
        }, 200);
    };

    const injectMagnets = async (block, torrentUrl, galleryInfo, priority = 0, options = {}) => {
        const cacheKey = getMagnetCacheKey(torrentUrl);
        const forceNetwork = options?.forceNetwork === true;
        const forceRebuild = options?.forceRebuild === true;
        const preferCache = options?.preferCache === true;
        const cacheOnly = options?.cacheOnly === true;

        if (injectingSet.has(cacheKey)) {
            console.log('[EhMagnet] ⚠️ 正在处理中，跳过重复调用:', torrentUrl);
            return;
        }

        // 查找紧邻 block 后面的 .eh-magnet-links 容器
        const nextSibling = block.nextElementSibling;
        const existingContainer = nextSibling && nextSibling.classList.contains('eh-magnet-links')
            ? nextSibling
            : null;
        
        // 检查是否是pending状态的容器（只有归档回退行且标记为pendingInfo）
        const isPendingContainer = existingContainer && 
            existingContainer.querySelector('.eh-magnet-archive-fallback[data-pending-info="true"]');
        
        console.log('[EhMagnet] injectMagnets 调用:', torrentUrl, 'nextSibling:', nextSibling?.className, 'isPending:', !!isPendingContainer);
        
        // 如果是pending容器，需要强制刷新；否则按原逻辑判断
        if (existingContainer && !isPendingContainer && !forceRebuild && !forceNetwork && !preferCache) {
            console.log('[EhMagnet] ⚠️ 容器已存在，跳过重复添加:', torrentUrl);
            return;
        }

        let resolvedGalleryInfo = (galleryInfo && galleryInfo.gid)
            ? galleryInfo
            : parseGalleryInfoFromTorrentUrl(torrentUrl);

        let magnets = null;
        let usedCache = false;
        if (!forceNetwork && preferCache) {
            const cached = getCachedDownloadInfo(torrentUrl);
            if (cached) {
                magnets = cloneMagnetItems(cached.magnets || []);
                if (cached.gallery && cached.gallery.gid && (!resolvedGalleryInfo || !resolvedGalleryInfo.gid)) {
                    resolvedGalleryInfo = { ...cached.gallery };
                }
                magnetCache.set(cacheKey, cloneMagnetItems(magnets));
                usedCache = true;
            }
        }

        if (!magnets && cacheOnly) {
            return;
        }

        injectingSet.add(cacheKey);

        try {
            if (!magnets) {
                magnets = await getMagnets(torrentUrl, priority, block, {
                    forceNetwork,
                    galleryInfo: resolvedGalleryInfo,
                    preferCache: preferCache && !usedCache,
                });
            }

            if (!Array.isArray(magnets)) {
                magnets = [];
            }

            const container = existingContainer || document.createElement('div');
            
            // 保存现有容器中的选中状态
            const wasChecked = existingContainer ? 
                Array.from(existingContainer.querySelectorAll('input[type="checkbox"]'))
                    .some(cb => cb.checked) : false;
            const savedGid = existingContainer?.dataset?.galleryGid;
            
            if (!existingContainer) {
                container.className = 'eh-magnet-links';
                container.style.marginTop = '4px';
                container.style.fontSize = '11px';
                container.style.lineHeight = '1.4';
                container.style.wordBreak = 'break-all';
            } else {
                container.classList.add('eh-magnet-links');
            }

            container.innerHTML = '';
            const tooltip = ensureTooltipContainer();

            if (!resolvedGalleryInfo || !resolvedGalleryInfo.gid) {
                const parsedFromUrl = parseGalleryInfoFromTorrentUrl(torrentUrl);
                if (parsedFromUrl) {
                    resolvedGalleryInfo = parsedFromUrl;
                }
            }

            if (resolvedGalleryInfo?.gid) {
                container.dataset.galleryGid = resolvedGalleryInfo.gid;
                container.dataset.galleryToken = resolvedGalleryInfo.token || '';
                container.dataset.galleryHref = resolvedGalleryInfo.href || '';
            } else {
                delete container.dataset.galleryGid;
                delete container.dataset.galleryToken;
                delete container.dataset.galleryHref;
            }

            const galleryTitleFromDom = block.querySelector('.glname a')?.textContent?.trim() || '';
            const galleryTitle = galleryTitleFromDom
                || resolvedGalleryInfo?.title
                || '';

            if (galleryTitle) {
                container.dataset.galleryTitle = galleryTitle;
            } else {
                delete container.dataset.galleryTitle;
            }

            const hasAnyMagnets = magnets.length > 0;
            const validMagnets = magnets.filter((item) => !item.isOutdated);

            if (!hasAnyMagnets || !validMagnets.length) {
                createArchiveFallbackRow(container, {
                    galleryInfo: resolvedGalleryInfo?.gid
                        ? { ...resolvedGalleryInfo, title: galleryTitle || resolvedGalleryInfo.title || '' }
                        : null,
                    message: hasAnyMagnets ? '⚠️ 仅找到过时种子，将改用存档下载' : '⚠️ 未找到种子，将改用存档下载',
                    dltype: 'org',
                    title: galleryTitle,
                    isOutdatedFallback: hasAnyMagnets,
                });
                if (!existingContainer) {
                    block.insertAdjacentElement('afterend', container);
                }
                updateStatusFlags();
                return;
            }

            // 使用画廊的 gid 作为 groupId，确保同一画廊的种子有相同的分组
            const groupId = resolvedGalleryInfo?.gid
                ? `eh-magnet-group-${resolvedGalleryInfo.gid}`
                : `eh-magnet-group-${++magnetGroupSeq}`;

            validMagnets
                .slice()
                .sort((a, b) => calculateMagnetScoreGlobal(b) - calculateMagnetScoreGlobal(a))
                .forEach((magnet) => {
                const row = document.createElement('div');
                row.className = 'eh-magnet-item';
                row.style.display = 'flex';
                row.style.alignItems = 'center';
                row.style.gap = '6px';
                const torrentHref = magnet.torrentUrl ? toAbsoluteUrl(magnet.torrentUrl) : '';
                const torrentName = magnet.filename || magnet.tooltipText || magnet.displayText || magnet.href;
                row.dataset.magnetValue = magnet.href;
                row.dataset.magnetName = magnet.filename || magnet.tooltipText || magnet.displayText || magnet.href;
                row.dataset.magnetTime = magnet.postedFull || magnet.postedValue || '';
                row.dataset.magnetUploader = magnet.uploaderValue || magnet.uploaderText || '';
                row.dataset.magnetOutdated = magnet.isOutdated ? 'true' : 'false';

                // 只在搜索页显示复选框
                const showCheckbox = isSearchPage();
                
                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.className = 'eh-magnet-checkbox';
                checkbox.dataset.magnetValue = magnet.href;
                checkbox.dataset.magnetGroup = groupId;
                checkbox.dataset.magnetTimestamp = String(magnet.postedTimestamp || 0);
                checkbox.dataset.magnetName = magnet.filename || magnet.tooltipText || magnet.displayText || magnet.href;
                checkbox.dataset.magnetTime = magnet.postedFull || magnet.postedValue || '';
                checkbox.dataset.magnetUploader = magnet.uploaderValue || magnet.uploaderText || '';
                if (torrentHref) checkbox.dataset.torrentHref = torrentHref;
                if (torrentName) checkbox.dataset.torrentName = torrentName;
                checkbox.style.margin = '0';
                checkbox.style.width = '16px';
                checkbox.style.height = '16px';
                if (!showCheckbox) checkbox.style.display = 'none'; // 画廊页隐藏复选框
                checkbox.dataset.magnetOutdated = magnet.isOutdated ? 'true' : 'false';
                if (resolvedGalleryInfo?.gid) {
                    checkbox.dataset.galleryGid = resolvedGalleryInfo.gid;
                    checkbox.dataset.galleryToken = resolvedGalleryInfo.token || '';
                    checkbox.dataset.galleryHref = resolvedGalleryInfo.href || '';
                }
                if (galleryTitle) checkbox.dataset.galleryTitle = galleryTitle;
                checkbox.addEventListener('change', () => {
                    const info = buildGalleryInfoFromDataset(checkbox.dataset);
                    if (checkbox.checked) {
                        selectedMagnets.add(magnet.href);
                        if (info?.gid) selectedGalleries.set(info.gid, info);
                    } else {
                        selectedMagnets.delete(magnet.href);
                        if (info?.gid) selectedGalleries.delete(info.gid);
                    }
                    updateSelectToggleState();
                    const index = Array.from(document.querySelectorAll('.eh-magnet-checkbox')).indexOf(checkbox);
                    if (index >= 0) lastCheckboxIndex = index;
                });

                const copyInline = document.createElement('button');
                copyInline.type = 'button';
                copyInline.textContent = '📥';
                copyInline.title = '发送到 Aria2';
                copyInline.className = 'eh-magnet-copy-inline';
                copyInline.style.marginLeft = '4px';
                copyInline.style.display = 'flex';
                copyInline.style.alignItems = 'center';
                copyInline.style.justifyContent = 'center';
                if (resolvedGalleryInfo?.gid) {
                    copyInline.dataset.galleryGid = resolvedGalleryInfo.gid;
                    copyInline.dataset.galleryToken = resolvedGalleryInfo.token || '';
                    copyInline.dataset.galleryHref = resolvedGalleryInfo.href || '';
                }
                if (galleryTitle) copyInline.dataset.galleryTitle = galleryTitle;
                copyInline.dataset.magnetValue = magnet.href;
                copyInline.dataset.magnetName = magnet.filename || magnet.tooltipText || magnet.displayText || magnet.href;
                copyInline.dataset.magnetTime = magnet.postedFull || magnet.postedValue || '';
                copyInline.dataset.magnetUploader = magnet.uploaderValue || magnet.uploaderText || '';
                if (torrentHref) copyInline.dataset.torrentHref = torrentHref;
                if (torrentName) copyInline.dataset.torrentName = torrentName;
                copyInline.dataset.magnetOutdated = magnet.isOutdated ? 'true' : 'false';
                attachSendButtonBehavior(copyInline);

                const link = document.createElement('a');
                link.href = magnet.href;
                link.textContent = magnet.displayText;
                link.rel = 'nofollow noopener';
                link.style.display = 'block';
                link.dataset.originalMagnet = magnet.href;
                link.dataset.magnetValue = magnet.href;
                link.dataset.magnetGroup = groupId;
                link.dataset.magnetTimestamp = String(magnet.postedTimestamp || 0);
                link.dataset.magnetName = magnet.filename || magnet.tooltipText || magnet.displayText || magnet.href;
                link.dataset.magnetTime = magnet.postedFull || magnet.postedValue || '';
                link.dataset.magnetUploader = magnet.uploaderValue || magnet.uploaderText || '';
                if (torrentHref) link.dataset.torrentHref = torrentHref;
                if (torrentName) link.dataset.torrentName = torrentName;
                if (resolvedGalleryInfo?.gid) {
                    link.dataset.galleryGid = resolvedGalleryInfo.gid;
                    link.dataset.galleryToken = resolvedGalleryInfo.token || '';
                    link.dataset.galleryHref = resolvedGalleryInfo.href || '';
                }
                if (galleryTitle) link.dataset.galleryTitle = galleryTitle;
                link.addEventListener('mouseenter', () => showTooltip(link, tooltip, validMagnets, galleryTitle));
                link.addEventListener('mousemove', () => showTooltip(link, tooltip, validMagnets, galleryTitle));
                link.addEventListener('mouseleave', () => hideTooltip(tooltip));
                link.addEventListener('click', (event) => {
                    copyMagnet(link.href).catch((err) => {
                        console.warn('复制失败', err);
                    });
                    const info = resolveGalleryInfo(link.dataset, resolvedGalleryInfo);
                    const magnetHref = link.dataset.magnetValue || link.getAttribute('href') || link.href;
                    markMagnetDownloaded(magnetHref, info);
                    row.dataset.magnetDownloaded = 'true';
                    const downloadedFlagEl = row.querySelector('.eh-magnet-downloaded-flag');
                    if (downloadedFlagEl) {
                        downloadedFlagEl.style.display = 'inline-flex';
                    }
                    const checkbox = row.querySelector('.eh-magnet-checkbox') || null;
                    syncEntryFlagDisplay({
                        row,
                        checkbox,
                        info,
                        magnetHref,
                        isArchiveFallback: row.dataset.archiveFallback === 'true'
                            || checkbox?.dataset.archiveFallback === 'true'
                            || false,
                    });
                    recordMagnetCopy(magnet, info, '单条复制', {
                        link,
                        row,
                        name: link.dataset.magnetName || magnet.filename,
                        postedTime: link.dataset.magnetTime || magnet.postedFull || magnet.postedValue || '',
                        uploader: link.dataset.magnetUploader || magnet.uploaderValue || '',
                        operationText: formatOperationTime(new Date()),
                    });
                });

                if (resolvedGalleryInfo?.gid) {
                    row.dataset.galleryGid = resolvedGalleryInfo.gid;
                    row.dataset.galleryToken = resolvedGalleryInfo.token || '';
                    row.dataset.galleryHref = resolvedGalleryInfo.href || '';
                }
                if (galleryTitle) row.dataset.galleryTitle = galleryTitle;
                if (Number.isFinite(magnet.sizeBytes) && magnet.sizeBytes > 0) {
                    row.dataset.magnetSize = magnet.sizeValue || '';
                }
                if (torrentHref) row.dataset.torrentHref = torrentHref;
                if (torrentName) row.dataset.torrentName = torrentName;
                if (torrentHref) row.dataset.torrentHref = torrentHref;

                checkbox.addEventListener('click', (event) => {
                    if (!event.shiftKey || !checkbox.checked) {
                        return;
                    }

                    const allCheckboxes = Array.from(document.querySelectorAll('.eh-magnet-checkbox'));
                    const currentIndex = allCheckboxes.indexOf(checkbox);
                    const anchorIndex = (lastCheckboxIndex !== null && lastCheckboxIndex >= 0)
                        ? lastCheckboxIndex
                        : allCheckboxes.findIndex((box) => box.checked && box !== checkbox);

                    if (anchorIndex === -1 || anchorIndex === currentIndex) {
                        updateSelectToggleState();
                        return;
                    }

                    const start = Math.min(anchorIndex, currentIndex);
                    const end = Math.max(anchorIndex, currentIndex);

                    const processedGroups = new Set();

                    for (let i = start; i <= end; i += 1) {
                        const targetBox = allCheckboxes[i];
                        const group = targetBox.dataset.magnetGroup || '__ungrouped';
                        if (processedGroups.has(group)) continue;
                        processedGroups.add(group);

                        const sameGroupBoxes = allCheckboxes.filter((candidate) => candidate.dataset.magnetGroup === group);
                        if (!sameGroupBoxes.length) continue;

                        sameGroupBoxes.forEach((candidate) => {
                            if (candidate.checked) {
                                candidate.checked = false;
                                if (candidate.dataset.magnetValue) {
                                    selectedMagnets.delete(candidate.dataset.magnetValue);
                                }
                                const infoCandidate = buildGalleryInfoFromDataset(candidate.dataset);
                                if (infoCandidate?.gid) selectedGalleries.delete(infoCandidate.gid);
                            }
                        });

                        // 按DOM顺序选择第一个有效项（而不是按时间戳排序后选择最新的）
                        // 这样与磁链列表的显示顺序和评分排序保持一致
                        const targetBox_toSelect = sameGroupBoxes.find((box) => {
                            const infoData = buildGalleryInfoFromDataset(box.dataset);
                            const candidateKey = box.dataset.magnetValue || box.dataset.archiveKey || '';
                            return !shouldSkipSelectionForBox(box, infoData, candidateKey);
                        });

                        if (targetBox_toSelect) {
                            targetBox_toSelect.checked = true;
                            if (targetBox_toSelect.dataset.magnetValue) selectedMagnets.add(targetBox_toSelect.dataset.magnetValue);
                            const infoLatest = buildGalleryInfoFromDataset(targetBox_toSelect.dataset);
                            if (infoLatest?.gid) selectedGalleries.set(infoLatest.gid, infoLatest);
                        }
                    }

                    lastCheckboxIndex = currentIndex;
                    updateSelectToggleState();
                });

                row.appendChild(checkbox);
                row.appendChild(copyInline);
                row.dataset.magnetValue = magnet.href;
                row.dataset.magnetName = magnet.filename || magnet.tooltipText || magnet.displayText || magnet.href;
                row.dataset.magnetTime = magnet.postedFull || magnet.postedValue || '';
                row.dataset.magnetUploader = magnet.uploaderValue || magnet.uploaderText || '';
                const ignoredFlag = createIgnoredFlagElement(magnet.href, resolvedGalleryInfo);
                const downloadedFlag = createDownloadedFlagElement(magnet.href, resolvedGalleryInfo);
                row.appendChild(ignoredFlag);
                row.appendChild(downloadedFlag);
                row.appendChild(link);
                container.appendChild(row);
            });

            if (!existingContainer) {
                block.insertAdjacentElement('afterend', container);
            }
            if (resolvedGalleryInfo?.gid) {
                container.dataset.galleryGid = resolvedGalleryInfo.gid;
                container.dataset.galleryToken = resolvedGalleryInfo.token || '';
                container.dataset.galleryHref = resolvedGalleryInfo.href || '';
            }
            updateSelectToggleState();
            updateStatusFlags();
            
            // 恢复选中状态
            if (wasChecked && savedGid && resolvedGalleryInfo?.gid === savedGid) {
                // 找到画廊级复选框或第一个磁链复选框
                const checkboxes = container.querySelectorAll('input[type="checkbox"]');
                if (checkboxes.length > 0) {
                    // 优先选择画廊级复选框（没有magnetValue的）
                    const galleryCheckbox = Array.from(checkboxes).find(cb => !cb.dataset.magnetValue);
                    const targetCheckbox = galleryCheckbox || checkboxes[0];
                    
                    targetCheckbox.checked = true;
                    
                    // 更新选择集合
                    if (targetCheckbox.dataset.magnetValue) {
                        selectedMagnets.add(targetCheckbox.dataset.magnetValue);
                    } else if (targetCheckbox.dataset.archiveKey) {
                        selectedMagnets.add(targetCheckbox.dataset.archiveKey);
                    }
                    if (savedGid) {
                        selectedGalleries.set(savedGid, true);
                    }
                    
                    updateSelectToggleState();
                }
            }
        } catch (e) {
            console.warn('Failed to fetch magnets:', e);
        } finally {
            // 清除处理标记
            injectingSet.delete(cacheKey);
        }
    };

    const getMagnets = async (torrentUrl, priority = 0, relatedElement = null, options = {}) => {
        const cacheKey = getMagnetCacheKey(torrentUrl);
        const forceNetwork = options?.forceNetwork === true;
        const galleryInfoForCache = options?.galleryInfo || null;

        if (!forceNetwork && magnetCache.has(cacheKey)) {
            return cloneMagnetItems(magnetCache.get(cacheKey));
        }

        if (!forceNetwork) {
            const cached = getCachedDownloadInfo(torrentUrl);
            if (cached) {
                const magnetsFromCache = cached.magnets || [];
                const clones = cloneMagnetItems(magnetsFromCache);
                magnetCache.set(cacheKey, clones);
                return cloneMagnetItems(clones);
            }
        } else {
            magnetCache.delete(cacheKey);
        }

        // 使用请求队列控制（传递关联元素用于动态优先级调整）
        return magnetRequestQueue.execute(async () => {
            // 二次检查缓存（队列等待期间可能已被其他请求缓存）
            if (!forceNetwork && magnetCache.has(cacheKey)) {
                return cloneMagnetItems(magnetCache.get(cacheKey));
            }
            if (!forceNetwork) {
                const cachedAgain = getCachedDownloadInfo(torrentUrl);
                if (cachedAgain) {
                    const magnetsFromCache = cachedAgain.magnets || [];
                    const clones = cloneMagnetItems(magnetsFromCache);
                    magnetCache.set(cacheKey, clones);
                    return cloneMagnetItems(clones);
                }
            }

            const magnets = [];
            try {
                const response = await fetch(torrentUrl, { credentials: 'include' });
                if (!response.ok) throw new Error(`Request failed with status ${response.status}`);

                const html = await response.text();
                const parser = new DOMParser();
                const doc = parser.parseFromString(html, 'text/html');

            const panelTables = doc.querySelectorAll('#torrentinfo .torrent-info > table, #torrentinfo table');
            if (panelTables.length) {
                panelTables.forEach((table) => {
                    const anchor = table.querySelector('a[href], a[onclick]');
                    const href = anchor?.getAttribute('href') || anchor?.getAttribute('onclick') || '';
                    const magnetHref = extractMagnetFromHref(href);
                    if (!magnetHref) return;
                    const info = parseMetadataFromTable(table);
                    const displayParts = [];
                    if (info.postedValue) displayParts.push(info.postedValue);
                    if (info.sizeValue) displayParts.push(info.sizeValue);
                    if (info.uploaderValue) displayParts.push(info.uploaderValue);
                    if (info.filename) displayParts.push(info.filename);
                    if (Number.isFinite(info.seeders)) displayParts.push(`做种 ${info.seeders}`);
                    if (Number.isFinite(info.downloads)) displayParts.push(`下载 ${info.downloads}`);
                    if (Number.isFinite(info.completes)) displayParts.push(`完成 ${info.completes}`);
                    magnets.push({
                        href: magnetHref,
                        displayText: [info.postedValue, info.sizeValue, info.uploaderValue].filter(Boolean).join(' | ') || magnetHref,
                        sizeBytes: info.sizeBytes,
                        postedText: info.postedLabel,
                        sizeText: info.sizeLabel,
                        uploaderText: info.uploaderLabel,
                        uploaderValue: info.uploaderValue,
                        filename: info.filename,
                        tooltipText: displayParts.join(' | '),
                        isOutdated: info.isOutdated,
                        postedTimestamp: info.postedTimestamp || 0,
                        postedFull: info.postedFull,
                        postedValue: info.postedValue,
                        sizeValue: info.sizeValue,
                        seeders: Number.isFinite(info.seeders) ? info.seeders : 0,
                        peers: Number.isFinite(info.downloads) ? info.downloads : 0,
                        completes: Number.isFinite(info.completes) ? info.completes : 0,
                        torrentUrl: info.torrentUrl || '',
                    });
                });
            } else {
                doc.querySelectorAll('#torrentinfo a[href]').forEach((anchor) => {
                    const href = anchor.getAttribute('href') || '';
                    const magnetHref = extractMagnetFromHref(href);
                    if (!magnetHref) return;
                    magnets.push({
                        href: magnetHref,
                        displayText: magnetHref,
                        sizeBytes: 0,
                        postedText: '',
                        sizeText: '',
                        uploaderText: '',
                        uploaderValue: '',
                        filename: '',
                        tooltipText: magnetHref,
                        isOutdated: false,
                        torrentUrl: '',
                    });
                });
            }
            } catch (err) {
                console.warn('Failed to load torrent page:', err);
            }

            const clonesForCache = cloneMagnetItems(magnets);
            magnetCache.set(cacheKey, clonesForCache);
            const galleryForCache = galleryInfoForCache || parseGalleryInfoFromTorrentUrl(torrentUrl);
            setDownloadCacheEntry(torrentUrl, magnets, galleryForCache);
            return cloneMagnetItems(clonesForCache);
        }, priority, cacheKey, relatedElement); // 传递 priority 和关联元素
    };

    const renderCachedDownloadInfoForBlock = (block, { forceRebuild = false } = {}) => {
        if (!downloadCacheEnabled) return false;
        if (!block || !(block instanceof HTMLElement)) return false;
        const torrentLink = block.querySelector('.gldown a[href*="gallerytorrents.php"]');
        if (!torrentLink) return false;

        const cached = getCachedDownloadInfo(torrentLink.href);
        if (!cached) return false;

        const nextSibling = block.nextElementSibling;
        const existingContainer = nextSibling && nextSibling.classList.contains('eh-magnet-links')
            ? nextSibling
            : null;
        if (existingContainer && !forceRebuild) {
            return false;
        }

        const cacheKey = getMagnetCacheKey(torrentLink.href);
        magnetCache.set(cacheKey, cloneMagnetItems(cached.magnets || []));

        const galleryContainer = block.closest('.gl1t') || block.closest('tr');
        const galleryLink = galleryContainer?.querySelector('.glname a[href*="/g/"]')
            || galleryContainer?.querySelector('a[href*="/g/"]')
            || galleryContainer?.querySelector('a[href*="/s/"]');
        const parsedInfo = parseGalleryInfo(galleryLink?.href || '');
        const galleryTitle = galleryContainer?.querySelector('.glname a')?.textContent?.trim()
            || block.querySelector('.glname a')?.textContent?.trim()
            || cached.gallery?.title
            || '';
        const enrichedInfo = parsedInfo
            ? { ...parsedInfo, title: galleryTitle || parsedInfo.title || '' }
            : (cached.gallery ? { ...cached.gallery, title: galleryTitle || cached.gallery.title || '' } : null);

        injectMagnets(block, torrentLink.href, enrichedInfo, 50, {
            preferCache: true,
            cacheOnly: true,
            forceRebuild,
        });
        return true;
    };

    const renderCachedDownloadInfoForGallery = ({ forceRebuild = false } = {}) => {
        if (!downloadCacheEnabled) return false;
        return injectGalleryTorrentLinks({
            preferCache: true,
            cacheOnly: true,
            forceRebuild,
        }) || false;
    };

    const applyDownloadCacheToVisibleGalleries = ({ forceRebuild = false } = {}) => {
        if (!downloadCacheEnabled) return;
        document.querySelectorAll('.gl5t').forEach((block) => {
            renderCachedDownloadInfoForBlock(block, { forceRebuild });
        });
        renderCachedDownloadInfoForGallery({ forceRebuild });
    };

    const getVisibleCheckedBoxes = () => Array.from(document.querySelectorAll('.eh-magnet-checkbox:checked')).filter((box) => !isInTempHiddenContainer(box));

    const updateIgnoreToggleState = () => {
        const buttons = [ignoreToggleButton, ignoreToggleButtonBottom].filter(Boolean);
        if (!buttons.length) return;

        const checkedBoxes = getVisibleCheckedBoxes();
        if (!checkedBoxes.length) {
            buttons.forEach((button) => {
                button.disabled = true;
                button.textContent = '忽略所选';
                button.dataset.state = 'ignore';
            });
            return;
        }

        const shouldUnignore = checkedBoxes.every((box) => {
            const row = box.closest('.eh-magnet-item');
            const container = row?.closest('.eh-magnet-links');
            const info = buildGalleryInfoFromDataset(box.dataset)
                || buildGalleryInfoFromDataset(row?.dataset)
                || buildGalleryInfoFromDataset(container?.dataset);
            const magnetHref = box.dataset.magnetValue || row?.dataset.magnetValue;
            if (!magnetHref) return false;
            return isMagnetIgnored(magnetHref, info);
        });

        buttons.forEach((button) => {
            button.disabled = false;
            button.textContent = shouldUnignore ? '取消忽略' : '忽略所选';
            button.dataset.state = shouldUnignore ? 'unignore' : 'ignore';
        });
    };

    const updateSelectToggleState = () => {
        const infiniteToggles = Array.from(document.querySelectorAll('input[data-setting="search-infinite-scroll"]'));
        infiniteToggles.forEach((checkbox) => {
            checkbox.checked = enableSearchInfiniteScroll;
        });

        updateIgnoreToggleState();
        updateSelectionMenuAvailability();
        updateSelectionSummary();
    };

    const rebuildSelectionSets = () => {
        selectedMagnets.clear();
        selectedGalleries.clear();
        Array.from(document.querySelectorAll('.eh-magnet-checkbox:checked')).forEach((box) => {
            if (isInTempHiddenContainer(box)) {
                box.checked = false;
            }
        });
        const checkedBoxes = getVisibleCheckedBoxes();
        checkedBoxes.forEach((box) => {
            const magnet = box.dataset.magnetValue;
            if (magnet) selectedMagnets.add(magnet);
            const info = buildGalleryInfoFromDataset(box.dataset);
            if (info?.gid) selectedGalleries.set(info.gid, info);
        });
        updateSelectionSummary();
    };

    const applySelectAllState = (shouldSelect) => {
        const checkboxes = Array.from(document.querySelectorAll('.eh-magnet-checkbox'));
        if (!checkboxes.length) return;

        const boxesByGroup = new Map();
        checkboxes.forEach((box) => {
            const group = box.dataset.magnetGroup || '__ungrouped';
            if (!boxesByGroup.has(group)) boxesByGroup.set(group, []);
            boxesByGroup.get(group).push(box);
        });

        boxesByGroup.forEach((groupBoxes) => {
            groupBoxes.forEach((box) => {
                box.checked = false;
            });
            if (!shouldSelect) return;

            // 【修复】按DOM顺序（即calculateMagnetScoreGlobal的排序）选择第一个有效项，而不是按时间戳重新排序
            // 这样与磁链列表的显示顺序保持一致
            const targetBox = groupBoxes.find((box) => !shouldSkipSelectionForBox(box));

            if (!targetBox) return;
            targetBox.checked = true;
        });

        rebuildSelectionSets();
        updateSelectToggleState();
    };

    const invertSelection = () => {
        const checkboxes = Array.from(document.querySelectorAll('.eh-magnet-checkbox'));
        if (!checkboxes.length) return;

        // 单纯反转选中状态，不受复选框约束的限制
        // 按画廊分组处理（处理多个种子的情况，保持最高优先级的种子被选中）
        const galleryGroups = new Map();
        
        checkboxes.forEach((box) => {
            // 注意：这里不调用 shouldSkipSelectionForBox，让所有画廊都能参与反选
            const gid = box.dataset.galleryGid;
            if (!galleryGroups.has(gid)) {
                galleryGroups.set(gid, []);
            }
            galleryGroups.get(gid).push(box);
        });

        // 对每个画廊组进行反选
        galleryGroups.forEach((boxes) => {
            // 检查该画廊是否有任何种子被选中
            const hasAnyChecked = boxes.some(box => box.checked);
            
            if (hasAnyChecked) {
                // 如果有任何种子被选中，全部取消
                boxes.forEach(box => box.checked = false);
            } else {
                // 如果都没选中，选中第一个（最高优先级的种子）
                if (boxes.length > 0) {
                    boxes[0].checked = true;
                }
            }
        });

        rebuildSelectionSets();
        updateSelectToggleState();
    };


    const copyMagnet = async (magnet) => {
        if (!magnet) return;
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(magnet);
        } else {
            const textarea = document.createElement('textarea');
            textarea.value = magnet;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand('copy');
            document.body.removeChild(textarea);
        }
    };

    const TORRENT_IFRAME_HOLD_MS = 700;
    const TORRENT_DOWNLOAD_DELAY_RANGE = [900, 1600];

    const triggerHiddenTorrentDownload = (url, options = {}) => {
        if (!url) return Promise.resolve(false);
        const { timeout = 15000, holdMs = TORRENT_IFRAME_HOLD_MS } = options;
        return new Promise((resolve) => {
            const iframe = document.createElement('iframe');
            iframe.style.display = 'none';
            let settled = false;

            const cleanup = () => {
                if (settled) return;
                settled = true;
                if (iframe.isConnected) {
                    iframe.remove();
                }
                resolve(true);
            };

            const finalize = () => {
                clearTimeout(timeoutId);
                if (holdMs > 0) {
                    setTimeout(cleanup, holdMs);
                } else {
                    cleanup();
                }
            };

            const timeoutId = setTimeout(finalize, timeout);
            iframe.addEventListener('load', finalize, { once: true });
            iframe.addEventListener('error', finalize, { once: true });

            document.body.appendChild(iframe);
            iframe.src = url;
        });
    };

    const recordRecentBatch = (entries, context = {}) => {
        if (!entries || !entries.length) return;
        const batch = createBatchEntry(entries, context);
        appendRecentBatch(batch);
    };

    const resolveRecentEntry = (magnetData, galleryInfo, context = {}) => {
        const magnetObject = (magnetData && typeof magnetData === 'object') ? magnetData : null;
        const href = typeof magnetData === 'string' ? magnetData : (magnetObject?.href || '');
        const archiveKey = context.archiveKey || magnetObject?.archiveKey || '';
        const archiveDltype = context.archiveDltype || magnetObject?.archiveDltype || '';
        const torrentHref = context.torrentHref || magnetObject?.torrentHref || '';
        const isArchive = Boolean(context.isArchive || magnetObject?.isArchive);
        const primaryKey = href || archiveKey || torrentHref;
        if (!primaryKey) return null;

        const row = context.row || null;
        const linkEl = context.link || null;
        const explicitName = context.name;
        const explicitSize = context.size;
        const derivedName = magnetObject?.filename
            || magnetObject?.displayText
            || row?.dataset?.magnetName
            || linkEl?.dataset?.magnetName
            || (href ? extractMagnetFilename(href) : '')
            || linkEl?.textContent?.trim()
            || '';
        const derivedSize = magnetObject?.sizeValue
            || row?.dataset?.magnetSize
            || '';
        const postedTime = context.postedTime
            || magnetObject?.postedFull
            || magnetObject?.postedValue
            || row?.dataset?.magnetTime
            || linkEl?.dataset?.magnetTime
            || '';
        const uploader = context.uploader
            || magnetObject?.uploaderValue
            || row?.dataset?.magnetUploader
            || linkEl?.dataset?.magnetUploader
            || '';

        const name = explicitName || derivedName || magnetObject?.tooltipText || magnetObject?.displayText || '';
        
        // 对于归档下载，downloadUrl 是实际的下载链接，magnet 是内部标识符
        const downloadUrl = context.downloadUrl || magnetObject?.downloadUrl || '';

        return {
            magnet: primaryKey,
            archiveKey: archiveKey || (isArchive ? primaryKey : ''),
            archiveDltype,
            isArchive,
            torrentHref,
            downloadUrl: downloadUrl || primaryKey, // 实际下载链接
            name: name || primaryKey,
            size: explicitSize || derivedSize || '',
            postedTime,
            uploader,
            gallery: galleryInfo?.gid
                ? {
                    gid: galleryInfo.gid,
                    href: galleryInfo.href || '',
                    token: galleryInfo.token || '',
                }
                : null,
        };
    };

    const recordMagnetCopy = (magnetData, galleryInfo, source, context = {}) => {
        const entry = resolveRecentEntry(magnetData, galleryInfo, context);
        if (!entry) return;
        let timestamp = context.timestamp;
        if (!Number.isFinite(timestamp)) {
            timestamp = Date.now();
        }
        recordRecentBatch([entry], { source, timestamp, operationText: context.operationText });
    };

    // 刷新单个画廊的磁链/种子信息
    const refreshSingleGalleryInfo = async (entry) => {
        if (!entry || !entry.info) {
            console.warn('[批量刷新] 条目或info为空');
            return false;
        }
        
        const galleryInfo = entry.info;
        const gid = galleryInfo.gid;
        
        if (!gid) {
            console.warn('[批量刷新] GID为空');
            return false;
        }
        
        // 使用现有的 resolveGalleryBlockForGid 函数来查找画廊块
        // 这个函数能处理各种HTML结构（列表视图、缩略图视图等）
        const hints = [];
        if (entry.checkbox) hints.push(entry.checkbox);
        if (entry.row) hints.push(entry.row);
        
        const block = resolveGalleryBlockForGid(gid, hints);
        if (!block) {
            console.warn(`[批量刷新] 未找到画廊块 (GID: ${gid})`);
            return false;
        }
        
        console.log(`[批量刷新] 找到画廊块: ${block.className}`);
        
        // 获取种子URL
        const torrentLink = block.querySelector('.gldown a[href*="gallerytorrents.php"]');
        if (!torrentLink) {
            console.warn(`[批量刷新] 未找到种子链接 (GID: ${gid})`);
            return false;
        }
        
        const torrentUrl = torrentLink.href;
        const cacheKey = getMagnetCacheKey(torrentUrl);
        
        console.log(`[批量刷新] 刷新画廊 ${gid}: ${torrentUrl}`);
        
        try {
            // 使用 forceNetwork 选项强制从网络获取，forceRebuild 重新构建容器
            // 使用高优先级 50 以加快处理速度
            injectMagnets(block, torrentUrl, galleryInfo, 50, {
                forceNetwork: true,
                forceRebuild: true,
                preferCache: false
            });
            
            // 等待这个特定的注入任务完成（最多等待20秒）
            const maxWaitTime = 20000;
            const pollInterval = 50;
            const startTime = Date.now();
            
            while (injectingSet.has(cacheKey) && Date.now() - startTime < maxWaitTime) {
                await new Promise(resolve => setTimeout(resolve, pollInterval));
            }
            
            console.log(`[批量刷新] 成功刷新画廊 ${gid}`);
            return true;
        } catch (err) {
            console.warn(`[批量刷新] 刷新画廊 ${gid} 失败:`, err);
            return false;
        }
    };

    // 批量刷新未获取信息的画廊
    // 返回值：{ refreshed: 数量, skipped: 数量, failed: 数量, entries: 刷新后的条目 }
    const batchRefreshPendingEntries = async (entries, options = {}) => {
        const { showProgress = true, checkType = 'any' } = options;
        
        // 筛选需要刷新的条目（在 try 前完成）
        const pendingEntries = entries.filter((entry) => {
            if (!entry) return false;
            const checkboxPending = entry.checkbox?.dataset?.pendingInfo === 'true';
            const rowPending = entry.row?.dataset?.pendingInfo === 'true';
            if (!checkboxPending && !rowPending) return false;
            
            // 区分两种情况：
            // 1. 待刷新（pendingInfo=true, 无磁链/种链）→ 需要刷新
            // 2. 已获取但无种/过时（isArchiveFallback=true, 但有torrentStatus属性）→ 不需要刷新
            
            // 检查是否已经确定为"无种"或"过时"状态
            const hasNoSeedsStatus = entry.checkbox?.dataset?.torrentStatus === 'noseed';
            const hasOutdatedStatus = entry.checkbox?.dataset?.torrentStatus === 'outdated';
            
            // 如果已经标记为无种或过时，就不要再刷新了
            if (hasNoSeedsStatus || hasOutdatedStatus) {
                return false;
            }
            
            // 根据checkType决定刷新条件
            if (checkType === 'magnet') {
                // 需要磁链：刷新未获取或有归档但无磁链的条目
                return !entry.magnetHref || entry.isArchiveFallback;
            } else if (checkType === 'torrent') {
                // 需要种子：刷新未获取或有归档但无种链的条目
                return !entry.torrentHref || entry.isArchiveFallback;
            } else {
                // 任意信息（默认）
                const hasAny = (entry.magnetHref || entry.torrentHref) && !entry.isArchiveFallback;
                return !hasAny;
            }
        });
        
        if (pendingEntries.length === 0) {
            return { refreshed: 0, skipped: 0, failed: 0, entries };
        }
        
        // 记录初始的全局进度状态，用于后续恢复
        const previousShowGlobalProgress = magnetRequestQueue.showGlobalProgress;
        const previousTotalTasks = magnetRequestQueue.totalTasks;
        const previousCompletedTasks = magnetRequestQueue.completedTasks;
        
        // 重置进度计数器显示本批次的进度
        magnetRequestQueue.totalTasks = pendingEntries.length;
        magnetRequestQueue.completedTasks = 0;
        magnetRequestQueue.showGlobalProgress = true;
        
        try {
        if (showProgress) {
            toastInfo(`开始刷新 ${pendingEntries.length} 个未获取信息的画廊...`);
        }
        
        let refreshed = 0;
        let failed = 0;
        let completed = 0;  // 追踪本批次的完成数
        
        // 使用magnetRequestQueue进行刷新（使用高优先级加速处理）
        // 使用并发控制替代 Promise.all 的无限制并发
        // 不再使用 magnetRequestQueue，改用 executeWithConcurrencyLimit
        const refreshTasks = pendingEntries.map((entry, index) => async () => {
            try {
                // 刷新该画廊的信息
                const success = await refreshSingleGalleryInfo(entry);
                if (success) {
                    refreshed++;
                } else {
                    failed++;
                }
                completed++;
                
                // 更新全局队列的计数器以显示本批次进度
                magnetRequestQueue.completedTasks = completed;
                magnetRequestQueue.updateProgress();
            } catch (err) {
                console.warn(`[批量刷新] 刷新画廊 ${entry.info?.gid} 失败:`, err);
                failed++;
                completed++;
            }
        });
        
        // 使用 executeWithConcurrencyLimit 控制并发，而不是 Promise.all
        await executeWithConcurrencyLimit(refreshTasks, null, (c, t) => {
            magnetRequestQueue.completedTasks = c;
            magnetRequestQueue.updateProgress();
        });
        
        // 额外等待以确保所有 DOM 更新完成
        // injectingSet 应该已经清空，但给浏览器额外时间处理 DOM
        await new Promise(resolve => setTimeout(resolve, 500));
        
        if (showProgress) {
            toastSuccess(`刷新完成：成功 ${refreshed} 个，失败 ${failed} 个`);
        }
        
        const result = {
            refreshed,
            skipped: entries.length - pendingEntries.length,
            failed,
            entries
        };
        
        return result;
        } finally {
            // 恢复全局进度条之前的状态
            magnetRequestQueue.showGlobalProgress = previousShowGlobalProgress;
            magnetRequestQueue.totalTasks = previousTotalTasks;
            magnetRequestQueue.completedTasks = previousCompletedTasks;
            magnetRequestQueue.updateProgress();
        }
    };

    const copySelectedMagnets = async () => {
        // 设置标志，禁用其他刷新操作
        isCopyingMagnets = true;
        try {
            return await copySelectedMagnets_internal();
        } finally {
            isCopyingMagnets = false;
        }
    };

    const copySelectedMagnets_internal = async () => {
        const entries = collectSelectedEntries();
        
        // 记录初始的勾选状态（gid -> 勾选状态映射）
        const initialCheckedGids = new Set(entries.map(e => e.info?.gid).filter(Boolean));
        
        // 检测是否有未获取信息的条目
        const pendingEntries = entries.filter((entry) => {
            if (!entry) return false;
            const checkboxPending = entry.checkbox?.dataset?.pendingInfo === 'true';
            const rowPending = entry.row?.dataset?.pendingInfo === 'true';
            if (!checkboxPending && !rowPending) return false;
            const hasUsableMagnet = Boolean(entry.magnetHref) && !entry.isArchiveFallback;
            return !hasUsableMagnet;
        });
        
        // 如果有未获取的条目，先自动刷新
        if (pendingEntries.length > 0) {
            console.log(`[复制磁链] 检测到 ${pendingEntries.length} 个未获取信息的画廊，自动刷新...`);
            
            // 使用 refreshSelectedGalleries 的方式进行刷新（更稳定）
            await refreshSelectedGalleries();
            
            // 刷新后，重新收集条目（因为已更新，但保持勾选状态）
            const freshEntries = collectSelectedEntries();
            return copySelectedMagnets_impl(freshEntries);
        }
        
        return copySelectedMagnets_impl(entries);
    };

    const copySelectedMagnets_impl = async (entries) => {
        const magnetEntries = entries.filter((entry) => !entry.isArchiveFallback && entry.magnetHref);
        
        // 分类失败的条目：无种、过时种子等
        // 注意：不能用 pendingInfo 来判断，因为刷新后状态会改变
        // 直接判断是否有有效磁链
        const failedEntries = entries.filter((entry) => {
            if (!entry) return false;
            const hasUsableMagnet = Boolean(entry.magnetHref) && !entry.isArchiveFallback;
            return !hasUsableMagnet;
        });
        
        if (!magnetEntries.length) {
            toastWarn('未选择任何可复制的磁力链接');
            return;
        }
        const text = magnetEntries.map((entry) => entry.magnetHref).join('\n');
        try {
            await copyMagnet(text);
            toastSuccess(`已复制 ${magnetEntries.length} 个磁力链接`);
            const nowText = formatOperationTime(new Date());
            const recentEntries = [];
            
            // 处理成功复制的条目 - 取消勾选并标记为已下载
            magnetEntries.forEach((entry) => {
                markMagnetDownloaded(entry.magnetHref, entry.info, { silent: true, skipPersist: true });
                if (entry.magnetHref && ignoredMagnets.has(entry.magnetHref)) {
                    unmarkMagnetIgnored(entry.magnetHref, entry.info, { silent: true, skipPersist: true });
                }
                if (entry.checkbox) entry.checkbox.checked = false;
                selectedMagnets.delete(entry.magnetHref);
                if (entry.info?.gid) selectedGalleries.delete(entry.info.gid);
                const resolved = resolveRecentEntry({ href: entry.magnetHref }, entry.info, {
                    row: entry.row,
                    link: entry.row?.querySelector('a'),
                    name: entry.name,
                    operationText: nowText,
                });
                if (resolved) recentEntries.push(resolved);
            });
            
            persistDownloadedState();
            persistIgnoredState();
            updateStatusFlags();
            rebuildSelectionSets();
            updateSelectToggleState();
            updateIgnoreToggleState();
            refreshGalleryIgnoreButtons();
            
            // 提示未成功复制的画廊
            if (failedEntries.length) {
                const previewTitles = failedEntries
                    .map((entry) => (entry.info?.title?.trim())
                        || entry.galleryTitle
                        || entry.archiveTitle
                        || (entry.info?.gid ? `gid:${entry.info.gid}` : ''))
                    .filter(Boolean)
                    .slice(0, 3);
                const hasMore = failedEntries.length > previewTitles.length;
                const previewText = previewTitles.length
                    ? `（${previewTitles.join('、')}${hasMore ? '等' : ''}）`
                    : '';
                
                // 统计不同类型的失败原因
                const outdatedCount = failedEntries.filter(e => 
                    e.checkbox?.dataset?.torrentStatus === 'outdated' || e.row?.dataset?.torrentStatus === 'outdated'
                ).length;
                const noseedCount = failedEntries.filter(e => 
                    e.checkbox?.dataset?.torrentStatus === 'noseed' || e.row?.dataset?.torrentStatus === 'noseed'
                ).length;
                
                let reasonText = '';
                if (outdatedCount > 0) reasonText += `种子过时${outdatedCount}个`;
                if (noseedCount > 0) {
                    if (reasonText) reasonText += '、';
                    reasonText += `无种子${noseedCount}个`;
                }
                if (!reasonText) reasonText = '未获取信息';
                
                toastWarn(`还有 ${failedEntries.length} 个画廊未复制（${reasonText}）${previewText}，已保持勾选`, {
                    duration: 3600,
                });
            }
            
            if (recentEntries.length) {
                recordRecentBatch(recentEntries, { source: '批量复制', operationText: nowText });
            }
        } catch (err) {
            console.warn('复制磁力链接失败', err);
            toastError('复制失败，请手动复制');
        }
    };

    const copySelectedTorrents = async () => {
        // 复制种链时暂时禁用悬停刷新，防止干扰
        const previousHoverRefreshEnabled = hoverRefreshEnabled;
        hoverRefreshEnabled = false;
        
        try {
            const entries = collectSelectedEntries();
            
            // 记录初始的勾选状态（gid -> 勾选状态映射）
            const initialCheckedGids = new Set(entries.map(e => e.info?.gid).filter(Boolean));
            
            // 检测是否有未获取信息的条目
            const pendingEntries = entries.filter((entry) => {
                if (!entry) return false;
                const checkboxPending = entry.checkbox?.dataset?.pendingInfo === 'true';
                const rowPending = entry.row?.dataset?.pendingInfo === 'true';
                if (!checkboxPending && !rowPending) return false;
                const hasUsableTorrent = Boolean(entry.torrentHref) && !entry.isArchiveFallback;
                return !hasUsableTorrent;
            });
            
            // 如果有未获取的条目，先自动刷新（使用 refreshSelectedGalleries 以获得最佳性能）
            if (pendingEntries.length > 0) {
                console.log(`[复制种子链接] 检测到 ${pendingEntries.length} 个未获取信息的画廊，自动刷新...`);
                // 注意：refreshSelectedGalleries 会刷新所有选中的条目，不仅仅是 pendingEntries
                // 但这样性能更好，因为使用了更高效的并发机制
                await refreshSelectedGalleries();
                
                // 刷新后，重新确保这些画廊保持勾选状态
                initialCheckedGids.forEach(gid => {
                    const checkbox = document.querySelector(`input[type="checkbox"][data-gallery-gid="${gid}"]`);
                    if (checkbox && !checkbox.checked) {
                        checkbox.checked = true;
                    }
                });
                
                // 重新收集条目（因为已更新，但保持勾选状态）
                const freshEntries = collectSelectedEntries();
                return copySelectedTorrents_impl(freshEntries);
            }
            
            return copySelectedTorrents_impl(entries);
        } finally {
            // 恢复悬停刷新设置
            hoverRefreshEnabled = previousHoverRefreshEnabled;
        }
    };

    const copySelectedTorrents_impl = async (entries) => {
        // 分类：有种子的和无种子的
        const torrentEntries = entries.filter((entry) => !entry.isArchiveFallback && entry.torrentHref);
        
        // 分类失败的条目：无种、过时等
        // 注意：不能用 pendingInfo 来判断，因为刷新后状态会改变
        // 直接判断是否有有效种链
        const failedEntries = entries.filter((entry) => {
            if (!entry) return false;
            const hasUsableTorrent = Boolean(entry.torrentHref) && !entry.isArchiveFallback;
            return !hasUsableTorrent;
        });
        
        if (!torrentEntries.length) {
            toastWarn('选中的条目没有可用的种子链接');
            return;
        }
        
        try {
            const text = torrentEntries.map((entry) => entry.torrentHref).join('\n');
            await copyMagnet(text);
            toastSuccess(`已复制 ${torrentEntries.length} 个种子链接`);
            
            const nowText = formatOperationTime(new Date());
            const recentEntries = [];
            
            // 处理成功复制的条目 - 取消勾选并标记为已下载
            torrentEntries.forEach((entry) => {
                // 标记为已下载
                markMagnetDownloaded(entry.torrentHref, entry.info, { silent: true, skipPersist: true });
                if (entry.torrentHref && ignoredMagnets.has(entry.torrentHref)) {
                    unmarkMagnetIgnored(entry.torrentHref, entry.info, { silent: true, skipPersist: true });
                }
                
                if (entry.checkbox) entry.checkbox.checked = false;
                if (entry.torrentHref) selectedMagnets.delete(entry.torrentHref);
                if (entry.info?.gid) selectedGalleries.delete(entry.info.gid);
                
                const magnetPayload = {
                    href: entry.torrentHref,
                    torrentHref: entry.torrentHref,
                    filename: entry.name || undefined,
                    displayText: entry.name || undefined,
                };
                const resolved = resolveRecentEntry(magnetPayload, entry.info, {
                    row: entry.row,
                    name: entry.name,
                    operationText: nowText,
                });
                if (resolved) recentEntries.push(resolved);
            });
            
            persistDownloadedState();
            persistIgnoredState();
            updateStatusFlags();
            rebuildSelectionSets();
            updateSelectToggleState();
            updateIgnoreToggleState();
            refreshGalleryIgnoreButtons();
            
            // 提示未成功复制的画廊
            if (failedEntries.length) {
                const previewTitles = failedEntries
                    .map((entry) => (entry.info?.title?.trim())
                        || entry.galleryTitle
                        || entry.archiveTitle
                        || (entry.info?.gid ? `gid:${entry.info.gid}` : ''))
                    .filter(Boolean)
                    .slice(0, 3);
                const hasMore = failedEntries.length > previewTitles.length;
                const previewText = previewTitles.length
                    ? `（${previewTitles.join('、')}${hasMore ? '等' : ''}）`
                    : '';
                
                // 统计无种数量
                const noseedCount = failedEntries.filter(e => 
                    e.checkbox?.dataset?.torrentStatus === 'noseed' || e.row?.dataset?.torrentStatus === 'noseed'
                ).length;
                
                const reasonText = noseedCount > 0 ? `无种子${noseedCount}个` : '未获取信息';
                
                toastWarn(`还有 ${failedEntries.length} 个画廊未复制（${reasonText}）${previewText}，已保持勾选`, {
                    duration: 3600,
                });
            }
            
            if (recentEntries.length) {
                recordRecentBatch(recentEntries, { source: '批量复制', operationText: nowText });
            }
        } catch (err) {
            console.warn('复制种子链接失败', err);
            toastError('复制失败，请手动复制');
        }
    };

    const downloadSelectedTorrents = async () => {
        const checkedBoxes = getVisibleCheckedBoxes();
        if (!checkedBoxes.length) {
            toastWarn('未选择任何条目');
            return;
        }

        const entryList = checkedBoxes.map((box) => {
            const row = box.closest('.eh-magnet-item');
            const container = row?.closest('.eh-magnet-links');
            const info = buildGalleryInfoFromDataset(box.dataset)
                || buildGalleryInfoFromDataset(row?.dataset)
                || buildGalleryInfoFromDataset(container?.dataset);
            const magnetHref = box.dataset.magnetValue || row?.dataset.magnetValue || '';
            const torrentHref = box.dataset.torrentHref || row?.dataset.torrentHref || '';
            return {
                box,
                info,
                magnetHref,
                torrentHref,
                row,
            };
        }).filter((entry) => Boolean(entry.torrentHref && entry.magnetHref));

        if (!entryList.length) {
            toastWarn('选中的条目没有可用的种子链接');
            return;
        }

        const uniqueUrls = Array.from(new Map(entryList.map((entry) => [entry.torrentHref, entry])).values());
        for (let index = 0; index < uniqueUrls.length; index += 1) {
            const item = uniqueUrls[index];
            try {
                await triggerHiddenTorrentDownload(item.torrentHref, { holdMs: TORRENT_IFRAME_HOLD_MS });
            } catch (err) {
                console.warn('触发隐藏种子下载失败', err);
            }
            if (index < uniqueUrls.length - 1) {
                const waitMs = randomInRange(TORRENT_DOWNLOAD_DELAY_RANGE[0], TORRENT_DOWNLOAD_DELAY_RANGE[1]);
                await delay(waitMs);
            }
        }

        entryList.forEach((entry) => {
            markMagnetDownloaded(entry.magnetHref, entry.info, { silent: true, skipPersist: true });
            entry.box.checked = false;
            selectedMagnets.delete(entry.magnetHref);
            if (entry.info?.gid) selectedGalleries.delete(entry.info.gid);
        });
        persistDownloadedState();
        persistIgnoredState();
        updateStatusFlags();
        refreshGalleryIgnoreButtons();
        clearSelection();
        toastSuccess(`已发起 ${uniqueUrls.length} 个种子下载`);

        // 记录到最近下载（种链下载）
        if (entryList.length) {
            const nowText = formatOperationTime(new Date());
            const recentEntries = entryList.map((entry) => resolveRecentEntry({
                href: entry.torrentHref,
                torrentHref: entry.torrentHref,
                name: entry.info?.title || entry.magnetHref || entry.torrentHref,
            }, entry.info, { row: entry.row, operationText: nowText })).filter(Boolean);
            if (recentEntries.length) {
                recordRecentBatch(recentEntries, { source: '批量下载', operationText: nowText });
            }
        }
    };

    const gatherSelectedGalleryContexts = (entries) => {
        const galleryMap = new Map();
        entries.forEach((entry) => {
            const container = entry.row?.closest ? entry.row.closest('.eh-magnet-links') : null;
            const info =
                entry.info
                || buildGalleryInfoFromDataset(entry.checkbox?.dataset)
                || buildGalleryInfoFromDataset(entry.row?.dataset)
                || buildGalleryInfoFromDataset(container?.dataset);
            let gid = info?.gid
                || entry.checkbox?.dataset.galleryGid
                || entry.row?.dataset.galleryGid
                || container?.dataset?.galleryGid
                || '';
            if (!gid) return;
            gid = String(gid);
            const context = galleryMap.get(gid) || { gid, info: null, entries: [] };
            if (!context.info && info) {
                context.info = info;
            } else if (!context.info) {
                const fallbackDataset = entry.checkbox?.dataset || entry.row?.dataset || container?.dataset || {};
                context.info = {
                    gid,
                    token: fallbackDataset.galleryToken || '',
                    href: fallbackDataset.galleryHref || '',
                    title: entry.galleryTitle || entry.archiveTitle || '',
                };
            }
            context.entries.push(entry);
            galleryMap.set(gid, context);
        });
        return Array.from(galleryMap.values());
    };

    const resolveGalleryBlockForGid = (gid, hintElements = []) => {
        const normalized = gid ? String(gid) : '';
        if (!normalized) return null;
        const escaped = escapeForSelector(normalized);

        const tryResolveFromElement = (element) => {
            if (!element || typeof element.closest !== 'function') return null;
            if (element.classList?.contains?.('gl5t')) return element;
            const block = element.closest('.gl5t');
            if (block) return block;
            const hintContainer = element.closest('.eh-magnet-links');
            if (hintContainer) {
                let prev = hintContainer.previousElementSibling;
                while (prev) {
                    if (prev.classList?.contains?.('gl5t')) return prev;
                    prev = prev.previousElementSibling;
                }
                const parent = hintContainer.parentElement;
                if (parent) {
                    const candidate = parent.querySelector('.gl5t');
                    if (candidate) return candidate;
                }
            }
            const parentGallery = element.closest('.gl1t, .gl1e, .gl1c, .gl1d, .gl1m, .gl1o, .gl1b, tr');
            if (parentGallery) {
                const candidate = parentGallery.querySelector('.gl5t');
                if (candidate) return candidate;
            }
            return null;
        };

        for (let i = 0; i < hintElements.length; i += 1) {
            const block = tryResolveFromElement(hintElements[i]);
            if (block) return block;
        }

        const container = document.querySelector(`.eh-magnet-links[data-gallery-gid="${escaped}"]`);
        if (container) {
            let prev = container.previousElementSibling;
            while (prev) {
                if (prev.classList?.contains?.('gl5t')) return prev;
                prev = prev.previousElementSibling;
            }
            const parent = container.closest('.gl1t, .gl1e, .gl1c, .gl1d, .gl1m, .gl1o, .gl1b, tr');
            if (parent) {
                const candidate = parent.querySelector('.gl5t');
                if (candidate) return candidate;
            }
        }

        const blockWithData = document.querySelector(`.gl5t[data-gallery-gid="${escaped}"]`);
        if (blockWithData) return blockWithData;

        const link = document.querySelector(`a[href*="/g/${escaped}/"]`);
        if (link) {
            const block = link.closest('.gl5t');
            if (block) return block;
            const parent = link.closest('.gl1t, .gl1e, .gl1c, .gl1d, .gl1m, .gl1o, .gl1b, tr');
            if (parent) {
                const candidate = parent.querySelector('.gl5t');
                if (candidate) return candidate;
            }
        }

        return null;
    };

    const resolveGalleryContainerForGid = (gid, block) => {
        if (block) {
            const sibling = block.nextElementSibling;
            if (sibling && sibling.classList?.contains('eh-magnet-links')) {
                return sibling;
            }
        }
        if (!gid) return null;
        return document.querySelector(`.eh-magnet-links[data-gallery-gid="${escapeForSelector(String(gid))}"]`);
    };

    const buildRefreshSkipSummary = (skippedLoaded, missingTorrent, missingBlock) => {
        const parts = [];
        if (skippedLoaded) parts.push(`跳过 ${skippedLoaded} 个已加载画廊`);
        if (missingTorrent) parts.push(`${missingTorrent} 个画廊无种子链接`);
        if (missingBlock) parts.push(`${missingBlock} 个画廊未在当前页面`);
        return parts.join('，');
    };

    const refreshSelectedGalleries = async ({ force = false } = {}) => {
        const entries = collectSelectedEntries();
        if (!entries.length) {
            toastWarn('未选择任何条目');
            return;
        }
        
        // 批量刷新时暂时禁用悬停刷新，防止干扰
        const previousHoverRefreshEnabled = hoverRefreshEnabled;
        hoverRefreshEnabled = false;
        
        try {
            // 记录初始的勾选状态（用于刷新后恢复）
            const initialCheckedGids = new Set(entries.map(e => e.info?.gid).filter(Boolean));
        
        const galleryContexts = gatherSelectedGalleryContexts(entries);
        if (!galleryContexts.length) {
            toastWarn('所选条目没有有效的画廊信息');
            return;
        }

        withDebugLog(() => console.log('[EhMagnet] refreshSelectedGalleries', {
            force,
            total: galleryContexts.length,
        }));

        let queuedCount = 0;
        let skippedLoaded = 0;
        let missingTorrent = 0;
        let missingBlock = 0;

        galleryContexts.forEach((ctx) => {
            const hints = [];
            (ctx.entries || []).forEach((entry) => {
                if (entry.checkbox) hints.push(entry.checkbox);
                if (entry.row) hints.push(entry.row);
            });
            const block = resolveGalleryBlockForGid(ctx.gid, hints);
            if (!block) {
                missingBlock += 1;
                return;
            }
            
            const container = resolveGalleryContainerForGid(ctx.gid, block);
            const pendingRow = container?.querySelector('.eh-magnet-archive-fallback[data-pending-info="true"]');
            const hasDownloadInfo = Boolean(container && container.children.length && !pendingRow);

            const torrentLink = block.querySelector('.gldown a[href*="gallerytorrents.php"]');
            if (!torrentLink) {
                missingTorrent += 1;
                return;
            }

            const galleryContainer = block.closest('.gl1t') || block.closest('tr');
            const galleryLink = galleryContainer?.querySelector('.glname a[href*="/g/"]')
                || galleryContainer?.querySelector('a[href*="/g/"]')
                || galleryContainer?.querySelector('a[href*="/s/"]');
            let galleryInfo = ctx.info
                || parseGalleryInfo(galleryLink?.href || '')
                || parseGalleryInfoFromTorrentUrl(torrentLink.href);
            if (galleryInfo && !galleryInfo.gid) {
                galleryInfo = { ...galleryInfo, gid: ctx.gid };
            }
            if (!galleryInfo) {
                galleryInfo = {
                    gid: ctx.gid,
                    token: '',
                    href: galleryLink?.href || '',
                    title: '',
                };
            }
            const galleryTitle = galleryContainer?.querySelector('.glname a')?.textContent?.trim()
                || block.querySelector('.glname a')?.textContent?.trim()
                || galleryInfo.title
                || '';
            if (galleryTitle && (!galleryInfo.title || galleryInfo.title !== galleryTitle)) {
                galleryInfo = { ...galleryInfo, title: galleryTitle };
            }

            if (!force && hasDownloadInfo) {
                skippedLoaded += 1;
                return;
            }

            const priority = force ? 120 : 100;
            const options = force ? { forceNetwork: true, forceRebuild: true } : undefined;
            injectMagnets(block, torrentLink.href, galleryInfo, priority, options);
            queuedCount += 1;
        });

        // 等待所有注入任务完成（轮询 injectingSet 直到为空，最多等待30秒）
        if (queuedCount > 0) {
            const maxWaitTime = 30000; // 30秒
            const pollInterval = 100; // 100ms
            const startTime = Date.now();
            
            while (injectingSet.size > 0 && Date.now() - startTime < maxWaitTime) {
                await new Promise(resolve => setTimeout(resolve, pollInterval));
            }
            
            if (injectingSet.size > 0) {
                console.warn('[EhMagnet] 注入任务未能在30秒内完成，仍有', injectingSet.size, '个任务未完成');
            }
        }

        // 刷新完成后，恢复之前勾选的画廊状态
        // 使用 gid 重新查询最新的 checkbox 元素，而不是依赖旧的 DOM 引用
        let restoredCount = 0;
        initialCheckedGids.forEach(gid => {
            const checkbox = document.querySelector(`input[type="checkbox"][data-gallery-gid="${gid}"]`);
            if (checkbox && !checkbox.checked) {
                checkbox.checked = true;
                restoredCount++;
            }
        });
        
        // 如果有勾选被恢复，再等待一次确保 DOM 完全更新
        if (restoredCount > 0) {
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        if (queuedCount > 0) {
            const summary = buildRefreshSkipSummary(force ? 0 : skippedLoaded, missingTorrent, missingBlock);
            if (force) {
                const suffix = summary ? `（${summary}）` : '';
                toastInfo(`已强制刷新 ${queuedCount} 个所选画廊的下载信息${suffix}`, {
                    duration: 3600,
                });
            } else {
                const suffix = summary ? `，${summary}` : '';
                toastSuccess(`已刷新 ${queuedCount} 个所选画廊${suffix}`);
            }
        } else {
            if (!force && skippedLoaded && !missingTorrent && !missingBlock) {
                toastInfo('所选画廊的下载信息均已获取，无需刷新');
            } else if (missingBlock === galleryContexts.length) {
                toastWarn('所选画廊未在当前页面，无法刷新');
            } else if (missingTorrent === galleryContexts.length) {
                toastWarn('所选画廊没有可用的种子链接');
            } else {
                toastWarn('未找到可刷新的画廊');
            }
        }

        return {
            queuedCount,
            skippedLoaded,
            missingTorrent,
            missingBlock,
            total: galleryContexts.length,
        };
        } finally {
            // 恢复悬停刷新设置
            hoverRefreshEnabled = previousHoverRefreshEnabled;
        }
    };

    function collectSelectedEntries() {
        const boxes = getVisibleCheckedBoxes();
        return boxes.map((box) => {
            const row = box.closest('.eh-magnet-item');
            const container = row?.closest('.eh-magnet-links');
            const info = buildGalleryInfoFromDataset(box.dataset)
                || buildGalleryInfoFromDataset(row?.dataset)
                || buildGalleryInfoFromDataset(container?.dataset);
            const magnetHref = box.dataset.magnetValue || row?.dataset.magnetValue || '';
            const torrentHref = box.dataset.torrentHref || row?.dataset.torrentHref || '';
            const name = box.dataset.magnetName || row?.dataset.magnetName || '';
            const archiveKey = box.dataset.archiveKey || row?.dataset.archiveKey || '';
            const isArchiveFallback = box.dataset.archiveFallback === 'true' || row?.dataset.archiveFallback === 'true';
            const archiveDltype = box.dataset.archiveDltype || row?.dataset.archiveDltype || '';
            const archivePage = box.dataset.galleryHref || row?.dataset.galleryHref || container?.dataset.galleryHref || info?.href || '';
            const archiveToken = box.dataset.galleryToken || row?.dataset.galleryToken || container?.dataset.galleryToken || info?.token || '';
            const archiverLink = box.dataset.archiverLink || row?.dataset.archiverLink || '';
            const archiveTitle = box.dataset.archiveTitle || row?.dataset.archiveTitle || container?.dataset.archiveTitle || '';
            const archiveFilename = box.dataset.archiveFilename || row?.dataset.archiveFilename || container?.dataset.archiveFilename || '';
            let galleryTitle = box.dataset.galleryTitle || row?.dataset.galleryTitle || container?.dataset.galleryTitle || archiveTitle || '';
            
            // 尝试从画廊列表DOM中提取标题（如果 dataset 中没有）
            const gid = box.dataset.galleryGid || row?.dataset.galleryGid || container?.dataset.galleryGid || info?.gid;
            if (gid && !galleryTitle) {
                // 查找对应的画廊块（支持列表视图 .gl1t 和缩略图视图 .gl3t）
                const galleryLink = document.querySelector(`.gl1t[href*="/g/${gid}/"], .gl3t a[href*="/g/${gid}/"]`);
                
                if (galleryLink) {
                    const galleryBlock = galleryLink.closest('.gl1e, .gl3t');
                    
                    if (galleryBlock) {
                        // 缩略图视图：.gl3t a > img 的 title 属性
                        // 列表视图：.gl1t（标题链接）
                        const titleElement = galleryBlock.querySelector('.gl1t');
                        if (titleElement) {
                            galleryTitle = titleElement.textContent.trim();
                        } else {
                            // 缩略图视图：从图片的 title 或 alt 属性获取
                            const imgElement = galleryBlock.querySelector('.gl3t a img');
                            if (imgElement) {
                                galleryTitle = imgElement.title || imgElement.alt || '';
                            }
                        }
                    }
                }
            }
            
            const normalizedInfo = (!info || !info?.gid) && (box.dataset.galleryGid || row?.dataset.galleryGid || container?.dataset.galleryGid)
                ? {
                    gid: box.dataset.galleryGid || row?.dataset.galleryGid || container?.dataset.galleryGid || '',
                    token: box.dataset.galleryToken || row?.dataset.galleryToken || container?.dataset.galleryToken || '',
                    href: box.dataset.galleryHref || row?.dataset.galleryHref || container?.dataset.galleryHref || '',
                    title: galleryTitle,
                }
                : (info ? { ...info, title: info.title || galleryTitle } : null);
            const effectiveInfo = normalizedInfo || info;
            return {
                checkbox: box,
                row,
                info: effectiveInfo,
                magnetHref,
                torrentHref,
                name,
                archiveKey,
                isArchiveFallback,
                galleryTitle,
                archiveTitle,
                archiveFilename,
                archive: isArchiveFallback ? {
                gid: effectiveInfo?.gid,
                token: archiveToken,
                pageLink: archivePage,
                archiverLink,
                key: archiveKey,
                dltype: archiveDltype || 'org',
                title: archiveTitle || galleryTitle,
                fileName: archiveFilename,
                } : null,
            };
        }).filter((entry) => entry.magnetHref || entry.torrentHref || entry.isArchiveFallback);
    }

    async function sendEntriesToAria(entries, options = {}) {
        const { silent = false, source = '', downloadType = 'magnet' } = options || {};
        if (!entries || !entries.length) {
            if (!silent) toastWarn('未选择任何磁力链接');
            throw new Error('没有可发送的条目');
        }
        
        // 检测是否有未获取信息的条目，如果有则自动刷新
        const pendingEntries = entries.filter((entry) => {
            if (!entry) return false;
            const checkboxPending = entry.checkbox?.dataset?.pendingInfo === 'true';
            const rowPending = entry.row?.dataset?.pendingInfo === 'true';
            return checkboxPending || rowPending;
        });
        
        if (pendingEntries.length > 0) {
            if (!silent) {
                console.log(`[Aria2发送] 检测到 ${pendingEntries.length} 个未获取信息的画廊，自动刷新...`);
            }
            await batchRefreshPendingEntries(entries, { showProgress: !silent, checkType: 'any' });
            // 重新收集条目以获得最新信息
            const freshEntries = collectSelectedEntries();
            return sendEntriesToAria(freshEntries, options);
        }
        
        const api = getAriaEhAPI();
        if (!api || typeof api.enqueueTasks !== 'function') {
            const err = new Error('EhAria2 下载助手未加载或版本不支持');
            if (!silent) toastError(err.message);
            throw err;
        }
        if (typeof api.isConfigured === 'function' && !api.isConfigured()) {
            const err = new Error('请先在 EhAria2 中配置 Aria2 RPC 地址');
            if (!silent) toastError(err.message);
            throw err;
        }

        const tasks = [];
        const mapping = [];
        const results = [];
        const recentEntries = [];
        const operationTimestamp = Date.now();
        const operationText = formatOperationTime(new Date(operationTimestamp));

        entries.forEach((entry) => {
            const magnetHref = entry.magnetHref || '';
            const torrentHref = entry.torrentHref || '';
            if (entry.isArchiveFallback) {
                const archiveInfo = entry.archive || {};
                const archiveGid = archiveInfo.gid || entry.info?.gid;
                if (!archiveGid) {
                    results.push({
                        success: false,
                        error: '画廊信息缺失，无法发送存档下载',
                        entry,
                    });
                    return;
                }
                const resolvedArchiveTitle = entry.galleryTitle
                    || entry.archiveTitle
                    || archiveInfo.title
                    || entry.info?.title
                    || '';
                const defaultFileName = archiveInfo.fileName || entry.archiveFilename || '';
                const archivePayload = {
                    gid: archiveGid,
                    token: archiveInfo.token || entry.info?.token || '',
                    dltype: archiveInfo.dltype || 'org',
                    pageLink: archiveInfo.pageLink || entry.info?.href || '',
                    archiverLink: archiveInfo.archiverLink || '',
                };
                if (resolvedArchiveTitle) archivePayload.title = resolvedArchiveTitle;
                const computedFileName = resolvedArchiveTitle
                    ? buildArchiveFileName(resolvedArchiveTitle, archivePayload.dltype || 'org')
                    : '';
                let finalFileName = defaultFileName || computedFileName;
                if (finalFileName && finalFileName.toLowerCase() === 'gallery.zip') {
                    finalFileName = computedFileName || '';
                }
                if (finalFileName) {
                    archivePayload.fileName = finalFileName;
                } else if (defaultFileName && defaultFileName.toLowerCase() !== 'gallery.zip') {
                    archivePayload.fileName = defaultFileName;
                }
                tasks.push({
                    gid: archiveGid,
                    archive: archivePayload,
                    name: finalFileName || entry.name || '',
                });
                mapping.push(entry);
                return;
            }
            if (!magnetHref && !torrentHref) {
                results.push({
                    success: false,
                    error: '无可用链接',
                    entry,
                });
                return;
            }
            // 根据下载类型只设置相应的链接
            const taskPayload = {
                gid: entry.info?.gid,
                name: entry.name || '',
            };
            if (downloadType === 'torrent') {
                taskPayload.torrent = torrentHref;
            } else {
                taskPayload.magnet = magnetHref;
            }
            tasks.push(taskPayload);
            mapping.push(entry);
        });

        if (tasks.length) {
            const apiResults = await api.enqueueTasks(tasks);
            apiResults.forEach((res, index) => {
                const entry = mapping[index];
                results.push({ ...res, entry });
            });
        }

        let successCount = 0;
        let failureCount = 0;
        let downloadChanged = false;
        let ignoreChanged = false;
        const failureMessages = [];

        results.forEach((result) => {
            const entry = result.entry;
            if (!entry) return;
            const magnetKey = entry.magnetHref || entry.torrentHref || entry.archiveKey || '';
            if (result.success) {
                successCount += 1;
                if (entry.isArchiveFallback) {
                    const fallbackInfo = entry.info?.gid
                        ? entry.info
                        : (entry.archive?.gid ? { gid: entry.archive.gid, token: entry.archive.token || '', href: entry.archive.pageLink || '' } : null);
                    if (fallbackInfo?.gid) {
                        const wasGalleryDownloaded = isGalleryDownloaded(fallbackInfo);
                        markGalleryDownloaded(fallbackInfo, { silent: true, skipPersist: true });
                        if (magnetKey) {
                            const wasDownloadedKey = isMagnetDownloaded(magnetKey);
                            markMagnetDownloaded(magnetKey, fallbackInfo, { silent: true, skipPersist: true });
                            if (!wasDownloadedKey) downloadChanged = true;
                        } else if (!wasGalleryDownloaded) {
                            downloadChanged = true;
                        }
                        if (!wasGalleryDownloaded) downloadChanged = true;
                    }
                } else if (magnetKey) {
                    const wasDownloaded = isMagnetDownloaded(magnetKey);
                    const wasIgnored = isMagnetIgnored(magnetKey, entry.info);
                    markMagnetDownloaded(magnetKey, entry.info, { silent: true, skipPersist: true });
                    if (!wasDownloaded) downloadChanged = true;
                    if (wasIgnored && !isMagnetIgnored(magnetKey, entry.info)) ignoreChanged = true;
                }
                if (entry.checkbox) entry.checkbox.checked = false;
                if (entry.magnetHref) selectedMagnets.delete(entry.magnetHref);
                if (entry.archiveKey) selectedMagnets.delete(entry.archiveKey);
                if (entry.info?.gid) selectedGalleries.delete(entry.info.gid);

                const recentContext = {
                    row: entry.row,
                    link: entry.row?.querySelector('a'),
                    name: entry.name,
                    postedTime: entry.row?.dataset?.magnetTime || '',
                    uploader: entry.row?.dataset?.magnetUploader || '',
                    size: entry.row?.dataset?.magnetSize || '',
                    isArchive: entry.isArchiveFallback,
                    archiveKey: entry.archiveKey || '',
                    archiveDltype: entry.archive?.dltype || '',
                    torrentHref: entry.torrentHref || '',
                    operationText,
                };
                const magnetPayload = entry.isArchiveFallback
                    ? {
                        href: entry.archiveKey || entry.magnetHref || '',
                        isArchive: true,
                        archiveKey: entry.archiveKey || '',
                        archiveDltype: entry.archive?.dltype || '',
                    }
                    : {
                        href: entry.magnetHref || entry.torrentHref || '',
                        torrentHref: entry.torrentHref || '',
                    };
                const recentEntry = resolveRecentEntry(magnetPayload, entry.info, recentContext);
                if (recentEntry) {
                    recentEntries.push(recentEntry);
                }
            } else {
                failureCount += 1;
                if (entry.checkbox) entry.checkbox.checked = true;
                if (entry.magnetHref) selectedMagnets.add(entry.magnetHref);
                if (entry.archiveKey) selectedMagnets.add(entry.archiveKey);
                if (entry.info?.gid) selectedGalleries.set(entry.info.gid, entry.info);
                if (result.error) failureMessages.push(result.error);
            }
        });

        if (downloadChanged) persistDownloadedState();
        if (ignoreChanged) persistIgnoredState();

        updateStatusFlags();
        rebuildSelectionSets();
        updateSelectToggleState();
        updateIgnoreToggleState();
        refreshGalleryIgnoreButtons();

        if (recentEntries.length) {
            recordRecentBatch(recentEntries, {
                source: source || '发送到 Aria2',
                timestamp: operationTimestamp,
                operationText,
            });
        }

        if (!silent) {
            if (failureCount) {
                const uniqueMessages = Array.from(new Set(failureMessages.filter(Boolean)));
                const errorText = uniqueMessages.length ? `\n失败原因：\n${uniqueMessages.join('\n')}` : '';
                toastInfo(`已发送 ${successCount}/${results.length} 个任务到 Aria2。${errorText}`);
            } else {
                toastSuccess(`已发送 ${successCount} 个任务到 Aria2`);
            }
        }

        return {
            successCount,
            failureCount,
            total: results.length,
            results,
            source,
        };
    }

    function sendSelectedToAria2() {
        return sendEntriesToAria(collectSelectedEntries(), { source: '批量发送' });
    }

    // ========== AB Download Manager 集成功能 ==========

    /**
     * 检测 AB Download Manager 是否运行
     * 注意：由于 CORS 限制，我们直接尝试发送下载任务，如果失败再提示
     */
    const checkAbdmAvailable = async () => {
        try {
            // 使用 mode: 'no-cors' 绕过 CORS 预检，但无法读取响应
            // 所以这里只是尝试连接，真正的可用性检查在发送任务时进行
            const response = await fetch(`http://localhost:${abdmPort}/ping`, {
                method: 'POST',
                mode: 'no-cors',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
            });
            // no-cors 模式下总是返回 opaque response，我们假设服务可用
            return true;
        } catch (err) {
            return false;
        }
    };

    /**
     * 从归档下载页面获取原始归档下载链接
     * 复制自 EhAria2下载助手.js 的 fetchArchiveDownloadInfo 函数
     */
    const fetchArchiveDownloadInfo = async ({ gid, token, pageLink }) => {
        // 构建 archiver.php 链接
        const isEx = window.location.hostname.includes('exhentai.org');
        const base = isEx ? 'https://exhentai.org' : 'https://e-hentai.org';
        const archiverLink = `${base}/archiver.php?gid=${gid}&token=${token}`;

        // 发送 POST 请求获取归档下载链接
        const formData = new FormData();
        formData.append('dltype', 'org'); // 原始归档
        formData.append('dlcheck', 'Download Original Archive');

        const archiverHtml = await fetch(archiverLink, {
            method: 'POST',
            credentials: 'include',
            body: formData,
        }).then((v) => v.text());

        // 提取下载链接
        const downloadLinkMatch = archiverHtml.match(/"(https?:\/\/[^"]+?\.hath\.network\/archive[^"]*)"/i);
        if (!downloadLinkMatch || !downloadLinkMatch[1]) {
            throw new Error('未找到存档下载地址');
        }

        const rawUrl = downloadLinkMatch[1];
        const downloadUrl = rawUrl.includes('?start=')
            ? rawUrl
            : `${rawUrl}${rawUrl.includes('?') ? '&' : '?'}start=1`;

        // 提取标题
        const titleMatch = archiverHtml.match(/<p\s+class="gname">(.+?)<\/p>/i);
        const title = titleMatch ? titleMatch[1].trim() : '';

        // 构建文件名
        const sanitizeFileName = (name) => {
            return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();
        };
        const fileName = sanitizeFileName(title || `gallery_${gid}`) + '_original.zip';

        return {
            downloadUrl,
            fileName,
            title,
            gid,
            token,
        };
    };

    /**
     * 发送下载任务到 AB Download Manager
     */
    const sendToAbdm = async (items) => {
        if (!items || items.length === 0) {
            throw new Error('没有可发送的下载项');
        }

        const requestBody = {
            items: items.map(item => ({
                link: item.link,
                downloadPage: item.downloadPage || '',
                headers: item.headers || {},
                suggestedName: item.suggestedName || '',
                type: 'http',
            })),
            options: {
                silentAdd: false,
                silentStart: false,
            },
        };

        try {
            // 使用 no-cors 模式避免 CORS 预检失败
            const response = await fetch(`http://localhost:${abdmPort}/add`, {
                method: 'POST',
                mode: 'no-cors',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestBody),
            });

            // no-cors 模式下无法读取响应状态，假设发送成功
            // 如果 AB DM 未运行，fetch 会抛出异常
            return { success: true };
        } catch (err) {
            throw new Error(`无法连接到 AB Download Manager (端口 ${abdmPort})，请确认服务已启动`);
        }
    };

    /**
     * 发送选中的画廊到 AB Download Manager（归档下载）
     */
    // 分类画廊：按种子状态分类
    const classifyEntriesByTorrentStatus = (entries) => {
        const classified = {
            valid: [],        // 有有效种子/磁链
            outdated: [],     // 种子过期
            noSeed: [],       // 无种子
            pending: []       // 未获取信息
        };
        
        entries.forEach(entry => {
            if (!entry) return;
            
            const isPending = entry.checkbox?.dataset?.pendingInfo === 'true' || entry.row?.dataset?.pendingInfo === 'true';
            if (isPending) {
                classified.pending.push(entry);
                return;
            }
            
            const hasMagnet = entry.magnetHref && !entry.isArchiveFallback;
            const hasTorrent = entry.torrentHref && !entry.isArchiveFallback;
            
            // 关键改进：检查归档回退行的状态
            // 归档回退行是当找不到种子或仅找到过时种子时创建的
            const isArchiveFallback = entry.isArchiveFallback;
            const isOutdated = entry.checkbox?.dataset?.magnetOutdated === 'true' || entry.row?.dataset?.magnetOutdated === 'true';
            
            let category = 'unknown';
            
            if (hasMagnet) {
                // 有磁链的画廊：优先级高，直接视为有效
                category = 'valid';
            } else if (hasTorrent) {
                // 有种链的画廊：检查状态
                const torrentStatus = entry.checkbox?.dataset?.torrentStatus || entry.row?.dataset?.torrentStatus;
                if (torrentStatus === 'outdated') {
                    category = 'outdated';
                } else if (torrentStatus === 'noseed') {
                    category = 'outdated';
                } else {
                    category = 'valid';
                }
            } else if (isArchiveFallback) {
                // 这是一个归档回退行（找不到种子或仅找到过时种子）
                if (isOutdated) {
                    // magnetOutdated=true 表示"仅找到过时种子"
                    category = 'outdated';
                } else {
                    // 否则表示"未找到种子"
                    category = 'noSeed';
                }
            } else {
                // 既没磁链也没种链，且不是归档回退 → 无种子
                category = 'noSeed';
            }
            
            classified[category].push(entry);
            
            console.log(`[分类] GID: ${entry.info?.gid}, 磁链: ${!!hasMagnet}, 种链: ${!!hasTorrent}, 归档回退: ${isArchiveFallback}, 过时标记: ${isOutdated}, 分类: ${category}`);
        });
        
        return classified;
    };

    // 统一发送下载对话框（完整重写版）
    const showDownloadDialog = async () => {
        let entries = collectSelectedEntries();
        
        if (!entries || entries.length === 0) {
            toastWarn('请先选中至少一个画廊');
            return;
        }
        
        // 记录初始的勾选状态（gid -> 勾选状态映射）
        const initialCheckedGids = new Set(entries.map(e => e.info?.gid).filter(Boolean));
        
        // 检测未获取信息的画廊，自动刷新
        const pendingEntries = entries.filter(e => 
            e.checkbox?.dataset?.pendingInfo === 'true' || e.row?.dataset?.pendingInfo === 'true'
        );
        
        if (pendingEntries.length > 0) {
            console.log(`[发送下载] 检测到 ${pendingEntries.length} 个未获取信息的画廊，自动刷新...`);
            await batchRefreshPendingEntries(entries, { showProgress: true, checkType: 'any' });
            
            // 刷新后，重新确保这些画廊保持勾选状态
            entries.forEach(entry => {
                if (initialCheckedGids.has(entry.info?.gid) && entry.checkbox) {
                    entry.checkbox.checked = true;
                }
            });
            
            // 重新收集（此时保留了勾选的状态）
            entries = collectSelectedEntries();
        }
        
        // 分类画廊
        const classified = classifyEntriesByTorrentStatus(entries);
        
        // 构建对话框
        if (classified.valid.length > 0 && classified.outdated.length === 0 && classified.noSeed.length === 0) {
            // 直接发送有效种子
            const dialog = document.createElement('div');
            dialog.style.cssText = `
                position: fixed;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
                z-index: 99999;
                background: white;
                border: 1px solid #ddd;
                border-radius: 6px;
                box-shadow: 0 4px 12px rgba(0,0,0,0.15);
                max-width: 450px;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            `;
            
            const header = document.createElement('div');
            header.style.cssText = 'padding: 16px; border-bottom: 1px solid #eee; font-size: 16px; font-weight: 600;';
            header.textContent = '发送下载';
            dialog.appendChild(header);
            
            const content = document.createElement('div');
            content.style.cssText = 'padding: 16px; border-bottom: 1px solid #eee;';
            
            const typeGroup = document.createElement('div');
            typeGroup.style.cssText = 'margin-bottom: 12px;';
            
            let selectedType = 'magnet';
            const typeMagnet = document.createElement('label');
            typeMagnet.style.cssText = 'display: inline-block; margin-right: 16px; cursor: pointer; font-size: 13px;';
            typeMagnet.innerHTML = `<input type="radio" name="send-type" value="magnet" checked> 磁链`;
            typeMagnet.addEventListener('change', (e) => { if (e.target.checked) selectedType = 'magnet'; });
            typeGroup.appendChild(typeMagnet);
            
            const typeTorrent = document.createElement('label');
            typeTorrent.style.cssText = 'display: inline-block; cursor: pointer; font-size: 13px;';
            typeTorrent.innerHTML = `<input type="radio" name="send-type" value="torrent"> 种链`;
            typeTorrent.addEventListener('change', (e) => { if (e.target.checked) selectedType = 'torrent'; });
            typeGroup.appendChild(typeTorrent);
            content.appendChild(typeGroup);
            
            const channelGroup = document.createElement('div');
            channelGroup.style.cssText = 'font-size: 13px;';
            
            const ariaAvailable = isAriaEhBridgeAvailable();
            const ariaConfigured = ariaAvailable && isAriaEhBridgeConfigured();
            
            // 判断是否有可以发送到Aria2的内容
            // Aria2需要有效的磁链/种链，不能是无种子或过时种子的画廊
            const hasValidForAria2 = classified.valid.length > 0;
            const canUseAria2 = ariaAvailable && ariaConfigured && hasValidForAria2;
            
            // 默认选择Aria2（如果可用）或AB DM
            let selectedChannel = canUseAria2 ? 'aria2' : 'abdm';
            
            // 【修改】添加对radio input的引用，用于后续置灰
            const typeInputs = typeGroup.querySelectorAll('input[name="send-type"]');
            
            const channelAria2 = document.createElement('label');
            channelAria2.style.cssText = 'display: inline-block; margin-right: 16px; cursor: pointer;';
            const aria2Input = document.createElement('input');
            aria2Input.type = 'radio';
            aria2Input.name = 'channel';
            aria2Input.value = 'aria2';
            aria2Input.checked = canUseAria2;
            aria2Input.disabled = !canUseAria2;
            aria2Input.addEventListener('change', (e) => {
                if (e.target.checked) {
                    selectedChannel = 'aria2';
                    // 启用磁链/种链选项
                    typeInputs.forEach(input => input.disabled = false);
                }
            });
            
            channelAria2.appendChild(aria2Input);
            const aria2Label = document.createElement('span');
            aria2Label.textContent = 'Aria2';
            
            let aria2DisabledReason = '';
            if (!ariaAvailable || !ariaConfigured) {
                aria2DisabledReason = '(未安装)';
            } else if (!hasValidForAria2) {
                aria2DisabledReason = '(无可用链接)';
            }
            
            if (aria2DisabledReason) {
                aria2Label.textContent += ' ' + aria2DisabledReason;
                aria2Label.style.color = '#999';
                channelAria2.style.opacity = '0.6';
                channelAria2.style.cursor = 'not-allowed';
            }
            channelAria2.appendChild(aria2Label);
            channelGroup.appendChild(channelAria2);
            
            // 【新增】Aria2（归档）选项
            const channelAria2Archive = document.createElement('label');
            channelAria2Archive.style.cssText = 'display: inline-block; margin-right: 16px; cursor: pointer;';
            const aria2ArchiveInput = document.createElement('input');
            aria2ArchiveInput.type = 'radio';
            aria2ArchiveInput.name = 'channel';
            aria2ArchiveInput.value = 'aria2-archive';
            aria2ArchiveInput.disabled = !canUseAria2;
            aria2ArchiveInput.addEventListener('change', (e) => {
                if (e.target.checked) {
                    selectedChannel = 'aria2-archive';
                    // 禁用磁链/种链选项
                    typeInputs.forEach(input => input.disabled = true);
                }
            });
            channelAria2Archive.appendChild(aria2ArchiveInput);
            const aria2ArchiveLabel = document.createElement('span');
            aria2ArchiveLabel.textContent = 'Aria2（归档）';
            if (!canUseAria2) {
                aria2ArchiveLabel.style.color = '#999';
            }
            channelAria2Archive.appendChild(aria2ArchiveLabel);
            channelGroup.appendChild(channelAria2Archive);
            
            // 【修改】AB DM 选项
            const channelAbdm = document.createElement('label');
            channelAbdm.style.cssText = 'display: inline-block; cursor: pointer;';
            const abdmInput = document.createElement('input');
            abdmInput.type = 'radio';
            abdmInput.name = 'channel';
            abdmInput.value = 'abdm';
            abdmInput.checked = !canUseAria2;
            abdmInput.addEventListener('change', (e) => {
                if (e.target.checked) {
                    selectedChannel = 'abdm';
                    // 禁用磁链/种链选项
                    typeInputs.forEach(input => input.disabled = true);
                }
            });
            channelAbdm.appendChild(abdmInput);
            const abdmLabel = document.createElement('span');
            abdmLabel.textContent = 'AB DM（归档）';
            const abdmWarning = document.createElement('span');
            abdmWarning.textContent = '⚠️ 归档消耗GP';
            abdmWarning.style.cssText = 'color: #f0ad4e; font-size: 11px; margin-left: 4px;';
            abdmLabel.appendChild(abdmWarning);
            channelAbdm.appendChild(abdmLabel);
            channelGroup.appendChild(channelAbdm);
            
            content.appendChild(channelGroup);
            dialog.appendChild(content);
            
            const btnArea = document.createElement('div');
            btnArea.style.cssText = 'padding: 12px 16px; display: flex; justify-content: flex-end; gap: 8px;';
            
            const cancelBtn = document.createElement('button');
            cancelBtn.textContent = '取消';
            cancelBtn.style.cssText = 'padding: 6px 16px; background: #f0f0f0; border: 1px solid #ccc; border-radius: 3px; cursor: pointer; font-size: 12px;';
            cancelBtn.addEventListener('click', () => dialog.remove());
            btnArea.appendChild(cancelBtn);
            
            const confirmBtn = document.createElement('button');
            confirmBtn.textContent = '发送';
            confirmBtn.style.cssText = 'padding: 6px 16px; background: #4CAF50; color: white; border: none; border-radius: 3px; cursor: pointer; font-size: 12px;';
            confirmBtn.addEventListener('click', async () => {
                dialog.remove();  // 【修复】立即关闭对话框
                try {
                    if (selectedChannel === 'aria2') {
                        // 过滤选中的类型
                        const filtered = classified.valid.filter(e => {
                            if (selectedType === 'magnet') return e.magnetHref && !e.isArchiveFallback;
                            if (selectedType === 'torrent') return e.torrentHref && !e.isArchiveFallback;
                            return false;
                        });
                        if (filtered.length === 0) {
                            toastWarn(`选中的画廊没有有效的${selectedType === 'magnet' ? '磁链' : '种链'}`);
                            return;
                        }
                        // 【修复】发送前显示处理中提示
                        toastInfo(`正在发送 ${filtered.length} 个画廊到Aria2...`);
                        // 【修复】不用await，让后续操作不阻塞
                        sendEntriesToAria(filtered, { silent: true, downloadType: selectedType });
                    } else if (selectedChannel === 'aria2-archive') {
                        // 【新增】Aria2（归档）选项
                        // 【修复】发送前显示处理中提示
                        toastInfo(`正在处理 ${classified.valid.length} 个画廊的归档...`);
                        
                        const toArchive = classified.valid.map(entry => ({
                            name: entry.info?.title || '未知',
                            gid: entry.info?.gid,
                            token: entry.info?.token,
                            href: entry.info?.href,
                            gallery: {
                                gid: entry.info?.gid,
                                token: entry.info?.token,
                                href: entry.info?.href,
                            },
                        }));
                        // 【修复】不用await，让后续操作不阻塞
                        showArchivePreCheckDialog(toArchive, async (readyItems) => {
                            // 发送到Aria2（通过fetchArchiveDownloadInfo获取链接，然后用extraOptions传文件名）
                            const api = getAriaEhAPI();
                            if (!api || typeof api.enqueueTasks !== 'function') {
                                toastError('EhAria2下载助手未加载');
                                return;
                            }
                            
                            const tasks = [];
                            // 使用并发控制替代顺序循环
                            const fetchTasks = readyItems.map((item, idx) => async () => {
                                try {
                                    const archiveInfo = await fetchArchiveDownloadInfo({
                                        gid: item.gid,
                                        token: item.token,
                                        pageLink: item.href,
                                    });
                                    
                                    // 从item.name提取纯标题
                                    let resolvedTitle = item.name;
                                    if (item.name && item.name.includes('GID')) {
                                        resolvedTitle = item.name.split('GID')[0].trim();
                                    }
                                    
                                    const finalFileName = buildArchiveFileName(resolvedTitle, archiveInfo.dltype || 'org');
                                    
                                    // 【修复】添加gid和token，让EhAria2能关联任务到画廊并显示进度
                                    tasks.push({
                                        gid: item.gid,
                                        token: item.token,
                                        uri: archiveInfo.downloadUrl,
                                        extraOptions: {
                                            out: finalFileName,
                                        },
                                    });
                                } catch (err) {
                                    console.warn(`获取 GID ${item.gid} 的归档链接失败:`, err);
                                }
                            });
                            
                            // 执行并发获取归档下载链接
                            await executeWithConcurrencyLimit(fetchTasks, null, (completed, total) => {
                                console.log(`[发送下载] 获取归档链接进度: ${completed}/${total}`);
                            });
                            
                            if (tasks.length > 0) {
                                const results = await api.enqueueTasks(tasks);
                                let sendSuccessCount = 0;
                                const nowText = formatOperationTime(new Date());
                                const recentEntries = [];
                                
                                results.forEach((res, idx) => {
                                    if (res.success) {
                                        sendSuccessCount++;
                                        
                                        // 【修复】标记为已下载并取消勾选
                                        const item = readyItems[idx];
                                        const gid = String(item.gid);
                                        
                                        // 标记为已下载
                                        markGalleryDownloaded({
                                            gid: item.gid,
                                            token: item.token,
                                            href: item.href,
                                        }, { silent: true, skipPersist: false });
                                        
                                        // 【修复】在DOM中取消对应的checkbox
                                        const checkboxesToUncheck = document.querySelectorAll(`.eh-magnet-checkbox[data-gallery-gid="${gid}"]`);
                                        checkboxesToUncheck.forEach(cb => {
                                            if (cb.checked) {
                                                cb.checked = false;
                                                const magnetKey = cb.dataset.magnetValue || cb.dataset.archiveKey || '';
                                                if (magnetKey) {
                                                    selectedMagnets.delete(magnetKey);
                                                }
                                            }
                                        });
                                        
                                        selectedGalleries.delete(gid);
                                        
                                        // 构建recent entry
                                        const archiveKeyForEntry = `archive://${gid}/org`;
                                        const recentEntry = resolveRecentEntry({
                                            href: archiveKeyForEntry,
                                            isArchive: true,
                                            archiveKey: archiveKeyForEntry,
                                            archiveDltype: 'org',
                                        }, {
                                            gid,
                                            token: item.token,
                                            href: item.href,
                                            title: item.name,
                                        }, {
                                            name: item.name,
                                            downloadUrl: tasks[idx].uri,
                                            operationText: nowText,
                                        });
                                        
                                        if (recentEntry) {
                                            recentEntries.push(recentEntry);
                                        }
                                    }
                                });
                                
                                if (recentEntries.length) {
                                    recordRecentBatch(recentEntries, { source: '纯种发送', operationText: nowText });
                                }
                                
                                toastSuccess(`成功发送 ${sendSuccessCount}/${tasks.length} 个任务到Aria2`);
                            }
                        });
                    } else if (selectedChannel === 'abdm') {
                        // 【修复】发送前显示处理中提示
                        toastInfo(`正在处理 ${classified.valid.length} 个画廊的归档...`);
                        
                        const toArchive = classified.valid.map(entry => ({
                            name: entry.info?.title || '未知',
                            gid: entry.info?.gid,
                            token: entry.info?.token,
                            href: entry.info?.href,
                            gallery: {
                                gid: entry.info?.gid,
                                token: entry.info?.token,
                                href: entry.info?.href,
                            },
                        }));
                        // 【修复】不用await，让后续操作不阻塞
                        showArchivePreCheckDialog(toArchive, async (readyItems) => {
                            await sendSelectedToAbdm(readyItems);
                        });
                    }
                } catch (err) {
                    console.warn('[发送下载] 发送失败', err);
                    toastError(`发送失败：${err?.message || err}`);
                }
            });
            btnArea.appendChild(confirmBtn);
            dialog.appendChild(btnArea);
            
            document.body.appendChild(dialog);
            return;
        }
        
        // 复杂情况：需要显示过时/无种的归档信息
        // 提前检查Aria2是否可用
        const ariaAvailableGlobal = isAriaEhBridgeAvailable();
        const ariaConfiguredGlobal = ariaAvailableGlobal && isAriaEhBridgeConfigured();
        // 需要归档区域的Aria2：只需要检查Aria2是否安装且配置
        // 因为无种/过时画廊可以通过归档功能发送到Aria2
        const canUseAria2Global = ariaAvailableGlobal && ariaConfiguredGlobal;
        
        // 首先获取过时/无种的归档信息
        const archiveInfos = {};
        const toArchive = [...classified.outdated, ...classified.noSeed];
        
        // 创建主对话框
        const mainDialog = document.createElement('div');
        mainDialog.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            z-index: 99999;
            background: white;
            border: 1px solid #ddd;
            border-radius: 6px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.15);
            max-width: 600px;
            max-height: 80vh;
            overflow-y: auto;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        `;
        
        // 标题
        const header = document.createElement('div');
        header.style.cssText = 'padding: 16px; border-bottom: 1px solid #eee; font-size: 16px; font-weight: 600;';
        header.textContent = '下载确认';
        mainDialog.appendChild(header);
        
        // 统计信息
        const statsDiv = document.createElement('div');
        statsDiv.style.cssText = 'padding: 12px 16px; background: #f5f5f5; font-size: 12px; color: #666;';
        const statItems = [];
        if (classified.valid.length > 0) statItems.push(`可直接下载：${classified.valid.length} 个`);
        if (classified.outdated.length > 0) statItems.push(`种子过时：${classified.outdated.length} 个`);
        if (classified.noSeed.length > 0) statItems.push(`无种子：${classified.noSeed.length} 个`);
        statsDiv.textContent = statItems.join(' | ');
        mainDialog.appendChild(statsDiv);
        
        // 内容区域
        const contentDiv = document.createElement('div');
        contentDiv.style.cssText = 'padding: 16px; border-bottom: 1px solid #eee;';
        
        // 有效种子区域
        let selectedSendType = 'magnet';
        let selectedValidChannel = 'aria2';
        if (classified.valid.length > 0) {
            const validSection = document.createElement('div');
            validSection.style.cssText = 'margin-bottom: 16px; padding-bottom: 12px; border-bottom: 1px solid #f0f0f0;';
            
            const validTitle = document.createElement('div');
            validTitle.style.cssText = 'font-weight: 600; margin-bottom: 8px; font-size: 13px;';
            validTitle.textContent = `📥 可直接下载 (${classified.valid.length} 个)`;
            validSection.appendChild(validTitle);
            
            const typeGroup = document.createElement('div');
            typeGroup.style.cssText = 'margin-bottom: 8px; font-size: 12px;';
            
            const typeMagnet = document.createElement('label');
            typeMagnet.style.cssText = 'display: inline-block; margin-right: 16px; cursor: pointer;';
            const typeMagnetInput = document.createElement('input');
            typeMagnetInput.type = 'radio';
            typeMagnetInput.name = 'valid-type';
            typeMagnetInput.value = 'magnet';
            typeMagnetInput.checked = true;
            typeMagnetInput.addEventListener('change', (e) => { if (e.target.checked) selectedSendType = 'magnet'; });
            typeMagnet.appendChild(typeMagnetInput);
            typeMagnet.appendChild(document.createTextNode(' 磁链'));
            typeGroup.appendChild(typeMagnet);
            
            const typeTorrent = document.createElement('label');
            typeTorrent.style.cssText = 'display: inline-block; cursor: pointer;';
            const typeTorrentInput = document.createElement('input');
            typeTorrentInput.type = 'radio';
            typeTorrentInput.name = 'valid-type';
            typeTorrentInput.value = 'torrent';
            typeTorrentInput.addEventListener('change', (e) => { if (e.target.checked) selectedSendType = 'torrent'; });
            typeTorrent.appendChild(typeTorrentInput);
            typeTorrent.appendChild(document.createTextNode(' 种链'));
            typeGroup.appendChild(typeTorrent);
            validSection.appendChild(typeGroup);
            
            // 【修改】保存type inputs用于后续置灰
            const validTypeInputs = typeGroup.querySelectorAll('input[name="valid-type"]');
            
            const channelGroup = document.createElement('div');
            channelGroup.style.cssText = 'font-size: 12px;';
            
            // 检查Aria2是否可用
            // 可直接下载区域：只检查Aria2是否安装且配置，以及是否有有效的画廊
            // 这部分画廊本身就是可以直接下载的，不受无种/过时画廊的影响
            const ariaAvailable = isAriaEhBridgeAvailable();
            const ariaConfigured = ariaAvailable && isAriaEhBridgeConfigured();
            const hasValidItems = classified.valid.length > 0;
            const canUseAria2ForValid = ariaAvailable && ariaConfigured && hasValidItems;
            
            const channelAria2 = document.createElement('label');
            channelAria2.style.cssText = 'display: inline-block; margin-right: 16px; cursor: pointer;';
            const aria2Input = document.createElement('input');
            aria2Input.type = 'radio';
            aria2Input.name = 'valid-channel';
            aria2Input.value = 'aria2';
            aria2Input.checked = canUseAria2ForValid;
            aria2Input.disabled = !canUseAria2ForValid;
            aria2Input.addEventListener('change', (e) => {
                if (e.target.checked) {
                    selectedValidChannel = 'aria2';
                    // 启用磁链/种链选项
                    validTypeInputs.forEach(input => input.disabled = false);
                }
            });
            
            channelAria2.appendChild(aria2Input);
            const aria2Label = document.createElement('span');
            aria2Label.textContent = 'Aria2';
            let aria2DisabledReason = '';
            if (!ariaAvailable || !ariaConfigured) {
                aria2DisabledReason = '(未安装)';
            } else if (!hasValidItems) {
                aria2DisabledReason = '(无可用链接)';
            }
            if (aria2DisabledReason) {
                aria2Label.textContent += ' ' + aria2DisabledReason;
                aria2Label.style.color = '#999';
                channelAria2.style.opacity = '0.6';
                channelAria2.style.cursor = 'not-allowed';
                // 如果Aria2不可用，默认改为AB DM
                selectedValidChannel = 'abdm';
            }
            channelAria2.appendChild(aria2Label);
            channelGroup.appendChild(channelAria2);
            
            // 【新增】Aria2（归档）选项
            const channelAria2Archive = document.createElement('label');
            channelAria2Archive.style.cssText = 'display: inline-block; margin-right: 16px; cursor: pointer;';
            const aria2ArchiveInput = document.createElement('input');
            aria2ArchiveInput.type = 'radio';
            aria2ArchiveInput.name = 'valid-channel';
            aria2ArchiveInput.value = 'aria2-archive';
            aria2ArchiveInput.disabled = !canUseAria2ForValid;
            aria2ArchiveInput.addEventListener('change', (e) => {
                if (e.target.checked) {
                    selectedValidChannel = 'aria2-archive';
                    // 禁用磁链/种链选项
                    validTypeInputs.forEach(input => input.disabled = true);
                }
            });
            channelAria2Archive.appendChild(aria2ArchiveInput);
            const aria2ArchiveLabel = document.createElement('span');
            aria2ArchiveLabel.textContent = 'Aria2（归档）';
            if (!canUseAria2ForValid) {
                aria2ArchiveLabel.style.color = '#999';
            }
            channelAria2Archive.appendChild(aria2ArchiveLabel);
            channelGroup.appendChild(channelAria2Archive);
            
            // 【修改】AB DM 选项
            const channelAbdm = document.createElement('label');
            channelAbdm.style.cssText = 'display: inline-block; cursor: pointer;';
            const abdmInput = document.createElement('input');
            abdmInput.type = 'radio';
            abdmInput.name = 'valid-channel';
            abdmInput.value = 'abdm';
            abdmInput.checked = !canUseAria2ForValid;
            abdmInput.addEventListener('change', (e) => {
                if (e.target.checked) {
                    selectedValidChannel = 'abdm';
                    // 禁用磁链/种链选项
                    validTypeInputs.forEach(input => input.disabled = true);
                }
            });
            channelAbdm.appendChild(abdmInput);
            const abdmLabel = document.createElement('span');
            abdmLabel.textContent = 'AB DM（归档）';
            const abdmWarning = document.createElement('span');
            abdmWarning.textContent = '⚠️ 归档消耗GP';
            abdmWarning.style.cssText = 'color: #f0ad4e; font-size: 11px; margin-left: 4px;';
            abdmLabel.appendChild(abdmWarning);
            channelAbdm.appendChild(abdmLabel);
            channelGroup.appendChild(channelAbdm);
            validSection.appendChild(channelGroup);
            
            contentDiv.appendChild(validSection);
        }
        
        // 需要归档区域（参考查询界面的样式）
        if (toArchive.length > 0) {
            const archiveSection = document.createElement('div');
            archiveSection.style.cssText = 'margin-bottom: 12px;';
            
            const archiveTitle = document.createElement('div');
            archiveTitle.style.cssText = 'font-weight: 600; margin-bottom: 12px; font-size: 13px;';
            archiveTitle.textContent = `📦 需要归档 (${toArchive.length} 个)`;
            archiveSection.appendChild(archiveTitle);
            
            // 显示当前资金（从fundInfo获取）
            const fundInfo = document.createElement('div');
            fundInfo.style.cssText = 'font-size: 11px; color: #999; margin-bottom: 12px;';
            fundInfo.innerHTML = `现有资金: <span id="archive-funds">获取中...</span>`;
            archiveSection.appendChild(fundInfo);
            
            // 获取资金信息（使用 fetchUserFundInfo）
            (async () => {
                try {
                    const userFundInfo = await fetchUserFundInfo();
                    if (userFundInfo && (userFundInfo.gp || userFundInfo.credits)) {
                        const gpText = userFundInfo.gp || '0';
                        const creditsText = userFundInfo.credits || '0';
                        document.getElementById('archive-funds').textContent = `${gpText} GP | ${creditsText} Credits`;
                    } else {
                        document.getElementById('archive-funds').textContent = '无法获取';
                    }
                } catch (e) {
                    console.warn('获取资金信息失败', e);
                    document.getElementById('archive-funds').textContent = '获取失败';
                }
            })();
            
            // 过时种子区域
            if (classified.outdated.length > 0) {
                const outdatedSubSection = document.createElement('div');
                outdatedSubSection.style.cssText = 'margin-bottom: 12px; padding: 8px; background: #fff9f0; border-left: 3px solid #ff9800; border-radius: 2px;';
                
                const outdatedLabel = document.createElement('div');
                outdatedLabel.style.cssText = 'font-size: 12px; font-weight: 600; margin-bottom: 8px; color: #ff9800;';
                outdatedLabel.textContent = `📌 种子过时 (${classified.outdated.length} 个)`;
                outdatedSubSection.appendChild(outdatedLabel);
                
                let outdatedTotal = 0;
                const outdatedItems = [];  // 收集需要获取信息的项和对应的DOM元素
                for (const entry of classified.outdated) {
                    const itemDiv = document.createElement('div');
                    itemDiv.style.cssText = 'display: flex; align-items: center; margin-bottom: 6px; font-size: 11px;';
                    
                    const checkbox = document.createElement('input');
                    checkbox.type = 'checkbox';
                    checkbox.checked = true;
                    checkbox.style.cssText = 'margin-right: 6px;';
                    itemDiv.appendChild(checkbox);
                    
                    const label = document.createElement('span');
                    label.textContent = entry.info?.title?.substring(0, 40) || `GID: ${entry.info?.gid}`;
                    label.style.cssText = 'flex: 1; color: #333;';
                    itemDiv.appendChild(label);
                    
                    // 创建占位符span（后续会被更新）
                    const gpSpan = document.createElement('span');
                    gpSpan.style.cssText = 'margin-left: 8px; color: #999; white-space: nowrap;';
                    gpSpan.textContent = '获取中...';
                    itemDiv.appendChild(gpSpan);
                    
                    outdatedItems.push({ entry, itemDiv, gpSpan });
                    outdatedSubSection.appendChild(itemDiv);
                    entry._checkbox = checkbox;
                }
                
                // 使用并发控制获取归档信息
                const outdatedFetchTasks = outdatedItems.map((item) => async () => {
                    try {
                        const archiveInfo = await fetchArchiveInfo(item.entry.info?.gid, item.entry.info?.token);
                        // 检查 gpSpan 是否仍然存在于 DOM 中（防止对话框已关闭）
                        if (!item.gpSpan || !document.body.contains(item.gpSpan)) {
                            return;
                        }
                        if (archiveInfo) {
                            item.gpSpan.style.color = '#ff9800';
                            item.gpSpan.textContent = `${archiveInfo.size} | ${archiveInfo.cost}`;
                            
                            // 提取数字用于求和
                            const costMatch = archiveInfo.cost.match(/\d+/);
                            if (costMatch) {
                                outdatedTotal += parseInt(costMatch[0]);
                            }
                        }
                    } catch (e) {
                        console.warn('获取归档信息失败', e);
                        // 检查 gpSpan 是否仍然存在
                        if (item.gpSpan && document.body.contains(item.gpSpan)) {
                            item.gpSpan.style.color = '#999';
                            item.gpSpan.textContent = '获取失败';
                        }
                    }
                });
                
                // 在后台执行并发获取（不阻塞对话框显示）
                // 不使用 await，让对话框立即显示
                executeWithConcurrencyLimit(outdatedFetchTasks, null).catch(err => {
                    console.warn('[存档选择] outdated 区域获取信息失败:', err);
                });
                
                archiveSection.appendChild(outdatedSubSection);
            }
            
            // 无种子区域
            if (classified.noSeed.length > 0) {
                const noseedSubSection = document.createElement('div');
                noseedSubSection.style.cssText = 'margin-bottom: 12px; padding: 8px; background: #fef5f5; border-left: 3px solid #f44336; border-radius: 2px;';
                
                const noseedLabel = document.createElement('div');
                noseedLabel.style.cssText = 'font-size: 12px; font-weight: 600; margin-bottom: 8px; color: #f44336;';
                noseedLabel.textContent = `⚠️ 无种子 (${classified.noSeed.length} 个)`;
                noseedSubSection.appendChild(noseedLabel);
                
                let noseedTotal = 0;
                const noSeedItems = [];  // 收集需要获取信息的项和对应的DOM元素
                for (const entry of classified.noSeed) {
                    const itemDiv = document.createElement('div');
                    itemDiv.style.cssText = 'display: flex; align-items: center; margin-bottom: 6px; font-size: 11px;';
                    
                    const checkbox = document.createElement('input');
                    checkbox.type = 'checkbox';
                    checkbox.checked = true;
                    checkbox.style.cssText = 'margin-right: 6px;';
                    itemDiv.appendChild(checkbox);
                    
                    const label = document.createElement('span');
                    label.textContent = entry.info?.title?.substring(0, 40) || `GID: ${entry.info?.gid}`;
                    label.style.cssText = 'flex: 1; color: #333;';
                    itemDiv.appendChild(label);
                    
                    // 创建占位符span（后续会被更新）
                    const gpSpan = document.createElement('span');
                    gpSpan.style.cssText = 'margin-left: 8px; color: #999; white-space: nowrap;';
                    gpSpan.textContent = '获取中...';
                    itemDiv.appendChild(gpSpan);
                    
                    noSeedItems.push({ entry, itemDiv, gpSpan });
                    noseedSubSection.appendChild(itemDiv);
                    entry._checkbox = checkbox;
                }
                
                // 使用并发控制获取归档信息
                const noSeedFetchTasks = noSeedItems.map((item) => async () => {
                    try {
                        const archiveInfo = await fetchArchiveInfo(item.entry.info?.gid, item.entry.info?.token);
                        // 检查 gpSpan 是否仍然存在于 DOM 中（防止对话框已关闭）
                        if (!item.gpSpan || !document.body.contains(item.gpSpan)) {
                            return;
                        }
                        if (archiveInfo) {
                            item.gpSpan.style.color = '#f44336';
                            item.gpSpan.textContent = `${archiveInfo.size} | ${archiveInfo.cost}`;
                            
                            const costMatch = archiveInfo.cost.match(/\d+/);
                            if (costMatch) {
                                noseedTotal += parseInt(costMatch[0]);
                            }
                        }
                    } catch (e) {
                        console.warn('获取归档信息失败', e);
                        // 检查 gpSpan 是否仍然存在
                        if (item.gpSpan && document.body.contains(item.gpSpan)) {
                            item.gpSpan.style.color = '#999';
                            item.gpSpan.textContent = '获取失败';
                        }
                    }
                });
                
                // 在后台执行并发获取（不阻塞对话框显示）
                // 不使用 await，让对话框立即显示
                executeWithConcurrencyLimit(noSeedFetchTasks, null).catch(err => {
                    console.warn('[存档选择] noSeed 区域获取信息失败:', err);
                });
                
                archiveSection.appendChild(noseedSubSection);
            }
            
            // 归档下载方式选择
            const archiveChannelGroup = document.createElement('div');
            archiveChannelGroup.style.cssText = 'margin-top: 12px; padding-top: 12px; border-top: 1px solid #f0f0f0; font-size: 12px;';
            
            let selectedArchiveChannel = canUseAria2Global ? 'aria2' : 'abdm';
            const archiveAria2 = document.createElement('label');
            archiveAria2.style.cssText = 'display: inline-block; margin-right: 16px; cursor: pointer;';
            const aria2Input = document.createElement('input');
            aria2Input.type = 'radio';
            aria2Input.name = 'archive-channel';
            aria2Input.value = 'aria2';
            aria2Input.checked = canUseAria2Global;
            aria2Input.disabled = !canUseAria2Global;
            archiveAria2.appendChild(aria2Input);
            const aria2Text = document.createElement('span');
            aria2Text.textContent = 'Aria2';
            if (!canUseAria2Global) {
                aria2Text.textContent += ' (未安装)';
                aria2Text.style.color = '#999';
                archiveAria2.style.opacity = '0.6';
                archiveAria2.style.cursor = 'not-allowed';
            }
            archiveAria2.appendChild(aria2Text);
            archiveAria2.addEventListener('change', (e) => { if (e.target.checked) selectedArchiveChannel = 'aria2'; });
            archiveChannelGroup.appendChild(archiveAria2);
            
            const archiveAbdm = document.createElement('label');
            archiveAbdm.style.cssText = 'display: inline-block; cursor: pointer;';
            const abdmInput = document.createElement('input');
            abdmInput.type = 'radio';
            abdmInput.name = 'archive-channel';
            abdmInput.value = 'abdm';
            abdmInput.checked = !canUseAria2Global;
            abdmInput.disabled = false;
            archiveAbdm.appendChild(abdmInput);
            const abdmText = document.createElement('span');
            abdmText.textContent = 'AB DM';
            archiveAbdm.appendChild(abdmText);
            archiveAbdm.addEventListener('change', (e) => { if (e.target.checked) selectedArchiveChannel = 'abdm'; });
            archiveChannelGroup.appendChild(archiveAbdm);
            archiveSection.appendChild(archiveChannelGroup);
            
            contentDiv.appendChild(archiveSection);
            mainDialog._selectedArchiveChannel = () => selectedArchiveChannel;
        }
        
        mainDialog.appendChild(contentDiv);
        
        // 按钮区域
        const btnArea = document.createElement('div');
        btnArea.style.cssText = 'padding: 12px 16px; display: flex; justify-content: flex-end; gap: 8px; background: #f9f9f9;';
        
        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = '取消';
        cancelBtn.style.cssText = 'padding: 6px 16px; background: #f0f0f0; border: 1px solid #ccc; border-radius: 3px; cursor: pointer; font-size: 12px;';
        cancelBtn.addEventListener('click', () => mainDialog.remove());
        btnArea.appendChild(cancelBtn);
        
        const sendBtn = document.createElement('button');
        sendBtn.textContent = '发送';
        sendBtn.style.cssText = 'padding: 6px 16px; background: #4CAF50; color: white; border: none; border-radius: 3px; cursor: pointer; font-size: 12px;';
        sendBtn.addEventListener('click', async () => {
            mainDialog.remove();
            
            try {
                // 发送有效种子
                if (classified.valid.length > 0) {
                    if (selectedValidChannel === 'aria2') {
                        const filtered = classified.valid.filter(e => {
                            if (selectedSendType === 'magnet') return e.magnetHref && !e.isArchiveFallback;
                            if (selectedSendType === 'torrent') return e.torrentHref && !e.isArchiveFallback;
                            return false;
                        });
                        if (filtered.length > 0) {
                            // 【修复】不用await，让有种的发送与无种的归档并行进行
                            toastInfo(`正在发送 ${filtered.length} 个${selectedSendType === 'magnet' ? '磁链' : '种链'}到Aria2...`);
                            sendEntriesToAria(filtered, { silent: true, downloadType: selectedSendType });
                        }
                    } else if (selectedValidChannel === 'aria2-archive') {
                        // 【新增】Aria2（归档）选项
                        // 【修复】不用await，让有种的发送与无种的归档并行进行
                        toastInfo(`正在处理 ${classified.valid.length} 个${selectedSendType === 'magnet' ? '磁链' : '种链'}的归档...`);
                        
                        const toArchive = classified.valid.map(entry => ({
                            name: entry.info?.title || '未知',
                            gid: entry.info?.gid,
                            token: entry.info?.token,
                            href: entry.info?.href,
                            gallery: {
                                gid: entry.info?.gid,
                                token: entry.info?.token,
                                href: entry.info?.href,
                            },
                        }));
                        showArchivePreCheckDialog(toArchive, async (readyItems) => {
                            // 发送到Aria2（通过fetchArchiveDownloadInfo获取链接）
                            const api = getAriaEhAPI();
                            if (!api || typeof api.enqueueTasks !== 'function') {
                                toastError('EhAria2下载助手未加载');
                                return;
                            }
                            
                            const tasks = [];
                            // 使用并发控制替代顺序循环
                            const fetchTasks = readyItems.map((item, idx) => async () => {
                                try {
                                    const archiveInfo = await fetchArchiveDownloadInfo({
                                        gid: item.gid,
                                        token: item.token,
                                        pageLink: item.href,
                                    });
                                    
                                    // 从item.name提取纯标题
                                    let resolvedTitle = item.name;
                                    if (item.name && item.name.includes('GID')) {
                                        resolvedTitle = item.name.split('GID')[0].trim();
                                    }
                                    
                                    const finalFileName = buildArchiveFileName(resolvedTitle, archiveInfo.dltype || 'org');
                                    
                                    // 【修复】添加gid和token，让EhAria2能关联任务到画廊并显示进度
                                    tasks.push({
                                        gid: item.gid,
                                        token: item.token,
                                        uri: archiveInfo.downloadUrl,
                                        extraOptions: {
                                            out: finalFileName,
                                        },
                                    });
                                } catch (err) {
                                    console.warn(`获取 GID ${item.gid} 的归档链接失败:`, err);
                                }
                            });
                            
                            // 执行并发获取归档下载链接
                            await executeWithConcurrencyLimit(fetchTasks, null, (completed, total) => {
                                console.log(`[发送下载] 获取归档链接进度: ${completed}/${total}`);
                            });
                            
                            if (tasks.length > 0) {
                                const results = await api.enqueueTasks(tasks);
                                let sendSuccessCount = 0;
                                results.forEach((res, idx) => {
                                    if (res.success) {
                                        sendSuccessCount++;
                                        
                                        // 【修复】标记为已下载并取消勾选
                                        const item = readyItems[idx];
                                        const gid = String(item.gid);
                                        
                                        // 标记为已下载
                                        markGalleryDownloaded({
                                            gid: item.gid,
                                            token: item.token,
                                            href: item.href,
                                        }, { silent: true, skipPersist: false });
                                        
                                        // 【修复】在DOM中直接查询并取消对应的checkbox
                                        const archiveKey = `archive://${gid}/org`;
                                        // 使用正确的属性名 data-gallery-gid
                                        const checkboxesToUncheck = document.querySelectorAll(`.eh-magnet-checkbox[data-gallery-gid="${gid}"]`);
                                        checkboxesToUncheck.forEach(cb => {
                                            if (cb.checked) {
                                                cb.checked = false;
                                                const magnetKey = cb.dataset.magnetValue || cb.dataset.archiveKey || '';
                                                if (magnetKey) {
                                                    selectedMagnets.delete(magnetKey);
                                                }
                                            }
                                        });
                                        
                                        selectedGalleries.delete(gid);
                                    }
                                });
                                toastSuccess(`成功发送 ${sendSuccessCount}/${tasks.length} 个任务到Aria2`);
                            }
                        });
                    } else if (selectedValidChannel === 'abdm') {
                        // 【修复】不用await，让有种的发送与无种的归档并行进行
                        toastInfo(`正在处理 ${classified.valid.length} 个画廊的归档...`);
                        
                        const toArchive = classified.valid.map(entry => ({
                            name: entry.info?.title || '未知',
                            gid: entry.info?.gid,
                            token: entry.info?.token,
                            href: entry.info?.href,
                            gallery: {
                                gid: entry.info?.gid,
                                token: entry.info?.token,
                                href: entry.info?.href,
                            },
                        }));
                        showArchivePreCheckDialog(toArchive, async (readyItems) => {
                            await sendSelectedToAbdm(readyItems);
                        });
                    }
                }
                
                // 发送需要归档的（仅发送勾选的项）
                if (toArchive.length > 0) {
                    const checkedArchive = toArchive.filter(e => e._checkbox && e._checkbox.checked);
                    if (checkedArchive.length > 0) {
                        const selectedArchiveChannel = mainDialog._selectedArchiveChannel?.() || 'abdm';
                        const toArchiveEntries = checkedArchive.map(entry => ({
                            name: entry.info?.title || '未知',
                            gid: entry.info?.gid,
                            token: entry.info?.token,
                            href: entry.info?.href,
                            gallery: {
                                gid: entry.info?.gid,
                                token: entry.info?.token,
                                href: entry.info?.href,
                            },
                        }));
                        
                        if (selectedArchiveChannel === 'aria2') {
                            // 【修改】支持Aria2（归档）
                            // 【修复】不用await，让无种的发送与有种的操作并行进行
                            toastInfo(`正在处理 ${checkedArchive.length} 个无种画廊的归档...`);
                            showArchivePreCheckDialog(toArchiveEntries, async (readyItems) => {
                                // 发送到Aria2 - 使用并发控制替代顺序循环
                                const tasks = [];
                                const archiveInfoResults = [];
                                
                                // 构建并发任务
                                const fetchTasks = readyItems.map((item, idx) => async () => {
                                    try {
                                        const archiveInfo = await fetchArchiveDownloadInfo({
                                            gid: item.gid,
                                            token: item.token,
                                            pageLink: item.href,
                                        });
                                        
                                        // 从item.name提取纯标题
                                        let resolvedTitle = item.name;
                                        if (item.name && item.name.includes('GID')) {
                                            resolvedTitle = item.name.split('GID')[0].trim();
                                        }
                                        
                                        const finalFileName = buildArchiveFileName(resolvedTitle, archiveInfo.dltype || 'org');
                                        
                                        // 【修复】添加gid和token，让EhAria2能关联任务到画廊并显示进度
                                        tasks.push({
                                            gid: item.gid,
                                            token: item.token,
                                            uri: archiveInfo.downloadUrl,
                                            extraOptions: {
                                                out: finalFileName,
                                            },
                                        });
                                    } catch (err) {
                                        console.warn(`获取 GID ${item.gid} 的归档链接失败:`, err);
                                    }
                                });
                                
                                // 执行并发获取归档下载链接
                                await executeWithConcurrencyLimit(fetchTasks, null, (completed, total) => {
                                    console.log(`[发送下载] 获取归档链接进度: ${completed}/${total}`);
                                });
                                
                                if (tasks.length > 0) {
                                    const api = getAriaEhAPI();
                                    if (!api || typeof api.enqueueTasks !== 'function') {
                                        toastError('EhAria2下载助手未加载');
                                        return;
                                    }
                                    
                                    const results = await api.enqueueTasks(tasks);
                                    let sendSuccessCount = 0;
                                    results.forEach((res, idx) => {
                                        if (res.success) {
                                            sendSuccessCount++;
                                        }
                                    });
                                    toastSuccess(`成功发送 ${sendSuccessCount}/${tasks.length} 个任务到Aria2`);
                                    
                                    // 【修复】标记为已下载并取消勾选（使用与sendEntriesToAria相同的逻辑）
                                    const nowText = formatOperationTime(new Date());
                                    const recentEntries = [];
                                    
                                    results.forEach((res, idx) => {
                                        if (res.success && readyItems[idx]) {
                                            const item = readyItems[idx];
                                            const gid = String(item.gid);
                                            
                                            // 标记为已下载（调用markGalleryDownloaded）
                                            markGalleryDownloaded({
                                                gid: item.gid,
                                                token: item.token,
                                                href: item.href,
                                            }, { silent: true, skipPersist: false });
                                            
                                            // 【修复】在DOM中直接查询并取消对应的checkbox
                                            // 使用正确的属性名 data-gallery-gid
                                            const checkboxesToUncheck = document.querySelectorAll(`.eh-magnet-checkbox[data-gallery-gid="${gid}"]`);
                                            checkboxesToUncheck.forEach(cb => {
                                                if (cb.checked) {
                                                    cb.checked = false;
                                                    const magnetKey = cb.dataset.magnetValue || cb.dataset.archiveKey || '';
                                                    if (magnetKey) {
                                                        selectedMagnets.delete(magnetKey);
                                                    }
                                                }
                                            });
                                            
                                            // 取消勾选
                                            selectedGalleries.delete(gid);
                                            
                                            // 构建recent entry用于记录
                                            // 【修复】重新定义archiveKey
                                            const archiveKeyForEntry = `archive://${gid}/org`;
                                            const recentEntry = resolveRecentEntry({
                                                href: archiveKeyForEntry,
                                                isArchive: true,
                                                archiveKey: archiveKeyForEntry,
                                                archiveDltype: 'org',
                                            }, {
                                                gid,
                                                token: item.token,
                                                href: item.href,
                                                title: item.name,
                                            }, {
                                                name: item.name,
                                                downloadUrl: tasks[idx].uri,
                                                operationText: nowText,
                                            });
                                            
                                            if (recentEntry) {
                                                recentEntries.push(recentEntry);
                                            }
                                        }
                                    });
                                    
                                    if (recentEntries.length) {
                                        recordRecentBatch(recentEntries, { source: '混合发送', operationText: nowText });
                                    }
                                }
                            });
                        } else if (selectedArchiveChannel === 'abdm') {
                            // 【修复】不用await，让无种的发送与有种的操作并行进行
                            toastInfo(`正在处理 ${checkedArchive.length} 个无种画廊的归档...`);
                            showArchivePreCheckDialog(toArchiveEntries, async (readyItems) => {
                                await sendSelectedToAbdm(readyItems);
                            });
                        }
                    }
                }
            } catch (err) {
                console.warn('[发送下载] 发送失败', err);
                toastError(`发送失败：${err?.message || err}`);
            }
        });
        btnArea.appendChild(sendBtn);
        
        mainDialog.appendChild(btnArea);
        document.body.appendChild(mainDialog);
    };
    const sendSelectedToAbdm = async (entriesToSend = null) => {
        // 支持两种调用方式：
        // 1. 不传参 - 从页面选择框收集条目（复选框菜单）
        // 2. 传入 entriesToSend - 直接使用提供的条目（预检后的条目）
        
        // 如果传入了预检后的条目，直接使用
        if (entriesToSend && Array.isArray(entriesToSend) && entriesToSend.length > 0) {
            const isAvailable = await checkAbdmAvailable();
            if (!isAvailable) {
                toastError(`AB Download Manager 未运行，请确保已启动`);
                return;
            }

            toastInfo(`开始获取 ${entriesToSend.length} 个画廊的归档下载链接...`);

            const downloadItems = [];
            let successCount = 0;
            let failureCount = 0;

            for (const item of entriesToSend) {
                try {
                    const archiveInfo = await fetchArchiveDownloadInfo({
                        gid: item.gid,
                        token: item.token,
                        pageLink: item.href,
                    });

                    downloadItems.push({
                        link: archiveInfo.downloadUrl,
                        downloadPage: item.href,
                        suggestedName: archiveInfo.fileName,
                    });
                    successCount++;
                } catch (err) {
                    console.warn(`获取 GID ${item.gid} 的归档信息失败:`, err);
                    failureCount++;
                }
            }

            if (downloadItems.length === 0) {
                toastError('未能获取任何有效的下载链接');
                return;
            }

            try {
                await sendToAbdm(downloadItems);
                toastSuccess(`成功发送 ${successCount} 条记录到AB DM${failureCount > 0 ? `（${failureCount} 条失败）` : ''}`);

                // 标记为已下载并取消勾选
                for (const item of entriesToSend) {
                    const gid = item.gid;
                    if (gid) {
                        markGalleryDownloaded({ gid: String(gid) });
                        
                        // 在页面上查找对应的复选框并取消勾选
                        const checkboxes = document.querySelectorAll(`.eh-magnet-checkbox[data-gallery-gid="${gid}"]`);
                        checkboxes.forEach(checkbox => {
                            checkbox.checked = false;
                        });
                    }
                }
            } catch (err) {
                console.warn('发送到 AB DM 失败:', err);
                toastError(`发送失败: ${err?.message || err}`);
            }
            return;
        }
        // 检查 AB DM 是否运行
        const isAvailable = await checkAbdmAvailable();
        if (!isAvailable) {
            toastError(`AB Download Manager 未运行或端口 ${abdmPort} 不可用\n请确保 AB Download Manager 已启动`);
            return;
        }

        const entries = collectSelectedEntries();
        if (!entries || entries.length === 0) {
            toastError('没有选中任何画廊');
            return;
        }

        // 统计种子项和归档项
        const torrentEntries = [];
        const archiveEntries = [];
        
        entries.forEach(entry => {
            if (entry.torrentHref) {
                torrentEntries.push(entry);
            } else {
                archiveEntries.push(entry);
            }
        });

        // 如果有种子项，询问用户如何处理
        let shouldContinue = true;
        let skipTorrents = false;

        if (torrentEntries.length > 0) {
            const totalCount = entries.length;
            const torrentCount = torrentEntries.length;
            const archiveCount = archiveEntries.length;

            const message = 
                `检测到 ${torrentCount} 个画廊有种子链接，${archiveCount} 个画廊将使用归档下载。\n\n` +
                `注意：\n` +
                `• AB Download Manager 不支持 BT 下载\n` +
                `• 归档下载会消耗 GP`;

            const choice = await showConfirmDialog({
                title: '检测到种子画廊',
                message: message,
                buttons: [
                    { text: '全部归档下载', value: 'all', primary: true },
                    { text: '仅归档无种子项', value: 'skip', },
                    { text: '取消', value: 'cancel', },
                ],
            });

            if (choice === 'all') {
                // 用户选择全部归档下载
                skipTorrents = false;
            } else if (choice === 'skip') {
                // 用户选择跳过种子项
                if (archiveCount === 0) {
                    toastInfo('操作已取消：所有选中的画廊都有种子');
                    return;
                }
                skipTorrents = true;
            } else {
                // 用户选择取消或关闭对话框
                toastInfo('操作已取消');
                return;
            }
        }

        // 确定要处理的条目
        const entriesToProcess = skipTorrents ? archiveEntries : entries;

        if (entriesToProcess.length === 0) {
            toastInfo('没有需要处理的画廊');
            return;
        }

        toastInfo(`开始获取 ${entriesToProcess.length} 个画廊的归档下载链接...`);

        const results = [];
        const downloadItems = [];
        let successCount = 0;
        let failureCount = 0;
        const failureMessages = [];

        for (const entry of entriesToProcess) {
            const gid = entry.info?.gid;
            const token = entry.info?.token;

            if (!gid || !token) {
                failureCount++;
                failureMessages.push(`画廊信息不完整: ${entry.info?.title || 'Unknown'}`);
                continue;
            }

            try {
                const archiveInfo = await fetchArchiveDownloadInfo({
                    gid,
                    token,
                    pageLink: entry.info?.href || '',
                });

                downloadItems.push({
                    link: archiveInfo.downloadUrl,
                    downloadPage: entry.info?.href || '',
                    headers: {
                        'Cookie': document.cookie,
                        'User-Agent': navigator.userAgent,
                    },
                    suggestedName: archiveInfo.fileName,
                });

                results.push({
                    success: true,
                    gid,
                    archiveInfo,
                });

                // 标记为已下载
                markGalleryDownloaded({ gid });

            } catch (err) {
                failureCount++;
                const errorMsg = `${entry.info?.title || gid}: ${err.message || err}`;
                failureMessages.push(errorMsg);
                results.push({
                    success: false,
                    gid,
                    error: err.message || String(err),
                });
            }
        }

        // 发送到 AB Download Manager
        if (downloadItems.length > 0) {
            try {
                await sendToAbdm(downloadItems);
                successCount = downloadItems.length;
                
                if (skipTorrents && torrentEntries.length > 0) {
                    // 如果跳过了种子项，不取消这些项的选择
                    // 只取消成功获取归档的项
                    results.forEach(result => {
                        if (result.success && result.gid) {
                            const gid = String(result.gid);
                            selectedGalleries.delete(gid);
                        }
                    });
                } else {
                    // 清空所有选择
                    clearSelection();
                }

                const summaryMsg = failureCount > 0
                    ? `成功发送 ${successCount} 个归档下载任务到 AB Download Manager\n失败 ${failureCount} 个`
                    : `成功发送 ${successCount} 个归档下载任务到 AB Download Manager`;

                toastSuccess(summaryMsg);

                if (failureMessages.length > 0) {
                    console.warn('[EhMagnet] AB DM 归档下载失败详情：', failureMessages);
                }

                // 记录到最近下载（归档下载）
                const nowText = formatOperationTime(new Date());
                const recentEntries = results
                    .filter((item) => item.success && item.archiveInfo)
                    .map((item) => {
                        const archiveKey = `archive://${item.gid}/org`;
                        // 从 entry.info 获取画廊信息（包含标题、上传时间、上传者等）
                        const entryInfo = entriesToProcess.find(e => e.info?.gid === item.gid)?.info;
                        
                        // 构建正确的画廊链接
                        const galleryToken = item.archiveInfo.token || entryInfo?.token || '';
                        const galleryHref = galleryToken
                            ? `https://e-hentai.org/g/${item.gid}/${galleryToken}`
                            : (entryInfo?.href || `https://e-hentai.org/g/${item.gid}/`);
                        
                        // 优先使用 archiveInfo.title，其次使用 entryInfo.title
                        const galleryTitle = item.archiveInfo.title || entryInfo?.title || '';
                        
                        const galleryInfo = {
                            gid: item.gid,
                            token: galleryToken,
                            href: galleryHref, // 画廊页面链接
                            title: galleryTitle,
                        };
                        
                        return resolveRecentEntry({
                            archiveKey,
                            archiveDltype: 'org',
                            isArchive: true,
                            href: archiveKey,
                        }, galleryInfo, {
                            name: galleryTitle,
                            downloadUrl: item.archiveInfo.downloadUrl, // 实际归档下载链接
                            operationText: nowText,
                        });
                    })
                    .filter(Boolean);
                if (recentEntries.length) {
                    recordRecentBatch(recentEntries, { source: '批量下载', operationText: nowText });
                }
            } catch (err) {
                toastError(`发送到 AB Download Manager 失败：${err.message || err}`);
                console.error('[EhMagnet] 发送到 AB DM 失败', err);
            }
        } else if (failureCount > 0) {
            toastError(`获取归档下载链接失败：${failureCount} 个`);
            if (failureMessages.length > 0) {
                console.warn('[EhMagnet] 获取归档链接失败详情：', failureMessages);
            }
        }
    };

    const refreshAfterTemporaryHideChange = () => {
        updateStatusFlags();
        rebuildSelectionSets();
        updateIgnoreToggleState();
    };

    const buildSelectionExportItems = (entries) => {
        if (!entries || !entries.length) return [];
        const galleryMap = new Map();
        entries.forEach((entry) => {
            const gid = entry?.info?.gid ? String(entry.info.gid) : '';
            if (!gid) return;
            if (!galleryMap.has(gid)) {
                galleryMap.set(gid, {
                    gid,
                    token: entry.info?.token || '',
                    href: entry.info?.href || '',
                    title: entry.galleryTitle || entry.info?.title || '',
                    magnet: entry.magnetHref || entry.archiveKey || '',
                    archiveKey: entry.archiveKey || '',
                    archiveDltype: entry.archive?.dltype || '',
                    isArchive: Boolean(entry.isArchiveFallback),
                });
            } else {
                const existing = galleryMap.get(gid);
                if (!existing.magnet && (entry.magnetHref || entry.archiveKey)) {
                    existing.magnet = entry.magnetHref || entry.archiveKey || '';
                }
                if (!existing.archiveKey && entry.archiveKey) {
                    existing.archiveKey = entry.archiveKey;
                }
                if (!existing.archiveDltype && entry.archive?.dltype) {
                    existing.archiveDltype = entry.archive.dltype;
                }
                if (!existing.title && (entry.galleryTitle || entry.info?.title)) {
                    existing.title = entry.galleryTitle || entry.info?.title || '';
                }
            }
        });
        return Array.from(galleryMap.values());
    };

    const buildSelectionExportPayload = (items) => ({
        type: 'eh-magnet-selection',
        version: SELECTION_EXPORT_VERSION,
        generatedAt: new Date().toISOString(),
        count: items.length,
        items,
    });

    const copySelectionPayloadToClipboard = async (items, options = {}) => {
        if (!items || !items.length) {
            if (options.emptyMessage) toastWarn(options.emptyMessage);
            return false;
        }
        const payload = buildSelectionExportPayload(items);
        const text = JSON.stringify(payload, null, 2);
        let copied = false;
        if (navigator.clipboard && navigator.clipboard.writeText) {
            try {
                await navigator.clipboard.writeText(text);
                copied = true;
            } catch (err) {
                console.warn('复制到剪贴板失败', err);
            }
        }
        if (!copied) {
            window.prompt('请手动复制以下 JSON：', text);
        } else if (options.successMessage) {
            toastSuccess(options.successMessage.replace('{count}', String(items.length)));
        }
        return true;
    };

    const buildSelectionItemsFromRecentEntries = (entries) => {
        if (!Array.isArray(entries)) return [];
        const normalized = entries
            .map((entry) => {
                const gid = entry?.gallery?.gid ? String(entry.gallery.gid) : '';
                if (!gid) return null;
                return {
                    info: {
                        gid,
                        token: entry.gallery?.token || '',
                        href: entry.gallery?.href || '',
                    },
                    magnetHref: entry.isArchive ? '' : (entry.magnet || ''),
                    archiveKey: entry.isArchive ? (entry.archiveKey || entry.magnet || '') : (entry.archiveKey || ''),
                    archive: entry.isArchive ? { dltype: entry.archiveDltype || '' } : null,
                    isArchiveFallback: Boolean(entry.isArchive),
                    galleryTitle: entry.name || '',
                    name: entry.name || '',
                };
            })
            .filter(Boolean);
        return buildSelectionExportItems(normalized);
    };

    const exportRecentEntriesToClipboard = async (entries, options = {}) => {
        const items = buildSelectionItemsFromRecentEntries(entries);
        if (!items.length) {
            if (options.emptyMessage) toastWarn(options.emptyMessage);
            return false;
        }
        const successMessage = options.successMessage || '已复制 {count} 个画廊信息';
        return copySelectionPayloadToClipboard(items, { successMessage });
    };

    const exportRecentBatchSelectionToClipboard = async (batch) => {
        if (!batch || !Array.isArray(batch.entries)) {
            toastWarn('该批次没有可导出的记录');
            return;
        }
        await exportRecentEntriesToClipboard(batch.entries, {
            emptyMessage: '该批次没有可导出的记录',
            successMessage: '已复制 {count} 个画廊信息',
        });
    };

    const exportAllRecentSelectionToClipboard = async () => {
        const batches = await loadRecentBatches();
        const entries = (batches || []).flatMap((batch) => batch.entries || []);
        await exportRecentEntriesToClipboard(entries, {
            emptyMessage: '暂无记录可以导出',
            successMessage: '已复制 {count} 个画廊信息',
        });
    };

    // 获取画廊的完整信息，包括页数
    const getGalleryInfo = (gid) => {
        if (!gid) return null;
        const gidStr = String(gid);
        
        // 查找画廊容器（.gl1t 是搜索结果条目）
        const galleryLink = document.querySelector(`a[href*="/g/${gidStr}/"]`);
        if (!galleryLink) return null;
        
        // 向上查找到 .gl1t 容器
        let gl1tElement = galleryLink;
        while (gl1tElement && !gl1tElement.classList?.contains?.('gl1t')) {
            gl1tElement = gl1tElement.parentElement;
            if (!gl1tElement) break;
        }
        
        if (!gl1tElement) return null;
        
        // 提取标题
        let title = gl1tElement.textContent.trim() || '';
        if (!title) {
            const titleEl = gl1tElement.querySelector('a');
            if (titleEl) title = titleEl.textContent.trim();
        }
        
        // 提取页数：在 .gl5t 中查找 "XX pages" 或 "XX 页" 的文本
        let pages = '';
        const gl5tElement = gl1tElement.querySelector('.gl5t');
        if (gl5tElement) {
            const allDivs = gl5tElement.querySelectorAll(':scope > div > div');
            for (const div of allDivs) {
                const text = div.textContent.trim();
                // 查找格式为 "50 pages" 或 "50 page" 或 "50 页" 的文本
                if (/^\d+\s+(pages?|页)$/i.test(text)) {
                    const match = text.match(/(\d+)\s+(pages?|页)/i);
                    if (match) {
                        pages = match[1];
                        break;
                    }
                }
            }
        }
        
        return {
            gid: gidStr,
            title: title,
            pages: pages || '?',
        };
    };

    // 显示重名画廊对话框（右侧浮窗，用于导出）
    const showDuplicateHandlerDialog = (allDuplicates, userSelectedIndices) => {
        return new Promise((resolve) => {
            // 创建右侧浮窗容器（缩窄至150px，与导入对话框保持一致）
            const floatingWindow = document.createElement('div');
            floatingWindow.className = 'eh-duplicate-handler-window';
            floatingWindow.style.cssText = `
                position: fixed;
                right: 20px;
                top: 50%;
                transform: translateY(-50%);
                width: 150px;
                max-height: 80vh;
                background: rgba(255, 255, 255, 0.88);
                border: 1px solid #ccc;
                border-radius: 6px;
                box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
                z-index: 10001;
                display: flex;
                flex-direction: column;
                overflow: hidden;
            `;
            
            // 标题栏（使用简洁风格，类似发送下载）
            const header = document.createElement('div');
            header.style.cssText = `
                padding: 8px 10px;
                background: #f0f0f0;
                color: #333;
                font-weight: bold;
                font-size: 12px;
                border-bottom: 1px solid #ddd;
                word-break: break-word;
                line-height: 1.3;
            `;
            header.textContent = '检测到重名画廊';
            floatingWindow.appendChild(header);
            
            // 内容区域
            const content = document.createElement('div');
            content.style.cssText = `
                flex: 1;
                overflow-y: auto;
                padding: 8px;
            `;
            
            // 存储用户选择状态（默认选中所有用户已勾选的项）
            const userSelections = new Map();
            allDuplicates.forEach((group, groupIdx) => {
                const selectedIndices = userSelectedIndices?.get(groupIdx) || [0];
                userSelections.set(groupIdx, selectedIndices);
            });
            
            // 全选复选框
            const selectAllDiv = document.createElement('div');
            selectAllDiv.style.cssText = `
                padding: 4px 0;
                margin-bottom: 6px;
                border-bottom: 1px solid #ddd;
                display: flex;
                align-items: center;
            `;
            const selectAllCheckbox = document.createElement('input');
            selectAllCheckbox.type = 'checkbox';
            selectAllCheckbox.style.cssText = `
                margin-right: 4px;
                cursor: pointer;
                flex-shrink: 0;
            `;
            const selectAllLabel = document.createElement('label');
            selectAllLabel.style.cssText = `
                cursor: pointer;
                font-size: 10px;
                font-weight: bold;
                color: #333;
                word-break: break-word;
            `;
            selectAllLabel.textContent = '全选';
            selectAllLabel.style.marginLeft = '2px';
            selectAllDiv.appendChild(selectAllCheckbox);
            selectAllDiv.appendChild(selectAllLabel);
            content.appendChild(selectAllDiv);
            
            // 生成重名组展示
            const checkboxRefs = []; // 保存所有复选框引用，用于全选
            allDuplicates.forEach((group, groupIdx) => {
                const groupDiv = document.createElement('div');
                groupDiv.style.cssText = `
                    margin-bottom: 8px;
                    padding: 6px;
                    background: #fafafa;
                    border-radius: 3px;
                    border-left: 2px solid #999;
                `;
                
                // 标题（支持多行）
                const titleDiv = document.createElement('div');
                titleDiv.style.cssText = `
                    font-weight: bold;
                    font-size: 10px;
                    margin-bottom: 4px;
                    color: #333;
                    word-break: break-word;
                    white-space: pre-wrap;
                    line-height: 1.3;
                `;
                titleDiv.textContent = group[0].title;
                groupDiv.appendChild(titleDiv);
                
                // 画廊列表
                group.forEach((item, itemIdx) => {
                    const itemDiv = document.createElement('div');
                    itemDiv.style.cssText = `
                        display: flex;
                        align-items: center;
                        padding: 2px 0;
                        font-size: 10px;
                    `;
                    
                    // 复选框
                    const checkbox = document.createElement('input');
                    checkbox.type = 'checkbox';
                    checkbox.style.cssText = `
                        margin-right: 3px;
                        cursor: pointer;
                        flex-shrink: 0;
                    `;
                    
                    // 检查是否应该默认选中
                    const selectedIndices = userSelections.get(groupIdx) || [];
                    checkbox.checked = selectedIndices.includes(itemIdx);
                    
                    checkbox.addEventListener('change', () => {
                        const selections = userSelections.get(groupIdx) || [];
                        if (checkbox.checked) {
                            if (!selections.includes(itemIdx)) {
                                selections.push(itemIdx);
                            }
                        } else {
                            const idx = selections.indexOf(itemIdx);
                            if (idx > -1) selections.splice(idx, 1);
                        }
                        userSelections.set(groupIdx, selections);
                        
                        // 更新全选状态
                        const allChecked = checkboxRefs.every(cb => cb.checked);
                        selectAllCheckbox.checked = allChecked;
                    });
                    
                    checkboxRefs.push(checkbox);
                    itemDiv.appendChild(checkbox);
                    
                    // 页数显示（可点击跳转）
                    const pageText = document.createElement('span');
                    pageText.style.cssText = `
                        flex: 1;
                        color: #666;
                        cursor: pointer;
                        user-select: none;
                        font-size: 9px;
                        word-break: break-word;
                    `;
                    pageText.textContent = `[${itemIdx + 1}] ${item.pages}p`;
                    
                    pageText.addEventListener('mouseenter', () => {
                        pageText.style.background = '#e0e0e0';
                        pageText.style.borderRadius = '2px';
                    });
                    pageText.addEventListener('mouseleave', () => {
                        pageText.style.background = 'transparent';
                    });
                    pageText.addEventListener('click', () => {
                        jumpToGallery(item.gid);
                        highlightGallery(item.gid);
                    });
                    
                    itemDiv.appendChild(pageText);
                    groupDiv.appendChild(itemDiv);
                });
                
                content.appendChild(groupDiv);
            });
            
            selectAllCheckbox.addEventListener('change', () => {
                checkboxRefs.forEach((cb, cbIdx) => {
                    const oldChecked = cb.checked;
                    cb.checked = selectAllCheckbox.checked;
                    
                    // 找到这个复选框对应的 groupIdx 和 itemIdx
                    let currentIdx = 0;
                    for (let gIdx = 0; gIdx < allDuplicates.length; gIdx++) {
                        for (let iIdx = 0; iIdx < allDuplicates[gIdx].length; iIdx++) {
                            if (currentIdx === cbIdx) {
                                const selections = userSelections.get(gIdx) || [];
                                if (selectAllCheckbox.checked && !selections.includes(iIdx)) {
                                    selections.push(iIdx);
                                } else if (!selectAllCheckbox.checked) {
                                    const idx = selections.indexOf(iIdx);
                                    if (idx > -1) selections.splice(idx, 1);
                                }
                                userSelections.set(gIdx, selections);
                                break;
                            }
                            currentIdx++;
                        }
                    }
                });
            });
            
            floatingWindow.appendChild(content);
            
            // 底部按钮
            const footer = document.createElement('div');
            footer.style.cssText = `
                padding: 8px;
                border-top: 1px solid #ddd;
                display: flex;
                gap: 6px;
                background: #f9f9f9;
            `;
            
            const cancelBtn = document.createElement('button');
            cancelBtn.textContent = '取消';
            cancelBtn.style.cssText = `
                flex: 1;
                padding: 6px;
                background: #f0f0f0;
                border: 1px solid #ccc;
                border-radius: 3px;
                cursor: pointer;
                font-size: 10px;
                white-space: pre-wrap;
                word-break: break-word;
                line-height: 1.2;
            `;
            cancelBtn.onclick = () => {
                floatingWindow.remove();
                resolve(null);
            };
            
            const confirmBtn = document.createElement('button');
            confirmBtn.textContent = '确定';
            confirmBtn.style.cssText = `
                flex: 1;
                padding: 6px;
                background: #667eea;
                color: white;
                border: none;
                border-radius: 3px;
                cursor: pointer;
                font-size: 10px;
                font-weight: bold;
                white-space: pre-wrap;
                word-break: break-word;
                line-height: 1.2;
            `;
            confirmBtn.onclick = () => {
                floatingWindow.remove();
                resolve(userSelections);
            };
            
            footer.appendChild(cancelBtn);
            footer.appendChild(confirmBtn);
            floatingWindow.appendChild(footer);
            
            document.body.appendChild(floatingWindow);
        });
    };

    // 显示重名画廊对话框（旧版本，保留用于导入）
    const showDuplicateGalleriesDialog = (title, galleryList) => {
        return new Promise((resolve) => {
            // 创建模态背景
            const modal = document.createElement('div');
            modal.style.cssText = `
                position: fixed;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background: rgba(0, 0, 0, 0.5);
                display: flex;
                align-items: center;
                justify-content: center;
                z-index: 10001;
            `;
            
            // 创建对话框
            const dialog = document.createElement('div');
            dialog.style.cssText = `
                background: rgba(255, 255, 255, 0.95);
                border-radius: 8px;
                padding: 20px;
                max-width: 500px;
                max-height: 70vh;
                overflow-y: auto;
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
            `;
            
            // 标题
            const titleDiv = document.createElement('div');
            titleDiv.style.cssText = `
                font-size: 16px;
                font-weight: bold;
                margin-bottom: 15px;
                color: #333;
            `;
            titleDiv.textContent = '检测到重名画廊';
            dialog.appendChild(titleDiv);
            
            // 画廊标题（可复制）
            const galleryTitleDiv = document.createElement('div');
            galleryTitleDiv.style.cssText = `
                background: #f5f5f5;
                padding: 10px;
                border-radius: 4px;
                margin-bottom: 15px;
                word-break: break-all;
                user-select: text;
                font-size: 13px;
                color: #666;
            `;
            galleryTitleDiv.textContent = title;
            dialog.appendChild(galleryTitleDiv);
            
            // 重名数量说明
            const countDiv = document.createElement('div');
            countDiv.style.cssText = `
                font-size: 13px;
                color: #666;
                margin-bottom: 12px;
                padding-bottom: 10px;
                border-bottom: 1px solid #ddd;
            `;
            countDiv.textContent = `共检测到 ${galleryList.length} 个同名画廊`;
            dialog.appendChild(countDiv);
            
            // 画廊列表表格
            const table = document.createElement('table');
            table.style.cssText = `
                width: 100%;
                border-collapse: collapse;
                font-size: 12px;
                margin-bottom: 15px;
            `;
            
            // 表头
            const thead = document.createElement('thead');
            const headerRow = document.createElement('tr');
            headerRow.style.cssText = `
                background: #f9f9f9;
                border-bottom: 1px solid #ddd;
            `;
            
            ['序号', '页数', '状态'].forEach(text => {
                const th = document.createElement('th');
                th.style.cssText = `
                    padding: 8px;
                    text-align: left;
                    font-weight: bold;
                    color: #333;
                    border: 1px solid #ddd;
                `;
                th.textContent = text;
                headerRow.appendChild(th);
            });
            thead.appendChild(headerRow);
            table.appendChild(thead);
            
            // 表体
            const tbody = document.createElement('tbody');
            galleryList.forEach((item, idx) => {
                const row = document.createElement('tr');
                row.style.cssText = `
                    border-bottom: 1px solid #eee;
                    cursor: pointer;
                    transition: background-color 0.2s;
                `;
                
                // 鼠标悬停效果
                row.onmouseenter = () => {
                    row.style.background = '#f0f0f0';
                };
                row.onmouseleave = () => {
                    row.style.background = idx === 0 ? '#e8f4fd' : 'transparent';
                };
                
                // 默认高亮第一个
                if (idx === 0) {
                    row.style.background = '#e8f4fd';
                }
                
                // 序号
                const seqTd = document.createElement('td');
                seqTd.style.cssText = `
                    padding: 8px;
                    border: 1px solid #eee;
                    text-align: center;
                `;
                seqTd.textContent = `[${idx + 1}]`;
                row.appendChild(seqTd);
                
                // 页数
                const pagesTd = document.createElement('td');
                pagesTd.style.cssText = `
                    padding: 8px;
                    border: 1px solid #eee;
                    text-align: center;
                `;
                pagesTd.textContent = item.pages || '?';
                row.appendChild(pagesTd);
                
                // 状态
                const statusTd = document.createElement('td');
                statusTd.style.cssText = `
                    padding: 8px;
                    border: 1px solid #eee;
                    color: #666;
                `;
                statusTd.textContent = idx === 0 ? '✓ 已选中' : '';
                row.appendChild(statusTd);
                
                // 点击跳转功能
                row.onclick = () => {
                    jumpToGallery(item.gid);
                    highlightGallery(item.gid);
                };
                
                tbody.appendChild(row);
            });
            table.appendChild(tbody);
            dialog.appendChild(table);
            
            // 按钮
            const buttonDiv = document.createElement('div');
            buttonDiv.style.cssText = `
                display: flex;
                gap: 10px;
                justify-content: flex-end;
                padding-top: 10px;
                border-top: 1px solid #ddd;
            `;
            
            const copyBtn = document.createElement('button');
            copyBtn.textContent = '复制标题';
            copyBtn.style.cssText = `
                padding: 8px 16px;
                background: #f0f0f0;
                border: 1px solid #ccc;
                border-radius: 4px;
                cursor: pointer;
                font-size: 12px;
                color: #333;
            `;
            copyBtn.onclick = () => {
                try {
                    navigator.clipboard.writeText(title).then(() => {
                        toastSuccess('已复制标题');
                    });
                } catch (err) {
                    toastError('复制失败');
                }
            };
            buttonDiv.appendChild(copyBtn);
            
            const closeBtn = document.createElement('button');
            closeBtn.textContent = '确定';
            closeBtn.style.cssText = `
                padding: 8px 16px;
                background: #007bff;
                color: white;
                border: none;
                border-radius: 4px;
                cursor: pointer;
                font-size: 12px;
            `;
            closeBtn.onclick = () => {
                modal.remove();
                resolve();
            };
            buttonDiv.appendChild(closeBtn);
            
            dialog.appendChild(buttonDiv);
            modal.appendChild(dialog);
            document.body.appendChild(modal);
        });
    };

    // 跳转到画廊位置
    const jumpToGallery = (gid) => {
        const gidStr = String(gid);
        const galleryLink = document.querySelector(`.gl1t[href*="/g/${gidStr}/"], .gl3t a[href*="/g/${gidStr}/"]`);
        if (!galleryLink) return;
        
        const galleryBlock = galleryLink.closest('.gl1e, .gl3t, tr');
        if (!galleryBlock) return;
        
        // 使用平滑滚动
        const rect = galleryBlock.getBoundingClientRect();
        const scrollTop = window.scrollY + rect.top - 100;
        window.scrollTo({
            top: Math.max(0, scrollTop),
            behavior: 'smooth'
        });
    };

    // 高亮画廊
    const highlightGallery = (gid) => {
        const gidStr = String(gid);
        const galleryLink = document.querySelector(`.gl1t[href*="/g/${gidStr}/"], .gl3t a[href*="/g/${gidStr}/"]`);
        if (!galleryLink) return;
        
        const galleryBlock = galleryLink.closest('.gl1e, .gl3t, tr');
        if (!galleryBlock) return;
        
        // 添加高亮彩框动画
        const originalBox = galleryBlock.style.boxShadow;
        const colors = ['#FFD700', '#FFA500', '#FF6347', '#32CD32', '#00BFFF'];
        let colorIndex = 0;
        
        const animate = () => {
            galleryBlock.style.boxShadow = `0 0 10px 2px ${colors[colorIndex]}`;
            colorIndex = (colorIndex + 1) % colors.length;
            
            if (colorIndex === 0) {
                // 动画完成，恢复原状
                galleryBlock.style.boxShadow = originalBox;
            } else {
                setTimeout(animate, 200);
            }
        };
        
        animate();
    };

    const exportSelectedGalleries = async () => {
        const entries = collectSelectedEntries();
        if (!entries.length) {
            toastWarn('未选择任何条目');
            return;
        }
        const items = buildSelectionExportItems(entries);
        return copySelectionPayloadToClipboard(items, {
            emptyMessage: '所选条目没有有效的画廊信息',
            successMessage: '已复制 {count} 个画廊信息',
        });
    };

    const extractGidsFromImportPayload = (data) => {
        if (!data) return [];
        if (Array.isArray(data)) {
            return data.map((item) => (item && (item.gid || item.galleryId) ? String(item.gid || item.galleryId) : '')).filter(Boolean);
        }
        if (Array.isArray(data?.items)) {
            return data.items.map((item) => (item && item.gid ? String(item.gid) : '')).filter(Boolean);
        }
        if (Array.isArray(data?.galleries)) {
            return data.galleries.map((item) => (item && item.gid ? String(item.gid) : '')).filter(Boolean);
        }
        return [];
    };

    // 标题标准化函数：去后缀、去数字后缀、处理空格、忽略大小写
    const normalizeTitle = (title) => {
        if (!title) return '';
        let normalized = title.trim();
        // 去掉首尾空行、压缩连续空行为1个
        normalized = normalized.replace(/\n\s*\n+/g, '\n').trim();
        // 去掉常见的压缩包后缀
        normalized = normalized.replace(/\.(zip|rar|7z|tar\.gz|tar\.bz2|tar\.xz|tar)$/i, '');
        // 去掉 (1), (2), (3) 这样的数字后缀
        normalized = normalized.replace(/\s*\(\d+\)\s*$/, '');
        // 去掉 _1, _2, _3 这样的数字后缀
        normalized = normalized.replace(/\s*_\d+\s*$/, '');
        // 去掉首尾空格
        normalized = normalized.trim();
        // 转换为小写便于比对
        return normalized.toLowerCase();
    };

    // 导出选择（仅标题）
    const exportSelectionTitleOnly = async () => {
        const entries = collectSelectedEntries();
        if (!entries.length) {
            toastWarn('未选择任何画廊');
            return;
        }

        const titles = entries
            .map((entry) => entry.galleryTitle || entry.info?.title || '')
            .filter(Boolean);

        if (!titles.length) {
            toastWarn('选中的画廊没有标题信息');
            return;
        }

        // 检测重名画廊
        const titleCountMap = new Map();
        const entryIndexMap = new Map(); // 保存原始 entry 的索引
        
        entries.forEach((entry, idx) => {
            const title = titles[idx];
            if (!title) return;
            
            if (!titleCountMap.has(title)) {
                titleCountMap.set(title, []);
                entryIndexMap.set(title, []);
            }
            
            const gid = entry.checkbox?.dataset.galleryGid || entry.info?.gid;
            titleCountMap.get(title).push({
                gid: gid,
                title: title,
                pages: getGalleryInfo(gid)?.pages || '?'
            });
            entryIndexMap.get(title).push(idx);
        });
        
        // 如果存在重名，显示浮窗让用户选择
        const duplicateGroups = Array.from(titleCountMap.entries())
            .filter(([title, items]) => items.length > 1)
            .map(([title, items]) => items);
        
        if (duplicateGroups.length > 0) {
            // 构建用户已选择的索引 Map
            const userSelectedIndices = new Map();
            let selectionGroupIdx = 0;
            for (const [title, items] of titleCountMap.entries()) {
                if (items.length > 1) {
                    const originalEntryIndices = entryIndexMap.get(title) || [];
                    
                    // 【新增】按GID去重：同一个画廊（相同GID）只保留第一个种子的索引
                    // 这样即使用户多选了同一个画廊的多个种子，在对话框中也只会显示一次
                    const uniqueByGid = [];
                    const seenGids = new Set();
                    originalEntryIndices.forEach(idx => {
                        const gid = items[idx]?.gid;
                        if (gid && !seenGids.has(gid)) {
                            seenGids.add(gid);
                            uniqueByGid.push(idx);
                        }
                    });
                    
                    userSelectedIndices.set(selectionGroupIdx, uniqueByGid.length > 0 ? uniqueByGid : originalEntryIndices);
                    selectionGroupIdx++;
                }
            }
            
            const userSelections = await showDuplicateHandlerDialog(duplicateGroups, userSelectedIndices);
            if (!userSelections) return; // 用户取消
            
            // 根据用户选择重新生成标题列表
            const finalTitles = [];
            let groupIdx = 0;
            
            for (const [title, items] of titleCountMap.entries()) {
                if (items.length > 1) {
                    // 这是一个重名组，按用户选择添加
                    const selectedIndices = userSelections.get(groupIdx) || [0];
                    selectedIndices.forEach(itemIdx => {
                        if (itemIdx < items.length) {
                            finalTitles.push(items[itemIdx].title);
                        }
                    });
                    groupIdx++;
                } else {
                    // 非重名项直接添加
                    finalTitles.push(items[0].title);
                }
            }
            
            const text = finalTitles.join('\n');
            try {
                await copyMagnet(text);
                toastSuccess(`已复制 ${finalTitles.length} 个画廊标题`);
            } catch (err) {
                console.warn('复制标题失败', err);
                toastError('复制失败，请重试');
            }
        } else {
            // 没有重名，直接导出
            const text = titles.join('\n');
            try {
                await copyMagnet(text);
                toastSuccess(`已复制 ${titles.length} 个画廊标题`);
            } catch (err) {
                console.warn('复制标题失败', err);
                toastError('复制失败，请重试');
            }
        }
    };

    // 导入选择（仅标题）
    const importSelectionTitleOnly = async () => {
        let text = '';
        if (navigator.clipboard && navigator.clipboard.readText) {
            try {
                text = await navigator.clipboard.readText();
            } catch (err) {
                console.warn('读取剪贴板失败', err);
            }
        }
        if (!text) {
            const input = window.prompt('粘贴文件名列表（每行一个）：');
            if (!input) return;
            text = input;
        }

        // 分割输入，去掉空行
        const fileNames = text
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean);

        if (!fileNames.length) {
            toastWarn('输入为空');
            return;
        }

        // 标准化文件名和搜索页标题
        const normalizedFiles = fileNames.map((name) => normalizeTitle(name));

        // 收集当前页面的所有画廊和其标题
        const allCheckboxes = Array.from(document.querySelectorAll('.eh-magnet-checkbox'));
        const galleryMap = new Map(); // Map: 标准化标题 -> [{checkbox, info, normalizedTitle}, ...]

        allCheckboxes.forEach((checkbox) => {
            const row = checkbox.closest('.eh-magnet-item');
            const container = row?.closest('.eh-magnet-links');
            let title = checkbox.dataset.galleryTitle
                || row?.dataset.galleryTitle
                || container?.dataset.galleryTitle
                || '';

            // 从DOM提取标题
            const gid = checkbox.dataset.galleryGid || row?.dataset.galleryGid || container?.dataset.galleryGid;
            if (!title && gid) {
                const galleryLink = document.querySelector(`.gl1t[href*="/g/${gid}/"], .gl3t a[href*="/g/${gid}/"]`);
                if (galleryLink) {
                    const galleryBlock = galleryLink.closest('.gl1e, .gl3t');
                    if (galleryBlock) {
                        const titleElement = galleryBlock.querySelector('.gl1t');
                        if (titleElement) {
                            title = titleElement.textContent.trim();
                        } else {
                            const imgElement = galleryBlock.querySelector('.gl3t a img');
                            if (imgElement) {
                                title = imgElement.title || imgElement.alt || '';
                            }
                        }
                    }
                }
            }

            if (title) {
                const normalized = normalizeTitle(title);
                if (!galleryMap.has(normalized)) {
                    galleryMap.set(normalized, []);
                }
                galleryMap.get(normalized).push({
                    checkbox,
                    title,
                    normalized,
                });
            }
        });

        // 进行匹配和标记
        const matched = [];
        const duplicates = new Map(); // 重复标题的记录
        const unmatched = [];

        normalizedFiles.forEach((normalizedFile) => {
            const galleryList = galleryMap.get(normalizedFile);

            if (!galleryList || galleryList.length === 0) {
                unmatched.push(normalizedFile);
            } else if (galleryList.length === 1) {
                // 单独匹配，勾选
                const { checkbox } = galleryList[0];
                if (!checkbox.checked) {
                    checkbox.checked = true;
                }
                matched.push(galleryList[0]);
            } else {
                // 多个匹配（重复标题）
                if (!duplicates.has(normalizedFile)) {
                    duplicates.set(normalizedFile, []);
                }
                
                // 获取重名画廊的完整信息（包括页数）
                const galleryInfoList = galleryList.map((item, idx) => ({
                    gid: item.checkbox.dataset.galleryGid,
                    title: item.title,
                    pages: getGalleryInfo(item.checkbox.dataset.galleryGid)?.pages || '?',
                    itemIndex: idx,  // 【新增】记录项在galleryList中的索引
                }));
                
                duplicates.set(normalizedFile, galleryInfoList);
                
                // 重名处理：根据剪贴板中的数量，选择相应数量的重名项
                // 计算该标题在剪贴板中出现的次数
                // 【修复】只勾选每个GID的第一个，而不是根据剪贴板数量勾选多个
                const seenGidsInDuplicates = new Set();
                for (let i = 0; i < galleryList.length; i++) {
                    const gid = galleryList[i].checkbox.dataset.galleryGid;
                    // 同一GID只勾选第一个
                    if (!seenGidsInDuplicates.has(gid)) {
                        seenGidsInDuplicates.add(gid);
                        if (!galleryList[i].checkbox.checked) {
                            galleryList[i].checkbox.checked = true;
                            matched.push(galleryList[i]); // 只在勾选时添加到 matched
                        }
                    }
                }
            }
        });

        rebuildSelectionSets();
        updateSelectToggleState();

        // 统计实际勾选的画廊数（去重）
        const matchedGids = new Set();
        matched.forEach(item => {
            if (item.checkbox && item.checkbox.dataset.galleryGid) {
                matchedGids.add(item.checkbox.dataset.galleryGid);
            }
        });

        // 显示结果对话框
        showImportResultDialog({
            matched: matchedGids.size,
            duplicates,
            unmatched,
            normalizedFiles,
            fileNames,
        });
    };

    // 导入结果对话框（改进版：支持重复项处理，右侧显示）
    const showImportResultDialog = async (result) => {
        const { matched, duplicates, unmatched, normalizedFiles, fileNames } = result;

        // 创建右侧浮窗容器（不使用模态遮罩）
        const floatingWindow = document.createElement('div');
        floatingWindow.className = 'eh-import-result-window';
        floatingWindow.style.cssText = `
            position: fixed;
            right: 20px;
            top: 50%;
            transform: translateY(-50%);
            width: 150px;
            max-height: 85vh;
            background: rgba(255, 255, 255, 0.88);
            border: 1px solid #ccc;
            border-radius: 6px;
            box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
            z-index: 10000;
            display: flex;
            flex-direction: column;
            overflow: hidden;
        `;

        const dialog = floatingWindow;

        // 统计数据（实时更新用）
        const stats = {
            matched: matched,
            duplicates: duplicates.size,
            unmatched: unmatched.length,
            updateDisplay: function() {
                const statsDiv = document.getElementById('import-stats-display');
                if (statsDiv) {
                    statsDiv.innerHTML = `
                        <p><strong>✓ 已匹配:</strong> ${this.matched} 个</p>
                        <p><strong>⚠ 重复标题:</strong> ${this.duplicates} 组</p>
                        <p><strong>✗ 未匹配:</strong> ${this.unmatched} 个</p>
                    `;
                }
            }
        };

        // 标题栏
        const header = document.createElement('div');
        header.style.cssText = `
            padding: 10px 14px;
            background: #f0f0f0;
            color: #333;
            font-weight: bold;
            font-size: 13px;
            border-bottom: 1px solid #ddd;
        `;
        header.textContent = '反查导入结果';
        dialog.appendChild(header);
        
        // 内容容器
        const content = document.createElement('div');
        content.style.cssText = `
            flex: 1;
            overflow-y: auto;
            padding: 10px;
        `;
        
        let html = '';

        // 统计信息（可实时更新）
        html += `
            <div id="import-stats-display" style="background: #fafafa; padding: 8px; border-radius: 4px; margin-bottom: 10px; font-size: 12px; line-height: 1.6;">
                <div style="margin: 3px 0; word-break: break-word;"><strong>✓</strong> 匹配 ${matched}</div>
                <div style="margin: 3px 0; word-break: break-word;"><strong>⚠</strong> 重名 ${duplicates.size}</div>
                <div style="margin: 3px 0; word-break: break-word;"><strong>✗</strong> 未匹配 ${unmatched.length}</div>
            </div>
        `;

        // 重复标题列表（带复选框，支持实时更新统计和跳转）
        if (duplicates.size > 0) {
            html += '<div style="font-weight: bold; font-size: 11px; color: #e74c3c; margin-top: 8px; margin-bottom: 6px; word-break: break-word;">重复标题</div>';
            html += '<div id="duplicate-items-container" style="background: #fafafa; border: 1px solid #ddd; border-radius: 4px; padding: 8px; margin-bottom: 10px;">';

            let duplicateIndex = 0;
            duplicates.forEach((galleryList, normalizedTitle) => {
                html += `<div style="margin-bottom: 8px; padding: 6px; background: white; border-radius: 3px; border-left: 2px solid #e74c3c;">`;
                html += `<div style="font-weight: bold; font-size: 11px; margin-bottom: 4px; word-break: break-word; white-space: pre-wrap; line-height: 1.4;">${galleryList[0].title}</div>`;
                
                // 画廊列表
                // 【新增】记录每个GID已处理的第一项，同一GID只勾选第一个
                const seenGidsInThisGroup = new Set();
                galleryList.forEach((item, itemIdx) => {
                    const checkboxId = `duplicate-checkbox-${duplicateIndex}-${itemIdx}`;
                    // 【修复】同一GID只勾选第一个，其他的取消勾选
                    const isFirstOfThisGid = !seenGidsInThisGroup.has(item.gid);
                    if (isFirstOfThisGid) {
                        seenGidsInThisGroup.add(item.gid);
                    }
                    const isChecked = isFirstOfThisGid;  // 只有第一个才被勾选
                    html += `
                        <div style="display: flex; align-items: center; padding: 4px 0; font-size: 11px;">
                            <input type="checkbox" id="${checkboxId}" data-dup-index="${duplicateIndex}" data-item-index="${itemIdx}" data-gid="${item.gid}"
                                   style="margin-right: 6px; cursor: pointer; flex-shrink: 0;" ${isChecked ? 'checked' : ''} />
                            <span class="duplicate-page-link" style="flex: 1; color: #666; cursor: pointer; user-select: none; word-break: break-word;" data-gid="${item.gid}">
                                [${itemIdx + 1}] ${item.pages}p
                            </span>
                        </div>
                    `;
                });
                
                html += `</div>`;
                duplicateIndex++;
            });

            html += '</div>';
        }


        content.innerHTML = html;
        dialog.appendChild(content);
        
        // 添加底部按钮栏
        const footer = document.createElement('div');
        footer.style.cssText = `
            padding: 8px;
            border-top: 1px solid #ddd;
            background: #f9f9f9;
            display: flex;
            gap: 6px;
        `;
        
        const btnClose = document.createElement('button');
        btnClose.id = 'btn-close';
        btnClose.textContent = '关闭';
        btnClose.style.cssText = `
            flex: 1;
            padding: 4px;
            background: #f0f0f0;
            border: 1px solid #ccc;
            border-radius: 3px;
            cursor: pointer;
            font-size: 10px;
            white-space: pre-wrap;
            word-break: break-word;
            line-height: 1.3;
        `;
        
        const btnUnmatched = document.createElement('button');
        btnUnmatched.id = 'btn-unmatched';
        btnUnmatched.innerHTML = '导出<br/>未匹配项';
        btnUnmatched.style.cssText = `
            flex: 1;
            padding: 4px;
            background: #ffe0e0;
            border: 1px solid #ffb3b3;
            border-radius: 3px;
            cursor: pointer;
            font-size: 10px;
            white-space: pre-wrap;
            word-break: break-word;
            line-height: 1.3;
        `;
        
        footer.appendChild(btnClose);
        footer.appendChild(btnUnmatched);
        dialog.appendChild(footer);
        
        document.body.appendChild(dialog);

        // 处理重复项复选框变化和跳转
        if (duplicates.size > 0) {
            const duplicateCheckboxes = dialog.querySelectorAll('input[data-dup-index]');
            const pageLinks = dialog.querySelectorAll('.duplicate-page-link');
            
            // 复选框变化事件
            duplicateCheckboxes.forEach((checkbox) => {
                checkbox.addEventListener('change', () => {
                    const gid = checkbox.dataset.gid;
                    const itemIndex = parseInt(checkbox.dataset.itemIndex);
                    
                    // 【修复】找到该GID对应的所有checkbox，然后根据itemIndex选择第几个
                    const allCheckboxesForGid = Array.from(document.querySelectorAll(`.eh-magnet-checkbox[data-gallery-gid="${gid}"]`));
                    
                    // 需要找到对应索引的checkbox
                    // 由于同一GID可能有多个种子，需要找到对应位置的那个
                    if (allCheckboxesForGid.length > itemIndex) {
                        allCheckboxesForGid[itemIndex].checked = checkbox.checked;
                    }
                    
                    // 实时更新统计
                    rebuildSelectionSets();
                    updateSelectToggleState();
                    
                    // 更新重复标题组数
                    let newDuplicateCount = 0;
                    duplicates.forEach((galleryList, normalizedTitle) => {
                        const groupCheckboxes = Array.from(duplicateCheckboxes)
                            .filter(cb => cb.getAttribute('data-dup-index') === checkbox.getAttribute('data-dup-index'));
                        const anyChecked = groupCheckboxes.some(cb => cb.checked);
                        const notAllChecked = groupCheckboxes.some(cb => !cb.checked);
                        if (anyChecked && notAllChecked) {
                            newDuplicateCount++;
                        }
                    });
                    
                    stats.duplicates = newDuplicateCount;
                    stats.matched = Array.from(document.querySelectorAll('.eh-magnet-checkbox:checked')).length;
                    stats.updateDisplay();
                });
            });
            
            // 页数链接点击跳转
            pageLinks.forEach((link) => {
                link.addEventListener('click', () => {
                    const gid = link.dataset.gid;
                    jumpToGallery(gid);
                    highlightGallery(gid);
                });
            });
        }

        // 事件处理
        btnClose.addEventListener('click', () => {
            dialog.remove();
        });

        btnUnmatched.addEventListener('click', async () => {
            if (unmatched.length === 0) {
                toastInfo('没有未匹配的文件');
                return;
            }

            // 反向转换：从标准化标题还原原始文件名
            const unmatchedFiles = [];
            unmatched.forEach((normalizedTitle) => {
                // 查找原始文件名
                const originalIndex = normalizedFiles.indexOf(normalizedTitle);
                if (originalIndex !== -1) {
                    const originalFileName = fileNames[originalIndex] || normalizedTitle;
                    unmatchedFiles.push(originalFileName);
                }
            });

            const text = unmatchedFiles.join('\n');
            try {
                await copyMagnet(text);
                toastSuccess(`已复制 ${unmatchedFiles.length} 个未匹配项`);
            } catch (err) {
                console.warn('复制失败', err);
                toastError('复制失败，请重试');
            }
        });

    };

    const importSelectionFromClipboard = async () => {
        let text = '';
        if (navigator.clipboard && navigator.clipboard.readText) {
            try {
                text = await navigator.clipboard.readText();
            } catch (err) {
                console.warn('读取剪贴板失败', err);
            }
        }
        if (!text) {
            const input = window.prompt('粘贴导出的 JSON：');
            if (!input) return;
            text = input;
        }
        try {
            const data = JSON.parse(text);
            const gids = extractGidsFromImportPayload(data);
            if (!gids.length) {
                toastWarn('导入的数据中没有有效的画廊信息');
                return;
            }
            const uniqueGids = Array.from(new Set(gids.map((gid) => String(gid))));
            let matchedGalleries = 0;
            let matchedCheckboxes = 0;
            const missingGids = [];

            uniqueGids.forEach((gid) => {
                if (!gid) return;
                const selector = `.eh-magnet-checkbox[data-gallery-gid="${escapeForSelector(gid)}"]`;
                const boxes = Array.from(document.querySelectorAll(selector));
                if (!boxes.length) {
                    missingGids.push(gid);
                    return;
                }
                matchedGalleries += 1;
                boxes.forEach((box) => {
                    if (!box.checked) {
                        box.checked = true;
                    }
                    matchedCheckboxes += 1;
                });
            });

            rebuildSelectionSets();
            updateSelectToggleState();

            withDebugLog(() => console.log('[EhMagnet] importSelection', {
                total: uniqueGids.length,
                matchedGalleries,
                matchedCheckboxes,
                missing: missingGids.length,
            }));

            if (matchedGalleries) {
                const messageParts = [`选中 ${matchedGalleries} 个画廊`];
                if (missingGids.length) {
                    messageParts.push(`${missingGids.length} 个未在当前页面出现`);
                }
                toastSuccess(`导入成功，${messageParts.join('，')}`);
            } else {
                toastInfo('导入成功，但当前页面未匹配到相应画廊');
            }
        } catch (err) {
            console.warn('导入选择失败', err);
            toastError('导入失败，请确认 JSON 格式正确');
        }
    };

    const hideSelectedGalleriesTemporarily = async () => {
        const entries = collectSelectedEntries();
        if (!entries.length) {
            toastWarn('未选择任何条目');
            return;
        }
        const gids = entries
            .map((entry) => (entry?.info?.gid ? String(entry.info.gid) : ''))
            .filter(Boolean);
        if (!gids.length) {
            toastWarn('所选条目没有有效的画廊信息');
            return;
        }
        const result = hideGalleriesByIds(gids);
        applyTemporaryHiddenState();
        refreshAfterTemporaryHideChange();
        clearSelection();
        const hiddenCount = result.hiddenCount;
        const skippedCount = result.alreadyHidden;
        if (hiddenCount) {
            toastSuccess(`已临时隐藏 ${hiddenCount} 个画廊${skippedCount ? `，其中 ${skippedCount} 个已隐藏` : ''}`);
        } else {
            toastInfo('所选画廊均已处于隐藏状态');
        }
    };

    const restoreTemporaryHiddenGalleries = () => {
        if (!tempHiddenGalleries.size) {
            toastInfo('当前没有临时隐藏的画廊');
            return;
        }
        const recovered = clearTemporaryHiddenGalleries();
        refreshAfterTemporaryHideChange();
        toastSuccess(`已恢复 ${recovered} 个临时隐藏的画廊`);
    };

    const inlineActionDefs = [
        { id: 'mark', label: '📌 标记' },
        { id: 'copy-magnet', label: '🧲 复制磁链' },
        { id: 'copy-torrent', label: '🌱 复制种链', requiresTorrent: true },
        { id: 'download-torrent', label: '⬇️ 下载种子', requiresTorrent: true },
        { id: 'ignore', label: '🚫 忽略' },
    ];

    let inlineContextMenu = null;
    let inlineContextMenuOutsideHandler = null;
    let inlineContextMenuScrollHandler = null;
    let inlineContextMenuResizeHandler = null;
    let inlineContextMenuKeyHandler = null;
    let inlineContextEntry = null;
    let inlineContextButton = null;

    function buildEntryFromElement(element) {
        if (!element) return null;
        const row = element.closest('.eh-magnet-item');
        const container = row?.closest('.eh-magnet-links');
        let info = resolveGalleryInfo(element.dataset, null)
            || buildGalleryInfoFromDataset(row?.dataset)
            || buildGalleryInfoFromDataset(container?.dataset);
        const checkbox = row?.querySelector('.eh-magnet-checkbox') || null;
        const magnetHref = element.dataset.magnetValue
            || row?.dataset.magnetValue
            || checkbox?.dataset.magnetValue
            || '';
        const torrentHref = element.dataset.torrentHref
            || row?.dataset.torrentHref
            || checkbox?.dataset.torrentHref
            || '';
        const name = element.dataset.magnetName
            || row?.dataset.magnetName
            || checkbox?.dataset.magnetName
            || container?.dataset.archiveFilename
            || '';
        const archiveKey = element.dataset.archiveKey
            || row?.dataset.archiveKey
            || checkbox?.dataset.archiveKey
            || '';
        const isArchiveFallback = element.dataset.archiveFallback === 'true'
            || row?.dataset.archiveFallback === 'true'
            || checkbox?.dataset.archiveFallback === 'true';
        const archiveDltype = element.dataset.archiveDltype
            || row?.dataset.archiveDltype
            || checkbox?.dataset.archiveDltype
            || '';
        const archivePage = element.dataset.galleryHref
            || row?.dataset.galleryHref
            || container?.dataset.galleryHref
            || info?.href
            || '';
        const archiveToken = element.dataset.galleryToken
            || row?.dataset.galleryToken
            || container?.dataset.galleryToken
            || info?.token
            || '';
        const archiverLink = element.dataset.archiverLink
            || row?.dataset.archiverLink
            || checkbox?.dataset.archiverLink
            || '';
        const archiveTitle = element.dataset.archiveTitle
            || row?.dataset.archiveTitle
            || checkbox?.dataset.archiveTitle
            || container?.dataset.archiveTitle
            || '';
        const archiveFilename = element.dataset.archiveFilename
            || row?.dataset.archiveFilename
            || checkbox?.dataset.archiveFilename
            || container?.dataset.archiveFilename
            || '';
        const galleryTitle = element.dataset.galleryTitle
            || row?.dataset.galleryTitle
            || checkbox?.dataset.galleryTitle
            || container?.dataset.galleryTitle
            || archiveTitle
            || '';
        const archive = isArchiveFallback ? {
            gid: info?.gid || checkbox?.dataset.galleryGid || row?.dataset.galleryGid || '',
            token: archiveToken,
            pageLink: archivePage,
            archiverLink,
            key: archiveKey,
            dltype: archiveDltype || 'org',
            title: archiveTitle,
            fileName: archiveFilename,
        } : null;
        if ((!info || !info?.gid) && archive?.gid) {
            info = {
                gid: archive.gid,
                token: archive.token || '',
                href: archive.pageLink || '',
                title: galleryTitle,
            };
        } else if (info && galleryTitle && !info.title) {
            info = { ...info, title: galleryTitle };
        }
        if ((!info || !info?.gid) && row) {
            const galleryBlock = row.closest('.gl5t') || row.closest('.gl1t') || null;
            if (galleryBlock) {
                const galleryLink = galleryBlock.querySelector('.glname a[href*="/g/"]');
                const parsed = parseGalleryInfo(galleryLink?.href || '');
                if (parsed?.gid) {
                    info = {
                        ...parsed,
                        title: galleryTitle || parsed.title || galleryLink?.textContent?.trim() || '',
                    };
                }
            }
        }
        if ((!info || !info?.gid) && typeof window !== 'undefined') {
            const detailInfo = parseGalleryInfo(window.location.href);
            if (detailInfo?.gid) {
                const detailTitle = document.querySelector('#gd2 #gn')?.textContent?.trim() || '';
                info = {
                    ...detailInfo,
                    title: galleryTitle || detailTitle || detailInfo.title || '',
                };
            }
        }
        return {
            element,
            row,
            checkbox,
            info,
            magnetHref,
            torrentHref,
            name,
            archiveKey,
            isArchiveFallback,
            archive,
            archiveTitle,
            archiveFilename,
            galleryTitle,
        };
    }

    function ensureInlineContextMenu() {
        if (inlineContextMenu && document.body.contains(inlineContextMenu)) return inlineContextMenu;
        const menu = document.createElement('div');
        menu.className = 'eh-inline-context-menu';
        menu.style.position = 'absolute';
        menu.style.display = 'none';
        menu.style.userSelect = 'none';
        applyMenuSurfaceStyle(menu, {
            minWidth: null,
            padding: '6px 0',
            zIndex: '1000000',
        });
        menu.style.whiteSpace = 'nowrap';
        menu.style.overflow = 'hidden';
        menu.setAttribute('role', 'menu');

        inlineActionDefs.forEach((def) => {
            const item = document.createElement('button');
            item.type = 'button';
            item.dataset.action = def.id;
            if (def.requiresTorrent) item.dataset.requiresTorrent = 'true';
            item.innerHTML = def.label;  // 【修复】使用innerHTML让&nbsp;被正确解析
            item.style.display = 'block';
            item.style.width = '100%';
            item.style.padding = '6px 14px';
            item.style.border = 'none';
            item.style.background = 'transparent';
            item.style.color = 'inherit';
            item.style.textAlign = 'left';
            item.style.cursor = 'pointer';
            item.style.fontSize = '13px';
            item.style.fontWeight = '600';
            
            // 添加title提示
            const inlineActionTitleMap = {
                'mark': '标记此画廊为已下载',
                'copy-magnet': '复制磁力链接到剪贴板',
                'copy-torrent': '复制种子链接到剪贴板',
                'download-torrent': '下载种子文件',
                'ignore': '忽略此画廊',
            };
            if (inlineActionTitleMap[def.id]) {
                item.title = inlineActionTitleMap[def.id];
            }
            
            const hoverColor = getMenuHoverBackground();
            item.addEventListener('mouseenter', () => {
                if (item.disabled) return;
                item.style.background = hoverColor;
            });
            item.addEventListener('mouseleave', () => {
                item.style.background = 'transparent';
            });
            item.addEventListener('click', (event) => {
                event.stopPropagation();
                if (item.disabled) return;
                const currentEntry = inlineContextEntry;
                hideInlineContextMenu();
                Promise.resolve(handleInlineAction(def.id, currentEntry)).catch((err) => {
                    console.warn('执行上下文操作失败', err);
                });
            });
            menu.appendChild(item);
        });

        menu.addEventListener('contextmenu', (event) => event.preventDefault());

        inlineContextMenu = menu;
        document.body.appendChild(menu);
        return menu;
    }

    function hideInlineContextMenu() {
        if (!inlineContextMenu) return;
        inlineContextMenu.style.display = 'none';
        inlineContextMenu.dataset.visible = 'false';
        inlineContextEntry = null;
        inlineContextButton = null;
        if (inlineContextMenuOutsideHandler) {
            document.removeEventListener('mousedown', inlineContextMenuOutsideHandler, true);
            inlineContextMenuOutsideHandler = null;
        }
        if (inlineContextMenuScrollHandler) {
            document.removeEventListener('scroll', inlineContextMenuScrollHandler, true);
            inlineContextMenuScrollHandler = null;
        }
        if (inlineContextMenuResizeHandler) {
            window.removeEventListener('resize', inlineContextMenuResizeHandler, true);
            inlineContextMenuResizeHandler = null;
        }
        if (inlineContextMenuKeyHandler) {
            document.removeEventListener('keydown', inlineContextMenuKeyHandler, true);
            inlineContextMenuKeyHandler = null;
        }
    }

    function showInlineContextMenu(event, entry, button) {
        const menu = ensureInlineContextMenu();
        hideInlineContextMenu();

        inlineContextEntry = entry;
        inlineContextButton = button;

        menu.style.display = 'block';
        menu.dataset.visible = 'true';

        const viewportX = event.clientX;
        const viewportY = event.clientY;
        let posX = window.scrollX + viewportX;
        let posY = window.scrollY + viewportY;

        menu.style.left = `${posX}px`;
        menu.style.top = `${posY}px`;

        const rect = menu.getBoundingClientRect();
        if (rect.right > window.innerWidth) {
            posX = Math.max(window.scrollX + 8, window.scrollX + window.innerWidth - rect.width - 8);
        }
        if (rect.bottom > window.innerHeight) {
            posY = Math.max(window.scrollY + 8, window.scrollY + window.innerHeight - rect.height - 8);
        }
        menu.style.left = `${posX}px`;
        menu.style.top = `${posY}px`;

        const hasTorrent = Boolean(entry.torrentHref);
        const keyForStatus = entry.magnetHref || entry.archiveKey || '';
        const magnetIgnored = keyForStatus
            ? isMagnetIgnored(keyForStatus, entry.info)
            : (entry.isArchiveFallback ? isGalleryIgnored(entry.info) : false);
        const magnetDownloaded = keyForStatus
            ? isMagnetDownloaded(keyForStatus)
            : (entry.isArchiveFallback ? isGalleryDownloaded(entry.info) : false);

        menu.querySelectorAll('button[data-action]').forEach((item) => {
            if (!(item instanceof HTMLButtonElement)) return;
            const requiresTorrent = item.dataset.requiresTorrent === 'true';
            const isCopyMagnetAction = item.dataset.action === 'copy-magnet';
            if ((requiresTorrent && !hasTorrent) || (isCopyMagnetAction && entry.isArchiveFallback)) {
                item.disabled = true;
                item.style.opacity = '0.45';
                item.style.cursor = 'not-allowed';
            } else {
                item.disabled = false;
                item.style.opacity = '1';
                item.style.cursor = 'pointer';
            }
            if (item.dataset.action === 'ignore') {
                item.innerHTML = magnetIgnored ? '&nbsp;✓&nbsp;&nbsp;取消忽略' : '🚫&nbsp;忽略';
            }
            if (item.dataset.action === 'mark') {
                item.innerHTML = magnetDownloaded ? '&nbsp;✓&nbsp;&nbsp;取消标记' : '📌&nbsp;标记';
            }
        });

        inlineContextMenuOutsideHandler = (e) => {
            if (menu.contains(e.target)) return;
            hideInlineContextMenu();
        };
        document.addEventListener('mousedown', inlineContextMenuOutsideHandler, true);

        inlineContextMenuScrollHandler = () => hideInlineContextMenu();
        document.addEventListener('scroll', inlineContextMenuScrollHandler, true);

        inlineContextMenuResizeHandler = () => hideInlineContextMenu();
        window.addEventListener('resize', inlineContextMenuResizeHandler, true);

        inlineContextMenuKeyHandler = (e) => {
            if (e.key === 'Escape') hideInlineContextMenu();
        };
        document.addEventListener('keydown', inlineContextMenuKeyHandler, true);
    }

    const syncEntryFlagDisplay = (entry) => {
        if (!entry || !entry.row) return;
        const { row } = entry;
        const checkbox = entry.checkbox || row.querySelector('.eh-magnet-checkbox');
        const info = entry.info
            || buildGalleryInfoFromDataset(row.dataset)
            || buildGalleryInfoFromDataset(checkbox?.dataset)
            || null;

        updateRowStatusFlags(row);

        const gid = info?.gid || row.dataset.galleryGid || checkbox?.dataset.galleryGid;
        if (gid) {
            const button = galleryIgnoreButtons.get(String(gid));
            if (button) updateGalleryIgnoreButtonState(button, String(gid));
        }
    };

    async function handleInlineAction(action, entryOverride) {
        const entry = entryOverride || inlineContextEntry;
        if (!entry) return;
        const magnetKey = entry.magnetHref || entry.torrentHref || entry.archiveKey || '';
        const isArchive = Boolean(entry.isArchiveFallback);

        withDebugLog(() => console.log('[EhMagnet] handleInlineAction', {
            action,
            magnetKey,
            gid: entry.info?.gid,
            isArchive,
            info: entry.info,
        }));

        try {
            if (action === 'copy-magnet') {
                if (isArchive) {
                    toastWarn('该条目仅支持存档下载，无法复制磁链');
                    return;
                }
                if (!entry.magnetHref) {
                    toastWarn('该条目没有磁力链接');
                    return;
                }
                await copyMagnet(entry.magnetHref);
                markMagnetDownloaded(magnetKey, entry.info, { silent: true, skipPersist: true });
                persistDownloadedState();
                persistIgnoredState();
                syncEntryFlagDisplay(entry);
                updateStatusFlags();
                
                // 记录到"最近下载"
                recordMagnetCopy(
                    { href: entry.magnetHref },
                    entry.info,
                    '右键复制磁链',
                    {
                        row: entry.row,
                        link: entry.row?.querySelector('a'),
                        name: entry.name,
                        size: entry.size,
                        postedTime: entry.postedTime,
                        uploader: entry.uploader,
                        operationText: formatOperationTime(new Date()),
                    }
                );
                return;
            }
            if (action === 'copy-torrent') {
                if (!entry.torrentHref) {
                    toastWarn('该条目没有种子链接');
                    return;
                }
                await copyMagnet(entry.torrentHref);
                markMagnetDownloaded(magnetKey, entry.info, { silent: true, skipPersist: true });
                persistDownloadedState();
                persistIgnoredState();
                syncEntryFlagDisplay(entry);
                updateStatusFlags();
                // 记录到"最近下载"（右键复制种链）
                recordMagnetCopy(
                    {
                        href: entry.torrentHref,
                        torrentHref: entry.torrentHref,
                        filename: entry.name || entry.torrentName || '',
                        displayText: entry.name || entry.torrentName || '',
                    },
                    entry.info,
                    '右键复制种链',
                    {
                        row: entry.row,
                        link: entry.element,
                        name: entry.name || entry.torrentName,
                        size: entry.size,
                        postedTime: entry.postedTime,
                        uploader: entry.uploader,
                        operationText: formatOperationTime(new Date()),
                    },
                );
                return;
            }
            if (action === 'download-torrent') {
                if (!entry.torrentHref) {
                    toastWarn('该条目没有种子链接');
                    return;
                }
                await triggerHiddenTorrentDownload(entry.torrentHref, { holdMs: TORRENT_IFRAME_HOLD_MS });
                markMagnetDownloaded(magnetKey, entry.info, { silent: true, skipPersist: true });
                persistDownloadedState();
                persistIgnoredState();
                syncEntryFlagDisplay(entry);
                updateStatusFlags();
                return;
            }
            if (action === 'ignore') {
                if (!magnetKey) {
                    toastWarn('该条目没有可忽略的链接');
                    return;
                }
                const wasIgnored = isMagnetIgnored(magnetKey, entry.info);
                
                // 检查是画廊级忽略还是单个磁力链接忽略
                const isGalleryLevelIgnored = entry.info?.gid && ignoredGalleries.has(String(entry.info.gid));
                const isMagnetLevelIgnored = magnetKey && ignoredMagnets.has(magnetKey);
                
                if (wasIgnored) {
                    if (isGalleryLevelIgnored && !isMagnetLevelIgnored) {
                        // 画廊级忽略（可能来自Highlight），取消整个画廊的忽略
                        unmarkGalleryIgnored(entry.info);
                    } else {
                        // 单个磁力链接忽略
                        unmarkMagnetIgnored(magnetKey, entry.info, { silent: true, skipPersist: true });
                        persistIgnoredState();
                    }
                } else {
                    markMagnetIgnored(magnetKey, entry.info, { silent: true, skipPersist: true });
                    persistIgnoredState();
                }
                syncEntryFlagDisplay(entry);
                updateStatusFlags();
                const fallbackGid = entry.info?.gid
                    || entry.checkbox?.dataset.galleryGid
                    || entry.row?.dataset.galleryGid
                    || entry.element?.dataset.galleryGid
                    || '';
                if (fallbackGid) {
                    refreshGalleryPostedBadges(String(fallbackGid));
                }
                
                // 触发事件通知EH Highlight Duplicate
                const eventGid = entry.info?.gid
                    ? String(entry.info.gid)
                    : (fallbackGid ? String(fallbackGid) : '');
                if (eventGid) {
                    try {
                        const event = new CustomEvent('eh-magnet-ignore-changed', { 
                            detail: { gid: eventGid, action: wasIgnored ? 'unmark' : 'mark', source: 'eh-magnet' },
                            bubbles: true 
                        });
                        document.dispatchEvent(event);
                    } catch (err) {}
                }
                return;
            }
            if (action === 'mark') {
                if (!magnetKey) {
                    toastWarn('该条目没有可标记的链接');
                    return;
                }
                const wasDownloaded = isMagnetDownloaded(magnetKey);
                let gid = entry.info?.gid ? String(entry.info.gid) : '';
                if (!gid) {
                    gid = entry.checkbox?.dataset.galleryGid
                        || entry.row?.dataset.galleryGid
                        || entry.element?.dataset.galleryGid
                        || '';
                }
                if (wasDownloaded) {
                    // 取消标记
                    unmarkMagnetDownloaded(magnetKey, entry.info, { silent: true, skipPersist: true });
                    if (isArchive && entry.info?.gid) {
                        removeGalleryDownloadRecords(gid);
                    }
                } else {
                    // 添加标记
                    markMagnetDownloaded(magnetKey, entry.info, { silent: true, skipPersist: true });
                    if (isArchive && entry.info?.gid) {
                        markGalleryDownloaded(entry.info, { silent: true, skipPersist: true });
                    }
                }
                persistDownloadedState();
                persistIgnoredState();
                syncEntryFlagDisplay(entry);
                
                // 标记为已下载时，取消勾选并从选中集合中删除
                if (!wasDownloaded) {
                    if (entry.checkbox) {
                        entry.checkbox.checked = false;
                    }
                    selectedMagnets.delete(magnetKey);
                    if (gid) {
                        selectedGalleries.delete(gid);
                    }
                    rebuildSelectionSets();
                    updateSelectToggleState();
                }
                
                if (gid) {
                    refreshGalleryPostedBadges(gid);
                    const block = resolveGalleryBlockFromElement(inlineContextButton)
                        || inlineContextButton?.closest('.gl5t');
                    if (block) {
                        const statusButton = block.querySelector('.eh-gallery-ignore-badge');
                        if (statusButton) {
                            if (wasDownloaded) {
                                statusButton.dataset.hovered = 'false';
                            }
                            updateGalleryIgnoreButtonState(statusButton, gid);
                        }
                    }
                }
                updateStatusFlags();
                refreshGalleryIgnoreButtons();
                return;
            }
        } catch (err) {
            console.warn('执行操作失败', err);
            toastError(err?.message || '操作失败');
        }
    }

    function attachSendButtonBehavior(button) {
        if (!button || button.dataset.ariaSendAttached === 'true') return;
        button.dataset.ariaSendAttached = 'true';
        button.classList.add('eh-magnet-send-button');
        button.textContent = '📥';
        button.title = '发送到 Aria2';

        button.addEventListener('click', async (event) => {
            event.stopPropagation();
            hideInlineContextMenu();
            if (!isAriaEhBridgeAvailable()) {
                toastError('EhAria2 下载助手未加载或版本不支持');
                button.textContent = '×';
                setTimeout(() => {
                    if (button.dataset.sending !== 'true') button.textContent = '📥';
                }, 1500);
                return;
            }
            if (!isAriaEhBridgeConfigured()) {
                toastError('请先在 EhAria2 设置中配置 Aria2 RPC 地址');
                button.textContent = '×';
                setTimeout(() => {
                    if (button.dataset.sending !== 'true') button.textContent = '📥';
                }, 1500);
                return;
            }
            const entry = buildEntryFromElement(button);
            if (!entry || (!entry.magnetHref && !entry.torrentHref && !entry.isArchiveFallback)) {
                toastWarn('该条目没有可发送的链接');
                return;
            }
            if (button.dataset.sending === 'true') return;
            button.dataset.sending = 'true';
            button.textContent = '⏳';
            try {
                const summary = await sendEntriesToAria([entry], { silent: true, source: '单条发送' });
                const outcome = summary.results && summary.results[0];
                if (outcome?.success) {
                    button.textContent = '✔';
                } else {
                    button.textContent = '×';
                    if (outcome?.error) {
                        toastError(outcome.error);
                    } else {
                        toastError('发送失败');
                    }
                }
                setTimeout(() => {
                    if (button.dataset.sending !== 'true') {
                        button.textContent = '📥';
                    }
                }, 1200);
            } catch (err) {
                console.warn('发送到 Aria2 失败', err);
                button.textContent = '×';
                toastError(err?.message || '发送失败');
                setTimeout(() => {
                    if (button.dataset.sending !== 'true') {
                        button.textContent = '📥';
                    }
                }, 1500);
            } finally {
                button.dataset.sending = 'false';
            }
        });

        button.addEventListener('contextmenu', (event) => {
            event.preventDefault();
            event.stopPropagation();
            const entry = buildEntryFromElement(button);
            if (!entry) return;
            showInlineContextMenu(event, entry, button);
        });
    }


    let selectionContextMenu = null;
    let selectionContextMenuOutsideHandler = null;
    let selectionContextMenuScrollHandler = null;
    let selectionContextMenuResizeHandler = null;
    let selectionContextMenuKeyHandler = null;
    let selectionContextMenuBound = false;

    const ensureSelectionContextMenu = () => {
        if (selectionContextMenu && document.body.contains(selectionContextMenu)) return selectionContextMenu;
        
        // 清理旧的二级菜单
        document.querySelectorAll('.eh-selection-submenu').forEach(submenu => {
            submenu.remove();
        });
        
        // 清理旧菜单
        if (selectionContextMenu && selectionContextMenu.parentNode) {
            selectionContextMenu.remove();
        }
        
        const menu = document.createElement('div');
        menu.className = 'eh-selection-context-menu';
        menu.style.position = 'absolute';
        menu.style.display = 'none';
        menu.style.userSelect = 'none';
        applyMenuSurfaceStyle(menu, {
            minWidth: '240px',
            padding: '6px 0',
            zIndex: '999999',
        });
        menu.style.overflow = 'hidden';
        menu.setAttribute('role', 'menu');

        const actionDefs = [
            { id: 'refresh-selected', label: '🔃 刷新所选画廊', requiresSelection: true },
            { id: 'refresh-selected-force', label: '⚡ 强制刷新所选画廊', requiresSelection: true },
            { id: 'copy-magnet', label: '🧲 复制所选（磁链）', requiresSelection: true },
            { id: 'copy-torrent', label: '🌱 复制所选（种链）', requiresSelection: true, requiresTorrent: true },
            { id: 'send-download', label: '📤 发送下载', requiresSelection: true },
            { id: 'query-archive-info', label: '📋 查询归档信息', requiresSelection: true },
            { id: 'mark-selected', label: '📌 标记所选', requiresSelection: true },
            { id: 'ignore-selected', label: '🚫 忽略所选', requiresSelection: true },
            { id: 'cancel', label: '❌ 取消选择', requiresSelection: true },
            { id: 'selectall', label: '☑️ 全选（有条件）' },
            { id: 'invert', label: '🔄 反选（无条件）' },
            { id: 'toggle-include-downloaded', label: '&nbsp;✓&nbsp;&nbsp;已下载', isToggle: true },
            { id: 'toggle-include-ignored', label: '🚫&nbsp;已忽略', isToggle: true },
            { id: 'toggle-include-no-seeds', label: '❌&nbsp;无种子', isToggle: true },
            { id: 'toggle-include-outdated', label: '⏰&nbsp;种子过时', isToggle: true },
            { id: 'import-export-submenu', label: '📥📤 导入/导出选择', isSubmenu: true },
            { id: 'hide-temp', label: '👁️ 临时隐藏所选', requiresSelection: true },
            { id: 'unhide-temp', label: '👁️‍🗨️ 取消临时隐藏', requiresHidden: true },
            { id: 'download-torrent', label: '⬇️ 下载所选种子', requiresSelection: true, requiresTorrent: true },
            { id: 'clear', label: '🗑️ 清除标识', requiresSelection: true },
        ];

        // 二级菜单定义：导入/导出选择
        const submenuDefs = {
            'import-export-submenu': [
                { id: 'export-selection', label: '💾 导出选择', requiresSelection: true },
                { id: 'import-selection', label: '📂 导入选择' },
                { id: 'export-selection-title-only', label: '📄 导出选择（仅标题）', requiresSelection: true },
                { id: 'import-selection-title-only', label: '🔍 导入选择（仅标题）' },
            ]
        };

        // 创建"多选时包含"标题和复选框组
        const toggleDefs = actionDefs.filter(def => def.isToggle);
        if (toggleDefs.length > 0) {
            // 添加分组标题
            const toggleTitle = document.createElement('div');
            toggleTitle.style.padding = '8px 14px 4px';
            toggleTitle.style.fontSize = '12px';
            toggleTitle.style.fontWeight = '600';
            toggleTitle.style.color = '#888';
            toggleTitle.textContent = '多选时包含：';
            menu.appendChild(toggleTitle);

            // 创建复选框容器（2列2行布局）
            const toggleContainer = document.createElement('div');
            toggleContainer.style.display = 'grid';
            toggleContainer.style.gridTemplateColumns = '1fr 1fr';
            toggleContainer.style.gap = '4px';
            toggleContainer.style.padding = '0 10px 4px';

            toggleDefs.forEach((def) => {
                const label = document.createElement('label');
                label.style.display = 'flex';
                label.style.alignItems = 'center';
                label.style.gap = '6px';
                label.style.cursor = 'pointer';
                label.style.fontSize = '13px';
                label.style.fontWeight = '500';
                label.style.padding = '4px';
                label.style.borderRadius = '3px';
                
                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.style.cursor = 'pointer';
                checkbox.style.width = '14px';
                checkbox.style.height = '14px';
                checkbox.style.flexShrink = '0';
                checkbox.style.margin = '0';
                checkbox.addEventListener('click', (event) => event.stopPropagation());
                checkbox.addEventListener('change', (event) => {
                    event.stopPropagation();
                    if (def.id === 'toggle-include-downloaded') {
                        excludeDownloadedOnSelect = !checkbox.checked;
                        excludeDownloaded = !excludeDownloadedOnSelect || !excludeIgnoredOnSelect;
                    } else if (def.id === 'toggle-include-ignored') {
                        excludeIgnoredOnSelect = !checkbox.checked;
                        excludeDownloaded = !excludeDownloadedOnSelect || !excludeIgnoredOnSelect;
                    } else if (def.id === 'toggle-include-no-seeds') {
                        excludeNoSeedsOnSelect = !checkbox.checked;
                    } else if (def.id === 'toggle-include-outdated') {
                        excludeOutdatedOnSelect = !checkbox.checked;
                    }
                    persistExcludePreference();
                    syncExcludeDownloadedState();
                    rebuildSelectionSets();
                    updateSelectToggleState();
                    updateIgnoreToggleState();
                    updateSelectionMenuAvailability();
                    syncSettingsMenuControls();
                });
                
                const text = document.createElement('span');
                text.innerHTML = def.label;  // 【修复】使用innerHTML让&nbsp;被正确解析
                text.style.userSelect = 'none';
                
                label.appendChild(checkbox);
                label.appendChild(text);
                label.addEventListener('click', (event) => event.stopPropagation());
                
                const hoverColor = getMenuHoverBackground();
                label.addEventListener('mouseenter', () => {
                    label.style.background = hoverColor;
                });
                label.addEventListener('mouseleave', () => {
                    label.style.background = 'transparent';
                });
                
                toggleContainer.appendChild(label);
                
                // 保存复选框引用
                if (def.id === 'toggle-include-downloaded') {
                    selectionIncludeDownloadedToggle = checkbox;
                } else if (def.id === 'toggle-include-ignored') {
                    selectionIncludeIgnoredToggle = checkbox;
                } else if (def.id === 'toggle-include-no-seeds') {
                    selectionIncludeNoSeedsToggle = checkbox;
                } else if (def.id === 'toggle-include-outdated') {
                    selectionIncludeOutdatedToggle = checkbox;
                }
            });

            menu.appendChild(toggleContainer);
        }

        // 渲染普通按钮和二级菜单
        actionDefs.filter(def => !def.isToggle).forEach((def) => {
            // 处理二级菜单
            if (def.isSubmenu && submenuDefs[def.id]) {
                const container = document.createElement('div');
                container.style.position = 'relative';
                container.style.display = 'block';
                container.style.overflow = 'visible';  // 允许二级菜单溢出
                
                const item = document.createElement('button');
                item.type = 'button';
                item.dataset.action = def.id;
                item.innerHTML = def.label + ' ▶';
                item.style.display = 'block';
                item.style.width = '100%';
                item.style.padding = '6px 14px';
                item.style.border = 'none';
                item.style.background = 'transparent';
                item.style.color = 'inherit';
                item.style.textAlign = 'left';
                item.style.cursor = 'pointer';
                item.style.fontSize = '13px';
                item.style.fontWeight = '600';
                item.style.userSelect = 'none';
                item.style.position = 'relative';
                item.style.zIndex = '1';
                
                // 创建二级菜单容器
                const submenu = document.createElement('div');
                submenu.className = 'eh-selection-submenu';
                submenu.style.position = 'fixed';  // 改为 fixed 以避免主菜单的 overflow 影响
                submenu.style.display = 'none';
                submenu.style.minWidth = '200px';
                submenu.style.zIndex = '1000000';
                submenu.style.pointerEvents = 'auto';  // 确保能接收点击事件
                applyMenuSurfaceStyle(submenu, {
                    minWidth: '200px',
                    padding: '6px 0',
                    zIndex: '1000000',
                });
                
                // 填充二级菜单项
                submenuDefs[def.id].forEach((subDef) => {
                    const subItem = document.createElement('button');
                    subItem.type = 'button';
                    subItem.dataset.action = subDef.id;
                    if (subDef.requiresSelection) subItem.dataset.requiresSelection = 'true';
                    if (subDef.requiresTorrent) subItem.dataset.requiresTorrent = 'true';
                    subItem.innerHTML = subDef.label;
                    subItem.style.display = 'block';
                    subItem.style.width = '100%';
                    subItem.style.padding = '6px 14px';
                    subItem.style.border = 'none';
                    subItem.style.background = 'transparent';
                    subItem.style.color = 'inherit';
                    subItem.style.textAlign = 'left';
                    subItem.style.cursor = 'pointer';
                    subItem.style.fontSize = '13px';
                    subItem.style.fontWeight = '600';
                    subItem.style.pointerEvents = 'auto';  // 确保能接收点击事件
                    
                    // 添加二级菜单项的 title 提示
                    const submenuTitleMap = {
                        'export-selection': '导出所选画廊列表到剪贴板（包含标题和链接）',
                        'import-selection': '从剪贴板导入画廊列表并选中（包含标题和链接）',
                        'export-selection-title-only': '导出所选画廊的标题列表到剪贴板',
                        'import-selection-title-only': '从剪贴板导入画廊标题列表并在当前页面选中匹配项',
                    };
                    if (submenuTitleMap[subDef.id]) {
                        subItem.title = submenuTitleMap[subDef.id];
                    }
                    
                    const hoverColor = getMenuHoverBackground();
                    subItem.addEventListener('mouseenter', () => {
                        if (subItem.disabled) return;
                        subItem.style.background = hoverColor;
                    });
                    subItem.addEventListener('mouseleave', () => {
                        subItem.style.background = 'transparent';
                    });
                    subItem.addEventListener('click', (event) => {
                        event.stopPropagation();
                        if (subItem.disabled) return;
                        hideSelectionContextMenu();
                        handleSelectionContextAction(subDef.id);
                    });
                    submenu.appendChild(subItem);
                });
                
                const hoverColor = getMenuHoverBackground();
                let submenuTimeout = null;
                
                item.addEventListener('mouseenter', () => {
                    clearTimeout(submenuTimeout);
                    // 计算二级菜单位置（fixed 定位，相对视口）
                    const rect = item.getBoundingClientRect();
                    
                    // 获取二级菜单的父菜单位置，用于计算二级菜单展开方向
                    const parentMenu = menu;
                    const parentRect = parentMenu.getBoundingClientRect();
                    
                    // 【修改】优先向右展开（与三角符号一致），只在右边空间不足时才向左展开
                    const viewportWidth = window.innerWidth;
                    const hasSpaceOnRight = (parentRect.right + 220) < viewportWidth;
                    const hasSpaceOnLeft = parentRect.left > 220;
                    
                    if (hasSpaceOnRight) {
                        // 右边有足够空间，二级菜单向右展开（默认）
                        submenu.style.left = (parentRect.right + 4) + 'px';  // 父菜单右边 + 间隔
                    } else if (hasSpaceOnLeft) {
                        // 右边空间不足但左边有足够空间，二级菜单向左展开
                        submenu.style.left = (parentRect.left - 210) + 'px';  // 父菜单左边 - 二级菜单宽度 - 间隔
                    } else {
                        // 两边空间都不足，优先向右（会超出边界）
                        submenu.style.left = (parentRect.right + 4) + 'px';
                    }
                    
                    // 二级菜单顶部对齐当前菜单项
                    submenu.style.top = rect.top + 'px';
                    
                    submenu.style.display = 'block';
                    item.style.background = hoverColor;
                });
                
                item.addEventListener('mouseleave', () => {
                    submenuTimeout = setTimeout(() => {
                        submenu.style.display = 'none';
                    }, 150);
                });
                
                submenu.addEventListener('mouseenter', () => {
                    clearTimeout(submenuTimeout);
                    submenu.style.display = 'block';
                });
                
                submenu.addEventListener('mouseleave', () => {
                    submenuTimeout = setTimeout(() => {
                        submenu.style.display = 'none';
                    }, 150);
                });
                
                container.appendChild(item);
                menu.appendChild(container);
                // 二级菜单直接添加到 document.body，因为使用 fixed 定位
                document.body.appendChild(submenu);
                return;
            }
            
            // 处理普通菜单项
            const item = document.createElement('button');
            item.type = 'button';
            item.dataset.action = def.id;
            if (def.requiresSelection) item.dataset.requiresSelection = 'true';
            if (def.requiresTorrent) item.dataset.requiresTorrent = 'true';
            if (def.requiresAria) item.dataset.requiresAria = 'true';
            if (def.requiresHidden) item.dataset.requiresHidden = 'true';
            item.innerHTML = def.label;  // 【修复】使用innerHTML让&nbsp;被正确解析
            item.style.display = 'block';
            item.style.width = '100%';
            item.style.padding = '6px 14px';
            item.style.border = 'none';
            item.style.background = 'transparent';
            item.style.color = 'inherit';
            item.style.textAlign = 'left';
            item.style.cursor = 'pointer';
            item.style.fontSize = '13px';
            item.style.fontWeight = '600';
            
            // 添加title提示
            const titleMap = {
                'refresh-selected': '刷新所有选中画廊获取最新种子信息',
                'refresh-selected-force': '强制刷新，忽略缓存',
                'copy-magnet': '将磁力链接复制到剪贴板',
                'copy-torrent': '将种子链接复制到剪贴板',
                'send-download': '发送到Aria2或AB Download Manager进行下载',
                'query-archive-info': '查询选中画廊在EH归档中的状态',
                'mark-selected': '标记所选画廊为已下载',
                'ignore-selected': '忽略所选画廊，不再显示',
                'cancel': '取消所有选中，清空复选框',
                'selectall': '勾选全部画廊（根据过滤条件）',
                'invert': '反转选中状态',
                'hide-temp': '临时隐藏选中画廊，重新加载后恢复',
                'unhide-temp': '显示所有被临时隐藏的画廊',
                'download-torrent': '下载所选画廊的种子文件',
                'clear': '清除所有选中画廊的标记和忽略状态',
                'import-export-submenu': '导入或导出选择列表',
            };
            if (titleMap[def.id]) {
                item.title = titleMap[def.id];
            }
            
            const hoverColor = getMenuHoverBackground();
            item.addEventListener('mouseenter', () => {
                if (item.disabled) return;
                item.style.background = hoverColor;
            });
            item.addEventListener('mouseleave', () => {
                item.style.background = 'transparent';
            });
            item.addEventListener('click', (event) => {
                event.stopPropagation();
                if (item.disabled) return;
                hideSelectionContextMenu();
                handleSelectionContextAction(def.id);
            });
            menu.appendChild(item);
        });

        menu.addEventListener('contextmenu', (event) => event.preventDefault());

        selectionContextMenu = menu;
        document.body.appendChild(menu);
        return menu;
    };

    const updateSelectionMenuAvailability = () => {
        if (!selectionContextMenu) return;
        syncSelectionMenuToggles();
        const checkedBoxes = getVisibleCheckedBoxes();
        const hasSelection = checkedBoxes.length > 0;
        const hasTorrentSelection = hasSelection && checkedBoxes.some((box) => {
            const row = box.closest('.eh-magnet-item');
            return Boolean(box.dataset.torrentHref || row?.dataset.torrentHref);
        });
        const hasSendableSelection = hasSelection && checkedBoxes.some((box) => {
            const row = box.closest('.eh-magnet-item');
            return Boolean(
                box.dataset.magnetValue
                || row?.dataset.magnetValue
                || box.dataset.torrentHref
                || row?.dataset.torrentHref
                || isArchiveFallbackElement(box)
            );
        });
        const ariaAvailable = isAriaEhBridgeAvailable();
        const ariaConfigured = ariaAvailable && isAriaEhBridgeConfigured();
        
        // 更新主菜单按钮
        selectionContextMenu.querySelectorAll('button[data-action]').forEach((item) => {
            if (!(item instanceof HTMLButtonElement)) return;
            const requiresSelection = item.dataset.requiresSelection === 'true';
            const requiresTorrent = item.dataset.requiresTorrent === 'true';
            const requiresAria = item.dataset.requiresAria === 'true';
            const requiresHidden = item.dataset.requiresHidden === 'true';
            const shouldDisable = (requiresSelection && !hasSelection)
                || (requiresTorrent && !hasTorrentSelection)
                || (requiresAria && (!ariaAvailable || !ariaConfigured || !hasSendableSelection))
                || (requiresHidden && tempHiddenGalleries.size === 0);
            if (shouldDisable) {
                item.disabled = true;
                item.style.opacity = '0.45';
                item.style.cursor = 'not-allowed';
            } else {
                item.disabled = false;
                item.style.opacity = '1';
                item.style.cursor = 'pointer';
            }
        });
        
        // 更新二级菜单按钮（在 document.body 中）
        document.querySelectorAll('.eh-selection-submenu button[data-action]').forEach((item) => {
            if (!(item instanceof HTMLButtonElement)) return;
            const requiresSelection = item.dataset.requiresSelection === 'true';
            const requiresTorrent = item.dataset.requiresTorrent === 'true';
            const shouldDisable = (requiresSelection && !hasSelection)
                || (requiresTorrent && !hasTorrentSelection);
            if (shouldDisable) {
                item.disabled = true;
                item.style.opacity = '0.45';
                item.style.cursor = 'not-allowed';
            } else {
                item.disabled = false;
                item.style.opacity = '1';
                item.style.cursor = 'pointer';
            }
        });
    };

    const hideSelectionContextMenu = () => {
        if (!selectionContextMenu) return;
        selectionContextMenu.style.display = 'none';
        selectionContextMenu.dataset.visible = 'false';
        selectionContextMenu.dataset.anchor = '';
        
        // 隐藏所有二级菜单
        document.querySelectorAll('.eh-selection-submenu').forEach(submenu => {
            submenu.style.display = 'none';
        });
        
        if (selectionContextMenuOutsideHandler) {
            document.removeEventListener('mousedown', selectionContextMenuOutsideHandler, true);
            selectionContextMenuOutsideHandler = null;
        }
        if (selectionContextMenuScrollHandler) {
            document.removeEventListener('scroll', selectionContextMenuScrollHandler, true);
            selectionContextMenuScrollHandler = null;
        }
        if (selectionContextMenuResizeHandler) {
            window.removeEventListener('resize', selectionContextMenuResizeHandler, true);
            selectionContextMenuResizeHandler = null;
        }
        if (selectionContextMenuKeyHandler) {
            document.removeEventListener('keydown', selectionContextMenuKeyHandler, true);
            selectionContextMenuKeyHandler = null;
        }
    };

    const handleSelectionContextAction = (action) => {
        if (action === 'cancel') {
            clearSelection();
            return;
        }
        if (action === 'selectall') {
            applySelectAllState(true);
            return;
        }
        if (action === 'invert') {
            invertSelection();
            return;
        }
        if (action === 'export-selection') {
            Promise.resolve(exportSelectedGalleries()).catch((err) => {
                console.warn('导出选择失败', err);
            });
            return;
        }
        if (action === 'import-selection') {
            Promise.resolve(importSelectionFromClipboard()).catch((err) => {
                console.warn('导入选择失败', err);
            });
            return;
        }
        if (action === 'export-selection-title-only') {
            Promise.resolve(exportSelectionTitleOnly()).catch((err) => {
                console.warn('导出选择（仅标题）失败', err);
            });
            return;
        }
        if (action === 'import-selection-title-only') {
            Promise.resolve(importSelectionTitleOnly()).catch((err) => {
                console.warn('导入选择（仅标题）失败', err);
            });
            return;
        }
        if (action === 'hide-temp') {
            Promise.resolve(hideSelectedGalleriesTemporarily()).catch((err) => {
                console.warn('临时隐藏所选失败', err);
            });
            return;
        }
        if (action === 'unhide-temp') {
            restoreTemporaryHiddenGalleries();
            return;
        }
        if (action === 'copy-magnet') {
            Promise.resolve(copySelectedMagnets()).catch((err) => {
                console.warn('复制选中失败', err);
            });
            return;
        }
        if (action === 'copy-torrent') {
            Promise.resolve(copySelectedTorrents()).catch((err) => {
                console.warn('复制种子链接失败', err);
            });
            return;
        }
        if (action === 'send-download') {
            // 新的统一发送下载菜单
            Promise.resolve(showDownloadDialog())
                .catch((err) => {
                    console.warn('[发送下载] 打开对话框失败', err);
                    toastError(`失败：${err?.message || err}`);
                });
            return;
        }
        if (action === 'query-archive-info') {
            // 收集选中的条目
            const selectedEntries = collectSelectedEntries();
            if (!selectedEntries || selectedEntries.length === 0) {
                toastWarn('请先选中至少一个画廊');
                return;
            }

            // 转换为批量查询所需的格式
            const queryEntries = selectedEntries
                .filter(entry => entry.info?.gid && entry.info?.token)
                .map(entry => ({
                    gid: entry.info.gid,
                    token: entry.info.token,
                    title: entry.info?.title || '未知',
                }));

            if (queryEntries.length === 0) {
                toastWarn('选中的画廊没有有效的 token');
                return;
            }

            // 打开批量查询界面并自动查询
            (async () => {
                try {
                    await showBatchQueryDialog({ autoQuery: true, queryEntries });
                } catch (err) {
                    console.warn('打开批量查询界面失败', err);
                    toastError(`失败：${err?.message || err}`);
                }
            })();
            return;
        }
        if (action === 'mark-selected') {
            const entries = collectSelectedEntries();
            if (!entries || entries.length === 0) {
                toastError('没有选中任何画廊');
                return;
            }
            let markedCount = 0;
            const affectedGids = new Set();
            entries.forEach(entry => {
                const info = entry.info;
                const magnetHref = entry.magnetHref || '';
                const archiveKey = entry.archiveKey || '';
                const effectiveKey = magnetHref || archiveKey;
                
                if (info?.gid) {
                    // 标记画廊为已下载
                    markGalleryDownloaded(info, { silent: true, skipPersist: true });
                    // 如果有具体的种子链接，也标记它
                    if (effectiveKey) {
                        markMagnetDownloaded(effectiveKey, info, { silent: true, skipPersist: true });
                    }
                    affectedGids.add(String(info.gid));
                    markedCount++;
                }
            });
            if (markedCount > 0) {
                persistDownloadedState();
                updateStatusFlags();
                // 刷新受影响画廊的种子行显示
                affectedGids.forEach((gid) => refreshGalleryPostedBadges(gid));
                toastSuccess(`已标记 ${markedCount} 个画廊为已下载`);
            }
            clearSelection();
            return;
        }
        if (action === 'ignore-selected') {
            const entries = collectSelectedEntries();
            if (!entries || entries.length === 0) {
                toastError('没有选中任何画廊');
                return;
            }
            let ignoredCount = 0;
            entries.forEach(entry => {
                const info = entry.info;
                if (info?.gid) {
                    markGalleryIgnored(info);
                    ignoredCount++;
                }
            });
            if (ignoredCount > 0) {
                toastSuccess(`已忽略 ${ignoredCount} 个画廊`);
            }
            clearSelection();
            return;
        }
        if (action === 'download-torrent') {
            Promise.resolve(downloadSelectedTorrents()).catch((err) => {
                console.warn('下载种子失败', err);
                toastError(`下载失败：${err?.message || err}`);
            });
            return;
        }
        if (action === 'refresh-selected') {
            Promise.resolve(refreshSelectedGalleries()).catch((err) => {
                console.warn('刷新所选画廊失败', err);
                toastError('刷新所选画廊失败');
            });
            return;
        }
        if (action === 'refresh-selected-force') {
            Promise.resolve(refreshSelectedGalleries({ force: true })).catch((err) => {
                console.warn('强制刷新所选画廊失败', err);
                toastError('强制刷新所选画廊失败');
            });
            return;
        }
        if (action === 'ignore') {
            toggleIgnoreSelected({ force: 'ignore', silentAlert: true });
            return;
        }
        if (action === 'mark') {
            markSelectedAsDownloaded();
            return;
        }
        if (action === 'clear') {
            clearSelectedMarkers();
        }
    };

    const showSelectionContextMenu = (event, anchor = '') => {
        const menu = ensureSelectionContextMenu();
        hideSelectionContextMenu();

        if (typeof event?.preventDefault === 'function') event.preventDefault();
        if (typeof event?.stopPropagation === 'function') event.stopPropagation();

        menu.style.display = 'block';
        menu.dataset.visible = 'true';
        menu.dataset.anchor = anchor || '';

        const viewportX = event.clientX;
        const viewportY = event.clientY;
        const posX = window.scrollX + viewportX;
        const posY = window.scrollY + viewportY;

        menu.style.left = `${posX}px`;
        menu.style.top = `${posY}px`;

        const rect = menu.getBoundingClientRect();
        let adjustedX = posX;
        let adjustedY = posY;
        
        // 检查菜单是否超出右边界，如需要则左移菜单
        if (rect.right > window.innerWidth) {
            // 计算菜单应该从右边往左偏移的距离
            adjustedX = window.scrollX + window.innerWidth - rect.width - 8;
            // 确保菜单不会超出左边界
            adjustedX = Math.max(window.scrollX + 8, adjustedX);
        }
        
        // 检查菜单是否超出下边界
        if (rect.bottom > window.innerHeight) {
            adjustedY = window.scrollY + window.innerHeight - rect.height - 8;
            // 确保菜单不会超出上边界
            adjustedY = Math.max(window.scrollY + 8, adjustedY);
        }
        
        menu.style.left = `${adjustedX}px`;
        menu.style.top = `${adjustedY}px`;

        updateSelectionMenuAvailability();

        selectionContextMenuOutsideHandler = (e) => {
            if (menu.contains(e.target)) return;
            // 检查点击是否在任何二级菜单内
            const submenu = document.querySelector('.eh-selection-submenu[style*="display: block"]');
            if (submenu && submenu.contains(e.target)) return;
            hideSelectionContextMenu();
        };
        document.addEventListener('mousedown', selectionContextMenuOutsideHandler, true);

        selectionContextMenuScrollHandler = () => hideSelectionContextMenu();
        document.addEventListener('scroll', selectionContextMenuScrollHandler, true);

        selectionContextMenuResizeHandler = () => hideSelectionContextMenu();
        window.addEventListener('resize', selectionContextMenuResizeHandler, true);

        selectionContextMenuKeyHandler = (e) => {
            if (e.key === 'Escape') hideSelectionContextMenu();
        };
        document.addEventListener('keydown', selectionContextMenuKeyHandler, true);
    };

    const handleCheckboxContextMenu = (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        if (!target.classList.contains('eh-magnet-checkbox')) return;
        event.preventDefault();
        event.stopPropagation();
        showSelectionContextMenu(event);
    };

    if (!selectionContextMenuBound) {
        document.addEventListener('contextmenu', handleCheckboxContextMenu, true);
        selectionContextMenuBound = true;
    }

    const cleanupDetachedControlReferences = () => {
        if (settingsButtonTop && !settingsButtonTop.isConnected) settingsButtonTop = null;
        if (moreActionsButtonTop && !moreActionsButtonTop.isConnected) moreActionsButtonTop = null;
        if (settingsButtonBottom && !settingsButtonBottom.isConnected) settingsButtonBottom = null;
        if (moreActionsButtonBottom && !moreActionsButtonBottom.isConnected) moreActionsButtonBottom = null;
        if (selectionSummaryTop && !selectionSummaryTop.isConnected) selectionSummaryTop = null;
        if (selectionSummaryBottom && !selectionSummaryBottom.isConnected) selectionSummaryBottom = null;
    };

    const assignControlReferences = (wrapper, anchor) => {
        if (!wrapper) return;
        const settingsBtn = wrapper.querySelector('.eh-magnet-settings');
        const moreActionsBtn = wrapper.querySelector('.eh-magnet-more-actions');
        if (anchor === 'top') {
            if (settingsBtn) settingsButtonTop = settingsBtn;
            if (moreActionsBtn) moreActionsButtonTop = moreActionsBtn;
        } else {
            if (settingsBtn) settingsButtonBottom = settingsBtn;
            if (moreActionsBtn) moreActionsButtonBottom = moreActionsBtn;
        }
    };

    const createSelectionSummaryElement = (anchor) => {
        const summary = document.createElement('div');
        summary.className = 'eh-magnet-selection-summary';
        summary.dataset.anchor = anchor;
        summary.style.fontSize = '12px';
        summary.style.fontWeight = '600';
        summary.style.margin = '6px 0 4px';
        summary.style.lineHeight = '1.6';
        summary.style.userSelect = 'none';
        summary.textContent = '当前未选择任何条目';
        return summary;
    };

    const ensureSelectionSummaryForAnchor = (anchor, container, referenceNode = null) => {
        if (!container) return;
        const selector = `.eh-magnet-selection-summary[data-anchor="${anchor}"]`;
        let summary = container.querySelector(selector);
        if (!summary) {
            summary = createSelectionSummaryElement(anchor);
            if (referenceNode && referenceNode.parentElement === container) {
                container.insertBefore(summary, referenceNode);
            } else if (container.firstChild) {
                container.insertBefore(summary, container.firstChild);
            } else {
                container.appendChild(summary);
            }
        } else if (referenceNode && referenceNode.parentElement === container && summary.nextSibling !== referenceNode) {
            container.insertBefore(summary, referenceNode);
        } else if (!summary.isConnected) {
            if (referenceNode && referenceNode.parentElement === container) {
                container.insertBefore(summary, referenceNode);
            } else {
                container.appendChild(summary);
            }
        }

        if (anchor === 'top') {
            selectionSummaryTop = summary;
        } else {
            selectionSummaryBottom = summary;
        }
        updateSelectionSummary();
    };

    const updateSelectionSummary = () => {
        const summaries = [selectionSummaryTop, selectionSummaryBottom].filter((node) => node && node.isConnected);
        if (!summaries.length) return;

        const entries = collectSelectedEntries();
        const total = entries.length;
        let text = '当前未选择任何条目';
        let title = '';
        let selectedDownloadedCount = 0;
        let selectedIgnoredCount = 0;

        if (total > 0) {
            const archiveCount = entries.filter((entry) => entry.isArchiveFallback).length;
            const seedEntries = entries.filter((entry) => !entry.isArchiveFallback);
            const seedCount = seedEntries.length;
            const gallerySeedMap = new Map();
            seedEntries.forEach((entry) => {
                const gid = entry?.info?.gid ? String(entry.info.gid) : '';
                if (!gid) return;
                gallerySeedMap.set(gid, (gallerySeedMap.get(gid) || 0) + 1);
            });
            let duplicateCount = 0;
            gallerySeedMap.forEach((count) => {
                if (count > 1) duplicateCount += (count - 1);
            });

            // 统计已选中的已下载和已忽略画廊
            entries.forEach((entry) => {
                const gid = entry?.info?.gid ? String(entry.info.gid) : '';
                if (!gid) return;
                if (downloadedGalleries.has(gid)) selectedDownloadedCount++;
                if (ignoredGalleries.has(gid)) selectedIgnoredCount++;
            });

            const parts = [];
            if (seedCount > 0) {
                parts.push(`🌱${seedCount}`);
            }
            if (archiveCount > 0) {
                parts.push(`📦${archiveCount}`);
            }
            if (!parts.length) {
                parts.push('未识别类型');
            }
            const selectedPart = `✓${total}(${parts.join('|')})`;
            const selectedStatusPart = [];
            if (selectedDownloadedCount > 0) selectedStatusPart.push(`📥${selectedDownloadedCount}`);
            if (selectedIgnoredCount > 0) selectedStatusPart.push(`🚫${selectedIgnoredCount}`);
            const selectedStatusStr = selectedStatusPart.length > 0 ? `⚠️(${selectedStatusPart.join('|')})` : '';
            
            text = selectedPart;
            if (selectedStatusStr) text += ` | ${selectedStatusStr}`;
            
            if (duplicateCount > 0) {
                title = '提示：同一画廊存在多个选中的种子，请确认是否需要全部操作。\n';
            }
            title += `已选择${total}项(种子${seedCount}项|归档${archiveCount}项)`;
            if (selectedStatusPart.length > 0) {
                title += `\n已选中的状态分布：${selectedStatusPart.map(p => {
                    if (p.startsWith('📥')) return `已下载${p.substring(2)}`;
                    if (p.startsWith('🚫')) return `已忽略${p.substring(2)}`;
                    return p;
                }).join(' | ')}`;
            }
        }

        // 添加页面总数统计（按画廊统计，而非种子）
        const allCheckboxes = Array.from(document.querySelectorAll('.eh-magnet-checkbox')).filter((box) => !isInTempHiddenContainer(box));
        const totalGalleries = document.querySelectorAll('.gl5t[data-eh-magnet-attached="1"]').length;
        
        if (allCheckboxes.length > 0) {
            const totalParts = [];
            const galleryGroups = new Map(); // 按画廊分组
            
            // 按 magnetGroup 或 galleryGid 分组统计
            allCheckboxes.forEach((box) => {
                const row = box.closest('.eh-magnet-item');
                const container = row?.closest('.eh-magnet-links');
                const gid = box.dataset.galleryGid || row?.dataset.galleryGid || container?.dataset.galleryGid || box.dataset.magnetGroup || 'unknown';
                if (!galleryGroups.has(gid)) {
                    galleryGroups.set(gid, {
                        gid: gid,
                        hasValidSeed: false,
                        hasOutdated: false,
                        hasArchiveFallback: false,
                        hasPending: false,
                        hasNonPending: false,
                    });
                }
                
                const group = galleryGroups.get(gid);
                const isArchive = box.dataset.archiveFallback === 'true';
                const isOutdated = box.dataset.magnetOutdated === 'true'
                    || row?.dataset?.magnetOutdated === 'true'
                    || container?.dataset?.magnetOutdated === 'true';
                const isPending = box.dataset.pendingInfo === 'true'
                    || row?.dataset?.pendingInfo === 'true'
                    || container?.dataset?.pendingInfo === 'true';
                
                if (isPending) {
                    group.hasPending = true;
                    return;
                }
                
                group.hasNonPending = true;
                
                if (isArchive) {
                    group.hasArchiveFallback = true;
                } else {
                    group.hasValidSeed = true;
                }
                
                if (isOutdated) {
                    group.hasOutdated = true;
                }
            });
            
            // 统计画廊数量
            let totalSeedCount = 0;
            let totalOutdatedCount = 0;
            let totalSeedlessCount = 0;
            let totalPendingCount = 0;
            let loadedGalleries = 0;
            
            galleryGroups.forEach((group) => {
                const {
                    hasValidSeed,
                    hasOutdated,
                    hasArchiveFallback,
                    hasPending,
                    hasNonPending,
                } = group;
                
                if (!hasNonPending) {
                    if (hasPending) {
                        totalPendingCount++;
                    }
                    return;
                }
                
                loadedGalleries++;
                
                if (hasValidSeed) {
                    totalSeedCount++;
                }
                if (!hasValidSeed && hasArchiveFallback && !hasOutdated) {
                    totalSeedlessCount++;
                }
                if (hasOutdated) {
                    totalOutdatedCount++;
                }
            });
            
            if (totalSeedCount > 0) {
                totalParts.push(`🌱${totalSeedCount}`);
            }
            if (totalOutdatedCount > 0) {
                totalParts.push(`⏰${totalOutdatedCount}`);
            }
            if (totalSeedlessCount > 0) {
                totalParts.push(`❌无${totalSeedlessCount}`);
            }
            
            // 统计页面上的已下载、已忽略、未下载
            let totalDownloadedCount = 0;
            let totalIgnoredCount = 0;
            let totalUndownloadedCount = 0;
            galleryGroups.forEach((group) => {
                if (downloadedGalleries.has(group.gid)) {
                    totalDownloadedCount++;
                } else if (ignoredGalleries.has(group.gid)) {
                    totalIgnoredCount++;
                } else {
                    totalUndownloadedCount++;
                }
            });
            
            const partsText = totalParts.length ? `(${totalParts.join('|')})` : '';
            const statusText = `📥${totalDownloadedCount}|🚫${totalIgnoredCount}|⬜${totalUndownloadedCount}`;
            const baseText = `📊${loadedGalleries}/${totalGalleries}(${statusText})${partsText}`;
            const pendingText = totalPendingCount > 0 ? ` / ⏳${totalPendingCount}` : '';
            const totalText = `${baseText}${pendingText}`;
            text = total > 0 ? `${text} / ${totalText}` : totalText;
            
            // 更新title提示信息
            title += `\n已加载${loadedGalleries}/${totalGalleries}项(已下载${totalDownloadedCount}|已忽略${totalIgnoredCount}|未下载${totalUndownloadedCount})`;
            if (totalSeedCount > 0) title += `|有种${totalSeedCount}`;
            if (totalOutdatedCount > 0) title += `|种子过时${totalOutdatedCount}`;
            if (totalSeedlessCount > 0) title += `|无种子${totalSeedlessCount}`;
            if (totalPendingCount > 0) title += `\n待加载${totalPendingCount}项`;
        }

        summaries.forEach((node) => {
            node.textContent = text;
            node.title = title;
        });
    };

    const createControlWrapper = (anchor) => {
        const wrapper = document.createElement('span');
        wrapper.className = 'eh-magnet-control-wrapper';
        wrapper.dataset.anchor = anchor;
        wrapper.style.display = 'inline-flex';
        wrapper.style.alignItems = 'center';
        wrapper.style.gap = '6px';
        wrapper.style.marginRight = '6px';
        wrapper.style.boxSizing = 'border-box';
        wrapper.style.position = 'relative';
        return wrapper;
    };

    const syncExcludeDownloadedState = () => {
        document.querySelectorAll('.eh-magnet-settings input[data-setting="search-infinite-scroll"]').forEach((checkbox) => {
            checkbox.checked = enableSearchInfiniteScroll;
        });
        syncSelectionMenuToggles();
        updateStatusFlags();
    };

    const toggleIgnoreSelected = (options = {}) => {
        const { force = null, keepSelection = false, silentAlert = false } = options || {};
        const buttons = [ignoreToggleButton, ignoreToggleButtonBottom].filter(Boolean);
        const checkedBoxes = getVisibleCheckedBoxes();
        if (!checkedBoxes.length) {
            if (!silentAlert) toastWarn('未选择任何磁力链接');
            buttons.forEach((button) => {
                if (button) {
                    button.disabled = true;
                    button.textContent = '忽略所选';
                    button.dataset.state = 'ignore';
                }
            });
            return;
        }

        const entries = checkedBoxes.map((box) => {
            const row = box.closest('.eh-magnet-item');
            const container = row?.closest('.eh-magnet-links');
            const info = buildGalleryInfoFromDataset(box.dataset)
                || buildGalleryInfoFromDataset(row?.dataset)
                || buildGalleryInfoFromDataset(container?.dataset);
            const magnetHref = box.dataset.magnetValue || row?.dataset.magnetValue || '';
            const archiveKey = box.dataset.archiveKey || row?.dataset.archiveKey || '';
            const key = magnetHref || archiveKey;
            const isArchiveFallback = box.dataset.archiveFallback === 'true' || row?.dataset.archiveFallback === 'true';
            const normalizedInfo = info || (box.dataset.galleryGid || row?.dataset.galleryGid || container?.dataset.galleryGid)
                ? {
                    gid: box.dataset.galleryGid || row?.dataset.galleryGid || container?.dataset.galleryGid || '',
                    token: box.dataset.galleryToken || row?.dataset.galleryToken || container?.dataset.galleryToken || '',
                    href: box.dataset.galleryHref || row?.dataset.galleryHref || container?.dataset.galleryHref || '',
                    title: box.dataset.galleryTitle || row?.dataset.galleryTitle || container?.dataset.galleryTitle || '',
                }
                : null;
            if (!key && !(normalizedInfo?.gid)) return null;
            return {
                key,
                info: normalizedInfo,
                row,
                checkbox: box,
                isArchiveFallback,
            };
        }).filter(Boolean);

        if (!entries.length) {
            updateIgnoreToggleState();
            return;
        }

        withDebugLog(() => {
            entries.forEach((entry) => {
                console.debug('[EhMagnet] toggleIgnoreSelected entry', {
                    key: entry.key,
                    gid: entry.info?.gid,
                    isArchive: entry.isArchiveFallback,
                    ignored: isMagnetIgnored(entry.key, entry.info),
                    galleryIgnored: entry.info?.gid ? isGalleryIgnored(entry.info) : null,
                });
            });
        });

        let shouldUnignore = entries.every(({ key, info }) => isMagnetIgnored(key, info));
        if (force === 'ignore') shouldUnignore = false;
        if (force === 'unignore') shouldUnignore = true;

        let downloadChanged = false;
        entries.forEach(({ key, info }) => {
            if (shouldUnignore) {
                unmarkMagnetIgnored(key, info, { silent: true, skipPersist: true });
            } else {
                const removed = markMagnetIgnored(key, info, { silent: true, skipPersist: true });
                if (removed) downloadChanged = true;
            }
        });

        if (!keepSelection) {
            checkedBoxes.forEach((box) => {
                box.checked = false;
                const key = box.dataset.magnetValue || box.dataset.archiveKey;
                if (key) selectedMagnets.delete(key);
                const info = buildGalleryInfoFromDataset(box.dataset);
                if (info?.gid) selectedGalleries.delete(info.gid);
            });
            lastCheckboxIndex = null;
        } else {
            rebuildSelectionSets();
        }

        persistIgnoredState();
        if (downloadChanged) persistDownloadedState();
        entries.forEach((entry) => {
            if (entry.row) updateRowStatusFlags(entry.row);
            try {
                syncEntryFlagDisplay({
                    row: entry.row,
                    checkbox: entry.checkbox,
                    info: entry.info,
                    magnetHref: entry.key,
                    archiveKey: entry.key,
                    isArchiveFallback: entry.isArchiveFallback,
                });
            } catch (err) {
                console.warn('[EhMagnet] syncEntryFlagDisplay failed', err, entry);
            }
        });
        updateStatusFlags();
        updateIgnoreToggleState();
        updateSelectToggleState();
        refreshGalleryIgnoreButtons();

        buttons.forEach((button) => {
            if (!button) return;
            button.textContent = shouldUnignore ? '忽略所选' : '取消忽略';
            button.dataset.state = shouldUnignore ? 'ignore' : 'unignore';
        });
        
        // 触发事件通知EH Highlight Duplicate
        try {
            // 收集所有受影响的gid（去重）
            const affectedGids = new Set();
            entries.forEach(({ info }) => {
                if (info?.gid) affectedGids.add(String(info.gid));
            });
            
            // 为每个gid触发事件
            affectedGids.forEach(gid => {
                const event = new CustomEvent('eh-magnet-ignore-changed', { 
                    detail: { gid, action: shouldUnignore ? 'unmark' : 'mark', source: 'eh-magnet' },
                    bubbles: true 
                });
                document.dispatchEvent(event);
            });
        } catch (err) {}
    };

    const clearSelection = () => {
        const checkedBoxes = Array.from(document.querySelectorAll('.eh-magnet-checkbox:checked'));
        if (checkedBoxes.length) {
            checkedBoxes.forEach((box) => {
                box.checked = false;
            });
        }
        selectedMagnets.clear();
        selectedGalleries.clear();
        lastCheckboxIndex = null;
        updateSelectToggleState();
        updateIgnoreToggleState();
    };

    // 标记指定条目为已下载（支持参数化）
    const markSelectedAsDownloaded = (entriesParam = null) => {
        // 如果指定了条目列表，使用该列表；否则使用当前选中的所有条目
        let checkedBoxes;
        if (entriesParam && Array.isArray(entriesParam)) {
            // 从条目列表提取复选框
            checkedBoxes = entriesParam
                .map(entry => entry.checkbox)
                .filter(box => box && document.contains(box));
        } else {
            // 使用当前所有选中的复选框
            checkedBoxes = getVisibleCheckedBoxes();
        }
        
        if (!checkedBoxes.length) {
            toastWarn('未选择任何磁力链接');
            return;
        }
        let downloadChanged = false;
        let ignoreChanged = false;
        const affectedGids = new Set();
        checkedBoxes.forEach((box) => {
            const row = box.closest('.eh-magnet-item');
            const container = row?.closest('.eh-magnet-links');
            const info = buildGalleryInfoFromDataset(box.dataset)
                || buildGalleryInfoFromDataset(row?.dataset)
                || buildGalleryInfoFromDataset(container?.dataset);
            const magnetHref = box.dataset.magnetValue || row?.dataset.magnetValue || '';
            const archiveKey = box.dataset.archiveKey || row?.dataset.archiveKey || '';
            const effectiveKey = magnetHref || archiveKey;
            const isArchive = isArchiveFallbackElement(box);
            if (isArchive) {
                if (info?.gid) {
                    const wasDownloaded = isGalleryDownloaded(info);
                    const wasIgnored = isGalleryIgnored(info);
                    markGalleryDownloaded(info, { silent: true, skipPersist: true });
                    if (effectiveKey) {
                        const wasKeyDownloaded = isMagnetDownloaded(effectiveKey);
                        markMagnetDownloaded(effectiveKey, info, { silent: true, skipPersist: true });
                        if (!wasKeyDownloaded) downloadChanged = true;
                    }
                    if (!wasDownloaded && isGalleryDownloaded(info)) downloadChanged = true;
                    if (wasIgnored && !isGalleryIgnored(info)) ignoreChanged = true;
                }
            } else {
                if (!effectiveKey) return;
                const wasIgnored = ignoredMagnets.has(effectiveKey);
                const wasDownloaded = downloadedMagnets.has(effectiveKey);
                
                // 标记画廊为已下载（与齿轮菜单行为一致）
                if (info?.gid) {
                    const wasGalleryDownloaded = isGalleryDownloaded(info);
                    const wasGalleryIgnored = isGalleryIgnored(info);
                    markGalleryDownloaded(info, { silent: true, skipPersist: true });
                    if (!wasGalleryDownloaded && isGalleryDownloaded(info)) downloadChanged = true;
                    if (wasGalleryIgnored && !isGalleryIgnored(info)) ignoreChanged = true;
                }
                
                markMagnetDownloaded(effectiveKey, info, { silent: true, skipPersist: true });
                if (!wasDownloaded) downloadChanged = true;
                if (wasIgnored && !isMagnetIgnored(effectiveKey, info)) ignoreChanged = true;
            }
            if (effectiveKey) {
                selectedMagnets.delete(effectiveKey);
            }
            if (info?.gid) {
                selectedGalleries.delete(info.gid);
                affectedGids.add(String(info.gid));
            }
        });
        if (downloadChanged) persistDownloadedState();
        if (ignoreChanged) persistIgnoredState();
        updateStatusFlags();
        updateSelectToggleState();
        refreshGalleryIgnoreButtons();
        affectedGids.forEach((gid) => refreshGalleryPostedBadges(gid));
    };

    const clearSelectedMarkers = () => {
        const checkedBoxes = getVisibleCheckedBoxes();
        if (!checkedBoxes.length) {
            toastWarn('未选择任何磁力链接');
            return;
        }
        let downloadChanged = false;
        let ignoreChanged = false;
        const affectedGids = new Set();
        checkedBoxes.forEach((box) => {
            const row = box.closest('.eh-magnet-item');
            const container = row?.closest('.eh-magnet-links');
            const info = buildGalleryInfoFromDataset(box.dataset)
                || buildGalleryInfoFromDataset(row?.dataset)
                || buildGalleryInfoFromDataset(container?.dataset);
            const magnetHref = box.dataset.magnetValue || row?.dataset.magnetValue || '';
            const archiveKey = box.dataset.archiveKey || row?.dataset.archiveKey || '';
            const effectiveKey = magnetHref || archiveKey;
            const isArchive = isArchiveFallbackElement(box);
            if (isArchive) {
                if (info?.gid) {
                    const gid = String(info.gid);
                    if (downloadedGalleries.has(gid)) {
                        downloadedGalleries.delete(gid);
                        downloadChanged = true;
                    }
                    if (legacyDownloadedGalleries.has(gid)) {
                        legacyDownloadedGalleries.delete(gid);
                        downloadChanged = true;
                    }
                    if (effectiveKey && downloadedMagnets.has(effectiveKey)) {
                        downloadedMagnets.delete(effectiveKey);
                        downloadChanged = true;
                    }
                    // 检查是画廊级忽略还是磁力链接级忽略（gid已在第5360行定义）
                    const isGalleryLevelIgnored = gid && ignoredGalleries.has(gid);
                    const isMagnetLevelIgnored = effectiveKey && ignoredMagnets.has(effectiveKey);
                    
                    if (isGalleryLevelIgnored && !isMagnetLevelIgnored) {
                        // 画廊级忽略（可能来自Highlight），取消整个画廊的忽略
                        unmarkGalleryIgnored(info, { silent: true });
                        ignoreChanged = true;
                    } else if (isMagnetLevelIgnored) {
                        // 磁力链接级忽略
                        unmarkMagnetIgnored(effectiveKey, info, { silent: true, skipPersist: true });
                        ignoreChanged = true;
                    }
                }
            } else {
                if (!effectiveKey) return;
                if (downloadedMagnets.has(effectiveKey)) {
                    unmarkMagnetDownloaded(effectiveKey, info, { silent: true, skipPersist: true });
                    downloadChanged = true;
                }
                
                // 检查是画廊级忽略还是磁力链接级忽略
                const gidStr = info?.gid ? String(info.gid) : '';
                const isGalleryLevelIgnored = gidStr && ignoredGalleries.has(gidStr);
                const isMagnetLevelIgnored = effectiveKey && ignoredMagnets.has(effectiveKey);
                
                if (isGalleryLevelIgnored && !isMagnetLevelIgnored) {
                    // 画廊级忽略（可能来自Highlight），取消整个画廊的忽略
                    unmarkGalleryIgnored(info, { silent: true });
                    ignoreChanged = true;
                } else if (isMagnetLevelIgnored) {
                    // 磁力链接级忽略
                    unmarkMagnetIgnored(effectiveKey, info, { silent: true, skipPersist: true });
                    ignoreChanged = true;
                }
            }
            if (effectiveKey) selectedMagnets.delete(effectiveKey);
            if (info?.gid) {
                selectedGalleries.delete(info.gid);
                affectedGids.add(String(info.gid));
            }
        });
        if (downloadChanged) persistDownloadedState();
        if (ignoreChanged) persistIgnoredState();
        updateStatusFlags();
        updateSelectToggleState();
        refreshGalleryIgnoreButtons();
        affectedGids.forEach((gid) => refreshGalleryPostedBadges(gid));
        
        // 如果有清除忽略标记，触发事件通知EH Highlight Duplicate
        if (ignoreChanged) {
            try {
                // 收集所有受影响的gid（去重）
                const affectedGids = new Set();
                checkedBoxes.forEach((box) => {
                    const info = buildGalleryInfoFromDataset(box.dataset)
                        || buildGalleryInfoFromDataset(box.closest('.eh-magnet-item')?.dataset);
                    if (info?.gid) affectedGids.add(String(info.gid));
                });
                
                // 为每个gid触发unmark事件
                affectedGids.forEach(gid => {
                    const event = new CustomEvent('eh-magnet-ignore-changed', { 
                        detail: { gid, action: 'unmark', source: 'eh-magnet' },
                        bubbles: true 
                    });
                    document.dispatchEvent(event);
                });
            } catch (err) {}
        }
    };


    const createMoreActionsButton = (anchor) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = '其它功能';
        button.className = 'eh-magnet-more-actions';
        button.style.padding = '2px 8px';
        button.style.cursor = 'pointer';
        button.dataset.anchor = anchor;
        button.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            const menu = ensureSelectionContextMenu();
            const currentAnchor = menu.dataset.visible === 'true' ? menu.dataset.anchor : '';
            if (currentAnchor && currentAnchor === anchor) {
                hideSelectionContextMenu();
                return;
            }
            const rect = button.getBoundingClientRect();
            const fakeEvent = {
                clientX: rect.left + rect.width / 2,
                clientY: rect.bottom + 4,
                preventDefault() {},
                stopPropagation() {},
            };
            showSelectionContextMenu(fakeEvent, anchor);
        });
        return button;
    };

    const createIgnoreToggleButton = () => {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = '忽略所选';
        button.className = 'eh-magnet-ignore-toggle-btn';
        button.style.padding = '2px 8px';
        button.style.cursor = 'pointer';
        button.dataset.state = 'ignore';
        button.disabled = true;
        button.addEventListener('click', toggleIgnoreSelected);
        return button;
    };


    const buildSettingsPayload = async () => {
        // 优先从IndexedDB读取标记数据
        let galleries = Object.fromEntries(downloadedGalleries.entries());
        let magnets = Array.from(downloadedMagnets.entries()).map(([href, info]) => ({
            href, gid: info.gid, timestamp: info.timestamp, autoGenerated: info.autoGenerated === true,
        }));
        let ignored = Object.fromEntries(ignoredGalleries.entries());
        let ignoredMagnetsList = Array.from(ignoredMagnets.entries()).map(([href, info]) => ({
            href, gid: info.gid, timestamp: info.timestamp,
        }));
        
        // 如果IndexedDB有数据，优先使用
        if (idbSupported && idbDatabase) {
            try {
                const idbGalleries = await loadDownloadedGalleriesFromIDB();
                const idbMagnets = await loadDownloadedMagnetsFromIDB();
                const idbIgnored = await loadIgnoredGalleriesFromIDB();
                const idbIgnoredMagnets = await loadIgnoredMagnetsFromIDB();
                
                if (idbGalleries && Object.keys(idbGalleries).length > 0) {
                    galleries = idbGalleries;
                }
                if (idbMagnets && idbMagnets.length > 0) {
                    magnets = idbMagnets;
                }
                if (idbIgnored && Object.keys(idbIgnored).length > 0) {
                    ignored = idbIgnored;
                }
                if (idbIgnoredMagnets && idbIgnoredMagnets.length > 0) {
                    ignoredMagnetsList = idbIgnoredMagnets;
                }
            } catch (err) {
                console.warn('[EhMagnet] 从IndexedDB读取数据失败，使用内存中的数据:', err);
            }
        }
        
        return {
            exclude: excludeDownloaded,
            excludeOutdated: excludeOutdatedOnSelect,
            enableLogs: enableDebugLog,
            searchInfiniteScroll: enableSearchInfiniteScroll,
            autoFetchBatchQuery: autoFetchBatchQuery,
            abdmPort: abdmPort,
            autoRefresh: autoRefreshEnabled,
            hoverRefresh: hoverRefreshEnabled,
            refreshConcurrent: refreshConcurrent,
            refreshIntervalMin: refreshIntervalMin,
            refreshIntervalMax: refreshIntervalMax,
            galleries,
            magnets,
            ignored,
            ignoredMagnets: ignoredMagnetsList,
        };
    };

    const applySettingsPayload = async (data) => {
        if (!data || typeof data !== 'object') throw new Error('格式错误');
        downloadedMagnets.clear();
        galleryDownloadedMagnets.clear();
        downloadedGalleries.clear();
        legacyDownloadedGalleries.clear();
        ignoredMagnets.clear();
        galleryIgnoredMagnets.clear();
        ignoredGalleries.clear();

        const { magnets, galleries, ignored, ignoredMagnets: ignoredMagnetEntries } = data;

        if (Array.isArray(magnets)) {
            magnets.forEach((item) => {
                if (!item || typeof item !== 'object') return;
                const { href, gid, timestamp } = item;
                if (!href) return;
                const normalizedGid = gid ? String(gid) : '';
                const normalizedTs = normalizeTimestampValue(timestamp) || Date.now();
                downloadedMagnets.set(href, {
                    gid: normalizedGid,
                    timestamp: normalizedTs,
                    autoGenerated: item.autoGenerated === true,
                });
                if (normalizedGid) {
                    const set = ensureDownloadedSet(normalizedGid);
                    if (set) set.add(href);
                    if (!downloadedGalleries.has(normalizedGid)) {
                        downloadedGalleries.set(normalizedGid, normalizedTs);
                    }
                    legacyDownloadedGalleries.add(normalizedGid);
                }
            });
        }

        if (galleries && typeof galleries === 'object') {
            Object.entries(galleries).forEach(([gid, timestamp]) => {
                const key = String(gid);
                const normalizedTs = normalizeTimestampValue(timestamp) || Date.now();
                downloadedGalleries.set(key, normalizedTs);
                legacyDownloadedGalleries.add(key);
            });
        }

        if (ignored && typeof ignored === 'object') {
            Object.entries(ignored).forEach(([gid, timestamp]) => {
                const key = String(gid);
                const normalizedTs = normalizeTimestampValue(timestamp) || Date.now();
                ignoredGalleries.set(key, normalizedTs);
                ensureIgnoredSet(key);
            });
        }

        if (Array.isArray(ignoredMagnetEntries)) {
            ignoredMagnetEntries.forEach((entry) => {
                if (!entry || typeof entry !== 'object') return;
                const { href, gid, timestamp } = entry;
                if (!href) return;
                const normalizedGid = gid ? String(gid) : '';
                const normalizedTs = normalizeTimestampValue(timestamp) || Date.now();
                ignoredMagnets.set(href, {
                    gid: normalizedGid,
                    timestamp: normalizedTs,
                });
                if (normalizedGid) {
                    const set = ensureIgnoredSet(normalizedGid);
                    if (set) set.add(href);
                    ignoredGalleries.set(normalizedGid, normalizedTs);
                }
            });
        }

        if ('exclude' in data) {
            excludeDownloaded = Boolean(data.exclude);
        }
        if ('excludeOutdated' in data) {
            excludeOutdatedOnSelect = Boolean(data.excludeOutdated);
        }
        if ('enableLogs' in data) {
            enableDebugLog = Boolean(data.enableLogs);
        }
        if ('searchInfiniteScroll' in data) {
            enableSearchInfiniteScroll = Boolean(data.searchInfiniteScroll);
        }
        if ('autoFetchBatchQuery' in data) {
            autoFetchBatchQuery = Boolean(data.autoFetchBatchQuery);
        }
        if ('abdmPort' in data) {
            const value = parseInt(data.abdmPort, 10);
            if (!isNaN(value) && value > 0 && value <= 65535) {
                abdmPort = value;
            }
        }
        if ('autoRefresh' in data) {
            autoRefreshEnabled = Boolean(data.autoRefresh);
        }
        if ('hoverRefresh' in data) {
            hoverRefreshEnabled = Boolean(data.hoverRefresh);
        }
        if ('refreshConcurrent' in data) {
            const value = parseInt(data.refreshConcurrent) || 1;
            refreshConcurrent = Math.max(1, Math.min(10, value));
            magnetRequestQueue.maxConcurrent = refreshConcurrent;
        }
        if ('refreshIntervalMin' in data) {
            const value = parseInt(data.refreshIntervalMin) || 1200;
            refreshIntervalMin = Math.max(500, value);
        }
        if ('refreshIntervalMax' in data) {
            const value = parseInt(data.refreshIntervalMax) || 2000;
            refreshIntervalMax = Math.max(refreshIntervalMin, value);
        }
        if ('refreshIntervalMin' in data || 'refreshIntervalMax' in data) {
            magnetRequestQueue.minIntervalRange = [refreshIntervalMin, refreshIntervalMax];
        }

        await persistDownloadedState();
        await persistIgnoredState();
        persistExcludePreference();
        persistLogPreference();
        persistSearchInfiniteScrollPreference();
        persistAbdmPortPreference();
        syncExcludeDownloadedState();
        updateStatusFlags();
        rebuildSelectionSets();
        refreshGalleryIgnoreButtons();
        updateSelectToggleState();
        syncSettingsMenuControls();
        if (enableSearchInfiniteScroll) {
            setupSearchInfiniteScroll();
        } else {
            teardownSearchInfiniteScroll();
        }
    };

    const ensureSettingsMenu = () => {
        if (settingsMenu && document.body.contains(settingsMenu)) return settingsMenu;
        const menu = document.createElement('div');
        menu.className = 'eh-magnet-settings-menu';
        menu.style.position = 'absolute';
        menu.style.top = '100%';
        menu.style.left = '0';
        menu.style.marginTop = '4px';
        menu.style.display = 'none';
        applyMenuSurfaceStyle(menu, {
            minWidth: '180px',
            padding: '8px',
            zIndex: '10000',
        });

        const infiniteRow = document.createElement('label');
        infiniteRow.style.display = 'flex';
        infiniteRow.style.alignItems = 'center';
        infiniteRow.style.gap = '6px';
        infiniteRow.style.marginBottom = '6px';
        infiniteRow.style.cursor = 'pointer';
        infiniteRow.style.fontSize = '13px';
        infiniteRow.style.fontWeight = '600';
        const infiniteCheckbox = document.createElement('input');
        infiniteCheckbox.type = 'checkbox';
        infiniteCheckbox.dataset.setting = 'search-infinite-scroll';
        infiniteCheckbox.checked = enableSearchInfiniteScroll;
        infiniteCheckbox.addEventListener('change', () => {
            enableSearchInfiniteScroll = infiniteCheckbox.checked;
            persistSearchInfiniteScrollPreference();
            if (enableSearchInfiniteScroll) {
                setupSearchInfiniteScroll();
            } else {
                teardownSearchInfiniteScroll();
            }
            syncSettingsMenuControls();
        });
        const infiniteText = document.createElement('span');
        infiniteText.textContent = '搜索页无限滚动';
        infiniteRow.appendChild(infiniteCheckbox);
        infiniteRow.appendChild(infiniteText);

        const logRow = document.createElement('label');
        logRow.style.display = 'flex';
        logRow.style.alignItems = 'center';
        logRow.style.gap = '6px';
        logRow.style.marginBottom = '6px';
        logRow.style.cursor = 'pointer';
        logRow.style.fontWeight = '600';
        logRow.style.fontSize = '13px';
        const logCheckbox = document.createElement('input');
        logCheckbox.type = 'checkbox';
        logCheckbox.dataset.setting = 'enable-log';
        logCheckbox.checked = enableDebugLog;
        logCheckbox.addEventListener('change', () => {
            enableDebugLog = logCheckbox.checked;
            persistLogPreference();
            syncSettingsMenuControls();
        });
        const logText = document.createElement('span');
        logText.textContent = '开启日志';
        logRow.appendChild(logCheckbox);
        logRow.appendChild(logText);

        const divider = document.createElement('hr');
        divider.style.margin = '6px 0';
        divider.style.border = 'none';
        divider.style.borderTop = `1px solid ${window.getComputedStyle(document.body).color || '#fff'}`;
        menu.appendChild(divider);

        // AB Download Manager 端口配置
        loadAbdmPortPreference();
        const abdmPortRow = document.createElement('div');
        abdmPortRow.style.display = 'flex';
        abdmPortRow.style.alignItems = 'center';
        abdmPortRow.style.gap = '6px';
        abdmPortRow.style.marginBottom = '6px';
        abdmPortRow.style.fontSize = '13px';
        abdmPortRow.style.fontWeight = '500';

        const abdmPortLabel = document.createElement('span');
        abdmPortLabel.textContent = 'AB DM 端口：';
        abdmPortLabel.style.flex = '0 0 auto';

        const abdmPortInput = document.createElement('input');
        abdmPortInput.type = 'number';
        abdmPortInput.min = '1';
        abdmPortInput.max = '65535';
        abdmPortInput.value = String(abdmPort);
        abdmPortInput.style.width = '80px';
        abdmPortInput.style.padding = '2px 4px';
        abdmPortInput.style.flex = '0 0 auto';

        const applyAbdmPort = () => {
            const value = parseInt(abdmPortInput.value, 10);
            if (isNaN(value) || value < 1 || value > 65535) {
                abdmPortInput.value = String(abdmPort);
                toastError('端口号必须在 1-65535 之间');
                return;
            }
            if (value === abdmPort) return;
            abdmPort = value;
            persistAbdmPortPreference();
            toastSuccess(`AB Download Manager 端口已设置为 ${abdmPort}`);
        };

        abdmPortInput.addEventListener('change', applyAbdmPort);
        abdmPortInput.addEventListener('blur', applyAbdmPort);

        abdmPortRow.appendChild(abdmPortLabel);
        abdmPortRow.appendChild(abdmPortInput);

        const divider2 = document.createElement('hr');
        divider2.style.margin = '6px 0';
        divider2.style.border = 'none';
        divider2.style.borderTop = `1px solid ${window.getComputedStyle(document.body).color || '#fff'}`;

        loadRecentBatchLimit();
        const recentLimitRow = document.createElement('div');
        recentLimitRow.style.display = 'flex';
        recentLimitRow.style.alignItems = 'center';
        recentLimitRow.style.gap = '6px';
        recentLimitRow.style.marginBottom = '6px';
        recentLimitRow.style.fontSize = '13px';
        recentLimitRow.style.fontWeight = '500';

        const recentLimitLabel = document.createElement('span');
        recentLimitLabel.textContent = '最近下载记录上限：';
        recentLimitLabel.style.flex = '0 0 auto';

        const recentLimitInput = document.createElement('input');
        recentLimitInput.type = 'number';
        recentLimitInput.min = '1';
        recentLimitInput.max = '999';
        recentLimitInput.value = String(recentBatchLimit);
        recentLimitInput.style.width = '64px';
        recentLimitInput.style.padding = '2px 4px';
        recentLimitInput.style.flex = '0 0 auto';
        recentLimitInput.title = '最多可保存999条最近下载记录';

        const applyRecentLimit = async () => {
            const value = clampRecentBatchLimit(recentLimitInput.value);
            recentLimitInput.value = String(value);
            if (value === recentBatchLimit) return;
            recentBatchLimit = value;
            persistRecentBatchLimit(value);
            const batches = await loadRecentBatches();
            await persistRecentBatches(batches);
            if (recentOverlay && recentOverlay.dataset.visible === 'true') {
                await renderRecentDialogBody();
            }
        };

        recentLimitInput.addEventListener('change', () => applyRecentLimit());
        recentLimitInput.addEventListener('blur', () => applyRecentLimit());

        recentLimitRow.appendChild(recentLimitLabel);
        recentLimitRow.appendChild(recentLimitInput);

        const buttonGroup = document.createElement('div');
        buttonGroup.style.display = 'flex';
        buttonGroup.style.flexDirection = 'column';
        buttonGroup.style.gap = '4px';
        buttonGroup.style.fontSize = '13px';

        const importButton = document.createElement('button');
        importButton.type = 'button';
        importButton.textContent = '导入设置（剪贴板）';
        importButton.style.padding = '4px 6px';
        importButton.style.cursor = 'pointer';
        importButton.style.fontSize = '13px';
        importButton.style.fontWeight = '600';
        importButton.addEventListener('click', async () => {
            const input = window.prompt('粘贴导出的 JSON 设置：');
            if (!input) return;
            try {
                const data = JSON.parse(input);
                toastInfo('导入中...');
                await applySettingsPayload(data);
                toastSuccess('导入成功');
            } catch (err) {
                console.warn('导入设置失败', err);
                toastError('导入失败，请确认 JSON 格式正确');
            }
        });

        const exportButton = document.createElement('button');
        exportButton.type = 'button';
        exportButton.textContent = '导出设置（剪贴板）';
        exportButton.style.padding = '4px 6px';
        exportButton.style.cursor = 'pointer';
        exportButton.style.fontSize = '13px';
        exportButton.style.fontWeight = '600';
        exportButton.addEventListener('click', async () => {
            try {
                const payload = await buildSettingsPayload();
                const text = JSON.stringify(payload, null, 2);
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(text).then(() => {
                        toastSuccess('已复制到剪贴板');
                    }).catch(() => {
                        window.prompt('请手动复制以下 JSON：', text);
                    });
                } else {
                    window.prompt('请手动复制以下 JSON：', text);
                }
            } catch (err) {
                console.warn('[EhMagnet] 导出设置失败', err);
                toastError('导出失败');
            }
        });

        const importFileButton = document.createElement('button');
        importFileButton.type = 'button';
        importFileButton.textContent = '导入设置（文件）';
        importFileButton.style.padding = '4px 6px';
        importFileButton.style.cursor = 'pointer';
        importFileButton.style.fontSize = '13px';
        importFileButton.style.fontWeight = '600';
        importFileButton.addEventListener('click', () => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = 'application/json,.json';
            input.style.display = 'none';
            input.addEventListener('change', async () => {
                const file = input.files && input.files[0];
                input.remove();
                if (!file) return;
                const reader = new FileReader();
                reader.onload = async () => {
                    try {
                        const text = typeof reader.result === 'string' ? reader.result : String(reader.result || '');
                        const data = JSON.parse(text);
                        toastInfo('导入中...');
                        await applySettingsPayload(data);
                        toastSuccess('导入成功');
                    } catch (err) {
                        console.warn('文件导入设置失败', err);
                        toastError('导入失败，请确认 JSON 文件有效');
                    }
                };
                reader.onerror = (event) => {
                    console.warn('读取设置文件失败', event);
                    toastError('读取文件失败');
                };
                reader.readAsText(file);
            }, { once: true });
            menu.appendChild(input);
            input.click();
        });

        const exportFileButton = document.createElement('button');
        exportFileButton.type = 'button';
        exportFileButton.textContent = '导出设置（文件）';
        exportFileButton.style.padding = '4px 6px';
        exportFileButton.style.cursor = 'pointer';
        exportFileButton.style.fontSize = '13px';
        exportFileButton.style.fontWeight = '600';
        exportFileButton.addEventListener('click', async () => {
            try {
                const payload = await buildSettingsPayload();
                const text = JSON.stringify(payload, null, 2);
                const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
                const fileName = `EhMagnetSettings-${formatTimestampForFilename()}.json`;
                const link = document.createElement('a');
                const objectUrl = URL.createObjectURL(blob);
                link.href = objectUrl;
                link.download = fileName;
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
                window.setTimeout(() => {
                    URL.revokeObjectURL(objectUrl);
                }, 1000);
            } catch (err) {
                console.warn('[EhMagnet] 导出设置失败', err);
                toastError('导出失败');
            }
        });

        // 功能说明对话框
        const showHelpDialog = () => {
            const dialog = document.createElement('div');
            dialog.style.cssText = `
                position: fixed;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
                background: white;
                border: 1px solid #ccc;
                border-radius: 8px;
                padding: 24px;
                z-index: 10001;
                width: 500px;
                max-height: 80vh;
                overflow-y: auto;
                box-shadow: 0 2px 10px rgba(0,0,0,0.2);
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            `;
            
            const title = document.createElement('h2');
            title.textContent = '❓ 功能说明';
            title.style.cssText = 'margin: 0 0 20px 0; font-size: 18px; font-weight: bold; text-align: center;';
            dialog.appendChild(title);
            
            const content = document.createElement('div');
            content.style.cssText = 'line-height: 1.8; font-size: 13px; color: #333;';
            content.innerHTML = `
                <div style="margin-bottom: 20px;">
                    <h3 style="margin: 10px 0; font-weight: bold; color: #222; text-align: left;">📋 选择操作</h3>
                    <div style="margin: 8px 0; padding-left: 20px; text-align: left;">
                        <div>• 单击复选框勾选单个画廊</div>
                        <div>• Shift+点击多选画廊范围</div>
                        <div>• 条件过滤：已下载、已忽略、无种子、种子过时</div>
                        <div>• ☑️ 全选 / 🔄 反选</div>
                    </div>
                </div>
                
                <div style="margin-bottom: 20px;">
                    <h3 style="margin: 10px 0; font-weight: bold; color: #222; text-align: left;">🎯 功能菜单入口</h3>
                    <div style="margin: 8px 0; padding-left: 20px; text-align: left;">
                        <div><strong>复选框右键</strong> - 批量操作：刷新、复制、发送、标记等</div>
                        <div><strong>📥种子右键</strong> - 单项操作：标记、复制、下载</div>
                        <div><strong>⚙️齿轮菜单</strong> - 单画廊设置：标记、刷新、发送到AB DM（归档）</div>
                    </div>
                </div>
                
                <div style="margin-bottom: 20px;">
                    <h3 style="margin: 10px 0; font-weight: bold; color: #222; text-align: left;">📤 发送下载</h3>
                    <div style="margin: 8px 0; padding-left: 20px; text-align: left;">
                        <div><strong>发送下载</strong> - 统一入口，支持：</div>
                        <div style="padding-left: 20px;">
                            <div>• 📌 磁链/🌱种链 选择</div>
                            <div>• ⬇️ Aria2 渠道（需配合修改版 EhAria2下载助手.js）</div>
                            <div>• 📤 AB DM 渠道（⚠️消耗GP）</div>
                        </div>
                        <div><strong>查询归档信息</strong> - 查询选中画廊的归档状态</div>
                    </div>
                </div>
                
                <div style="margin-bottom: 20px;">
                    <h3 style="margin: 10px 0; font-weight: bold; color: #222; text-align: left;">📌 标记 / 🚫 忽略</h3>
                    <div style="margin: 8px 0; padding-left: 20px; text-align: left;">
                        <div>• 标记画廊为"已下载"或忽略</div>
                        <div>• 在画廊上点击对应图标可取消标记/忽略</div>
                        <div>• 支持批量操作和单个操作</div>
                    </div>
                </div>
                
                <div style="margin-bottom: 20px;">
                    <h3 style="margin: 10px 0; font-weight: bold; color: #222; text-align: left;">🔧 高级功能</h3>
                    <div style="margin: 8px 0; padding-left: 20px; text-align: left;">
                        <div><strong>自动刷新</strong> - 打开页面时是否自动获取种子信息</div>
                        <div><strong>鼠标悬停刷新</strong> - 悬停时自动刷新该画廊</div>
                        <div><strong>网络操作设置</strong> - 配置所有批量操作（查询、下载、验证等）的并发数和请求间隔</div>
                        <div><strong>🡇 归档下载</strong> - 快捷发送到AB DM（消耗GP）</div>
                    </div>
                </div>
                
                <div style="margin-bottom: 16px;">
                    <p style="margin: 0; font-size: 12px; color: #666; text-align: left;">
                        💡 提示：悬停鼠标在各UI元素上可查看快速提示
                    </p>
                </div>
                
                <div style="padding-top: 16px; border-top: 1px solid #e0e0e0;">
                    <p style="margin: 0 0 8px 0; font-size: 12px; color: #ff6b6b; font-weight: bold;">
                        ⚠️ 注意事项
                    </p>
                    <p style="margin: 0; font-size: 12px; color: #666; text-align: left;">
                        • 本脚本仅适配E-Hentai缩略图（Thumb）模式
                    </p>
                </div>
            `;
            dialog.appendChild(content);
            
            const closeButton = document.createElement('button');
            closeButton.type = 'button';
            closeButton.textContent = '关闭';
            closeButton.style.cssText = `
                margin-top: 20px;
                padding: 8px 16px;
                background: #007bff;
                color: white;
                border: none;
                border-radius: 4px;
                cursor: pointer;
                font-weight: 600;
                font-size: 13px;
            `;
            closeButton.addEventListener('click', () => {
                document.body.removeChild(dialog);
            });
            dialog.appendChild(closeButton);
            
            const overlay = document.createElement('div');
            overlay.style.cssText = `
                position: fixed;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background: rgba(0,0,0,0.5);
                z-index: 10000;
            `;
            overlay.addEventListener('click', () => {
                document.body.removeChild(overlay);
                document.body.removeChild(dialog);
            });
            
            document.body.appendChild(overlay);
            document.body.appendChild(dialog);
        };

        // 种链转磁链功能
        const showTorrentToMagnetDialog = () => {
            const dialog = document.createElement('div');
            dialog.style.cssText = `
                position: fixed;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
                background: white;
                border: 1px solid #ccc;
                border-radius: 8px;
                padding: 20px;
                z-index: 10001;
                width: 500px;
                max-height: 80vh;
                overflow-y: auto;
                box-shadow: 0 2px 10px rgba(0,0,0,0.2);
            `;
            
            const title = document.createElement('h3');
            title.textContent = '种链批量转磁链';
            title.style.margin = '0 0 15px 0';
            dialog.appendChild(title);
            
            const description = document.createElement('p');
            description.textContent = '粘贴种链URL，自动转换为磁链：';
            description.style.cssText = 'font-size: 12px; color: #666; margin: 0 0 10px 0;';
            dialog.appendChild(description);
            
            const textarea = document.createElement('textarea');
            textarea.placeholder = '每行一个种链URL，如：\nhttps://ehtracker.org/get/3706796/3863286-aktg3pfr9v55cc1v6iz/7f4fb57c26a486bc5604757002b33d3209c28255.torrent';
            textarea.style.cssText = `
                width: 100%;
                height: 120px;
                padding: 8px;
                border: 1px solid #ccc;
                border-radius: 4px;
                font-family: monospace;
                font-size: 11px;
                resize: vertical;
                box-sizing: border-box;
            `;
            dialog.appendChild(textarea);
            
            const resultContainer = document.createElement('div');
            resultContainer.style.cssText = `
                margin-top: 15px;
                padding: 10px;
                background: #f9f9f9;
                border: 1px solid #e0e0e0;
                border-radius: 4px;
                min-height: 60px;
                max-height: 200px;
                overflow-y: auto;
                font-family: monospace;
                font-size: 11px;
                white-space: pre-wrap;
                word-break: break-all;
            `;
            resultContainer.innerHTML = '<div style="color: #999;">转换结果将显示在这里</div>';
            dialog.appendChild(resultContainer);
            
            const buttonContainer = document.createElement('div');
            buttonContainer.style.cssText = 'margin-top: 15px; display: flex; gap: 8px; justify-content: flex-end;';
            
            const convertBtn = document.createElement('button');
            convertBtn.textContent = '转换';
            convertBtn.style.cssText = `
                padding: 6px 12px;
                background: #5cb85c;
                color: white;
                border: none;
                border-radius: 4px;
                cursor: pointer;
                font-size: 12px;
            `;
            convertBtn.addEventListener('click', async () => {
                const input = textarea.value.trim();
                if (!input) {
                    toastWarn('请粘贴种链URL');
                    return;
                }
                
                const lines = input.split('\n').map(l => l.trim()).filter(l => l);
                const magnets = [];
                
                for (const line of lines) {
                    // 提取哈希值（种链URL中的哈希）
                    const match = line.match(/([a-f0-9]{40})\.(torrent)?$/i);
                    if (match) {
                        const hash = match[1].toLowerCase();
                        const magnet = `magnet:?xt=urn:btih:${hash}`;
                        magnets.push(magnet);
                    } else {
                        magnets.push(`❌ 无效: ${line}`);
                    }
                }
                
                resultContainer.innerHTML = magnets.join('\n');
                
                // 复制所有有效的磁链到剪贴板
                const validMagnets = magnets.filter(m => m.startsWith('magnet:'));
                if (validMagnets.length > 0) {
                    navigator.clipboard.writeText(validMagnets.join('\n')).then(() => {
                        toastSuccess(`已转换并复制 ${validMagnets.length} 条磁链`);
                    }).catch(() => {
                        toastWarn('复制失败，请手动复制');
                    });
                }
            });
            buttonContainer.appendChild(convertBtn);
            
            const copyBtn = document.createElement('button');
            copyBtn.textContent = '复制结果';
            copyBtn.style.cssText = `
                padding: 6px 12px;
                background: #0275d8;
                color: white;
                border: none;
                border-radius: 4px;
                cursor: pointer;
                font-size: 12px;
            `;
            copyBtn.addEventListener('click', () => {
                const text = resultContainer.textContent;
                if (text && text !== '转换结果将显示在这里') {
                    navigator.clipboard.writeText(text).then(() => {
                        toastSuccess('已复制');
                    }).catch(() => {
                        toastWarn('复制失败');
                    });
                }
            });
            buttonContainer.appendChild(copyBtn);
            
            const closeBtn = document.createElement('button');
            closeBtn.textContent = '关闭';
            closeBtn.style.cssText = `
                padding: 6px 12px;
                background: #ccc;
                color: #333;
                border: none;
                border-radius: 4px;
                cursor: pointer;
                font-size: 12px;
            `;
            closeBtn.addEventListener('click', () => {
                dialog.remove();
            });
            buttonContainer.appendChild(closeBtn);
            
            dialog.appendChild(buttonContainer);
            document.body.appendChild(dialog);
        };

        const recentButton = document.createElement('button');
        recentButton.type = 'button';
        recentButton.textContent = '最近下载';
        recentButton.style.padding = '4px 6px';
        recentButton.style.cursor = 'pointer';
        recentButton.style.fontSize = '13px';
        recentButton.style.fontWeight = '600';
        recentButton.addEventListener('click', async () => {
            await showRecentDialog();
        });

        const batchQueryButton = document.createElement('button');
        batchQueryButton.type = 'button';
        batchQueryButton.textContent = '批量查询/归档';
        batchQueryButton.style.padding = '4px 6px';
        batchQueryButton.style.cursor = 'pointer';
        batchQueryButton.style.fontSize = '13px';
        batchQueryButton.style.fontWeight = '600';
        batchQueryButton.addEventListener('click', () => {
            showBatchQueryDialog();
        });

        const torrentToMagnetButton = document.createElement('button');
        torrentToMagnetButton.type = 'button';
        torrentToMagnetButton.textContent = '种链转磁链';
        torrentToMagnetButton.style.padding = '4px 6px';
        torrentToMagnetButton.style.cursor = 'pointer';
        torrentToMagnetButton.style.fontSize = '13px';
        torrentToMagnetButton.style.fontWeight = '600';
        torrentToMagnetButton.addEventListener('click', () => {
            showTorrentToMagnetDialog();
        });

        const helpButton = document.createElement('button');
        helpButton.type = 'button';
        helpButton.textContent = '功能说明';
        helpButton.style.padding = '4px 6px';
        helpButton.style.cursor = 'pointer';
        helpButton.style.fontSize = '13px';
        helpButton.style.fontWeight = '600';
        helpButton.title = '查看功能使用说明和快捷方式';
        helpButton.addEventListener('click', () => {
            showHelpDialog();
        });

        buttonGroup.appendChild(batchQueryButton);
        buttonGroup.appendChild(recentButton);
        buttonGroup.appendChild(torrentToMagnetButton);
        buttonGroup.appendChild(importButton);
        buttonGroup.appendChild(exportButton);
        buttonGroup.appendChild(importFileButton);
        buttonGroup.appendChild(exportFileButton);
        buttonGroup.appendChild(helpButton);
        menu.appendChild(buttonGroup);

        // 添加4个很少改动的设置行
        const divider3 = document.createElement('hr');
        divider3.style.margin = '6px 0';
        divider3.style.border = 'none';
        divider3.style.borderTop = `1px solid ${window.getComputedStyle(document.body).color || '#fff'}`;
        menu.appendChild(divider3);

        menu.appendChild(infiniteRow);
        menu.appendChild(logRow);

        // 添加最后两个设置项和分隔线
        menu.appendChild(divider2);
        menu.appendChild(abdmPortRow);
        menu.appendChild(recentLimitRow);

        settingsMenu = menu;
        document.body.appendChild(menu);
        syncSettingsMenuControls();
        return menu;
    };

    const toggleSettingsMenu = (button) => {
        const menu = ensureSettingsMenu();
        if (!menu) return;

        const isVisible = menu.dataset.visible === 'true' && menu.dataset.anchor === button.dataset.anchor;
        document.querySelectorAll('.eh-magnet-settings-menu').forEach((el) => {
            el.style.display = 'none';
            el.dataset.visible = 'false';
        });

        if (isVisible) return;

        const rect = button.getBoundingClientRect();
        menu.style.left = `${rect.left + window.scrollX}px`;
        menu.style.top = `${rect.bottom + window.scrollY + 6}px`;
        menu.style.display = 'block';
        menu.dataset.visible = 'true';
        menu.dataset.anchor = button.dataset.anchor;

        const handleOutsideClick = (event) => {
            if (menu.contains(event.target) || button.contains(event.target)) return;
            menu.style.display = 'none';
            menu.dataset.visible = 'false';
            document.removeEventListener('mousedown', handleOutsideClick);
        };
        document.addEventListener('mousedown', handleOutsideClick);
    };

    const createSettingsButton = (anchorId) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = '设置';
        button.className = 'eh-magnet-settings';
        button.style.padding = '2px 8px';
        button.style.cursor = 'pointer';
        button.dataset.anchor = anchorId;
        button.addEventListener('click', (event) => {
            event.stopPropagation();
            toggleSettingsMenu(button);
        });
        return button;
    };

    const ensureControlWrapperForAnchor = (anchor, container, insertBeforeNode = null) => {
        if (!container) return;
        const selector = `.eh-magnet-control-wrapper[data-anchor="${anchor}"]`;
        const wrappers = Array.from(container.querySelectorAll(selector));
        wrappers.forEach((wrapper, index) => {
            if (index === 0) {
                assignControlReferences(wrapper, anchor);
                ensureSelectionSummaryForAnchor(anchor, container, wrapper);
            } else {
                wrapper.remove();
            }
        });
        if (wrappers.length) return;

        const controlWrapper = createControlWrapper(anchor);
        const settingsButton = createSettingsButton(anchor);
        const moreActionsButton = createMoreActionsButton(anchor);
        controlWrapper.appendChild(settingsButton);
        controlWrapper.appendChild(moreActionsButton);
        if (insertBeforeNode) {
            container.insertBefore(controlWrapper, insertBeforeNode);
        } else {
            container.appendChild(controlWrapper);
        }
        assignControlReferences(controlWrapper, anchor);
        ensureSelectionSummaryForAnchor(anchor, container, controlWrapper);
    };

    const injectControls = () => {
        const nav = document.querySelectorAll('.searchnav');
        if (!nav.length) return;

        cleanupDetachedControlReferences();

        const topNav = nav[0];
        const bottomNav = nav.length > 1 ? nav[nav.length - 1] : null;

        if (topNav) {
            const modeContainer = topNav.querySelector(':scope > div:last-child');
            if (modeContainer) {
                ensureControlWrapperForAnchor('top', modeContainer, modeContainer.firstChild);
            }
        }

        if (bottomNav && bottomNav !== topNav) {
            const slot = bottomNav.querySelector(':scope > div:last-child') || bottomNav.lastElementChild;
            if (slot) {
                ensureControlWrapperForAnchor('bottom', slot);
            }
        }
    };

    const isSearchPage = () => {
        try {
            const path = window.location.pathname;
            const params = new URLSearchParams(window.location.search);
            // 搜索页、主页、订阅页、收藏页等都应该显示复选框
            // 排除画廊详情页 (/g/)、归档页 (/archiver.php) 等
            if (path.includes('/g/') || path.includes('/archiver.php')) {
                return false;
            }
            // 根路径 "/" 或带搜索参数都算作列表页
            // 包含 uploader 页面（点击作者名进入的页面）、收藏页、订阅页等
            return path === '/' || params.has('f_search') || params.has('f_cats') || path.includes('/watched') || path.includes('/uploader/') || path.includes('/favorites') || path === '';
        } catch (err) {
            return false;
        }
    };

    const resolveSearchNextUrl = (link) => {
        if (!link) return '';
        const href = link.getAttribute('href');
        if (!href) return '';
        try {
            return new URL(href, window.location.href).toString();
        } catch (err) {
            console.warn('解析下一页链接失败', err);
            return '';
        }
    };

    const disableExternalSearchInfiniteScroll = () => {
        if (!isSearchPage()) return;
        // 只有在启用了内置搜索无限滚动时，才禁用LOLICON的无限滚动
        if (!enableSearchInfiniteScroll) return;
        if (typeof IntersectionObserver !== 'function') return;
        const proto = IntersectionObserver.prototype;
        if (!proto || typeof proto.observe !== 'function') return;

        const removeLoliconTriggers = () => {
            document
                .querySelectorAll(`.${LOLICON_SCROLL_TRIGGER_CLASS}`)
                .forEach((node) => {
                    try {
                        node.remove();
                    } catch (err) {
                        withDebugLog(() => console.warn('移除 LOLICON 触发器失败', err));
                    }
                });
        };

        if (!proto.__ehMagnetOriginalObserve) {
            proto.__ehMagnetOriginalObserve = proto.observe;
            proto.observe = function patchedObserve(target) {
                try {
                    if (
                        target instanceof Element &&
                        target.classList.contains(LOLICON_SCROLL_TRIGGER_CLASS)
                    ) {
                        target.remove();
                        return this;
                    }
                } catch (err) {
                    withDebugLog(() => console.warn('拦截 LOLICON 观察目标失败', err));
                }
                return proto.__ehMagnetOriginalObserve.call(this, target);
            };
        }

        if (typeof queueMicrotask === 'function') {
            queueMicrotask(removeLoliconTriggers);
        } else {
            Promise.resolve().then(removeLoliconTriggers).catch(() => {});
        }
        setTimeout(removeLoliconTriggers, 0);
    };

    const injectSearchInfiniteScrollStyle = () => {
        if (searchInfiniteScrollStyleInjected) return;
        searchInfiniteScrollStyleInjected = true;
        const style = document.createElement('style');
        style.id = 'eh-magnet-infinite-style';
        style.textContent = `
            .eh-magnet-infinite-container.eh-magnet-loading::after {
                content: '加载中…';
                display: block;
                text-align: center;
                padding: 16px 0;
                color: #666;
                font-size: 14px;
            }
            .eh-magnet-infinite-sentinel {
                width: 100%;
                height: 1px;
            }
        `;
        document.head.appendChild(style);
    };

    const fetchSearchDocument = async (url) => {
        const response = await fetch(url, {
            credentials: 'include',
            headers: {
                'X-Requested-With': 'XMLHttpRequest',
            },
        });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        const html = await response.text();
        return new DOMParser().parseFromString(html, 'text/html');
    };

    const teardownSearchInfiniteScroll = () => {
        if (searchInfiniteScrollObserver) {
            searchInfiniteScrollObserver.disconnect();
            searchInfiniteScrollObserver = null;
        }
        searchInfiniteScrollLoading = false;
        searchInfiniteScrollNextUrl = '';
        if (searchInfiniteScrollSentinel && searchInfiniteScrollSentinel.isConnected) {
            searchInfiniteScrollSentinel.remove();
        }
        if (searchInfiniteScrollContainer) {
            searchInfiniteScrollContainer.classList.remove('eh-magnet-infinite-container', 'eh-magnet-loading');
            searchInfiniteScrollContainer.removeAttribute('data-eh-magnet-infinite');
        }
        searchInfiniteScrollContainer = null;
        searchInfiniteScrollSentinel = null;
        searchInfiniteScrollInitialized = false;
    };

    const setupSearchInfiniteScroll = () => {
        if (!enableSearchInfiniteScroll) {
            teardownSearchInfiniteScroll();
            return;
        }
        if (!isSearchPage()) {
            teardownSearchInfiniteScroll();
            return;
        }
        const container = document.querySelector('.itg.gld');
        if (!container) {
            teardownSearchInfiniteScroll();
            return;
        }
        const nextUrl = resolveSearchNextUrl(document.querySelector('#dnext'));
        if (!nextUrl) {
            teardownSearchInfiniteScroll();
            return;
        }
        if (searchInfiniteScrollInitialized && searchInfiniteScrollContainer === container) {
            searchInfiniteScrollNextUrl = nextUrl;
            return;
        }

        teardownSearchInfiniteScroll();

        injectSearchInfiniteScrollStyle();
        searchInfiniteScrollContainer = container;
        searchInfiniteScrollContainer.dataset.ehMagnetInfinite = '1';
        searchInfiniteScrollContainer.classList.add('eh-magnet-infinite-container');
        searchInfiniteScrollSentinel = document.createElement('div');
        searchInfiniteScrollSentinel.className = 'eh-magnet-infinite-sentinel';
        searchInfiniteScrollContainer.appendChild(searchInfiniteScrollSentinel);
        searchInfiniteScrollNextUrl = nextUrl;
        searchInfiniteScrollInitialized = true;

        searchInfiniteScrollObserver = new IntersectionObserver(async (entries) => {
            const entry = entries[0];
            if (!entry || !entry.isIntersecting) return;
            if (!enableSearchInfiniteScroll) {
                teardownSearchInfiniteScroll();
                return;
            }
            if (!searchInfiniteScrollNextUrl) {
                teardownSearchInfiniteScroll();
                return;
            }
            if (searchInfiniteScrollLoading) return;
            if (!searchInfiniteScrollContainer || !searchInfiniteScrollSentinel) {
                teardownSearchInfiniteScroll();
                return;
            }
            searchInfiniteScrollLoading = true;
            searchInfiniteScrollContainer.classList.add('eh-magnet-loading');
            const currentUrl = searchInfiniteScrollNextUrl;
            try {
                const doc = await fetchSearchDocument(currentUrl);
                const items = Array.from(doc.querySelectorAll('.itg.gld > .gl1t'));
                if (!items.length) {
                    searchInfiniteScrollNextUrl = '';
                    teardownSearchInfiniteScroll();
                    return;
                }
                if (!searchInfiniteScrollContainer || !searchInfiniteScrollSentinel) {
                    teardownSearchInfiniteScroll();
                    return;
                }
                const fragment = document.createDocumentFragment();
                items.forEach((item) => fragment.appendChild(item));
                searchInfiniteScrollContainer.insertBefore(fragment, searchInfiniteScrollSentinel);
                items.forEach((item) => scan(item));
                updateStatusFlags();
                refreshGalleryIgnoreButtons();
                searchInfiniteScrollNextUrl = resolveSearchNextUrl(doc.querySelector('#dnext')) || '';
                if (typeof history.replaceState === 'function' && currentUrl !== window.location.href) {
                    history.replaceState(null, doc.title, currentUrl);
                }
                if (!searchInfiniteScrollNextUrl) {
                    teardownSearchInfiniteScroll();
                }
            } catch (err) {
                console.warn('搜索页加载下一页失败', err);
                teardownSearchInfiniteScroll();
            } finally {
                if (searchInfiniteScrollContainer) {
                    searchInfiniteScrollContainer.classList.remove('eh-magnet-loading');
                }
                searchInfiniteScrollLoading = false;
            }
        }, {
            root: null,
            threshold: 0.1,
        });

        searchInfiniteScrollObserver.observe(searchInfiniteScrollSentinel);
    };

    let observerDisconnected = false;
    const observer = new MutationObserver((mutations) => {
        if (observerDisconnected) return; // 防止重入
        
        let shouldRescan = false;
        mutations.forEach((mutation) => {
            mutation.addedNodes.forEach((node) => {
                if (!(node instanceof HTMLElement)) return;
                // 跳过我们自己添加的元素
                if (node.classList && (node.classList.contains('eh-magnet-links') || node.classList.contains('eh-magnet-item'))) {
                    return;
                }
                // 检测画廊元素本身（.gl1t, tr）或其内部的关键元素
                if (node.matches('.gldown a[href*="gallerytorrents.php"], #gd5, .gl5t, .gl1t, .itg > tbody > tr')) {
                    shouldRescan = true;
                }
                // 检测节点内部是否包含画廊元素
                if (node.querySelector('.gldown a[href*="gallerytorrents.php"], .gl5t, .gl1t')) {
                    shouldRescan = true;
                }
            });
        });
        if (shouldRescan) {
            console.log('[EhMagnet] MutationObserver 检测到新画廊，调用 scan()');
            // 临时断开 observer，避免死循环
            observer.disconnect();
            observerDisconnected = true;
            scan();
            observerDisconnected = false;
            // 重新连接
            observer.observe(document.body, { childList: true, subtree: true });
        }
        injectControls();
        if (!galleryInjectionDone && !galleryInjectionPending) {
            injectGalleryTorrentLinks();
        }
    });

    window.addEventListener('EhAria2:gallery-downloaded', (event) => {
        const detail = event?.detail || {};
        const gid = detail.gid ? String(detail.gid) : '';
        if (!gid) return;
        const info = {
            gid,
            token: detail.token || '',
            href: detail.href || '',
        };
        const wasDownloaded = isGalleryDownloaded(info);
        const wasIgnored = isGalleryIgnored(info);
        const archiveRows = document.querySelectorAll(`.eh-magnet-item[data-gallery-gid="${escapeForSelector(gid)}"][data-archive-fallback="true"]`);
        const archiveKeys = Array.from(archiveRows).map((row) => row.dataset.magnetValue || row.dataset.archiveKey || '').filter(Boolean);
        const anyMagnetIgnored = archiveKeys.some((key) => isMagnetIgnored(key, info));
        const anyMagnetDownloaded = archiveKeys.some((key) => isMagnetDownloaded(key));

        if (wasIgnored || anyMagnetIgnored) {
            withDebugLog(() => console.log('[EhMagnet] EhAria2:gallery-downloaded skipped (ignored)', {
                gid,
                wasIgnored,
                anyMagnetIgnored,
            }));
            return;
        }

        if (!anyMagnetDownloaded) {
            markGalleryDownloaded(info, { silent: true, skipPersist: true });
        }
        archiveRows.forEach((row) => {
            const key = row.dataset.magnetValue || row.dataset.archiveKey || '';
            if (key) {
                markMagnetDownloaded(key, info, { silent: true, skipPersist: true });
            }
        });
        persistDownloadedState();
        if (wasIgnored && !isGalleryIgnored(info)) {
            persistIgnoredState();
        }
        updateStatusFlags();
        rebuildSelectionSets();
        refreshGalleryIgnoreButtons();
    });

    ensureTempHideStyles();
    loadLogPreference();
    loadSearchInfiniteScrollPreference();
    loadAutoFetchBatchQueryPreference();
    loadAbdmPortPreference();
    disableExternalSearchInfiniteScroll();
    loadTempHiddenGalleries();
    
    // 等待IndexedDB初始化和状态加载完成后，再启动页面扫描
    (async () => {
        // 等待IndexedDB初始化完成
        let maxWait = 50; // 最多等待5秒
        while (!idbSupported && maxWait > 0) {
            await new Promise(resolve => setTimeout(resolve, 100));
            maxWait--;
        }
        
        // 现在加载状态
        await loadDownloadedState();
        await loadIgnoredState();
        
        // 加载后立即保存，清理掉所有无效的时间戳（如"X小时后"）
        persistDownloadedState();
        persistIgnoredState();
        
        // 现在才启动页面扫描和设置
        console.log('[EhMagnet] 调用 scan()');
        scan();
        injectControls();
        updateStatusFlags();
        injectGalleryTorrentLinks();
        setupSearchInfiniteScroll();
        applyTemporaryHiddenState();
    })();
    
    // 清理页面上所有包含"小时后"的旧tooltip
    const cleanupInvalidTooltips = () => {
        const elements = document.querySelectorAll('.eh-gallery-ignore-badge, .eh-magnet-downloaded-flag');
        let cleanedCount = 0;
        elements.forEach(el => {
            if (el.title && /小时后|小时前|分钟后|分钟前|天后|天前/.test(el.title)) {
                console.warn('[EhMagnet] 清理无效tooltip:', el.title);
                const gid = el.dataset.galleryGid;
                if (gid && el.classList.contains('eh-gallery-ignore-badge')) {
                    // 重新设置tooltip
                    updateGalleryIgnoreButtonState(el, gid);
                } else {
                    // 清空无效tooltip
                    el.title = '点击取消标记';
                }
                cleanedCount++;
            }
        });
        if (cleanedCount > 0) {
            console.log(`[EhMagnet] 已清理 ${cleanedCount} 个无效tooltip`);
        }
    };
    
    // 在DOM加载完成后清理
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', cleanupInvalidTooltips);
    } else {
        setTimeout(cleanupInvalidTooltips, 100);
    }
    cleanupLegacyGalleryBadges();
    cleanupDownloadIgnoreConflicts({ persist: true });
    loadRecentBatchLimit();
    // 其他初始化操作将在async中进行
    
    // 使用定时器替代 MutationObserver（更兼容指纹浏览器）
    let lastGalleryCount = document.querySelectorAll('.gl5t').length;
    setInterval(() => {
        const allGalleries = document.querySelectorAll('.gl5t');
        const currentGalleryCount = allGalleries.length;
        
        // 检查是否有新画廊
        const hasNewGalleries = currentGalleryCount > lastGalleryCount;
        
        // 检查是否有未处理的画廊（没有 data-eh-magnet-attached 属性）
        const unprocessedGalleries = Array.from(allGalleries).filter(
            block => !block.dataset.ehMagnetAttached && block.querySelector('.gldown a[href*="gallerytorrents.php"]')
        );
        const hasUnprocessed = unprocessedGalleries.length > 0;
        
        if (hasNewGalleries || hasUnprocessed) {
            if (hasNewGalleries) {
                console.log('[EhMagnet] 检测到新画廊（定时器），调用 scan()');
            }
            if (hasUnprocessed) {
                console.log(`[EhMagnet] 检测到 ${unprocessedGalleries.length} 个未处理的画廊，调用 scan()`);
            }
            lastGalleryCount = currentGalleryCount;
            scan();
            injectControls();
        }
    }, 1000); // 每秒检查一次
    
    console.log('[EhMagnet] 使用定时器模式（兼容指纹浏览器）');
    console.log('[EhMagnet] 初始化完全完成！');

    window.addEventListener('storage', (event) => {
        if (!event?.key) return;
        if (!STATE_SYNC_STORAGE_KEYS.has(event.key)) return;
        if (event.key === STATE_REVISION_KEY) {
            const newRevision = parseStateRevisionValue(event.newValue);
            if (newRevision === lastKnownStateRevision) {
                return;
            }
            scheduleStateSync('storage-revision');
            return;
        }
        scheduleStateSync('storage-data', { force: true });
    });

    window.addEventListener('beforeunload', () => {
        try {
            persistDownloadCache();
        } catch (err) {
            console.warn('[EhMagnet] beforeunload 保存缓存失败', err);
        }
    });

    const syncCacheIfRevisionChanged = (reason) => {
        const now = Date.now();
        if (now - lastStateSyncTime < 400) return;
        const revision = readStateRevision();
        if (revision !== lastKnownStateRevision) {
            scheduleStateSync(reason);
        }
    };

    window.addEventListener('focus', () => syncCacheIfRevisionChanged('focus'));
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return;
        syncCacheIfRevisionChanged('visibility');
    });

    // 监听来自EH Highlight Duplicate的下载标记请求
    console.log('[EhMagnet] 已注册 eh-duplicate-download-mark 事件监听器');
    document.addEventListener('eh-duplicate-download-mark', (event) => {
        console.log('[EhMagnet] 收到 eh-duplicate-download-mark 事件', event.detail);
        const { gid, action } = event.detail || {};
        
        if (!gid) return;
        
        // 查找该画廊的第一个磁力链接或归档下载
        const row = document.querySelector(`.eh-magnet-item[data-gallery-gid="${escapeForSelector(gid)}"]`);
        if (!row) {
            console.log('[EhMagnet] 未找到gid', gid, '的磁力链接行');
            return;
        }
        
        const checkbox = row.querySelector('.eh-magnet-checkbox');
        const container = row.closest('.eh-magnet-links');
        const info = buildGalleryInfoFromDataset(row.dataset) || buildGalleryInfoFromDataset(container?.dataset);
        const magnetHref = row.dataset.magnetValue || checkbox?.dataset.magnetValue;
        const archiveKey = row.dataset.archiveKey || checkbox?.dataset.archiveKey;
        const key = magnetHref || archiveKey;
        
        if (!key) {
            console.log('[EhMagnet] 未找到gid', gid, '的磁力链接或归档key');
            return;
        }
        
        console.log('[EhMagnet] 找到key:', key, 'action:', action);
        
        if (action === 'mark') {
            markMagnetDownloaded(key, info);
        } else if (action === 'unmark') {
            unmarkMagnetDownloaded(key, info);
        }
    });
    
    // 监听来自EH Highlight Duplicate的忽略状态变化
    console.log('[EhMagnet] 已注册 eh-duplicate-ignore-changed 事件监听器');
    document.addEventListener('eh-duplicate-ignore-changed', (event) => {
        console.log('[EhMagnet] 收到 eh-duplicate-ignore-changed 事件', event.detail);
        const { gid, action, source } = event.detail || {};
        
        // 如果是本脚本自己触发的事件，跳过重新加载（避免循环）
        if (source === 'eh-magnet') {
            console.log('[EhMagnet] 跳过自己触发的事件');
            return;
        }
        
        console.log('[EhMagnet] 重新加载前 ignoredGalleries.has(gid):', ignoredGalleries.has(String(gid)));
        
        // 重新加载完整的忽略状态（从其他脚本同步数据）
        (async () => {
            await loadIgnoredState();
            console.log('[EhMagnet] 重新加载后 ignoredGalleries.has(gid):', ignoredGalleries.has(String(gid)));
        })();
        console.log('[EhMagnet] ignoredGalleries size:', ignoredGalleries.size);
        
        // 如果有指定gid，需要更新该画廊下的所有磁力链接标识
        if (gid) {
            const rows = document.querySelectorAll(`.eh-magnet-item[data-gallery-gid="${escapeForSelector(gid)}"]`);
            console.log('[EhMagnet] 找到', rows.length, '行磁力链接');
            
            rows.forEach((row) => {
                const ignoredFlag = row.querySelector('.eh-magnet-ignored-flag');
                const checkbox = row.querySelector('.eh-magnet-checkbox');
                const container = row.closest('.eh-magnet-links');
                const info = buildGalleryInfoFromDataset(row.dataset) || buildGalleryInfoFromDataset(container?.dataset);
                const magnetHref = row.dataset.magnetValue || checkbox?.dataset.magnetValue;
                const archiveKey = row.dataset.archiveKey || checkbox?.dataset.archiveKey;
                const key = magnetHref || archiveKey;
                
                if (ignoredFlag) {
                    const isIgnored = isMagnetIgnored(key, info);
                    console.log('[EhMagnet] 磁力链接', key, 'isIgnored:', isIgnored);
                    ignoredFlag.style.display = isIgnored ? 'inline-flex' : 'none';
                    ignoredFlag.dataset.active = isIgnored ? 'true' : 'false';
                }
            });
        }
        
        // 刷新画廊忽略按钮显示
        console.log('[EhMagnet] 调用 refreshGalleryIgnoreButtons');
        refreshGalleryIgnoreButtons();
        // 更新所有条目的状态标识
        console.log('[EhMagnet] 调用 updateStatusFlags');
        updateStatusFlags();
        console.log('[EhMagnet] 事件处理完成');
    });

    // 在详情页添加AB DM归档按钮
    // 仅在页面初始加载时注入，不使用 MutationObserver 以避免性能问题
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', injectArchiveButtonOnDetailPage);
    } else {
        injectArchiveButtonOnDetailPage();
    }

    // 初始化IndexedDB
    console.log('[EhMagnet] 正在初始化IndexedDB...');
    initIndexedDB().then(() => {
        // 配置去重队列的操作函数
        debouncedSaveGalleries.setOperation(saveDownloadedGalleriesToIDB);
        debouncedIgnoreGalleries.setOperation(saveIgnoredGalleriesToIDB);
        debouncedSaveMagnets.setOperation(saveDownloadedMagnetsToIDB);
        debouncedIgnoreMagnets.setOperation(saveIgnoredMagnetsToIDB);
        console.log('[EhMagnet] ✅ 去重队列已配置完成');
        console.log('[EhMagnet] IndexedDB初始化完成，idbSupported:', idbSupported);
    }).catch(err => {
        console.error('[EhMagnet] IndexedDB初始化失败:', err);
    });
})();
