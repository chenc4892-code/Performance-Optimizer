/**
 * Performance Optimizer - SillyTavern Extension
 *
 * Optimizes streaming performance by:
 * 1. Deferring regex processing until streaming completes
 * 2. Caching compiled RegExp objects to avoid repeated compilation
 * 3. CSS containment — isolates message layout/paint so updates don't cascade
 * 4. content-visibility: auto — browser skips rendering off-screen messages
 * 5. Streaming CSS mode — disables heavy visual effects (blur, shadow) during streaming
 */

import {
    eventSource,
    event_types,
    saveSettingsDebounced,
    messageFormatting,
    chat,
} from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';

const MODULE_NAME = 'performance-optimizer';
const LOG_PREFIX = '[PerfOpt]';

// ===================== Default Settings =====================

const defaultSettings = {
    enabled: true,
    deferRegexDuringStreaming: true,
    cacheRegex: true,
    cssContainment: true,
    reduceStreamingEffects: true,
};

// ===================== State =====================

let isGenerating = false;
let regexDisabled = false;
let regexWasAlreadyDisabled = false;
let stats = {
    regexSkipped: 0,
    regexCacheHits: 0,
    regexCacheMisses: 0,
};

// ===================== Settings =====================

function getSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = { ...defaultSettings };
    }
    // Merge any missing keys from defaults (for upgrades)
    for (const [key, value] of Object.entries(defaultSettings)) {
        if (!(key in extension_settings[MODULE_NAME])) {
            extension_settings[MODULE_NAME][key] = value;
        }
    }
    return extension_settings[MODULE_NAME];
}

// ===================== Optimization 1: Defer Regex During Streaming =====================

/**
 * Temporarily disable the regex extension during streaming.
 *
 * How it works: getRegexedString() in regex/engine.js checks
 * `extension_settings.disabledExtensions.includes('regex')` before doing
 * any work. By adding 'regex' to that array during streaming, we skip ALL
 * regex compilation and execution on every frame — the single biggest
 * performance win.
 *
 * After streaming ends, we remove it and re-render the final message with
 * full regex processing applied once.
 */
function disableRegexForStreaming() {
    const settings = getSettings();
    if (!settings.deferRegexDuringStreaming) return;

    regexWasAlreadyDisabled = extension_settings.disabledExtensions?.includes('regex') ?? false;

    if (!regexWasAlreadyDisabled && Array.isArray(extension_settings.disabledExtensions)) {
        extension_settings.disabledExtensions.push('regex');
        console.debug(`${LOG_PREFIX} Regex deferred for streaming`);
        stats.regexSkipped++;
    }
}

function restoreRegexAfterStreaming() {
    const settings = getSettings();
    if (!settings.deferRegexDuringStreaming) return;

    if (!regexWasAlreadyDisabled && Array.isArray(extension_settings.disabledExtensions)) {
        const idx = extension_settings.disabledExtensions.indexOf('regex');
        if (idx !== -1) {
            extension_settings.disabledExtensions.splice(idx, 1);
            console.debug(`${LOG_PREFIX} Regex restored`);
        }
    }
}

/**
 * Re-render the last AI message with full formatting (including regex).
 * Called after streaming ends so the final message gets proper treatment.
 *
 * After setting innerHTML, we emit CHARACTER_MESSAGE_RENDERED so that other
 * extensions (e.g. 酒馆助手/JS-Slash-Runner) can post-process the message
 * — for example, converting HTML code blocks into rendered iframes.
 */
function rerenderLastMessage() {
    const lastMesId = chat.length - 1;
    if (lastMesId < 0) return;

    const lastMes = chat[lastMesId];
    if (!lastMes || lastMes.is_user) return;

    const formattedText = messageFormatting(
        lastMes.mes,
        lastMes.name,
        lastMes.is_system,
        lastMes.is_user,
        lastMesId,
        {},
        false,
    );

    const mesElement = document.querySelector(`#chat .mes[mesid="${lastMesId}"] .mes_text`);
    if (mesElement) {
        mesElement.innerHTML = formattedText;
        console.debug(`${LOG_PREFIX} Final message re-rendered with regex`);

        // Notify other extensions that the message DOM has been replaced,
        // so they can re-apply post-processing (iframe rendering, etc.)
        eventSource.emit(event_types.CHARACTER_MESSAGE_RENDERED, lastMesId);
    }
}

