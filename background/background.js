// background.js

chrome.runtime.onInstalled.addListener(() => {
    chrome.storage.local.get(['collectedWords'], (result) => {
        if (!result.collectedWords) {
            chrome.storage.local.set({ collectedWords: {} });
        }
    });
});

const responseCache = new Map();
const inFlightRequests = new Map();
const CACHE_MAX_ENTRIES = 200;

function cacheGet(key) {
    const item = responseCache.get(key);
    if (!item) return null;
    if (item.expiresAt <= Date.now()) {
        responseCache.delete(key);
        return null;
    }
    responseCache.delete(key);
    responseCache.set(key, item);
    return item.value;
}

function cacheSet(key, value, ttlMs) {
    responseCache.set(key, { value, expiresAt: Date.now() + ttlMs });
    while (responseCache.size > CACHE_MAX_ENTRIES) {
        const oldestKey = responseCache.keys().next().value;
        responseCache.delete(oldestKey);
    }
}

function withInFlight(key, fn) {
    const existing = inFlightRequests.get(key);
    if (existing) return existing;
    const p = Promise.resolve()
        .then(fn)
        .finally(() => {
            inFlightRequests.delete(key);
        });
    inFlightRequests.set(key, p);
    return p;
}

// Listen for messages from content scripts or options page
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'speak') {
        chrome.tts.stop();
        chrome.tts.speak(request.word, {
            lang: 'en-US',
            rate: 0.9,
            pitch: 1.0,
            volume: 1.0,
            onEvent: (event) => {
                if (event.type === 'error') {
                    console.error('TTS Error:', event.errorMessage);
                }
            }
        });
        sendResponse({ status: 'speaking' });
        return true;
    }

    if (request.action === 'lookupWord') {
        const word = request.word;
        
        // 1. Get Settings
        chrome.storage.local.get(['apiSettings'], async (result) => {
            const settings = result.apiSettings || {};
            const provider = settings.provider || 'default'; // default = web scraping

            // If using Professional Provider for lookup, we might want to use it for definition too?
            // Actually, DictionaryAPI is very good for English definitions (phonetics, audio).
            // Users usually want "Professional" for the CHINESE translation part.
            // So we will keep DictionaryAPI for English data, but replace Youdao Suggest with Professional API if configured.
            
            // Parallel fetch: English Data (Free) + Chinese Data (Provider)
            
            try {
                const providerKey = buildProviderKey(provider, settings);
                const cacheKey = `lookupWord:${providerKey}:${word}`;
                const cached = cacheGet(cacheKey);
                if (cached) {
                    sendResponse(cached);
                    return;
                }

                const value = await withInFlight(cacheKey, async () => {
                    const engPromise = fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${word}`)
                        .then(r => r.ok ? r.json() : null)
                        .then(data => (Array.isArray(data) ? data[0] : data));

                    let cnPromise;

                    if (provider === 'openai' && settings.openai && settings.openai.key) {
                        cnPromise = translateWithOpenAI(word, settings.openai);
                    } else if (provider === 'youdao' && settings.youdao && settings.youdao.appId) {
                        cnPromise = translateWithYoudaoOfficial(word, settings.youdao);
                    } else if (provider === 'deepl' && settings.deepl && settings.deepl.key) {
                        cnPromise = translateWithDeepL(word, settings.deepl);
                    } else {
                        cnPromise = fetch(`https://dict.youdao.com/suggest?q=${word}&num=1&doctype=json`)
                            .then(r => r.ok ? r.json() : null)
                            .then(data => {
                                if (data && data.data && data.data.entries && data.data.entries[0]) {
                                    return data.data.entries[0].explain;
                                }
                                return '';
                            });
                    }

                    const [engData, chinese] = await Promise.all([engPromise, cnPromise]);
                    return { provider, engData, chinese };
                });

                cacheSet(cacheKey, value, 60 * 60 * 1000);
                sendResponse(value);

            } catch (err) {
                console.error('Lookup failed', err);
                sendResponse({ error: err.toString() });
            }
        });
        return true; // Keep channel open
    }

    if (request.action === 'translateText') {
        const text = request.text;

        chrome.storage.local.get(['apiSettings'], async (result) => {
            const settings = result.apiSettings || {};
            const provider = settings.provider || 'default';

            try {
                const providerKey = buildProviderKey(provider, settings);
                const cacheKey = `translateText:${providerKey}:${truncateCacheText(text)}`;
                const cached = cacheGet(cacheKey);
                if (cached) {
                    sendResponse(cached);
                    return;
                }

                const value = await withInFlight(cacheKey, async () => {
                    let translation = '';

                    if (provider === 'openai' && settings.openai && settings.openai.key) {
                        translation = await translateWithOpenAI(text, settings.openai);
                    } else if (provider === 'youdao' && settings.youdao && settings.youdao.appId) {
                        translation = await translateWithYoudaoOfficial(text, settings.youdao);
                    } else if (provider === 'deepl' && settings.deepl && settings.deepl.key) {
                        translation = await translateWithDeepL(text, settings.deepl);
                    } else {
                        translation = await translateWithWeb(text);
                    }

                    return { provider, translation };
                });
                cacheSet(cacheKey, value, 15 * 60 * 1000);
                sendResponse(value);
            } catch (err) {
                console.error("Translation failed:", err);
                // Fallback to Web if Professional fails? 
                // Maybe better to show error so user knows key is wrong.
                // But for "User Experience", maybe fallback is better.
                // Let's fallback only if provider was default, otherwise return error to let user know config is bad.
                if (provider !== 'default') {
                     sendResponse({ error: `Provider Error: ${err.message}. Check Settings.` });
                } else {
                     sendResponse({ error: "Translation unavailable." });
                }
            }
        });

        return true; // Keep channel open
    }

    if (request.action === 'enhancePopup') {
        const kind = request.kind;
        const text = request.text;
        const context = request.context || '';

        chrome.storage.local.get(['apiSettings', 'uiSettings'], async (result) => {
            const settings = result.apiSettings || {};
            const uiSettings = result.uiSettings || {};
            const provider = settings.provider || 'default';

            if (provider !== 'openai') {
                sendResponse({ provider, error: 'Enhance requires OpenAI provider' });
                return;
            }
            if (!uiSettings.enableEnhance) {
                sendResponse({ provider, error: 'Enhance disabled' });
                return;
            }
            if (kind !== 'word' && kind !== 'sentence') {
                sendResponse({ provider, error: 'Invalid kind' });
                return;
            }

            try {
                const providerKey = buildProviderKey(provider, settings);
                const cacheKey = `enhance:${kind}:${providerKey}:${truncateCacheText(`${text}\n${context}`)}`;
                const cached = cacheGet(cacheKey);
                if (cached) {
                    sendResponse(cached);
                    return;
                }

                const value = await withInFlight(cacheKey, async () => {
                    const enhanced = await enhanceWithOpenAI(kind, text, context, settings.openai || {});
                    return { provider, enhanced };
                });

                cacheSet(cacheKey, value, 30 * 60 * 1000);
                sendResponse(value);
            } catch (err) {
                sendResponse({ provider, error: err?.message || String(err) });
            }
        });

        return true;
    }

    // Maintain connection
    return true;
});

