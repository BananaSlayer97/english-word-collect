/* options.js */

let allWords = {};
let studyQueue = [];
let currentCardIndex = -1;
let currentMasteryTab = 'learning'; // 'learning' or 'mastered'
let currentAudio = null;

document.addEventListener('DOMContentLoaded', () => {
    initializeApp();
});

async function initializeApp() {
    await fetchWords();
    setupNavigation();
    setupSearch();
    setupExport();
    setupImport(); // Add Import
    setupSettings(); // Settings Tab
    setupMasteryTabs();
    setupFlashcards();
    setupQuizMode(); // Initialize Quiz
    // renderWordList(); // Moved inside fetchWords callback
    // updateCounts(); // Moved inside fetchWords callback
}

async function fetchWords() {
    return new Promise((resolve) => {
        chrome.storage.local.get(['collectedWords'], (result) => {
            allWords = result.collectedWords || {};
            const migrated = migrateCollectedWords(allWords);
            if (migrated.changed) {
                allWords = migrated.words;
                chrome.storage.local.set({ collectedWords: allWords }, () => {
                    updateCounts();
                    const activeView = document.querySelector('.nav-link.active')?.getAttribute('data-view');
                    if (activeView === 'vocabulary') renderWordList();
                    if (activeView === 'sentences') renderSentencesGrid();
                    initHeatmap();
                    resolve();
                });
                return;
            }

            updateCounts();
            const activeView = document.querySelector('.nav-link.active')?.getAttribute('data-view');
            if (activeView === 'vocabulary') renderWordList();
            if (activeView === 'sentences') renderSentencesGrid();
            initHeatmap();
            resolve();
        });
    });
}

function setupNavigation() {
    const navLinks = document.querySelectorAll('.nav-link');
    navLinks.forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            const viewId = link.getAttribute('data-view');

            navLinks.forEach(i => i.classList.remove('active'));
            link.classList.add('active');

            document.querySelectorAll('.view-section').forEach(view => {
                view.style.display = 'none';
            });
            document.getElementById(`view-${viewId}`).style.display = 'block';

            if (viewId === 'vocabulary') {
                renderWordList();
                updateCounts();
            }
            if (viewId === 'study') startStudyMode();
            if (viewId === 'sentences') renderSentencesGrid();
            if (viewId === 'settings') loadSettingsUI();
        });
    });
}

chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (!changes.collectedWords) return;

    allWords = changes.collectedWords.newValue || {};
    updateCounts();

    const activeView = document.querySelector('.nav-link.active')?.getAttribute('data-view');
    if (activeView === 'vocabulary') renderWordList(document.getElementById('word-search')?.value?.toLowerCase() || '');
    if (activeView === 'sentences') renderSentencesGrid();
    initHeatmap();
});

function setupSearch() {
    const searchInput = document.getElementById('word-search');
    searchInput.addEventListener('input', () => {
        renderWordList(searchInput.value.toLowerCase());
    });
}

function setupMasteryTabs() {
    const tabs = document.querySelectorAll('.tab-btn');
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            tabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            currentMasteryTab = tab.getAttribute('data-status');
            renderWordList(document.getElementById('word-search').value.toLowerCase());
        });
    });
}

