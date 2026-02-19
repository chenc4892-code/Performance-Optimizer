/**
 * Performance Optimizer - SillyTavern Extension
 *
 * Optimizes streaming performance by:
 * 1. Deferring regex processing until streaming completes
 * 2. Caching compiled RegExp objects to avoid repeated compilation
 * 3. CSS containment — isolates message layout/paint so updates don't cascade
 * 4. content-visibility: auto — browser skips rendering off-screen messages
 * 5. Streaming CSS mode — disables heavy visual effects (blur, shadow) during streaming
 * 6. Lightweight HTML/iframe renderer — replaces heavy JS-Slash-Runner rendering
 * 7. Tab-switch scroll preservation — prevents scroll jumping on mobile
 * 8. Global blur suppression — disables backdrop-filter for mobile battery savings
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

const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
    || (navigator.maxTouchPoints > 1 && window.innerWidth < 1024);

const defaultSettings = {
    enabled: true,
    deferRegexDuringStreaming: true,
    cacheRegex: true,
    cssContainment: true,
    reduceStreamingEffects: true,
    lightHtmlRenderer: true,
    preventScrollJump: true,
    globalBlurSuppression: isMobile,
};

// ===================== State =====================

let isGenerating = false;
let regexDisabled = false;
let regexWasAlreadyDisabled = false;
let stats = {
    regexSkipped: 0,
    regexCacheHits: 0,
    regexCacheMisses: 0,
    iframesCreated: 0,
    iframesDestroyed: 0,
    scrollRestored: 0,
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
 * extensions (and our own iframe renderer) can post-process the message.
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

// ===================== Optimization 6: Lightweight HTML/iframe Renderer =====================

/**
 * A lightweight alternative to JS-Slash-Runner's heavy iframe rendering.
 *
 * Instead of loading jQuery + Vue + Tailwind + FontAwesome into every iframe,
 * this renderer creates minimal iframes with just the HTML content and a tiny
 * height-adjustment script (~15 lines). Combined with IntersectionObserver
 * for lazy loading, this reduces per-iframe overhead from ~500KB to ~1KB.
 *
 * Detection uses the same logic as JS-Slash-Runner: checks for 'html>',
 * '<head>', or '<body' in <pre><code> blocks.
 */

/** Map of placeholder element -> { htmlContent, iframe, mesId } */
const iframePlaceholders = new Map();
let iframeObserver = null;

/** postMessage handler — receives height updates from sandboxed iframes */
function onIframeResizeMessage(e) {
    if (!e.data || e.data.type !== 'perf-opt-resize') return;
    for (const [, data] of iframePlaceholders) {
        if (data.iframe && data.iframe.contentWindow === e.source) {
            data.iframe.style.height = e.data.height + 'px';
            break;
        }
    }
}
window.addEventListener('message', onIframeResizeMessage);

function isHTMLContent(text) {
    return ['html>', '<head>', '<body'].some(tag => text.includes(tag));
}