// ===================== Optimization 2: RegExp Compilation Cache =====================

const regexCache = new Map();
const CACHE_MAX_SIZE = 500;
let OriginalRegExp = null;

/**
 * Wrap the global RegExp constructor with a caching layer.
 *
 * The regex engine in SillyTavern calls `regexFromString()` which creates a
 * new RegExp on every invocation — even for the exact same pattern. During
 * streaming this means the same user-defined regex patterns get compiled
 * hundreds of times.
 *
 * This cache stores compiled RegExp objects keyed by pattern+flags. For
 * stateful regexes (global/sticky), lastIndex is reset before returning.
 */
function enableRegexCache() {
    if (OriginalRegExp) return;

    // WebKit (iOS/Safari) has a different RegExp implementation in
    // JavaScriptCore. Replacing window.RegExp can break internal string
    // operations and JSON parsing on that engine. Skip to be safe.
    const isWebKit = /AppleWebKit/.test(navigator.userAgent) && !/Chrome\//.test(navigator.userAgent);
    if (isWebKit) {
        console.debug(`${LOG_PREFIX} RegExp cache skipped (WebKit detected)`);
        return;
    }

    OriginalRegExp = window.RegExp;

    const Cached = function RegExp(pattern, flags) {
        // When called as function (without new) — delegate to original
        if (!new.target) {
            return OriginalRegExp(pattern, flags);
        }

        const patternStr = (pattern instanceof OriginalRegExp)
            ? pattern.source
            : String(pattern ?? '');
        const flagsStr = (pattern instanceof OriginalRegExp && flags === undefined)
            ? pattern.flags
            : String(flags ?? '');
        const key = patternStr + '|||' + flagsStr;

        if (regexCache.has(key)) {
            const cached = regexCache.get(key);
            cached.lastIndex = 0;
            stats.regexCacheHits++;
            return cached;
        }

        const regex = new OriginalRegExp(pattern, flags);
        stats.regexCacheMisses++;

        // LRU eviction
        if (regexCache.size >= CACHE_MAX_SIZE) {
            const firstKey = regexCache.keys().next().value;
            regexCache.delete(firstKey);
        }
        regexCache.set(key, regex);

        return regex;
    };

    // Inherit prototype so instanceof works
    Cached.prototype = OriginalRegExp.prototype;

    // Copy static properties ($1-$9, input, etc.)
    for (const prop of Object.getOwnPropertyNames(OriginalRegExp)) {
        if (prop === 'prototype' || prop === 'length' || prop === 'name') continue;
        try {
            const desc = Object.getOwnPropertyDescriptor(OriginalRegExp, prop);
            if (desc) Object.defineProperty(Cached, prop, desc);
        } catch { /* skip non-configurable */ }
    }

    // Fix instanceof
    Object.defineProperty(Cached, Symbol.hasInstance, {
        value: (inst) => inst instanceof OriginalRegExp,
    });

    window.RegExp = Cached;
    console.debug(`${LOG_PREFIX} RegExp cache enabled`);
}

function disableRegexCache() {
    if (!OriginalRegExp) return;
    window.RegExp = OriginalRegExp;
    OriginalRegExp = null;
    regexCache.clear();
    console.debug(`${LOG_PREFIX} RegExp cache disabled`);
}

// ===================== Optimization 3+4: CSS Containment & Content Visibility =====================

const CONTAINMENT_STYLE_ID = 'perf-opt-containment';

/**
 * Inject a <style> element that adds CSS containment and content-visibility
 * to chat messages.
 *
 * - `contain: layout style` makes each .mes an independent layout context,
 *   so updating one message (e.g. during streaming) doesn't trigger reflow
 *   of every other message in the chat container.
 *
 * - `content-visibility: auto` tells the browser to skip rendering messages
 *   that are scrolled out of the viewport. For long chats (100+ messages)
 *   this dramatically reduces layout, paint, and compositing costs.
 *
 * - `contain-intrinsic-size: auto 200px` provides an estimated height for
 *   off-screen messages so the scrollbar remains stable.
 *
 * Note: content-visibility: auto is only applied to messages that are at
 * least 5 from the bottom (via :nth-last-child). The last few messages
 * always render at their true height, preventing scroll jumping during
 * swipes and re-rolls — which only affect the bottom of the chat.
 */
