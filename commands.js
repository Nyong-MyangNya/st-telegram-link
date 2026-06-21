import { chat } from '../../../../script.js';

function sanitizeText(text = '') {
    return text
        .replace(/<br\s*\/?\>/gi, '\n')
        .replace(/<[^>]*>?/gm, '');
}

export function createCommandHandlers() {
    return {
        '/history': async (args, chatId, token) => {
            const count = args[0] ? parseInt(args[0], 10) : 5;
            const recentChats = chat.slice(-count);
            let historyText = `📜 Recent conversation history (${recentChats.length} items):\n\n`;

            if (recentChats.length === 0) {
                historyText += 'No conversation history available.';
            } else {
                recentChats.forEach((message) => {
                    const cleanText = sanitizeText(message.mes || '');
                    historyText += `[${message.name}]: ${cleanText}\n\n`;
                });
            }

            await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: chatId,
                    text: historyText.substring(0, 4000)
                })
            });
        },
        '/cancel': async () => {
            const $stopBtn = $('#mes_stop');
            if ($stopBtn.length > 0) {
                setTimeout(() => {
                    $stopBtn.trigger('click');
                }, 100);
            }
        }
        // add new command here
    };
}

export const commandHandlers = createCommandHandlers();
