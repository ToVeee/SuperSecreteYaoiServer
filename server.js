
const fs = require('fs').promises;
const path = require('path');
const bot = require('./bot.js');
const cheerio = require('cheerio');

const SUBSCRIPTIONS_FILE = path.join(__dirname, 'subscriptions.json');

let subscription = {};
let saveQueue = Promise.resolve();

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));


// DATA STORAGE

async function loadSubscriptions() {
    try {
        const data = await fs.readFile(SUBSCRIPTIONS_FILE, 'utf8');
        const saved = JSON.parse(data);

        if (!saved || typeof saved !== 'object' || Array.isArray(saved)) {
            throw new Error('Invalid subscriptions.json structure');
        }

        subscription = {};

        for (const [manga, data] of Object.entries(saved)) {
            // Migrate old array-based subscriptions
            if (Array.isArray(data)) {
                subscription[manga] = {
                    url: `https://vymanga.site/manga/${manga}`,
                    subscribers: data.map(String),
                    chapters: 0
                };
                continue;
            }

            if (!data || typeof data !== 'object') continue;

            subscription[manga] = {
                url: data.url || `https://vymanga.site/manga/${manga}`,
                subscribers: Array.isArray(data.subscribers)
                    ? data.subscribers.map(String)
                    : [],
                chapters: Number.isFinite(Number(data.chapters))
                    ? Number(data.chapters)
                    : 0
            };
        }

        await saveSubscriptions();

    } catch (error) {
        if (error.code === 'ENOENT') {
            subscription = {};
            await saveSubscriptions();
            return;
        }

        throw error;
    }
}


async function saveSubscriptions() {
    const data = JSON.stringify(subscription, null, 2);

    // Prevent simultaneous writes from overwriting each other
    saveQueue = saveQueue.catch(() => { }).then(async () => {
        const tempFile = `${SUBSCRIPTIONS_FILE}.tmp`;

        await fs.writeFile(tempFile, data);
        await fs.rename(tempFile, SUBSCRIPTIONS_FILE);
    });

    return saveQueue;
}


// MANGA HELPERS

