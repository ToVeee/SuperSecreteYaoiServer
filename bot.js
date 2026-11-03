const token = "9270490873:AAFzswSozibmavd9_w4geTqxzsK9d-W7M6o";

let lastUpdateId = 0;

async function sendMessage(chatId, text) {
    const response = await fetch(
        `https://api.telegram.org/bot${token}/sendMessage`,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                chat_id: chatId,
                text: text
            })
        }
    );

    return await response.json();
}

async function getMessage() {
    const response = await fetch(
        `https://api.telegram.org/bot${token}/getUpdates?offset=${lastUpdateId + 1}`
    );

    const data = await response.json();

    if (!data.ok) {
        throw new Error(data.description);
    }

    if (data.result.length > 0) {
        lastUpdateId = data.result[data.result.length - 1].update_id;
    }

    return data.result;
}

module.exports = {
    sendMessage,
    getMessage
}; 