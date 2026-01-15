// content.js

let selectedText = '';
let popup = null;
let currentAudio = null;
let highlightTimeoutId = null;
let lastHighlightState = new Map();
let popupPinned = false;

// Initialize: highlight existing words on load
function initHighlighting() {
    chrome.storage.local.get(['collectedWords'], (result) => {
        if (result.collectedWords) {
            highlightWordsOnPage(result.collectedWords);
            lastHighlightState = buildHighlightState(result.collectedWords);
        }
    });
}

// Ensure DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initHighlighting);
} else {
    initHighlighting();
}

// Observe dynamic content changes (SPA support)
const observer = new MutationObserver((mutations) => {
    let shouldUpdate = false;
    for (const mutation of mutations) {
        if (mutation.addedNodes.length > 0) {
            shouldUpdate = true;
            break;
        }
    }
    // Debounce the update
    if (shouldUpdate) {
        if (highlightTimeoutId) clearTimeout(highlightTimeoutId);
        highlightTimeoutId = setTimeout(initHighlighting, 1000);
    }
});

observer.observe(document.body, {
    childList: true,
    subtree: true
});

// Use capture to potentially catch events before other listeners
document.addEventListener('mouseup', handleMouseUp);

function handleMouseUp(event) {
    if (popup && popup.contains(event.target)) {
        event.stopPropagation();
        return;
    }

    const selection = window.getSelection().toString().trim();

    // Minimum 2 chars, maximum 1000 for sanity
    if (selection && selection.length >= 2 && selection.length <= 1000) {
        selectedText = selection;

        // Context Capture: Try to get the surrounding sentence
        let contextSentence = '';
        try {
            const anchorNode = window.getSelection().anchorNode;
            if (anchorNode && anchorNode.parentElement) {
                const fullText = anchorNode.parentElement.innerText || anchorNode.textContent;
                // Simple sentence splitter: match sentence containing the selection
                // Split by . ! ? but keep delimiters. 
                const sentences = fullText.match(/[^\.!\?]+[\.!\?]+/g) || [fullText];
                contextSentence = sentences.find(s => s.includes(selectedText)) || fullText;
                contextSentence = contextSentence.trim();
                // Limit context length
                if (contextSentence.length > 300) contextSentence = contextSentence.substring(0, 300) + '...';
            }
        } catch (e) {
        }

        showPopup(event.pageX, event.pageY, selectedText, contextSentence);
    } else {
        if (!popupPinned) removePopup();
    }
}

