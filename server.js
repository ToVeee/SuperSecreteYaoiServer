const http = require('http');

const PORT = process.env.PORT || 3000;

http.createServer((req, res) => {
    res.writeHead(200);
    res.end('Bot is running!');
}).listen(PORT, '0.0.0.0', () => {
    console.log(`Listening on port ${PORT}`);
});

const fs = require('fs').promises;
const bot = require('./bot.js');
const cheerio = require('cheerio');

let subscription = {};

async function loadSubscriptions() {
    subscription = JSON.parse(
        await fs.readFile('subscriptions.json', 'utf8')
    );
}

async function saveSubscriptions() {
    await fs.writeFile(
        'subscriptions.json',
        JSON.stringify(subscription, null, 2)
    );
}


// TELEGRAM LISTENER

async function listen() {
    const messages = await bot.getMessage();

    for (const update of messages) {
        const message = update.message;

        if (!message?.text) continue;

        const text = message.text;
        const chatId = message.chat.id;

        const args = text.split(' ');
        const command = args[0];
        const input = args.slice(1).join(' ').trim();

        if (command === '/start') {
            await bot.sendMessage(
                chatId,
                'Welcome! Use:\n/subscribe manga-name to subscribe.\n/chapters manga-name to check chapters.\n/AddSubscription manga-name to add a manga to the list.\n/RemoveSubscription manga-name to remove a manga from the list.\n/subscriptions to view your subscriptions.\n/sublist to see available subscriptions'
            );
        }

        if (command === '/status') {
            await bot.sendMessage(chatId, 'Server is running!');
        }

        if (command === '/AddSubscription') {
            if (!input) {
                await bot.sendMessage(chatId, 'Use: /AddSubscription manga-link(vymanga.site/manga/manga-name)');
                continue;
            } else {
                await addManga(input);
                await bot.sendMessage(chatId, `Manga added: ${input}`);
            }
        }

        if (command === '/RemoveSubscription') {
            if (!input) {
                await bot.sendMessage(chatId, 'Use: /RemoveSubscription manga-name');
                continue;
            }

            if (subscription[input]) {
                subscription[input] = subscription[input].filter(id => id !== chatId);
                await saveSubscriptions();
                await bot.sendMessage(chatId, `Unsubscribed from ${input}.`);
            } else {
                await bot.sendMessage(chatId, `You are not subscribed to ${input}.`);
            }
        }
        if (command === '/subscriptions') {
            const subs = Object.keys(subscription).filter(manga => subscription[manga].includes(chatId));
            for (const manga of subs) {
                await bot.sendMessage(chatId, `You are subscribed to: ${manga}`);
            }
        }

        if (command === '/sublist') {
            const manhwas = Object.keys(subscription).map(key => subscription[key].url);
            if (manhwas.length === 0) {
                await bot.sendMessage(chatId, 'No manhwas available.');
            } else {
                for (const manga of manhwas) {
                    await bot.sendMessage(chatId, `Available manhwa: ${manga}`);
                }
            }
        }

        if (command === '/subscribe') {
            if (!input) {
                await bot.sendMessage(chatId, 'Use: /subscribe manga-name');
                continue;
            }

            const manga = subscription[input];

            if (!manga) {
                await bot.sendMessage(chatId, 'Manga not found. Check /manhwas.');
                continue;
            }

            if (manga.subscribers.includes(chatId)) {
                await bot.sendMessage(chatId, 'Already subscribed!');
                continue;
            }

            manga.subscribers.push(chatId);

            await saveSubscriptions();

            await bot.sendMessage(chatId, `Subscribed to ${input}!`);
        }

        if (command === '/chapters') {
            if (!input) {
                await bot.sendMessage(chatId, 'Usage: /chapters manga-name');
                continue;
            }

            await notify(chatId, input);
        }
    }
}


// MANGA SCRAPER

async function checkForNewChapters() {
    for (const [mangaName, mangaData] of Object.entries(subscription)) {

        const currentChapters = mangaData.chapters;
        const newChapters = await getChapters(mangaData.url);

        if (newChapters > currentChapters) {
            mangaData.chapters = newChapters;

            await saveSubscriptions();
            for (const chatId of mangaData.subscribers) {
                await bot.sendMessage(chatId, `New chapter(s) available for ${mangaName}! Total chapters: ${newChapters}`);
            }
        }
    }
}

async function getChapters(url) {
    const response = await fetch(url);

    if (!response.ok) {
        throw new Error(`Failed to fetch manga: ${response.status}`);
    }

    const $ = cheerio.load(await response.text());
    return $('.list-group-item.list-chapter').length;
}

async function addManga(url) {

    if (subscription[manga]) {
        await bot.sendMessage(chatId, 'Manga already exists!');
        return;
    }
    const manga = url.split('/').at(-1);
    const chapters = await getChapters(url);
    const newSubscription = {
        url: url,
        subscribers: [],
        chapters: chapters
    };

    subscription[manga] = newSubscription;
    await saveSubscriptions();
    console.log(`Adding manga: ${manga} with URL: ${url}`);
}

async function notify(chatId, manga) {
    try {
        const url = `https://vymanga.site/manga/${encodeURIComponent(manga)}`;

        const response = await fetch(url);

        if (!response.ok) {
            await bot.sendMessage(chatId, 'Could not find that manga.');
            return;
        }

        const $ = cheerio.load(await response.text());

        const mangaTitle = $('.title').text().trim();

        const uniqueID = new Set();

        $('.list-group-item.list-chapter').each((index, element) => {
            const id = $(element).attr('id');

            if (id && id !== 'chapter-0') {
                uniqueID.add(id);
            }


        });

        await bot.sendMessage(
            chatId,
            `Manga: ${mangaTitle}\nChapters: ${uniqueID.size}`
        );

    } catch (error) {
        console.error(error);
        await bot.sendMessage(chatId, 'Something went wrong while checking the manga.');
    }
}


// START SERVER

async function start() {
    await loadSubscriptions();

    console.log('Bot is running!');

    while (true) {
        try {
            await listen();
        } catch (error) {
            console.error('Listener error:', error);
            await new Promise(resolve => setTimeout(resolve, 3000));
        }
    }
}

async function startChapterChecker() {
    while (true) {
        await checkForNewChapters();
        await new Promise(resolve => setTimeout(resolve, 300000));
    }
}

start();
startChapterChecker();