function buildIframeSrcdoc(htmlContent) {
    return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
html,body{margin:0;padding:0;overflow:hidden;max-width:100%;}
</style>
</head><body>
${htmlContent}
<script>
(function(){
    // window.frameElement is null in sandboxed iframes — use postMessage instead
    function sendHeight(){
        var h=document.body.scrollHeight;
        if(h>0) window.parent.postMessage({type:'perf-opt-resize',height:h},'*');
    }
    new ResizeObserver(function(){requestAnimationFrame(sendHeight);}).observe(document.body);
    if(document.readyState==='loading'){
        document.addEventListener('DOMContentLoaded',sendHeight);
    } else {
        sendHeight();
    }
    window.addEventListener('load',sendHeight);
})();
</script>
</body></html>`;
}

function createIframeForPlaceholder(placeholder) {
    const data = iframePlaceholders.get(placeholder);
    if (!data || data.iframe) return;

    const iframe = document.createElement('iframe');
    iframe.className = 'perf-opt-iframe';
    iframe.frameBorder = '0';
    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
    iframe.srcdoc = buildIframeSrcdoc(data.htmlContent);

    placeholder.textContent = '';
    placeholder.appendChild(iframe);
    data.iframe = iframe;
    stats.iframesCreated++;
    console.debug(`${LOG_PREFIX} Iframe created (total: ${stats.iframesCreated})`);
}

function destroyIframeForPlaceholder(placeholder) {
    const data = iframePlaceholders.get(placeholder);
    if (!data || !data.iframe) return;

    data.iframe.srcdoc = '';
    data.iframe.remove();
    data.iframe = null;
    placeholder.textContent = 'HTML（滚动到此处加载）';
    stats.iframesDestroyed++;
}

function getIframeObserver() {
    if (iframeObserver) return iframeObserver;

    iframeObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
            const placeholder = entry.target;
            if (!iframePlaceholders.has(placeholder)) continue;

            if (entry.isIntersecting) {
                createIframeForPlaceholder(placeholder);
            } else {
                destroyIframeForPlaceholder(placeholder);
            }
        }
    }, {
        root: document.getElementById('chat'),
        rootMargin: '300px 0px',
    });

    return iframeObserver;
}

function processMessageForIframes(mesId) {
    const settings = getSettings();
    if (!settings.enabled || !settings.lightHtmlRenderer) return;

    const mesText = document.querySelector(`#chat .mes[mesid="${mesId}"] .mes_text`);
    if (!mesText) return;

    // Clean up any stale placeholders from a previous render of this message
    // (happens after edits/swipes when .mes_text innerHTML is fully replaced)
    cleanupPlaceholdersForMessage(mesId);

    const codeBlocks = mesText.querySelectorAll('pre code');
    for (const code of codeBlocks) {
        const text = code.textContent || '';
        if (!isHTMLContent(text)) continue;

        const pre = code.closest('pre');
        if (!pre || pre.dataset.perfOptProcessed) continue;
        pre.dataset.perfOptProcessed = 'true';

        // Decode HTML entities that DOMPurify/Showdown may have introduced
        const tmp = document.createElement('textarea');
        tmp.innerHTML = text;
        const htmlContent = tmp.value;

        // Create placeholder
        const placeholder = document.createElement('div');
        placeholder.className = 'perf-opt-iframe-placeholder';
        placeholder.textContent = 'HTML（加载中...）';

        iframePlaceholders.set(placeholder, { htmlContent, iframe: null, mesId });

        pre.replaceWith(placeholder);

        // Register with IntersectionObserver
        getIframeObserver().observe(placeholder);
    }
}

function processAllMessagesForIframes() {
    const settings = getSettings();
    if (!settings.enabled || !settings.lightHtmlRenderer) return;

    const messages = document.querySelectorAll('#chat .mes');
    for (const mes of messages) {
        const mesId = mes.getAttribute('mesid');
        if (mesId !== null) {
            processMessageForIframes(mesId);
        }
    }
}

function cleanupPlaceholdersForMessage(mesId) {
    const toRemove = [];
    for (const [placeholder, data] of iframePlaceholders) {
        if (String(data.mesId) !== String(mesId)) continue;
        if (iframeObserver) iframeObserver.unobserve(placeholder);
        if (data.iframe) {
            data.iframe.srcdoc = '';
            data.iframe.remove();
        }
        // Remove orphaned placeholder from DOM (it's detached after innerHTML replace)
        if (placeholder.isConnected) placeholder.remove();
        toRemove.push(placeholder);
    }
    for (const p of toRemove) iframePlaceholders.delete(p);
    if (toRemove.length > 0) {
        console.debug(`${LOG_PREFIX} Cleaned up ${toRemove.length} stale placeholder(s) for mesId ${mesId}`);
    }
}

function cleanupAllIframes() {
    if (iframeObserver) {
        iframeObserver.disconnect();
        iframeObserver = null;
    }
    for (const [, data] of iframePlaceholders) {
        if (data.iframe) {
            data.iframe.srcdoc = '';
            data.iframe.remove();
        }
    }
    iframePlaceholders.clear();
    console.debug(`${LOG_PREFIX} All iframes cleaned up`);
}

// ===================== Optimization 7: Tab-switch Scroll Preservation =====================