function setupExport() {
    document.getElementById('export-json').addEventListener('click', () => {
        const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(allWords, null, 2));
        const downloadAnchorNode = document.createElement('a');
        downloadAnchorNode.setAttribute("href", dataStr);
        downloadAnchorNode.setAttribute("download", "word_collector_pro.json");
        document.body.appendChild(downloadAnchorNode);
        downloadAnchorNode.click();
        downloadAnchorNode.remove();
    });

    document.getElementById('export-csv').addEventListener('click', () => {
        // BOM for Excel
        let csvContent = "\uFEFFWord,Definition,Translation,Phonetic,Context,AddedAt\n";

        Object.entries(allWords).forEach(([word, data]) => {
            const displayWord = (data && data.originalText) ? data.originalText : word;
            const def = (data.definition || '').replace(/"/g, '""');
            const cn = (data.chinese || '').replace(/"/g, '""');
            const ctx = (data.context || '').replace(/"/g, '""');
            const added = formatPreciseDate(data.addedAt);

            csvContent += `"${displayWord.replace(/"/g, '""')}","${def}","${cn}","${(data.phonetic || '').replace(/"/g, '""')}","${ctx}","${added}"\n`;
        });

        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.setAttribute("href", url);
        link.setAttribute("download", "word_collector_pro.csv");
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    });
}

function setupImport() {
    const importBtn = document.getElementById('import-json');
    const fileInput = document.getElementById('import-file');

    if (importBtn && fileInput) {
        importBtn.addEventListener('click', () => {
            fileInput.click();
        });

        fileInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;

            const reader = new FileReader();
            reader.onload = (event) => {
                try {
                    const importedWords = JSON.parse(event.target.result);
                    let importCount = 0;

                    // Merge strategy: Add new words, do not overwrite existing ones (safe)
                    // Or maybe overwrite if 'mastered' is true? 
                    // Let's stick to safe merge: only add missing keys.

                    Object.keys(importedWords).forEach(key => {
                        if (!allWords[key]) {
                            allWords[key] = importedWords[key];
                            importCount++;
                        } else {
                            // Optional: Merge fields if missing? currently simple skip.
                        }
                    });

                    if (importCount > 0) {
                        chrome.storage.local.set({ collectedWords: allWords }, () => {
                            updateCounts();
                            renderWordList();
                            initHeatmap();
                            alert(`Success! Imported ${importCount} new words.`);
                        });
                    } else {
                        alert('No new words found in file.');
                    }

                } catch (err) {
                    console.error('Import error', err);
                    alert('Invalid JSON file.');
                }
                // Reset input
                fileInput.value = '';
            };
            reader.readAsText(file);
        });
    }
}