// Storage synchronization is handled directly by content scripts via chrome.storage.onChanged

// --- Translation Services ---

async function translateWithWeb(text) {
    // Strategy: Try Youdao first (Best for CN users), Fallback to Google
    try {
        const res = await fetch(`https://fanyi.youdao.com/translate?&doctype=json&type=AUTO&i=${encodeURIComponent(text)}`);
        const data = await res.json();

        if (data.translateResult) {
            return data.translateResult
                .map(para => para.map(s => s.tgt).join(''))
                .join('\n');
        }
    } catch (e) {
        console.warn("Youdao web translation failed, switching to Google...", e);
    }

    // Fallback: Google Translate
    try {
        const res = await fetch(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=zh-CN&dt=t&q=${encodeURIComponent(text)}`);
        const data = await res.json();
        return data[0].map(s => s[0]).join('');
    } catch (err) {
        console.error("All translation services failed:", err);
        throw new Error("All web services failed");
    }
}

async function translateWithOpenAI(text, config) {
    const apiKey = config.key;
    const model = config.model || 'gpt-3.5-turbo';
    const apiHost = normalizeHttpsHost(config.host) || 'https://api.openai.com';

    // Simple Prompt
    const messages = [
        { role: "system", content: "You are a professional translator. Translate the following English text to Simplified Chinese. Only output the translation, no explanations." },
        { role: "user", content: text }
    ];

    const res = await fetch(`${apiHost}/v1/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
            model: model,
            messages: messages,
            temperature: 0.3
        })
    });

    if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error?.message || 'OpenAI API Error');
    }

    const data = await res.json();
    return data.choices[0].message.content.trim();
}