async function showPopup(x, y, text, context = '') {
    if (popup && popup.getAttribute('data-text') === text) return;
    removePopup();
    popupPinned = false;

    const isSingleWord = !text.includes(' ') && text.length < 30;
    const normalizedWord = isSingleWord ? text.toLowerCase().replace(/[^a-z-]/g, '') : '';
    const storageKey = isSingleWord ? normalizedWord : text.toLowerCase();
    if (isSingleWord && !normalizedWord) return;

    popup = document.createElement('div');
    popup.className = 'wc-popup-container';
    if (isSingleWord) popup.classList.add('wc-single-word');
    popup.setAttribute('data-text', text);
    const requestId = crypto.randomUUID();
    popup.dataset.requestId = requestId;

    const viewportWidth = window.innerWidth;
    const popupWidth = 320;
    let left = x;
    if (x + popupWidth > viewportWidth) left = viewportWidth - popupWidth - 20;

    popup.style.left = `${left}px`;
    popup.style.top = `${y + 15}px`;
    popup.innerHTML = `<div style="text-align:center; padding: 20px; color: #6b7280;">正在解析 / Translating...</div>`;

    popup.addEventListener('mouseup', (e) => e.stopPropagation());
    popup.addEventListener('mousedown', (e) => e.stopPropagation());
    document.body.appendChild(popup);

    try {
        const ui = await getUiSettings();
        let engData = null;
        let chineseTranslation = '';
        let phonetic = '';
        let meaningsHtml = '';
        let audioUrl = null;
        let audioObj = null;
        let provider = 'default';
        let enhanced = null;

        if (isSingleWord) {
            const word = normalizedWord;
            // Delegate to background script
            const result = await new Promise(resolve => {
                chrome.runtime.sendMessage({ action: 'lookupWord', word: word }, (response) => {
                    resolve(response || {});
                });
            });
            if (!popup || popup.getAttribute('data-text') !== text || popup.dataset.requestId !== requestId) return;

            if (result.error) console.warn("Lookup warning:", result.error);

            engData = result.engData;
            chineseTranslation = result.chinese;
            provider = result.provider || provider;

            if (engData) {
                phonetic = engData.phonetic || (engData.phonetics && engData.phonetics.find(p => p.text)?.text) || '';
                
                // Extract Audio
                if (engData.phonetics) {
                    const pWithAudio = engData.phonetics.find(p => p.audio && p.audio.length > 0);
                    if (pWithAudio) {
                        audioUrl = pWithAudio.audio;
                        // Preload
                        audioObj = new Audio(audioUrl);
                        audioObj.preload = 'auto';
                        audioObj.load(); 
                    }
                }

                meaningsHtml = renderWordMeanings(engData, ui);
            }
        } else {
            // Delegate sentence translation
            const result = await new Promise(resolve => {
                chrome.runtime.sendMessage({ action: 'translateText', text: text }, (response) => {
                    resolve(response || {});
                });
            });
            if (!popup || popup.getAttribute('data-text') !== text || popup.dataset.requestId !== requestId) return;

            if (result.error) throw new Error(result.error);

            chineseTranslation = result.translation;
            provider = result.provider || provider;
            if (chineseTranslation) {
                meaningsHtml = `
                    <div class="wc-sentence-translation">${escapeHtml(chineseTranslation)}</div>
                    <div class="wc-sentence-original">${escapeHtml(text)}</div>
                `;
            }
        }

        if (!chineseTranslation && !meaningsHtml) throw new Error('Not found');

        // Format Chinese Definition: Translate abbreviations
        if (chineseTranslation && isSingleWord) {
            chineseTranslation = formatChineseDefinition(chineseTranslation);
        }

        const storage = await chrome.storage.local.get(['collectedWords']);
        const collectedWords = storage.collectedWords || {};
        const storedItem = collectedWords[storageKey];
        const isCollected = !!storedItem;
        const isMastered = storedItem && storedItem.mastered;

        const providerLabel = formatProviderLabel(provider);

        popup.innerHTML = `
            <div class="wc-header">
                <div class="wc-word-info">
                    <h2 class="wc-word-text">${escapeHtml(isSingleWord ? (normalizedWord || text) : '句子翻译 / Sentence')}</h2>
                    ${isSingleWord ? `
                    <div class="wc-phonetic-row">
                        <span class="wc-phonetic-text">${escapeHtml(phonetic)}</span>
                        <button class="wc-audio-btn" id="wc-play-audio" title="播放发音">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>
                        </button>
                    </div>` : `
                    <button class="wc-audio-btn" id="wc-play-audio" title="播放全文">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>
                    </button>
                    `}
                </div>
                <div class="wc-header-actions">
                    <span class="wc-provider-badge" title="当前翻译服务商">${escapeHtml(providerLabel)}</span>
                    <button class="wc-icon-btn" id="wc-pin-btn" title="固定弹窗">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M14 9l7-7"></path><path d="M14 9l-4 4"></path><path d="M3 21l9-9"></path><path d="M15 3l6 6"></path></svg>
                    </button>
                    <button class="wc-icon-btn" id="wc-copy-btn" title="复制译文/释义">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                    </button>
                    <button id="wc-heart-btn" class="wc-heart-btn ${isCollected ? 'active' : ''}" title="${isCollected ? '已收藏' : '加入词库'}">
                        <svg class="heart-icon" viewBox="0 0 24 24" fill="${isCollected ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2">
                            <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path>
                        </svg>
                    </button>
                </div>
            </div>
            <div class="wc-content-scroll">
                ${meaningsHtml}
                ${(isSingleWord && chineseTranslation) ? `
                    <div class="wc-meaning-block" style="margin-top: 15px; padding-top: 15px; border-top: 1px dashed rgba(0,0,0,0.1);">
                        <div class="wc-pos" style="background:#dbeafe; color:#1e40af;">中文</div>
                        <div class="wc-definition" style="font-weight: 600; color:#1e3a8a;">${escapeHtml(chineseTranslation)}</div>
                    </div>` : ''}
                ${ui.showContext && context ? `
                    <div class="wc-context">
                        <span class="wc-context-label">Context</span>
                        <div class="wc-context-text">${escapeHtml(context)}</div>
                    </div>` : ''}
                <div class="wc-expand">
                    <button class="wc-expand-btn" id="wc-expand-btn" aria-expanded="${ui.defaultExpanded ? 'true' : 'false'}">
                        ${ui.defaultExpanded ? '收起更多' : '更多'}
                    </button>
                </div>
                <div class="wc-more ${ui.defaultExpanded ? 'open' : ''}" id="wc-more">
                    <div class="wc-more-section" id="wc-more-static"></div>
                    <div class="wc-more-section" id="wc-more-enhanced"></div>
                </div>
            </div>
            <div id="wc-status-container">
                ${isCollected ? `<div class="wc-status"><span class="wc-dot"></span> ${isMastered ? '已归档' : '已收藏'}</div>` : ''}
            </div>
        `;

        const playBtn = document.getElementById('wc-play-audio');
        playBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            
            // Visual feedback
            const originalIcon = playBtn.innerHTML;
            playBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" class="wc-spin"><path d="M12 2v4m0 12v4M4.93 4.93l2.83 2.83m8.48 8.48l2.83 2.83M2 12h4m12 0h4M4.93 19.07l2.83-2.83m8.48-8.48l2.83-2.83"></path></svg>`;
            
            const restoreIcon = () => { playBtn.innerHTML = originalIcon; };
            stopCurrentAudio();

            const playWithFallback = () => {
                // Tier 1: Real Audio (Preloaded)
                if (audioObj) {
                    audioObj.currentTime = 0;
                    currentAudio = audioObj;
                    audioObj.play()
                        .then(() => restoreIcon())
                        .catch(err => {
                            console.warn("Real audio failed, trying Youdao...", err);
                            tryYoudao();
                        });
                    return;
                }
                tryYoudao();
            };

            const tryYoudao = () => {
                // Tier 2: Youdao TTS
                // Note: Youdao works best for words and short phrases.
                const youdaoUrl = `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(text)}&type=2`;
                const ydAudio = new Audio(youdaoUrl);
                currentAudio = ydAudio;
                
                // Timeout fallback
                const timeoutId = setTimeout(() => {
                    console.warn("Online audio timeout, falling back to local TTS");
                    fallbackToLocal();
                }, 1500); // 1.5s timeout as promised

                ydAudio.onplay = () => {
                    clearTimeout(timeoutId);
                    restoreIcon();
                };

                ydAudio.onerror = () => {
                    clearTimeout(timeoutId);
                    fallbackToLocal();
                };

                ydAudio.play().catch(() => {
                    clearTimeout(timeoutId);
                    fallbackToLocal();
                });
            };

            const fallbackToLocal = () => {
                // Tier 3: Chrome TTS
                chrome.runtime.sendMessage({ action: 'speak', word: text });
                restoreIcon();
            };

            playWithFallback();
        });

        const heartBtn = document.getElementById('wc-heart-btn');
        heartBtn.addEventListener('click', async (e) => {
            e.stopPropagation();

            // Animation
            heartBtn.classList.add('active');
            const svg = heartBtn.querySelector('svg');
            svg.setAttribute('fill', 'currentColor');

            const def = isSingleWord ? (engData?.meanings[0].definitions[0].definition || '') : text;
            await saveWord(isSingleWord ? (normalizedWord || text) : text, def, engData || {}, chineseTranslation, isSingleWord, context);

            // Update status text
            const statusContainer = document.getElementById('wc-status-container');
            statusContainer.innerHTML = `<div class="wc-status"><span class="wc-dot"></span> 已收藏</div>`;

            // Optional: Shake effect if already saved? No, just keep as "Saved" state.
        });

        const pinBtn = document.getElementById('wc-pin-btn');
        pinBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            popupPinned = !popupPinned;
            pinBtn.classList.toggle('active', popupPinned);
        });

        const copyBtn = document.getElementById('wc-copy-btn');
        copyBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const copyText = isSingleWord
                ? (chineseTranslation || collectPrimaryDefinitions(engData) || '')
                : (chineseTranslation || '');
            if (!copyText) return;
            await copyToClipboard(copyText);
            flashButton(copyBtn);
        });

        const expandBtn = document.getElementById('wc-expand-btn');
        const more = document.getElementById('wc-more');
        const staticContainer = document.getElementById('wc-more-static');
        const enhancedContainer = document.getElementById('wc-more-enhanced');

        const renderMoreStatic = () => {
            if (isSingleWord) {
                staticContainer.innerHTML = renderWordMoreStatic(engData, ui);
            } else {
                staticContainer.innerHTML = '';
            }
        };

        const renderMoreEnhanced = async () => {
            if (!ui.enableEnhance) return;
            if (provider !== 'openai') return;
            if (!enhancedContainer) return;
            enhancedContainer.innerHTML = `<div class="wc-more-loading">正在生成增强信息…</div>`;
            const response = await new Promise(resolve => {
                chrome.runtime.sendMessage({ action: 'enhancePopup', kind: isSingleWord ? 'word' : 'sentence', text: isSingleWord ? normalizedWord : text, context }, (resp) => resolve(resp || {}));
            });
            if (!popup || popup.getAttribute('data-text') !== text || popup.dataset.requestId !== requestId) return;
            if (response.error) {
                enhancedContainer.innerHTML = `<div class="wc-more-error">${escapeHtml(String(response.error))}</div>`;
                return;
            }
            enhanced = response.enhanced || null;
            enhancedContainer.innerHTML = renderEnhanced(kindForEnhance(isSingleWord), enhanced);
        };

        const openMore = async () => {
            more.classList.add('open');
            expandBtn.setAttribute('aria-expanded', 'true');
            expandBtn.innerText = '收起更多';
            renderMoreStatic();
            await renderMoreEnhanced();
        };

        const closeMore = () => {
            more.classList.remove('open');
            expandBtn.setAttribute('aria-expanded', 'false');
            expandBtn.innerText = '更多';
        };

        expandBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (more.classList.contains('open')) {
                closeMore();
            } else {
                await openMore();
            }
        });

        if (ui.defaultExpanded) {
            await openMore();
        }

        // Click outside to close is handled by global listener (if implemented) or we rely on user clicking away.
        // But previously there was a global click listener to close it? 
        // Let's check handleMouseUp or similar. 
        // Yes, handleMouseUp calls removePopup() if clicking outside.
    } catch (error) {
        console.error("Translation Error:", error);
        popup.innerHTML = `
            <div class="wc-word-text">解析失败</div>
            <div style="margin: 12px 0; font-size: 14px; color: #6b7280;">暂时无法翻译此段内容，请检查网络。</div>
        `;
        // No buttons to listen to here either, or maybe keep close button for error?
        // User asked to remove buttons. Auto-close is safer.
        setTimeout(() => {
            // Optional: Auto close on error after delay? 
        }, 3000);
    }
}

