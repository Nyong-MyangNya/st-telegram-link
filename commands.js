import { chat, characters, selectCharacterById } from '../../../../script.js';

function sanitizeText(text = '') {
    return text
        .replace(/<br\s*\/?\>/gi, '\n')
        .replace(/<[^>]*>?/gm, '');
}

function findCharacterMatch(query = '') {
    const trimmed = query.trim();
    if (!trimmed) {
        return null;
    }

    const numericIndex = Number(trimmed);
    if (Number.isInteger(numericIndex) && characters[numericIndex]) {
        return numericIndex;
    }

    const normalized = trimmed.toLowerCase();

    const exactByName = characters.findIndex(character => character?.name?.toLowerCase() === normalized);
    if (exactByName !== -1) {
        return exactByName;
    }

    const exactByAvatar = characters.findIndex(character => character?.avatar?.toLowerCase() === normalized);
    if (exactByAvatar !== -1) {
        return exactByAvatar;
    }

    const matches = characters
        .map((character, index) => ({ character, index }))
        .filter(({ character }) => {
            const name = character?.name?.toLowerCase() || '';
            const avatar = character?.avatar?.toLowerCase() || '';
            return name.includes(normalized) || avatar.includes(normalized);
        });

    if (matches.length === 1) {
        return matches[0].index;
    }

    return matches;
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
    const charChangeHandler = async (args, chatId, token) => {
        const query = (args || []).join(' ').trim();
        const match = findCharacterMatch(query);

        if (!query) {
            await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: chatId,
                    text: 'Usage: /char-change <character name or index>\nExample: /char-change Alice'
                })
            });
            return;
        }

        if (Array.isArray(match)) {
            const preview = match
                .slice(0, 8)
                .map(({ index, character }) => `${index}. ${character?.name || 'Unnamed'} (${character?.avatar || 'none'})`)
                .join('\n');

            await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: chatId,
                    text: `Could not uniquely match "${query}".\n\nMatches:\n${preview}${match.length > 8 ? '\n...' : ''}`
                })
            });
            return;
        }

        if (match === null || match === undefined || !characters[match]) {
            await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: chatId,
                    text: `No character found for "${query}".`
                })
            });
            return;
        }

        await selectCharacterById(match);
        const selected = characters[match];
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text: `✅ Switched to character #${match} (${selected?.name || 'Unnamed'})`
            })
        });
    };

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
        '/char_list': async (_, chatId, token) => {
            const charEntries = characters
                .map((character, index) => {
                    const name = sanitizeText(character?.name || `Character ${index}`);
                    const avatar = character?.avatar || 'none';
                    return `${index}. ${name} (${avatar})`;
                })
                .join('\n');

            const text = charEntries
                ? `📚 Character list (${characters.length} total):\n\n${charEntries}`
                : '📚 Character list is empty.';

            await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: chatId,
                    text: text.substring(0, 4000)
                })
            });
        },
        '/char_change': charChangeHandler,
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