function formatPreciseDate(timestamp) {
    const d = new Date(timestamp);
    const pad = (n) => n.toString().padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function initHeatmap() {
    const container = document.getElementById('activity-heatmap');
    if (!container) return;
    container.innerHTML = '';

    // 1. Prepare data
    const dailyCounts = {};
    Object.values(allWords).forEach(word => {
        const date = new Date(word.addedAt);
        const dayStr = `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`; // format: YYYY-M-D
        dailyCounts[dayStr] = (dailyCounts[dayStr] || 0) + 1;
    });

    // 2. Generate last 365 days (approx 52 weeks)
    // We want to show a year-like view or at least ~6 months to look nice.
    // Let's go with roughly 6 months (180 days) for now to save space in the compact UI, or 52 weeks if horizontal space allows.
    // Let's do roughly 200 days to fill the width.
    const today = new Date();
    const daysToShow = 210; // ~7 months

    for (let i = daysToShow; i >= 0; i--) {
        const d = new Date();
        d.setDate(today.getDate() - i);

        const dayStr = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
        const count = dailyCounts[dayStr] || 0;

        // Determine level
        let level = 0;
        if (count > 0) level = 1;
        if (count > 2) level = 2;
        if (count > 5) level = 3;
        if (count > 10) level = 4;

        const cell = document.createElement('div');
        cell.className = `heatmap-day level-${level}`;
        cell.dataset.title = `${d.toLocaleDateString()}: ${count} words`;

        container.appendChild(cell);
    }
}

function renderWordList(filter = '') {
    const listContainer = document.getElementById('word-list-compact');
    if (!listContainer) return;

    listContainer.innerHTML = '';

    const wordEntries = Object.entries(allWords)
        .sort((a, b) => b[1].addedAt - a[1].addedAt)
        .filter(([word, data]) => {
            // Exclude sentences from vocabulary list
            if (data.isSentence || word.includes(' ')) return false;

            // Filter by search
            const matchSearch = word.toLowerCase().includes(filter) || (data.chinese && data.chinese.toLowerCase().includes(filter));
            if (!matchSearch) return false;

            // Filter by Mastery Tab
            const isMastered = !!data.mastered;
            return currentMasteryTab === 'mastered' ? isMastered : !isMastered;
        });

    if (wordEntries.length === 0) {
        listContainer.innerHTML = `
            <div style="text-align: center; padding: 60px 0; color: #475569; font-size: 14px;">
                ${filter ? '没有发现匹配内容 / No matches.' : '这里空空如也 / Empty list.'}
            </div>
        `;
        return;
    }

    wordEntries.forEach(([word, data]) => {
        const row = document.createElement('div');
        row.className = 'word-row-compact';

        const displayWord = (data && data.originalText) ? data.originalText : word;
        const timeStr = formatPreciseDate(data.addedAt);
        const masteryActionLabel = data.mastered ? '移回生词本' : '掌握归档';
        const masteryClass = data.mastered ? 'is-mastered' : '';
        const isSentence = data.isSentence || word.includes(' ');
        const contextTooltip = data.context ? `\n\nContext:\n${data.context}` : '';

        row.innerHTML = `
            <div class="cell-word" title="${escapeAttr(`${displayWord}${contextTooltip}`)}">
                ${isSentence ? `<span class="badge-sentence">句子</span>` : ''}
                ${escapeHtml(displayWord)}
            </div>
            <div class="cell-pron">
                <button class="btn-audio-mini" data-word="${escapeAttr(word)}" title="${isSentence ? '播放全文' : '播放发音'}">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>
                </button>
            </div>
            <div class="cell-phonetic">${escapeHtml(isSentence ? '-' : (data.phonetic || '/.../'))}</div>
            <div class="cell-meaning" title="${escapeAttr(data.chinese || data.definition || '')}">${escapeHtml(data.chinese || data.definition || '')}</div>
            <div class="cell-date">${escapeHtml(timeStr)}</div>
            <div class="cell-action">
                <button class="btn-status ${masteryClass}" data-word="${escapeAttr(word)}">
                    ${escapeHtml(masteryActionLabel)}
                </button>
            </div>
        `;

        row.querySelector('.btn-audio-mini').addEventListener('click', (e) => {
            const w = e.currentTarget.dataset.word;
            playAudioWithFallback(w, e.currentTarget);
        });

        row.querySelector('.btn-status').addEventListener('click', (e) => {
            toggleMastery(e.target.dataset.word);
        });

        listContainer.appendChild(row);
    });
}

async function toggleMastery(word) {
    if (allWords[word]) {
        allWords[word].mastered = !allWords[word].mastered;
        await chrome.storage.local.set({ collectedWords: allWords });
        renderWordList(document.getElementById('word-search').value.toLowerCase());
        updateCounts();
    }
}

function updateCounts() {
    const entries = Object.entries(allWords);

    // Split entries into words and sentences
    const words = entries.filter(([w, d]) => !d.isSentence && !w.includes(' '));
    const sentences = entries.filter(([w, d]) => d.isSentence || w.includes(' '));

    const learning = words.filter(([w, d]) => !d.mastered).length;
    const mastered = words.filter(([w, d]) => d.mastered).length;
    const sentenceCount = sentences.length;

    const countLearning = document.getElementById('count-learning');
    const countMastered = document.getElementById('count-mastered');
    const countSentences = document.getElementById('count-sentences');

    if (countLearning) countLearning.innerText = `(${learning})`;
    if (countMastered) countMastered.innerText = `(${mastered})`;
    if (countSentences) countSentences.innerText = `(${sentenceCount})`;
}

// --- Study Mode Logic ---
function setupFlashcards() {
    const card = document.getElementById('study-card');
    if (!card) return;

    card.addEventListener('click', () => {
        card.classList.toggle('is-flipped');
    });

    document.getElementById('study-next').addEventListener('click', (e) => {
        e.stopPropagation();
        showNextCard();
    });
}

function startStudyMode() {
    // Only study SINGLE WORDS in "Learning" status (exclude sentences/context-only tags)
    studyQueue = Object.keys(allWords)
        .filter(word => {
            const data = allWords[word];
            const isSentence = data.isSentence || word.includes(' ');
            return !data.mastered && !isSentence;
        })
        .sort(() => Math.random() - 0.5);

    currentCardIndex = -1;
    showNextCard();
}

function showNextCard() {
    const card = document.getElementById('study-card');
    if (!card) return;

    card.classList.remove('is-flipped');
    currentCardIndex++;

    if (studyQueue.length === 0) {
        document.getElementById('study-word').innerText = "All Set!";
        document.getElementById('study-def').innerText = "当前生词本已空，快去划选新词吧。";
        return;
    }

    if (currentCardIndex >= studyQueue.length) {
        currentCardIndex = 0; // Loop back
    }

    const word = studyQueue[currentCardIndex];
    const data = allWords[word];

    setTimeout(() => {
        document.getElementById('study-word').innerText = word;
        document.getElementById('study-def').innerText = data.chinese || data.definition || "No definition found.";
    }, 200);
}

// --- Quiz Mode Logic ---
let quizScore = 0;
let quizStreak = 0;
let currentQuizTarget = null;
let isQuizActive = false;

function setupQuizMode() {
    // Mode Switching
    const modeBtns = document.querySelectorAll('.mode-btn');
    modeBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
            // UI Toggle
            modeBtns.forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');

            const mode = e.target.dataset.mode;
            document.getElementById('study-flashcard-container').style.display = mode === 'flashcard' ? 'block' : 'none';
            document.getElementById('study-quiz-container').style.display = mode === 'quiz' ? 'block' : 'none';
            document.getElementById('study-spelling-container').style.display = mode === 'spelling' ? 'block' : 'none';

            if (mode === 'quiz') startQuizGame();
            if (mode === 'spelling') startSpellingGame();
        });
    });

    // Audio Hint for Quiz
    document.getElementById('quiz-play-audio').addEventListener('click', (e) => {
        if (currentQuizTarget) {
            playAudioWithFallback(currentQuizTarget, e.currentTarget);
        }
    });

    // Audio Hint for Spelling
    document.getElementById('spelling-play-audio').addEventListener('click', (e) => {
        if (currentSpellingTarget) {
            playAudioWithFallback(currentSpellingTarget, e.currentTarget);
        }
    });

    // Spelling Input Listener
    const spellingInput = document.getElementById('spelling-input');
    spellingInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            checkSpelling();
        }
    });

    spellingInput.addEventListener('input', () => {
        document.getElementById('spelling-feedback').innerText = "";
        spellingInput.style.borderColor = "var(--border)";
    });
}

