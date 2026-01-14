// background.js

chrome.runtime.onInstalled.addListener(() => {
    console.log('Word Collector Extension installed.');
    chrome.storage.local.get(['collectedWords'], (result) => {
        if (!result.collectedWords) {
            chrome.storage.local.set({ collectedWords: {} });
        }
    });
});

// Listen for messages from content scripts or options page
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'speak') {
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
        Promise.allSettled([
            fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${word}`).then(r => r.ok ? r.json() : null),
            fetch(`https://dict.youdao.com/suggest?q=${word}&num=1&doctype=json`).then(r => r.ok ? r.json() : null)
        ]).then(results => {
            const engData = (results[0].status === 'fulfilled' && results[0].value)
                ? (Array.isArray(results[0].value) ? results[0].value[0] : results[0].value)
                : null;

            let chinese = '';
            if (results[1].status === 'fulfilled' && results[1].value) {
                const cnJson = results[1].value;
                if (cnJson.data && cnJson.data.entries && cnJson.data.entries[0]) {
                    chinese = cnJson.data.entries[0].explain;
                }
            }
            sendResponse({ engData, chinese });
        }).catch(err => sendResponse({ error: err.toString() }));
        return true; // Keep channel open
    }

    if (request.action === 'translateText') {
        const text = request.text;

        (async () => {
            // Strategy: Try Youdao first (Best for CN users), Fallback to Google
            try {
                const res = await fetch(`https://fanyi.youdao.com/translate?&doctype=json&type=AUTO&i=${encodeURIComponent(text)}`);
                const data = await res.json();

                if (data.translateResult) {
                    // Youdao returns array of paragraphs, each containing array of sentence objects
                    const translation = data.translateResult
                        .map(para => para.map(s => s.tgt).join(''))
                        .join('\n');

                    if (translation) {
                        sendResponse({ translation });
                        return;
                    }
                }
            } catch (e) {
                console.warn("Youdao translation failed, switching to Google...", e);
            }

            // Fallback: Google Translate
            try {
                const res = await fetch(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=zh-CN&dt=t&q=${encodeURIComponent(text)}`);
                const data = await res.json();
                const translation = data[0].map(s => s[0]).join('');
                sendResponse({ translation });
            } catch (err) {
                console.error("All translation services failed:", err);
                sendResponse({ error: "Translation services unavailable." });
            }
        })();

        return true; // Keep channel open
    }

    // Maintain connection
    return true;
});

// Storage synchronization is handled directly by content scripts via chrome.storage.onChanged