async function translateWithYoudaoOfficial(text, config) {
    const appKey = config.appId;
    const appSecret = config.appSecret;
    if (!appKey || !appSecret) throw new Error('Youdao AppID/AppSecret missing');

    const salt = crypto.randomUUID();
    const curtime = Math.floor(Date.now() / 1000).toString();
    const signStr = `${appKey}${truncateYoudaoInput(text)}${salt}${curtime}${appSecret}`;
    const sign = await sha256Hex(signStr);

    const body = new URLSearchParams({
        q: text,
        from: 'auto',
        to: 'zh-CHS',
        appKey,
        salt,
        sign,
        signType: 'v3',
        curtime
    });

    const res = await fetch('https://openapi.youdao.com/api', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body
    });

    if (!res.ok) throw new Error(`Youdao HTTP ${res.status}`);
    const data = await res.json();
    if (data.errorCode && data.errorCode !== '0') {
        throw new Error(`Youdao Error ${data.errorCode}${data.errorMessage ? `: ${data.errorMessage}` : ''}`);
    }
    if (Array.isArray(data.translation) && data.translation.length > 0) {
        return data.translation.join('\n').trim();
    }
    throw new Error('No translation returned from Youdao');
}

async function translateWithDeepL(text, config) {
    const authKey = config.key;
    const isPro = config.type === 'pro';
    const apiHost = isPro ? 'https://api.deepl.com/v2' : 'https://api-free.deepl.com/v2';

    const res = await fetch(`${apiHost}/translate`, {
        method: 'POST',
        headers: {
            'Authorization': `DeepL-Auth-Key ${authKey}`,
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
            text: text,
            target_lang: 'ZH'
        })
    });

    if (!res.ok) {
        // DeepL error handling
        if (res.status === 403) throw new Error('DeepL Authorization Failed');
        if (res.status === 456) throw new Error('DeepL Quota Exceeded');
        throw new Error(`DeepL Error: ${res.statusText}`);
    }

    const data = await res.json();
    if (data.translations && data.translations.length > 0) {
        return data.translations[0].text;
    }
    throw new Error('No translation returned from DeepL');
}