/**
 * When the user switches away from the browser (e.g. checking another app
 * on mobile), the browser may recalculate layout for content-visibility: auto
 * elements, causing scroll position to jump when returning.
 *
 * This module saves the scroll position (as distance-from-bottom) when the
 * page becomes hidden, and restores it after two animation frames when the
 * page becomes visible again — giving the browser time to settle layout.
 *
 * We use distance-from-bottom because the last few messages don't use
 * content-visibility (thanks to :nth-last-child), so their heights are
 * stable and the bottom reference point is reliable.
 */

let savedScrollInfo = null;

function onVisibilityChange() {
    const settings = getSettings();
    if (!settings.enabled || !settings.preventScrollJump) return;

    const chatElement = document.getElementById('chat');
    if (!chatElement) return;

    if (document.hidden) {
        // Save scroll position relative to bottom
        savedScrollInfo = {
            scrollTop: chatElement.scrollTop,
            scrollHeight: chatElement.scrollHeight,
            clientHeight: chatElement.clientHeight,
            distanceFromBottom: chatElement.scrollHeight - chatElement.scrollTop - chatElement.clientHeight,
        };
        console.debug(`${LOG_PREFIX} Scroll position saved (distFromBottom: ${savedScrollInfo.distanceFromBottom.toFixed(0)}px)`);
    } else {
        if (!savedScrollInfo) return;
        const info = savedScrollInfo;
        savedScrollInfo = null;

        // Wait two frames for layout to stabilize after tab restore
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                const newScrollTop = chatElement.scrollHeight - chatElement.clientHeight - info.distanceFromBottom;
                chatElement.scrollTop = Math.max(0, newScrollTop);
                stats.scrollRestored++;
                console.debug(`${LOG_PREFIX} Scroll position restored (distFromBottom: ${info.distanceFromBottom.toFixed(0)}px)`);
            });
        });
    }
}

function enableScrollPreservation() {
    document.addEventListener('visibilitychange', onVisibilityChange);
    console.debug(`${LOG_PREFIX} Scroll preservation enabled`);
}

function disableScrollPreservation() {
    document.removeEventListener('visibilitychange', onVisibilityChange);
    savedScrollInfo = null;
    console.debug(`${LOG_PREFIX} Scroll preservation disabled`);
}

// ===================== Optimization 8: Global Blur Suppression =====================

/**
 * SillyTavern's style.css has 26+ backdrop-filter: blur() declarations.
 * On mobile, these cause sustained GPU compositing even when not streaming.
 * This option permanently removes all blur effects for significant battery
 * savings. Unlike the streaming-only mode, this stays active all the time.
 */

const BLUR_SUPPRESS_STYLE_ID = 'perf-opt-no-blur';