function removePopup() {
    if (popup) {
        popup.remove();
        popup = null;
    }
}

async function saveWord(text, definition, fullData, chineseTranslation, isSingleWord, context) {
    const originalText = String(text ?? '');
    const key = text.toLowerCase();
    const result = await chrome.storage.local.get(['collectedWords']);
    const words = result.collectedWords || {};

    if (!words[key]) {
        words[key] = {
            originalText,
            definition,
            chinese: chineseTranslation || '',
            phonetic: isSingleWord ? ((fullData && fullData.phonetic) || (fullData && fullData.phonetics && fullData.phonetics.find(p => p.text)?.text) || '') : '',
            context: context || '',
            addedAt: Date.now(),
            mastered: false,
            isSentence: !isSingleWord,
            count: 1
        };

        await chrome.storage.local.set({ collectedWords: words });

        const btn = document.getElementById('wc-collect-btn');
        if (btn) {
            btn.innerText = '已在库中';
            btn.disabled = true;
            btn.style.background = '#059669';
        }

        const statusContainer = document.getElementById('wc-status-container');
        if (statusContainer) {
            statusContainer.innerHTML = '<div class="wc-status"><span class="wc-dot"></span> 已收藏</div>';
        }

        if (isSingleWord) {
            highlightWordsOnPage({ [key]: words[key] });
        }
    }
}