function enableCSSContainment() {
    if (document.getElementById(CONTAINMENT_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = CONTAINMENT_STYLE_ID;
    style.textContent = `
        #chat .mes {
            contain: layout style;
        }
        #chat .mes:nth-last-child(n+5) {
            content-visibility: auto;
            contain-intrinsic-size: auto 200px;
        }
    `;
    document.head.appendChild(style);
    console.debug(`${LOG_PREFIX} CSS containment enabled`);
}

function disableCSSContainment() {
    const el = document.getElementById(CONTAINMENT_STYLE_ID);
    if (el) {
        el.remove();
        console.debug(`${LOG_PREFIX} CSS containment disabled`);
    }
}

// ===================== Optimization 5: Streaming CSS Mode =====================

/**
 * Add `perf-streaming` class to <body> during streaming. CSS rules in
 * style.css use this class to disable GPU-heavy effects (backdrop-filter,
 * box-shadow, transitions, filter) while the AI is generating.
 *
 * Effects are restored instantly when the class is removed after generation.
 */
function enableStreamingCSSMode() {
    document.body.classList.add('perf-streaming');
}

function disableStreamingCSSMode() {
    document.body.classList.remove('perf-streaming');
}

// ===================== Event Handlers =====================

function onGenerationStarted(type) {
    const settings = getSettings();
    if (!settings.enabled) return;

    // Don't optimize quiet/background generations
    if (type === 'quiet') return;

    isGenerating = true;
    console.debug(`${LOG_PREFIX} Generation started`);
}

function onStreamTokenReceived() {
    const settings = getSettings();
    if (!settings.enabled || !isGenerating) return;

    // Disable regex on first streaming token — this confirms streaming is active.
    // We don't disable on GENERATION_STARTED because that also fires for
    // non-streaming generation where regex should run normally.
    if (!regexDisabled) {
        disableRegexForStreaming();
        regexDisabled = true;

        // Optimization 5: reduce visual effects during streaming
        if (settings.reduceStreamingEffects) {
            enableStreamingCSSMode();
        }
    }
}

function onGenerationEnded() {
    if (!isGenerating) return;
    isGenerating = false;

    if (!regexDisabled) return;
    regexDisabled = false;

    // Restore regex — this fires INSIDE onFinishStreaming, BEFORE the final
    // onProgressStreaming(true) call. So the final processing will have regex
    // enabled and produce the correct output.
    restoreRegexAfterStreaming();

    // Restore visual effects
    disableStreamingCSSMode();

    // Safety re-render after a short delay, in case the event ordering changes
    // in future SillyTavern versions
    setTimeout(() => {
        rerenderLastMessage();
        console.debug(`${LOG_PREFIX} Generation ended — regex restored`);
    }, 100);
}

function onGenerationStopped() {
    if (!isGenerating) return;
    isGenerating = false;

    if (!regexDisabled) return;
    regexDisabled = false;

    restoreRegexAfterStreaming();
    disableStreamingCSSMode();
    setTimeout(() => {
        rerenderLastMessage();
        console.debug(`${LOG_PREFIX} Generation stopped — regex restored`);
    }, 100);
}

// ===================== Settings UI =====================

function createSettingsUI() {
    const settings = getSettings();

    const html = `
    <div id="perf-optimizer-settings" class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>Performance Optimizer</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content" style="display: none;">
            <div class="perf-opt-desc">
                通过延迟和缓存策略减少 AI 流式输出期间的 CPU/GPU 浪费，
                提升酒馆整体流畅度。
            </div>

            <div class="perf-opt-item">
                <label for="perf_opt_enabled">
                    <input type="checkbox" id="perf_opt_enabled"
                        ${settings.enabled ? 'checked' : ''} />
                    启用性能优化器
                </label>
            </div>

            <hr />

            <div class="perf-opt-item">
                <label for="perf_opt_defer_regex">
                    <input type="checkbox" id="perf_opt_defer_regex"
                        ${settings.deferRegexDuringStreaming ? 'checked' : ''} />
                    流式期间延迟正则处理
                </label>
            </div>
            <div class="perf-opt-desc">
                AI 输出时跳过所有正则脚本的执行，等响应结束后一次性处理。
                消除最大的 CPU 瓶颈——每帧重复编译和执行正则。
            </div>

            <div class="perf-opt-item">
                <label for="perf_opt_cache_regex">
                    <input type="checkbox" id="perf_opt_cache_regex"
                        ${settings.cacheRegex ? 'checked' : ''} />
                    缓存正则编译结果
                </label>
            </div>
            <div class="perf-opt-desc">
                缓存已编译的正则表达式，相同 pattern 不再重复编译。
                对整个酒馆都有效，不仅限于流式输出。
            </div>

            <div class="perf-opt-item">
                <label for="perf_opt_css_containment">
                    <input type="checkbox" id="perf_opt_css_containment"
                        ${settings.cssContainment ? 'checked' : ''} />
                    CSS 渲染隔离
                </label>
            </div>
            <div class="perf-opt-desc">
                隔离每条消息的布局计算，更新一条消息不会触发整个聊天区域重排。
                同时跳过屏幕外消息的渲染，长对话受益显著。
            </div>

            <div class="perf-opt-item">
                <label for="perf_opt_reduce_effects">
                    <input type="checkbox" id="perf_opt_reduce_effects"
                        ${settings.reduceStreamingEffects ? 'checked' : ''} />
                    流式期间降低视觉特效
                </label>
            </div>
            <div class="perf-opt-desc">
                AI 输出时临时关闭模糊、阴影、过渡动画等 GPU 密集特效，
                响应结束后立即恢复。
            </div>

            <div class="perf-opt-stats" id="perf_opt_stats">
                <i>统计数据将在首次生成后显示。</i>
            </div>

            <div class="perf-opt-author">
                金瓜瓜@gua.guagua.uk
            </div>
        </div>
    </div>`;

    $('#extensions_settings2').append(html);

    // Settings event listeners
    $('#perf_opt_enabled').on('change', function () {
        settings.enabled = this.checked;
        saveSettingsDebounced();
    });

    $('#perf_opt_defer_regex').on('change', function () {
        settings.deferRegexDuringStreaming = this.checked;
        saveSettingsDebounced();
    });

    $('#perf_opt_cache_regex').on('change', function () {
        settings.cacheRegex = this.checked;
        if (this.checked) {
            enableRegexCache();
        } else {
            disableRegexCache();
        }
        saveSettingsDebounced();
    });

    $('#perf_opt_css_containment').on('change', function () {
        settings.cssContainment = this.checked;
        if (this.checked) {
            enableCSSContainment();
        } else {
            disableCSSContainment();
        }
        saveSettingsDebounced();
    });

    $('#perf_opt_reduce_effects').on('change', function () {
        settings.reduceStreamingEffects = this.checked;
        saveSettingsDebounced();
    });

    // Drawer toggle is handled globally by SillyTavern's core click handler
    // on '.inline-drawer-toggle' — no need to bind our own.
}

function updateStatsUI() {
    const statsEl = document.getElementById('perf_opt_stats');
    if (!statsEl) return;

    const lines = [
        '<b>本次会话统计：</b>',
        `正则延迟：${stats.regexSkipped} 次生成`,
    ];

    if (OriginalRegExp) {
        const total = stats.regexCacheHits + stats.regexCacheMisses;
        const hitRate = total > 0 ? ((stats.regexCacheHits / total) * 100).toFixed(1) : '0';
        lines.push(`正则缓存：${stats.regexCacheHits}/${total} 命中 (${hitRate}%)，${regexCache.size} 条缓存`);
    }

    statsEl.innerHTML = lines.join('<br>');
}

// ===================== Initialization =====================

(function init() {
    try {
        const settings = getSettings();

        createSettingsUI();

        // Core event hooks
        eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);
        eventSource.on(event_types.STREAM_TOKEN_RECEIVED, onStreamTokenReceived);
        eventSource.on(event_types.GENERATION_ENDED, () => {
            onGenerationEnded();
            updateStatsUI();
        });
        eventSource.on(event_types.GENERATION_STOPPED, () => {
            onGenerationStopped();
            updateStatsUI();
        });

        // Enable regex cache on startup
        if (settings.enabled && settings.cacheRegex) {
            enableRegexCache();
        }

        // Enable CSS containment on startup
        if (settings.enabled && settings.cssContainment) {
            enableCSSContainment();
        }

        console.log(`${LOG_PREFIX} Loaded — enabled=${settings.enabled}, deferRegex=${settings.deferRegexDuringStreaming}, cacheRegex=${settings.cacheRegex}, cssContainment=${settings.cssContainment}, reduceEffects=${settings.reduceStreamingEffects}`);
    } catch (err) {
        console.error(`${LOG_PREFIX} Failed to initialize — SillyTavern will continue normally.`, err);
    }
})();
