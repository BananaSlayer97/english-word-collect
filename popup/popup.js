document.addEventListener('DOMContentLoaded', async () => {
    // 1. Fetch Stats
    const result = await chrome.storage.local.get(['collectedWords']);
    const allWords = result.collectedWords || {};
    const totalCount = Object.keys(allWords).length;

    // Calculate Today's Count
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayTs = todayStart.getTime();

    const todayCount = Object.values(allWords).filter(w => w.addedAt >= todayTs).length;

    document.getElementById('total-count').innerText = totalCount;
    document.getElementById('today-count').innerText = todayCount;

    // 2. Button Actions
    document.getElementById('open-library').addEventListener('click', () => {
        chrome.runtime.openOptionsPage();
    });

    document.getElementById('open-study').addEventListener('click', () => {
        chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html') }, (tab) => {
            // Slight delay to ensure tab loads before sending message (optional, usually options.js handles view state)
            // Ideally option.js reads URL params or hash. 
            // For now simplest is we just open options page. 
            // To auto-switch to study mode, we could use a URL hash like options.html#study
        });
    });
});