function highlightWordsOnPage(wordsMap) {
    // Only highlight single words for performance and clarity
    const wordsToHighlight = Object.keys(wordsMap).filter(k => !wordsMap[k].isSentence && !k.includes(' '));
    if (wordsToHighlight.length === 0) return;

    const sortedWords = wordsToHighlight.sort((a, b) => b.length - a.length).map(escapeRegExp);
    const regex = new RegExp(`\\b(${sortedWords.join('|')})\\b`, 'gi');

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
    const textNodes = [];
    let node;
    while (node = walker.nextNode()) {
        const parent = node.parentElement;
        if (!parent) continue;
        if (['script', 'style', 'textarea', 'input', 'code', 'noscript'].includes(parent.tagName.toLowerCase())) continue;
        if (parent.isContentEditable) continue;
        if (parent.closest('.wc-popup-container') || parent.classList.contains('wc-highlighted-word')) continue;
        textNodes.push(node);
    }

    textNodes.forEach(textNode => {
        const text = textNode.nodeValue;
        if (!textNode.parentNode) return;

        if (regex.test(text)) {
            const fragment = document.createDocumentFragment();
            let lastIndex = 0;
            let match;

            regex.lastIndex = 0;
            while ((match = regex.exec(text)) !== null) {
                fragment.appendChild(document.createTextNode(text.substring(lastIndex, match.index)));
                const span = document.createElement('span');
                const matchedWord = match[0].toLowerCase();
                const wordData = wordsMap[matchedWord];

                span.className = 'wc-highlighted-word' + (wordData?.mastered ? ' wc-mastered' : '');
                span.title = wordData?.chinese || wordData?.definition || '';
                span.textContent = match[0];

                fragment.appendChild(span);
                lastIndex = regex.lastIndex;
            }
            fragment.appendChild(document.createTextNode(text.substring(lastIndex)));

            if (textNode.parentNode) {
                textNode.parentNode.replaceChild(fragment, textNode);
            }
        }
    });
}