function startQuizGame() {
    // Only quiz on SINGLE WORDS (exclude sentences)
    const learningWords = Object.keys(allWords).filter(w => {
        const data = allWords[w];
        const isSentence = data.isSentence || w.includes(' ');
        return !data.mastered && !isSentence;
    });

    if (learningWords.length < 4) {
        document.getElementById('quiz-question-word').innerText = "Need more words!";
        document.getElementById('quiz-feedback').innerText = "Collect at least 4 words to start quiz.";
        return;
    }

    // Pick target
    const targetIndex = Math.floor(Math.random() * learningWords.length);
    currentQuizTarget = learningWords[targetIndex];
    const targetData = allWords[currentQuizTarget];

    // Pick 3 distractors
    const distractors = [];
    while (distractors.length < 3) {
        const randIndex = Math.floor(Math.random() * learningWords.length);
        const w = learningWords[randIndex];
        if (w !== currentQuizTarget && !distractors.includes(w)) {
            distractors.push(w);
        }
    }

    // Render Question
    document.getElementById('quiz-question-word').innerText = currentQuizTarget;
    document.getElementById('quiz-feedback').innerText = "";

    // Auto play audio (optional, maybe distracting? let's default off, user clicks)
    // chrome.runtime.sendMessage({ action: 'speak', word: currentQuizTarget });

    // Render Options
    const options = [currentQuizTarget, ...distractors];
    // Shuffle
    options.sort(() => Math.random() - 0.5);

    const container = document.getElementById('quiz-options');
    container.innerHTML = '';

    options.forEach(word => {
        const btn = document.createElement('div');
        btn.className = 'quiz-option-btn';
        btn.dataset.word = word;
        // Show Chinese as options
        const meaning = allWords[word].chinese || allWords[word].definition || 'No definition';
        // Truncate if too long
        btn.innerText = meaning.length > 40 ? meaning.substring(0, 40) + '...' : meaning;

        btn.addEventListener('click', () => checkQuizAnswer(word, btn));
        container.appendChild(btn);
    });
}