function getSlug(input) {
    let slug = input.trim();

    if (slug.startsWith('http://') || slug.startsWith('https://')) {
        const parsed = new URL(slug);

        if (!parsed.hostname.endsWith('vymanga.site')) {
            throw new Error('Only vymanga.site URLs are supported.');
        }

        const parts = parsed.pathname.split('/').filter(Boolean);

        if (parts[0] !== 'manga' || !parts[1]) {
            throw new Error('Invalid manga URL.');
        }

        slug = parts[1];
    } else {
        slug = slug.replace(/^\/?manga\//, '').replace(/\/+$/, '');
    }

    return decodeURIComponent(slug);
}


function getMangaUrl(slug) {
    return `https://vymanga.site/manga/${encodeURIComponent(slug)}`;
}


async function getMangaInfo(url) {
    const response = await fetch(url, {
        signal: AbortSignal.timeout(15000)
    });

    if (!response.ok) {
        throw new Error(`Manga request failed: ${response.status}`);
    }

    const $ = cheerio.load(await response.text());

    const mangaTitle = $('.title').text().trim();
    const uniqueIDs = new Set();

    $('.list-group-item.list-chapter').each((index, element) => {
        const id = $(element).attr('id');

        if (id && id !== 'chapter-0') {
            uniqueIDs.add(id);
        }
    });

    return {
        title: mangaTitle,
        chapters: uniqueIDs.size
    };
}


async function getChapters(url) {
    const info = await getMangaInfo(url);
    return info.chapters;
}


// TELEGRAM LISTENER

async function listen() {
    const messages = await bot.getMessage();

    if (!Array.isArray(messages)) {
        throw new Error('Telegram returned an invalid update list.');
    }

    for (const update of messages) {
        const message = update.message;

        if (!message?.text) continue;

        const text = message.text.trim();
        const chatId = String(message.chat.id);

        const args = text.split(/\s+/);
        const command = args[0].split('@')[0].toLowerCase();
        const input = args.slice(1).join(' ').trim();


        if (command === '/start') {
            await bot.sendMessage(
                chatId,
                'Welcome! Use:\n' +
                '/subscribe manga-name - Subscribe\n' +
                '/chapters manga-name - Check chapters\n' +
                '/AddSubscription manga-link - Add manga\n' +
                '/RemoveSubscription manga-name - Unsubscribe\n' +
                '/subscriptions - View your subscriptions\n' +
                '/sublist - View available manga\n' +
                '/status - Check server status'
            );
        }

        else if (command === '/status') {
            await bot.sendMessage(chatId, 'Server is running!');
        }

        else if (command === '/addsubscription') {
            if (!input) {
                await bot.sendMessage(
                    chatId,
                    'Usage: /AddSubscription https://vymanga.site/manga/manga-name'
                );
                continue;
            }

            try {
                const result = await addManga(input);

                await bot.sendMessage(chatId, result);
            } catch (error) {
                console.error('Add manga error:', error);
                await bot.sendMessage(chatId, 'Could not add that manga.');
            }
        }

        else if (command === '/removesubscription') {
            if (!input) {
                await bot.sendMessage(
                    chatId,
                    'Usage: /RemoveSubscription manga-name'
                );
                continue;
            }

            try {
                const slug = getSlug(input);
                const manga = subscription[slug];

                if (!manga) {
                    await bot.sendMessage(chatId, 'Manga not found.');
                    continue;
                }

                const wasSubscribed = manga.subscribers.includes(chatId);

                if (!wasSubscribed) {
                    await bot.sendMessage(
                        chatId,
                        `You are not subscribed to ${slug}.`
                    );
                    continue;
                }

                manga.subscribers = manga.subscribers.filter(
                    id => id !== chatId
                );

                await saveSubscriptions();

                await bot.sendMessage(
                    chatId,
                    `Unsubscribed from ${slug}.`
                );

            } catch (error) {
                await bot.sendMessage(chatId, 'Invalid manga name.');
            }
        }

        else if (command === '/subscriptions') {
            const subs = Object.keys(subscription).filter(
                manga => subscription[manga].subscribers.includes(chatId)
            );

            if (subs.length === 0) {
                await bot.sendMessage(
                    chatId,
                    'You are not subscribed to any manga.'
                );
                continue;
            }

            await bot.sendMessage(
                chatId,
                'Your subscriptions:\n' + subs.join('\n')
            );
        }

        else if (command === '/sublist') {
            const manhwas = Object.entries(subscription);

            if (manhwas.length === 0) {
                await bot.sendMessage(chatId, 'No manga available.');
                continue;
            }

            const list = manhwas.map(
                ([name, data]) => `${name}\n${data.url}`
            );

            await bot.sendMessage(
                chatId,
                'Available manga:\n\n' + list.join('\n\n')
            );
        }

        else if (command === '/subscribe') {
            if (!input) {
                await bot.sendMessage(
                    chatId,
                    'Usage: /subscribe manga-name'
                );
                continue;
            }

            try {
                const slug = getSlug(input);
                const manga = subscription[slug];

                if (!manga) {
                    await bot.sendMessage(
                        chatId,
                        'Manga not found. Check /sublist.'
                    );
                    continue;
                }

                if (manga.subscribers.includes(chatId)) {
                    await bot.sendMessage(
                        chatId,
                        'Already subscribed!'
                    );
                    continue;
                }

                manga.subscribers.push(chatId);

                await saveSubscriptions();

                await bot.sendMessage(
                    chatId,
                    `Subscribed to ${slug}!`
                );

            } catch (error) {
                await bot.sendMessage(chatId, 'Invalid manga name.');
            }
        }

        else if (command === '/chapters') {
            if (!input) {
                await bot.sendMessage(
                    chatId,
                    'Usage: /chapters manga-name'
                );
                continue;
            }

            await notify(chatId, input);
        }
    }

    return messages.length;
}


// MANGA DATABASE

async function addManga(input) {
    const slug = getSlug(input);
    const url = getMangaUrl(slug);

    if (subscription[slug]) {
        return `Manga already exists: ${slug}`;
    }

    const info = await getMangaInfo(url);

    subscription[slug] = {
        url,
        subscribers: [],
        chapters: info.chapters
    };

    await saveSubscriptions();

    console.log(`Added manga: ${slug}`);

    return `Manga added: ${info.title || slug}\nChapters: ${info.chapters}`;
}


// CHAPTER NOTIFICATIONS

async function notify(chatId, input) {
    try {
        const slug = getSlug(input);

        const manga = subscription[slug];
        const url = manga ? manga.url : getMangaUrl(slug);

        const info = await getMangaInfo(url);

        // Save the latest chapter count for registered manga
        if (manga && manga.chapters !== info.chapters) {
            manga.chapters = info.chapters;
            await saveSubscriptions();

            console.log(`Updated saved chapters for ${slug}: ${info.chapters}`);
        }

        await bot.sendMessage(
            chatId,
            `Manga: ${info.title || slug}\nChapters: ${info.chapters}`
        );

    } catch (error) {
        console.error('Notify error:', error);

        await bot.sendMessage(
            chatId,
            'Something went wrong while checking the manga.'
        );
    }
}


// AUTOMATIC CHAPTER CHECKER

async function checkForNewChapters() {
    for (const [mangaName, mangaData] of Object.entries(subscription)) {
        try {
            const newChapters = await getChapters(mangaData.url);
            const currentChapters = mangaData.chapters;

            // Establish a baseline for migrated records
            if (currentChapters === 0) {
                mangaData.chapters = newChapters;
                await saveSubscriptions();
                continue;
            }

            if (newChapters > currentChapters) {
                mangaData.chapters = newChapters;

                await saveSubscriptions();

                console.log(
                    `New chapters for ${mangaName}: ${newChapters}`
                );

                for (const chatId of mangaData.subscribers) {
                    try {
                        await bot.sendMessage(
                            chatId,
                            `New chapter(s) available for ${mangaName}!\n` +
                            `Total chapters: ${newChapters}`
                        );
                    } catch (error) {
                        console.error(
                            `Notification failed for ${chatId}:`,
                            error
                        );
                    }
                }
            }

        } catch (error) {
            console.error(
                `Chapter check failed for ${mangaName}:`,
                error
            );
        }
    }
}


// SERVER LOOPS

async function startListener() {
    while (true) {
        try {
            const count = await listen();

            // Prevent a tight loop if Telegram returns no updates
            if (count === 0) {
                await sleep(1000);
            }

        } catch (error) {
            console.error('Listener error:', error);
            await sleep(3000);
        }
    }
}


async function startChapterChecker() {
    while (true) {
        try {
            await checkForNewChapters();
        } catch (error) {
            console.error('Chapter checker error:', error);
        }

        await sleep(300000);
    }
}


// START SERVER

async function start() {
    await loadSubscriptions();

    console.log('Bot is running!');
    console.log(`Loaded ${Object.keys(subscription).length} manga.`);

    await Promise.all([
        startListener(),
        startChapterChecker()
    ]);
}

start().catch(error => {
    console.error('Fatal startup error:', error);
});