function formatChineseDefinition(text) {
    if (!text) return '';
    const map = {
        'n\\.': '名词',
        'v\\.': '动词',
        'adj\\.': '形容词',
        'adv\\.': '副词',
        'prep\\.': '介词',
        'conj\\.': '连词',
        'pron\\.': '代词',
        'art\\.': '冠词',
        'num\\.': '数词',
        'int\\.': '感叹词',
        'vt\\.': '及物动词',
        'vi\\.': '不及物动词',
        'aux\\.': '助动词',
        'pl\\.': '复数',
        'sing\\.': '单数',
        'pref\\.': '前缀',
        'suff\\.': '后缀',
        'web\\.': '网络',
        'abbr\\.': '缩写'
    };

    let formatted = text;
    for (const [key, value] of Object.entries(map)) {
        formatted = formatted.replace(new RegExp(key, 'gi'), `${value} `);
    }
    return formatted;
}

chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.collectedWords) {
        const newWords = changes.collectedWords.newValue || {};
        const newState = buildHighlightState(newWords);

        const removed = [];
        const changed = [];
        const added = [];

        for (const [key, fp] of lastHighlightState.entries()) {
            const nextFp = newState.get(key);
            if (!nextFp) {
                removed.push(key);
            } else if (nextFp !== fp) {
                changed.push(key);
            }
        }

        for (const key of newState.keys()) {
            if (!lastHighlightState.has(key)) added.push(key);
        }

        if (removed.length > 0 || changed.length > 0) {
            cleanupHighlights();
            highlightWordsOnPage(newWords);
        } else if (added.length > 0) {
            const subset = {};
            added.forEach(k => {
                subset[k] = newWords[k];
            });
            highlightWordsOnPage(subset);
        }

        lastHighlightState = newState;
    }
});