function checkQuizAnswer(selectedWord, btnElement) {
    if (isQuizActive) return; // Prevent double clicks
    isQuizActive = true;

    const isCorrect = selectedWord === currentQuizTarget;
    const allBtns = document.querySelectorAll('.quiz-option-btn');

    if (isCorrect) {
        btnElement.classList.add('correct');
        quizScore += 10;
        quizStreak++;
        document.getElementById('quiz-feedback').innerText = "Excellent! 🎉";
        document.getElementById('quiz-feedback').style.color = "#10b981";
    } else {
        btnElement.classList.add('wrong');
        btnElement.classList.add('shake');
        quizStreak = 0;
        document.getElementById('quiz-feedback').innerText = "Oops! Try again.";
        document.getElementById('quiz-feedback').style.color = "#ef4444";

        allBtns.forEach(btn => {
            if (btn.dataset.word === currentQuizTarget) btn.classList.add('correct');
        });
    }

    updateQuizStats();

    // Next question delay
    setTimeout(() => {
        isQuizActive = false;
        startQuizGame();
    }, isCorrect ? 1200 : 2000); // Longer delay for wrong answer to see
}

function updateQuizStats() {
    document.getElementById('quiz-score').innerText = `Score: ${quizScore}`;
    document.getElementById('quiz-streak').innerText = `Streak: 🔥${quizStreak}`;
}

function renderSentencesGrid() {
    const grid = document.getElementById('sentences-grid');
    if (!grid) return;

    grid.innerHTML = '';

    const sentenceEntries = Object.entries(allWords)
        .filter(([word, data]) => data.isSentence || word.includes(' '))
        .sort((a, b) => b[1].addedAt - a[1].addedAt);

    if (sentenceEntries.length === 0) {
        grid.innerHTML = `
            <div style="grid-column: 1/-1; text-align: center; padding: 100px 0; color: var(--text-dim); font-size: 15px;">
                还没有收藏任何精选句子。<br>在页面中划选长句，点击心形图标即可收藏库中。
            </div>
        `;
        return;
    }

    sentenceEntries.forEach(([text, data]) => {
        const card = document.createElement('div');
        card.className = 'sentence-card';

        const timeStr = formatPreciseDate(data.addedAt);
        const originalText = (data && data.originalText) ? data.originalText : text;

        card.innerHTML = `
            <div class="en">${escapeHtml(originalText)}</div>
            <div class="cn">${escapeHtml(data.chinese || '暂无翻译')}</div>
            <div class="meta">
                <div class="date">${escapeHtml(timeStr)}</div>
                <div class="sentence-card-actions">
                    <button class="btn-icon-sm speak-btn" title="朗读">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>
                    </button>
                    <button class="btn-icon-sm copy-btn" title="复制原文">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                    </button>
                    <button class="btn-icon-sm delete-btn delete" title="删除">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                    </button>
                </div>
            </div>
        `;

        // Event Listeners
        card.querySelector('.speak-btn').addEventListener('click', (e) => {
            playAudioWithFallback(originalText, e.currentTarget);
        });

        card.querySelector('.copy-btn').addEventListener('click', () => {
            navigator.clipboard.writeText(originalText).then(() => {
                const icon = card.querySelector('.copy-btn');
                const originalHtml = icon.innerHTML;
                icon.innerHTML = '<span style="font-size:10px;">Done</span>';
                setTimeout(() => icon.innerHTML = originalHtml, 1500);
            });
        });

        card.querySelector('.delete-btn').addEventListener('click', async () => {
            if (confirm('确定要删除这条句子吗？')) {
                delete allWords[text];
                await chrome.storage.local.set({ collectedWords: allWords });
                renderSentencesGrid();
                updateCounts();
            }
        });

        grid.appendChild(card);
    });
}