function enableGlobalBlurSuppression() {
    if (document.getElementById(BLUR_SUPPRESS_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = BLUR_SUPPRESS_STYLE_ID;
    style.textContent = `
        body.perf-no-blur *,
        body.perf-no-blur *::before,
        body.perf-no-blur *::after {
            backdrop-filter: none !important;
            -webkit-backdrop-filter: none !important;
        }
    `;
    document.head.appendChild(style);
    document.body.classList.add('perf-no-blur');
    console.debug(`${LOG_PREFIX} Global blur suppression enabled`);
}

function disableGlobalBlurSuppression() {
    document.body.classList.remove('perf-no-blur');
    const el = document.getElementById(BLUR_SUPPRESS_STYLE_ID);
    if (el) {
        el.remove();
        console.debug(`${LOG_PREFIX} Global blur suppression disabled`);
    }
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

            <div class="perf-opt-section-title">流式输出优化</div>

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

            <hr />

            <div class="perf-opt-section-title">HTML 渲染与显示</div>

            <div class="perf-opt-item">
                <label for="perf_opt_light_html">
                    <input type="checkbox" id="perf_opt_light_html"
                        ${settings.lightHtmlRenderer ? 'checked' : ''} />
                    轻量 HTML 渲染
                </label>
            </div>
            <div class="perf-opt-desc">
                用轻量 iframe 渲染消息中的 HTML 代码块，不加载 jQuery/Vue/Tailwind
                等库。配合关闭酒馆助手的渲染模块使用，大幅降低内存和 CPU 占用。
                支持视口懒加载——屏幕外的 iframe 不会被创建。
            </div>

            <hr />

            <div class="perf-opt-section-title">移动端优化</div>

            <div class="perf-opt-item">
                <label for="perf_opt_scroll_preserve">
                    <input type="checkbox" id="perf_opt_scroll_preserve"
                        ${settings.preventScrollJump ? 'checked' : ''} />
                    防止切屏跳滚
                </label>
            </div>
            <div class="perf-opt-desc">
                切出浏览器再回来时，保持聊天滚动位置不变。
                解决 content-visibility 优化导致的切屏后滚动跳跃问题。
            </div>

            <div class="perf-opt-item">
                <label for="perf_opt_no_blur">
                    <input type="checkbox" id="perf_opt_no_blur"
                        ${settings.globalBlurSuppression ? 'checked' : ''} />
                    全局关闭模糊特效
                </label>
            </div>
            <div class="perf-opt-desc">
                永久关闭所有 backdrop-filter 模糊特效（不仅限于流式期间）。
                手机上可显著降低 GPU 负载和耗电。${isMobile ? '（已检测到移动端，默认开启）' : ''}
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

    $('#perf_opt_light_html').on('change', function () {
        settings.lightHtmlRenderer = this.checked;
        if (this.checked) {
            processAllMessagesForIframes();
        } else {
            cleanupAllIframes();
        }
        saveSettingsDebounced();
    });

    $('#perf_opt_scroll_preserve').on('change', function () {
        settings.preventScrollJump = this.checked;
        if (this.checked) {
            enableScrollPreservation();
        } else {
            disableScrollPreservation();
        }
        saveSettingsDebounced();
    });

    $('#perf_opt_no_blur').on('change', function () {
        settings.globalBlurSuppression = this.checked;
        if (this.checked) {
            enableGlobalBlurSuppression();
        } else {
            disableGlobalBlurSuppression();
        }
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

    if (stats.iframesCreated > 0) {
        lines.push(`HTML 渲染：${stats.iframesCreated} 个 iframe 创建，${stats.iframesDestroyed} 个已回收`);
        lines.push(`当前活跃：${stats.iframesCreated - stats.iframesDestroyed} 个 iframe`);
    }

    if (stats.scrollRestored > 0) {
        lines.push(`滚动恢复：${stats.scrollRestored} 次`);
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

        // ---- New modules ----

        // Optimization 6: Lightweight HTML renderer
        // Always register listeners; processMessageForIframes checks settings internally.
        eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, (mesId) => {
            processMessageForIframes(mesId);
        });
        eventSource.on(event_types.USER_MESSAGE_RENDERED, (mesId) => {
            processMessageForIframes(mesId);
        });
        // After edit: MESSAGE_UPDATED fires (not CHARACTER_MESSAGE_RENDERED)
        eventSource.on(event_types.MESSAGE_UPDATED, (mesId) => {
            processMessageForIframes(mesId);
        });
        // After swipe: re-render the swiped message
        eventSource.on(event_types.MESSAGE_SWIPED, (mesId) => {
            processMessageForIframes(mesId);
        });
        // When more historical messages load at the top of the chat
        eventSource.on(event_types.MORE_MESSAGES_LOADED, () => {
            processAllMessagesForIframes();
        });
        // Process all messages when a chat is loaded
        eventSource.on(event_types.CHAT_CHANGED, () => {
            cleanupAllIframes();
            // Small delay to let the DOM populate
            setTimeout(() => processAllMessagesForIframes(), 300);
        });

        // Optimization 7: Tab-switch scroll preservation
        if (settings.enabled && settings.preventScrollJump) {
            enableScrollPreservation();
        }

        // Optimization 8: Global blur suppression
        if (settings.enabled && settings.globalBlurSuppression) {
            enableGlobalBlurSuppression();
        }

        console.log(`${LOG_PREFIX} v2.0.0 Loaded — enabled=${settings.enabled}, deferRegex=${settings.deferRegexDuringStreaming}, cacheRegex=${settings.cacheRegex}, cssContainment=${settings.cssContainment}, reduceEffects=${settings.reduceStreamingEffects}, lightHTML=${settings.lightHtmlRenderer}, scrollPreserve=${settings.preventScrollJump}, noBlur=${settings.globalBlurSuppression}`);
    } catch (err) {
        console.error(`${LOG_PREFIX} Failed to initialize — SillyTavern will continue normally.`, err);
    }
})();
