/**
 * Performance Optimizer - SillyTavern Extension
 *
 * Optimizes streaming performance by:
 * 1. Deferring regex processing until streaming completes
 * 2. Caching compiled RegExp objects to avoid repeated compilation
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
                Reduces CPU waste during AI streaming by deferring heavy
                processing to after generation completes.
            </div>

            <div class="perf-opt-item">
                <label for="perf_opt_enabled">
                    <input type="checkbox" id="perf_opt_enabled"
                        ${settings.enabled ? 'checked' : ''} />
                    Enable Performance Optimizer
                </label>
            </div>

            <hr />

            <div class="perf-opt-item">
                <label for="perf_opt_defer_regex">
                    <input type="checkbox" id="perf_opt_defer_regex"
                        ${settings.deferRegexDuringStreaming ? 'checked' : ''} />
                    Defer regex during streaming
                </label>
            </div>
            <div class="perf-opt-desc">
                Skips all regex script execution during streaming frames.
                Regex is applied once after the response completes. This
                eliminates the biggest CPU bottleneck — repeated regex
                compilation and execution on incomplete text every frame.
            </div>

            <div class="perf-opt-item">
                <label for="perf_opt_cache_regex">
                    <input type="checkbox" id="perf_opt_cache_regex"
                        ${settings.cacheRegex ? 'checked' : ''} />
                    Cache RegExp compilation
                </label>
            </div>
            <div class="perf-opt-desc">
                Caches compiled regular expressions so identical patterns
                aren't recompiled on every use. Benefits the entire app,
                not just streaming.
            </div>

            <div class="perf-opt-stats" id="perf_opt_stats">
                <i>Stats will appear after the first generation.</i>
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

    // Drawer toggle is handled globally by SillyTavern's core click handler
    // on '.inline-drawer-toggle' — no need to bind our own.
}

function updateStatsUI() {
    const statsEl = document.getElementById('perf_opt_stats');
    if (!statsEl) return;

    const lines = [
        '<b>Session stats:</b>',
        `Regex deferred: ${stats.regexSkipped} generation(s)`,
    ];

    if (OriginalRegExp) {
        const total = stats.regexCacheHits + stats.regexCacheMisses;
        const hitRate = total > 0 ? ((stats.regexCacheHits / total) * 100).toFixed(1) : '0';
        lines.push(`RegExp cache: ${stats.regexCacheHits}/${total} hits (${hitRate}%), ${regexCache.size} entries`);
    }

    statsEl.innerHTML = lines.join('<br>');
}

// ===================== Initialization =====================

(function init() {
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

    console.log(`${LOG_PREFIX} Loaded — enabled=${settings.enabled}, deferRegex=${settings.deferRegexDuringStreaming}, cacheRegex=${settings.cacheRegex}`);
})();