// --- Spelling Mode Logic ---
let spellingScore = 0;
let spellingStreak = 0;
let currentSpellingTarget = null;

function startSpellingGame() {
    const learningWords = Object.keys(allWords).filter(w => {
        const data = allWords[w];
        const isSentence = data.isSentence || w.includes(' ');
        return !data.mastered && !isSentence;
    });

    const spellingDef = document.getElementById('spelling-def-cn');
    const spellingInput = document.getElementById('spelling-input');

    if (learningWords.length === 0) {
        spellingDef.innerText = "生词本已空 / List Empty";
        spellingInput.disabled = true;
        return;
    }

    // Pick target
    const targetIndex = Math.floor(Math.random() * learningWords.length);
    currentSpellingTarget = learningWords[targetIndex];
    const targetData = allWords[currentSpellingTarget];

    // Reset UI
    spellingDef.innerText = targetData.chinese || targetData.definition || "No definition";
    spellingInput.value = "";
    spellingInput.disabled = false;
    document.getElementById('spelling-feedback').innerText = "";
    document.getElementById('spelling-result-word').style.display = "none";
    spellingInput.focus();

    // Play Audio
    playAudioWithFallback(currentSpellingTarget);
}

function checkSpelling() {
    const input = document.getElementById('spelling-input');
    const userValue = input.value.trim().toLowerCase();
    const correctValue = currentSpellingTarget.toLowerCase();
    const feedback = document.getElementById('spelling-feedback');

    if (userValue === correctValue) {
        // Success
        spellingScore += 10;
        spellingStreak++;
        feedback.innerText = "Correct! ✨";
        feedback.style.color = "#4ade80";
        input.style.borderColor = "#4ade80";
        input.classList.add('success-anim');
        input.disabled = true;

        updateSpellingStats();

        setTimeout(() => {
            input.classList.remove('success-anim');
            startSpellingGame();
        }, 1200);
    } else {
        // Fail
        spellingStreak = 0;
        feedback.innerText = "Keep trying! ✊";
        feedback.style.color = "#f87171";
        input.style.borderColor = "#f87171";
        updateSpellingStats();
        
        setTimeout(() => {
            if (input.value.trim() !== "") {
                 const resultWord = document.getElementById('spelling-result-word');
                 resultWord.innerText = currentSpellingTarget;
                 resultWord.style.display = "block";
            }
        }, 800);
    }
}

function updateSpellingStats() {
    document.getElementById('spelling-score').innerText = `Score: ${spellingScore}`;
    document.getElementById('spelling-streak').innerText = `Streak: 🔥${spellingStreak}`;
}