async function enhanceWithOpenAI(kind, text, context, config) {
    const apiKey = config.key;
    if (!apiKey) throw new Error('OpenAI API Key missing');
    const model = config.model || 'gpt-3.5-turbo';
    const apiHost = normalizeHttpsHost(config.host) || 'https://api.openai.com';

    const payload = kind === 'word'
        ? {
            schema: 'wc.v1.word',
            word: text,
            context
        }
        : {
            schema: 'wc.v1.sentence',
            text,
            context
        };

    const messages = [
        {
            role: 'system',
            content: 'Return JSON only. No markdown, no extra text. Keep arrays short. Use Simplified Chinese for explanations.'
        },
        {
            role: 'user',
            content: `Generate professional translation helper info as JSON for this input:\n${JSON.stringify(payload)}\n\nIf schema is wc.v1.word, include: synonyms_en[], collocations_en[], forms_en[], notes_zh.\nIf schema is wc.v1.sentence, include: alternatives_zh[{style, text}], grammar_zh[], keywords_en[].`
        }
    ];

    const res = await fetch(`${apiHost}/v1/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
            model,
            messages,
            temperature: 0.2
        })
    });

    if (!res.ok) {
        const err = await res.json().catch(() => null);
        throw new Error(err?.error?.message || 'OpenAI API Error');
    }

    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content || '';
    const parsed = safeJsonParse(content);
    if (!parsed) throw new Error('Failed to parse enhance JSON');
    return sanitizeEnhanceResult(kind, parsed);
}

function normalizeHttpsHost(input) {
    if (!input) return '';
    const raw = String(input).trim().replace(/\/+$/, '');
    if (!raw) return '';
    try {
        const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
        if (url.protocol !== 'https:') return '';
        return `${url.protocol}//${url.host}`;
    } catch {
        return '';
    }
}

function truncateYoudaoInput(q) {
    const str = String(q ?? '');
    const len = str.length;
    if (len <= 20) return str;
    return `${str.slice(0, 10)}${len}${str.slice(len - 10)}`;
}

async function sha256Hex(input) {
    const data = new TextEncoder().encode(String(input));
    const hash = await crypto.subtle.digest('SHA-256', data);
    return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function buildProviderKey(provider, settings) {
    if (provider === 'openai') {
        const host = normalizeHttpsHost(settings.openai?.host) || 'https://api.openai.com';
        const model = settings.openai?.model || 'gpt-3.5-turbo';
        return `openai:${host}:${model}`;
    }
    if (provider === 'deepl') {
        const type = settings.deepl?.type || 'free';
        return `deepl:${type}`;
    }
    if (provider === 'youdao') {
        const appId = settings.youdao?.appId || '';
        return `youdao:${appId}`;
    }
    return 'default';
}

function truncateCacheText(text) {
    const str = String(text ?? '').trim();
    if (str.length <= 220) return str;
    return `${str.slice(0, 120)}\u0000${str.length}\u0000${str.slice(-80)}`;
}

function safeJsonParse(text) {
    const raw = String(text || '').trim();
    if (!raw) return null;
    try {
        return JSON.parse(raw);
    } catch {
        const start = raw.indexOf('{');
        const end = raw.lastIndexOf('}');
        if (start >= 0 && end > start) {
            try {
                return JSON.parse(raw.slice(start, end + 1));
            } catch {
                return null;
            }
        }
        return null;
    }
}

function sanitizeEnhanceResult(kind, obj) {
    const safe = (v) => String(v ?? '').trim();
    const safeArr = (arr, maxLen) => Array.isArray(arr) ? arr.map(safe).filter(Boolean).slice(0, maxLen) : [];

    if (kind === 'word') {
        return {
            synonyms_en: safeArr(obj.synonyms_en, 10),
            collocations_en: safeArr(obj.collocations_en, 10),
            forms_en: safeArr(obj.forms_en, 10),
            notes_zh: safe(obj.notes_zh).slice(0, 220)
        };
    }

    const alternatives = Array.isArray(obj.alternatives_zh)
        ? obj.alternatives_zh.slice(0, 4).map((x) => ({
            style: safe(x?.style).slice(0, 16),
            text: safe(x?.text).slice(0, 220)
        })).filter(x => x.text)
        : [];

    return {
        alternatives_zh: alternatives,
        grammar_zh: safeArr(obj.grammar_zh, 6).map(s => s.slice(0, 120)),
        keywords_en: safeArr(obj.keywords_en, 10)
    };
}
