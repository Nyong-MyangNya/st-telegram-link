import { chat } from '../../../../script.js';

function sanitizeText(text = '') {
    return text
        .replace(/<br\s*\/?\>/gi, '\n')
        .replace(/<[^>]*>?/gm, '');
}

function sendTextToInput(text = '') {
    const $textarea = $('#send_textarea');
    const $sendBtn = $('#send_but');

    if ($textarea.length > 0 && $sendBtn.length > 0) {
        $textarea.val(text);
        $textarea[0].dispatchEvent(new Event('input', { bubbles: true }));
        setTimeout(() => {
            $sendBtn.trigger('click');
        }, 100);
    }
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
        '/sendas': async (args, chatId, token, rawText) => {
            const rawArgs = args.filter(Boolean);
            if (rawArgs.length === 0) return;

            const rawCommandText = (rawText || `/sendas ${rawArgs.join(' ')}`).trim();
            const match = rawCommandText.match(/^\/sendas\s+(.+?)\s*:\s*(.*)$/);

            if (match) {
                const name = match[1].trim();
                const rest = match[2].trim();

                if (name) {
                    const escapedName = name.replaceAll('"', '\\"');
                    const commandText = `/sendas name="${escapedName}"${rest ? ` ${rest}` : ''}`;
                    sendTextToInput(commandText);
                    return;
                }
            }

            const commandText = `/sendas ${rawArgs.join(' ')}`.trim();
            sendTextToInput(commandText);
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
