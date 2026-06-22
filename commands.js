import { Generate, chat, characters, selectCharacterById } from '../../../../script.js';

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
        '/next': async (args, chatId, token) => {
            sendTextToInput('');
        },        
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
        '/impersonate': async (args, chatId, token, rawText) => {
            const { eventSource, event_types, generateRaw, name1, name2 } = SillyTavern.getContext();

            const firstSpaceIndex = rawText.indexOf(" ");
            // 공백 뒤의 문자열을 가져온 뒤, 양끝 공백을 제거(.trim())
            const rawDialogue = firstSpaceIndex !== -1 ? rawText.slice(firstSpaceIndex + 1).trim() : "";            

            // impersonate실행후 중간에 프롬프트 바꾸기 (GENERATE_AFTER_DATA) // TODO: 생성된 지훈의 메세지가 텔레그램에 안보임
            const eventPromise = new Promise((resolve) => {
                const onAfterData = (generate_data, dryRun) => {
                    cleanup();
                    
                    let newPrompt = generate_data.prompt;
                    if (rawDialogue) {
                        const regex = new RegExp(`(${name1}|${name2}):$`);
                        newPrompt = newPrompt.replace(regex, '');
                        newPrompt += `Rewrite this dialogue of ${name1} into a novel sentence with actions: "${rawDialogue}"\n\n${name1}:`;
                    }
                    generate_data.prompt = newPrompt;
                    resolve(generate_data);
                };

                const onStopOrEnd = () => {
                    cleanup(); // 중간에 중단되면 정리
                    resolve(null); // 더 이상 기다리지 않음
                };

                // 2. 리스너 제거 함수 (에러 없이 안전하게 정리)
                const cleanup = () => {
                    eventSource.removeListener(event_types.GENERATE_AFTER_DATA, onAfterData);
                    eventSource.removeListener(event_types.GENERATE_STOPPED, onStopOrEnd);
                    eventSource.removeListener(event_types.GENERATE_ENDED, onStopOrEnd);
                };

                // 3. 이벤트 등록
                eventSource.on(event_types.GENERATE_AFTER_DATA, onAfterData);
                eventSource.on(event_types.GENERATE_STOPPED, onStopOrEnd);
                eventSource.on(event_types.GENERATE_ENDED, onStopOrEnd);
            });            

            let result = await Generate("impersonate", {});
            // console.log(`result:`, result);
            sendTextToInput(result);
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
            if (characters.length === 0) {
                await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        chat_id: chatId,
                        text: '📚 Character list is empty.'
                    })
                });
                return;
            }

            const buttons = characters.map((character, index) => ({
                text: `${index}. ${character?.name || `Char ${index}`}`,
                callback_data: `/char_change:${index}`
            }));

            // Send in chunks if there are too many buttons (Telegram limit is 100 per message, but UI looks bad with too many)
            const chunkSize = 10;
            for (let i = 0; i < buttons.length; i += chunkSize) {
                const chunk = buttons.slice(i, i + chunkSize);
                await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        chat_id: chatId,
                        text: i === 0 ? `📚 Character list (${characters.length} total):` : `Characters ${i+1}-${Math.min(i + chunkSize, characters.length)}:` ,
                        reply_markup: {
                            inline_keyboard: [
                                chunk.map(btn => ({ text: btn.text, callback_data: btn.callback_data }))
                            ]
                        }
                    })
                });
            }
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