function escapeHtml(value) {
    const str = String(value ?? '');
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function escapeRegExp(value) {
    return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cleanupHighlights() {
    const nodes = document.querySelectorAll('span.wc-highlighted-word');
    nodes.forEach(span => {
        const text = document.createTextNode(span.textContent || '');
        span.replaceWith(text);
    });
}

function stopCurrentAudio() {
    if (!currentAudio) return;
    try {
        currentAudio.pause();
        currentAudio.currentTime = 0;
    } catch {
    } finally {
        currentAudio = null;
    }
}

function buildHighlightState(wordsMap) {
    const map = new Map();
    Object.entries(wordsMap || {}).forEach(([key, value]) => {
        if (!value || value.isSentence || key.includes(' ')) return;
        const fp = `${value.mastered ? '1' : '0'}\u0000${value.chinese || ''}\u0000${value.definition || ''}`;
        map.set(key, fp);
    });
    return map;
}

async function getUiSettings() {
    const result = await chrome.storage.local.get(['uiSettings']);
    const stored = result.uiSettings || {};
    return {
        showContext: stored.showContext !== false,
        showExamples: stored.showExamples !== false,
        enableEnhance: !!stored.enableEnhance,
        defaultExpanded: !!stored.defaultExpanded
    };
}

function formatProviderLabel(provider) {
    if (provider === 'openai') return 'OpenAI';
    if (provider === 'deepl') return 'DeepL';
    if (provider === 'youdao') return '有道';
    return '默认';
}

function collectPrimaryDefinitions(engData) {
    if (!engData || !Array.isArray(engData.meanings)) return '';
    const defs = [];
    engData.meanings.slice(0, 2).forEach(m => {
        const def = m?.definitions?.[0]?.definition;
        if (def) defs.push(def);
    });
    return defs.join('\n');
}

function renderWordMeanings(engData, ui) {
    if (!engData || !Array.isArray(engData.meanings)) return '';
    let html = '';
    engData.meanings.slice(0, 3).forEach(m => {
        const def = m?.definitions?.[0] || null;
        if (!def) return;
        const example = ui.showExamples ? (def.example || '') : '';
        html += `
            <div class="wc-meaning-block">
                <span class="wc-pos">${escapeHtml(m.partOfSpeech || '')}</span>
                <div class="wc-definition">${escapeHtml(def.definition || '')}</div>
                ${example ? `<div class="wc-example">${escapeHtml(example)}</div>` : ''}
            </div>
        `;
    });
    return html;
}

function renderWordMoreStatic(engData, ui) {
    if (!engData || !Array.isArray(engData.meanings)) return '';
    const defs = [];
    engData.meanings.slice(0, 4).forEach(m => {
        const def = m?.definitions?.[0] || null;
        if (!def) return;
        defs.push({
            pos: m.partOfSpeech || '',
            definition: def.definition || '',
            example: ui.showExamples ? (def.example || '') : ''
        });
    });
    if (defs.length === 0) return '';
    return defs.map(d => `
        <div class="wc-more-item">
            <div class="wc-more-title">${escapeHtml(d.pos)}</div>
            <div class="wc-more-text">${escapeHtml(d.definition)}</div>
            ${d.example ? `<div class="wc-more-sub">${escapeHtml(d.example)}</div>` : ''}
        </div>
    `).join('');
}

function renderEnhanced(kind, enhanced) {
    if (!enhanced) return '';
    if (kind === 'word') {
        const chips = (arr) => (arr || []).map(x => `<span class="wc-chip">${escapeHtml(x)}</span>`).join('');
        const synonyms = chips(enhanced.synonyms_en);
        const collocations = chips(enhanced.collocations_en);
        const forms = chips(enhanced.forms_en);
        const notes = enhanced.notes_zh ? `<div class="wc-more-text">${escapeHtml(enhanced.notes_zh)}</div>` : '';
        return `
            ${synonyms ? `<div class="wc-more-item"><div class="wc-more-title">同义替换</div><div class="wc-chip-row">${synonyms}</div></div>` : ''}
            ${collocations ? `<div class="wc-more-item"><div class="wc-more-title">常见搭配</div><div class="wc-chip-row">${collocations}</div></div>` : ''}
            ${forms ? `<div class="wc-more-item"><div class="wc-more-title">词形变化</div><div class="wc-chip-row">${forms}</div></div>` : ''}
            ${notes ? `<div class="wc-more-item"><div class="wc-more-title">提示</div>${notes}</div>` : ''}
        `;
    }

    const alt = Array.isArray(enhanced.alternatives_zh) ? enhanced.alternatives_zh : [];
    const grammar = Array.isArray(enhanced.grammar_zh) ? enhanced.grammar_zh : [];
    const keywords = Array.isArray(enhanced.keywords_en) ? enhanced.keywords_en : [];
    const altHtml = alt.map(a => `<div class="wc-more-item"><div class="wc-more-title">${escapeHtml(a.style || '版本')}</div><div class="wc-more-text">${escapeHtml(a.text || '')}</div></div>`).join('');
    const grammarHtml = grammar.length ? `<div class="wc-more-item"><div class="wc-more-title">语法要点</div><div class="wc-more-list">${grammar.map(x => `<div class="wc-more-li">${escapeHtml(x)}</div>`).join('')}</div></div>` : '';
    const keywordHtml = keywords.length ? `<div class="wc-more-item"><div class="wc-more-title">关键词</div><div class="wc-chip-row">${keywords.map(k => `<span class="wc-chip">${escapeHtml(k)}</span>`).join('')}</div></div>` : '';
    return `${altHtml}${grammarHtml}${keywordHtml}`;
}

function kindForEnhance(isSingleWord) {
    return isSingleWord ? 'word' : 'sentence';
}

async function copyToClipboard(text) {
    const value = String(text ?? '');
    try {
        await navigator.clipboard.writeText(value);
        return;
    } catch {
    }
    const ta = document.createElement('textarea');
    ta.value = value;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    ta.style.top = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
}

function flashButton(btn) {
    if (!btn) return;
    btn.classList.add('flash');
    setTimeout(() => btn.classList.remove('flash'), 500);
}