// --- Audio Helper ---
function playAudioWithFallback(word, btnElement = null) {
    let originalIcon = '';
    let restoreIcon = () => {};

    if (btnElement) {
        originalIcon = btnElement.innerHTML;
        // Simple spinner svg
        btnElement.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" class="wc-spin"><path d="M12 2v4m0 12v4M4.93 4.93l2.83 2.83m8.48 8.48l2.83 2.83M2 12h4m12 0h4M4.93 19.07l2.83-2.83m8.48-8.48l2.83-2.83"></path></svg>`;
        restoreIcon = () => { btnElement.innerHTML = originalIcon; };
    }

    const fallbackToLocal = () => {
        chrome.runtime.sendMessage({ action: 'speak', word: word });
        if (btnElement) restoreIcon();
    };

    // Try Youdao TTS (Tier 2)
    // Note: Use type=2 for US English
    const youdaoUrl = `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(word)}&type=2`;
    const audio = new Audio(youdaoUrl);
    stopCurrentAudio();
    currentAudio = audio;
    
    // Timeout mechanism (1.5s)
    const timeoutId = setTimeout(() => {
        // If it hasn't started playing, cancel and fallback
        fallbackToLocal();
    }, 1500);

    audio.onplay = () => {
        clearTimeout(timeoutId);
        if (btnElement) restoreIcon();
    };

    audio.onerror = () => {
        clearTimeout(timeoutId);
        fallbackToLocal();
    };

    audio.play().catch(err => {
        clearTimeout(timeoutId);
        fallbackToLocal();
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

// --- Settings Logic ---
function setupSettings() {
    const providerSelect = document.getElementById('provider-select');
    if (providerSelect) {
        providerSelect.addEventListener('change', (e) => {
            switchProviderUI(e.target.value);
        });
    }

    document.getElementById('save-settings').addEventListener('click', saveSettings);
}

function loadSettingsUI() {
    chrome.storage.local.get(['apiSettings', 'uiSettings'], (result) => {
        const settings = result.apiSettings || { provider: 'default', openai: {}, youdao: {}, deepl: {} };
        const uiSettings = result.uiSettings || {};
        
        const providerSelect = document.getElementById('provider-select');
        if (providerSelect) {
            providerSelect.value = settings.provider || 'default';
            switchProviderUI(providerSelect.value);
        }

        // OpenAI
        if (settings.openai) {
            document.getElementById('openai-key').value = settings.openai.key || '';
            document.getElementById('openai-model').value = settings.openai.model || 'gpt-3.5-turbo';
            document.getElementById('openai-host').value = settings.openai.host || '';
        }

        // Youdao
        if (settings.youdao) {
            document.getElementById('youdao-appid').value = settings.youdao.appId || '';
            document.getElementById('youdao-secret').value = settings.youdao.appSecret || '';
        }

        // DeepL
        if (settings.deepl) {
            document.getElementById('deepl-key').value = settings.deepl.key || '';
            document.getElementById('deepl-type').value = settings.deepl.type || 'free';
        }

        const showContext = document.getElementById('ui-show-context');
        const showExamples = document.getElementById('ui-show-examples');
        const enableEnhance = document.getElementById('ui-enable-enhance');
        const defaultExpanded = document.getElementById('ui-default-expanded');

        if (showContext) showContext.checked = uiSettings.showContext !== false;
        if (showExamples) showExamples.checked = uiSettings.showExamples !== false;
        if (enableEnhance) enableEnhance.checked = !!uiSettings.enableEnhance;
        if (defaultExpanded) defaultExpanded.checked = !!uiSettings.defaultExpanded;
    });
}

async function saveSettings() {
    const provider = document.getElementById('provider-select')?.value || 'default';
    
    const settings = {
        provider: provider,
        openai: {
            key: document.getElementById('openai-key').value.trim(),
            model: document.getElementById('openai-model').value.trim(),
            host: document.getElementById('openai-host').value.trim()
        },
        youdao: {
            appId: document.getElementById('youdao-appid').value.trim(),
            appSecret: document.getElementById('youdao-secret').value.trim()
        },
        deepl: {
            key: document.getElementById('deepl-key').value.trim(),
            type: document.getElementById('deepl-type').value
        }
    };

    const validation = validateSettings(settings);
    if (!validation.ok) {
        showToast(validation.message, 'error');
        return;
    }

    const permissionOk = await ensureProviderPermissions(settings);
    if (!permissionOk) {
        showToast('需要授权访问该 Host 才能请求接口', 'error');
        return;
    }

    const uiSettings = {
        showContext: document.getElementById('ui-show-context')?.checked !== false,
        showExamples: document.getElementById('ui-show-examples')?.checked !== false,
        enableEnhance: !!document.getElementById('ui-enable-enhance')?.checked,
        defaultExpanded: !!document.getElementById('ui-default-expanded')?.checked
    };

    chrome.storage.local.set({ apiSettings: settings, uiSettings }, () => {
        showToast('已保存，立即生效', 'success');
    });
}

function switchProviderUI(provider) {
    document.querySelectorAll('.config-section').forEach(el => el.style.display = 'none');
    const target = document.getElementById(`config-${provider}`);
    if (target) target.style.display = 'block';
}

function showToast(message, type) {
    const toast = document.getElementById('save-toast');
    const text = document.getElementById('toast-text');
    if (!toast || !text) return;
    text.innerText = message;
    toast.classList.remove('success', 'error');
    toast.classList.add(type);
    toast.classList.add('show');
    setTimeout(() => { toast.classList.remove('show'); }, 3000);
}

function validateSettings(settings) {
    if (settings.provider === 'default') {
        return { ok: true };
    }
    if (settings.provider === 'openai') {
        if (!settings.openai.key) return { ok: false, message: '请填写 OpenAI API Key' };
        if (settings.openai.host && !isValidHttpsHost(settings.openai.host)) return { ok: false, message: 'OpenAI Host 必须为 https:// 域名或完整 https URL' };
        return { ok: true };
    }
    if (settings.provider === 'deepl') {
        if (!settings.deepl.key) return { ok: false, message: '请填写 DeepL Authentication Key' };
        return { ok: true };
    }
    if (settings.provider === 'youdao') {
        if (!settings.youdao.appId || !settings.youdao.appSecret) return { ok: false, message: '请填写有道 AppID 与 App Secret' };
        return { ok: true };
    }
    return { ok: false, message: '请选择服务商' };
}

function escapeHtml(value) {
    const str = String(value ?? '');
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function escapeAttr(value) {
    return escapeHtml(value).replace(/\n/g, '&#10;').replace(/\r/g, '&#13;');
}

function isValidHttpsHost(value) {
    const raw = String(value ?? '').trim();
    if (!raw) return true;
    try {
        const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
        return url.protocol === 'https:' && !!url.host;
    } catch {
        return false;
    }
}

function migrateCollectedWords(words) {
    let changed = false;
    const next = {};

    Object.entries(words || {}).forEach(([key, value]) => {
        const data = (value && typeof value === 'object') ? { ...value } : {};
        if (!data.originalText) {
            data.originalText = key;
            changed = true;
        }
        next[key] = data;
    });

    return { changed, words: next };
}

async function ensureProviderPermissions(settings) {
    if (settings.provider !== 'openai') return true;
    const rawHost = String(settings.openai?.host ?? '').trim();
    if (!rawHost) return true;

    const originPattern = toHttpsOriginPattern(rawHost);
    if (!originPattern) return false;
    if (originPattern.startsWith('https://api.openai.com/')) return true;

    const has = await containsOrigins([originPattern]);
    if (has) return true;
    return requestOrigins([originPattern]);
}

function toHttpsOriginPattern(value) {
    try {
        const url = new URL(String(value).includes('://') ? String(value) : `https://${value}`);
        if (url.protocol !== 'https:') return '';
        return `${url.origin}/*`;
    } catch {
        return '';
    }
}

function requestOrigins(origins) {
    return new Promise((resolve) => {
        chrome.permissions.request({ origins }, (granted) => resolve(!!granted));
    });
}

function containsOrigins(origins) {
    return new Promise((resolve) => {
        chrome.permissions.contains({ origins }, (result) => resolve(!!result));
    });
}
