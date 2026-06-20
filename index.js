import { chat } from '../../../../script.js';
import { SlashCommandParser } from '../../../../scripts/slash-commands/SlashCommandParser.js';

// Get extension settings and helper functions from SillyTavern context
const { extensionSettings, saveSettingsDebounced, renderExtensionTemplateAsync, eventSource, event_types } = SillyTavern.getContext();
const MODULE_NAME = 'st-telegram-link';

// Default settings for the Telegram link extension
const defaultSettings = Object.freeze({
    token: '',
    chatId: ''
});

// Load or initialize settings for this module
function getSettings() {
    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(extensionSettings[MODULE_NAME], key)) {
            extensionSettings[MODULE_NAME][key] = defaultSettings[key];
        }
    }
    return extensionSettings[MODULE_NAME];
}

jQuery(async () => {
    const settings = getSettings();

    // Render the extension settings UI
    const settingsHtml = await renderExtensionTemplateAsync('third-party/st-telegram-link', 'settings', {
        token: settings.token,
        chatId: settings.chatId
    });
    $('#extensions_settings').append(settingsHtml);

    // Save settings when user clicks the save button
    $(document).on('click', '#save_telegram_settings', () => {
        settings.token = $('#telegram_bot_token').val();
        settings.chatId = $('#telegram_chat_id').val();
        saveSettingsDebounced();
        alert('Settings saved successfully');
    });

    // Register supported SillyTavern commands with Telegram bot commands
    async function registerTelegramCommands() {
        if (!settings.token) return;
        const commandsMap = SlashCommandParser.commands;
        if (!commandsMap) return;
        const FILTERS = [
            /^send/,
            /^continue$/,

            /char$/,
            /chat/,

            /^sys$/,
            /^comment$/,
            /^persona/,

            /^help$/
        ];
        const cmdList = [];
        const entries = commandsMap instanceof Map ? Array.from(commandsMap.entries()) : Object.entries(commandsMap);
        for (const [key, value] of entries) {
            let cleanCommand = key.toLowerCase().replace(/-/g, '_');

            if (FILTERS.some(regex => regex.test(cleanCommand))) {

                let description = "";
                if (value.helpString) {
                    description = value.helpString.replace(/<[^>]*>/g, '').trim();
                } else if (value.help) {
                    description = value.help;
                } else {
                    description = "";
                }
                const finalDescription = description.substring(0, 256).split('\n')[0].trim();

                cmdList.push({ command: cleanCommand, description: finalDescription || "Command" });
            }
        }

        // 
        cmdList.push({ 
            command: 'history', 
            description: 'Show recent conversation history (e.g. /history 5)' 
        });

        console.log(cmdList);
        await fetch(`https://api.telegram.org/bot${settings.token}/setMyCommands`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ commands: cmdList.slice(0, 100) })
        });
    }
    registerTelegramCommands();

    //
    let currentTelegramMessageId = null;    // Telegram message ID that was created
    let isSendingInitialMessage = false;   // Lock while creating the initial message
    let lastTelegramUpdateTime = 0;         // Throttle timing check
    let lastTelegramSentText = '';          // Cache to prevent duplicate sends (400 error)
    const TELEGRAM_EDIT_THROTTLE = 2000;    // Telegram edit throttle (2 seconds)

    // Called each time a token is received during streaming
    eventSource.on(event_types.STREAM_TOKEN_RECEIVED, async () => {
        const currentSettings = getSettings();
        if (!currentSettings.token || !currentSettings.chatId) return;

        const message = chat[chat.length - 1];
        if (!message || message.is_user) return;

        const now = Date.now();
        // Convert message.message to SillyTavern standard message.mes
        const fullText = `${message.name}: ${message.mes || '...'}`;

        // 1. Create initial Telegram message
        if (!currentTelegramMessageId && !isSendingInitialMessage) {
            isSendingInitialMessage = true;
            try {
                const response = await fetch(`https://api.telegram.org/bot${currentSettings.token}/sendMessage`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ chat_id: currentSettings.chatId, text: fullText })
                });
                const data = await response.json();
                if (data.ok) {
                    currentTelegramMessageId = data.result.message_id;
                    lastTelegramSentText = fullText;
                    lastTelegramUpdateTime = Date.now();
                }
            } catch (error) {
                console.error('[Telegram Link] Failed to send initial message:', error);
            } finally {
                isSendingInitialMessage = false;
            }
            return;
        }

        // 2. After throttle time passed, update Telegram only when actual content changed (prevent 400 errors)
        if (currentTelegramMessageId && (now - lastTelegramUpdateTime > TELEGRAM_EDIT_THROTTLE)) {
            if (fullText === lastTelegramSentText) return; 

            lastTelegramUpdateTime = now;
            lastTelegramSentText = fullText;
            try {
                await fetch(`https://api.telegram.org/bot${currentSettings.token}/editMessageText`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        chat_id: currentSettings.chatId,
                        message_id: currentTelegramMessageId,
                        text: fullText
                    })
                });
            } catch (error) {
                console.error('[Telegram Link] Streaming update failed:', error);
            }
        }
    });

    // 1-2. Called when streaming is fully finished (final sentence sync)
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, async () => {
        const currentSettings = getSettings();
        if (!currentSettings.token || !currentSettings.chatId) return;

        const message = chat[chat.length - 1];
        if (!message || message.is_user) return;

        const fullText = `${message.name}: ${message.mes}`;

        let attempts = 0;
        while (!currentTelegramMessageId && isSendingInitialMessage && attempts < 30) {
            await new Promise(resolve => setTimeout(resolve, 100));
            attempts++;
        }

        try {
            if (currentTelegramMessageId) {
                // Update Telegram only when the final content differs to prevent 400 errors
                if (fullText !== lastTelegramSentText) {
                    await fetch(`https://api.telegram.org/bot${currentSettings.token}/editMessageText`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            chat_id: currentSettings.chatId,
                            message_id: currentTelegramMessageId,
                            text: fullText
                        })
                    });
                }
            } else {
                await fetch(`https://api.telegram.org/bot${currentSettings.token}/sendMessage`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ chat_id: currentSettings.chatId, text: fullText })
                });
            }
        } catch (error) {
            console.error('[Telegram Link] Final message sync failed:', error);
        } finally {
            currentTelegramMessageId = null;
            isSendingInitialMessage = false;
            lastTelegramSentText = '';
        }
    });


    // command handler
    const commandHandlers = {
        '/history': async (args, chatId, token) => {
            const count = args[0] ? parseInt(args[0], 10) : 5;
            const recentChats = chat.slice(-count);
            let historyText = `📜 Recent conversation history (${recentChats.length} items):\n\n`;

            if (recentChats.length === 0) {
                historyText += "No conversation history available.";
            } else {
                recentChats.forEach(m => {
                    const cleanText = (m.mes || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>?/gm, '');
                    historyText += `[${m.name}]: ${cleanText}\n\n`;
                });
            }
            
            await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: chatId, text: historyText.substring(0, 4000) })
            });
        },
        // add new command here
    };    

    // 2. Detect Telegram messages in real time and input them into SillyTavern (Inbound - Long Polling)
    let lastUpdateId = null;
    let isPolling = false;

    async function pollTelegramUpdates() {
        const currentSettings = getSettings();
        if (!currentSettings.token || !currentSettings.chatId) {
            setTimeout(pollTelegramUpdates, 2000);
            return;
        }

        if (isPolling) return;
        isPolling = true;

        try {
            if (lastUpdateId === null) {
                const response = await fetch(`https://api.telegram.org/bot${currentSettings.token}/getUpdates?offset=-1&timeout=0`);
                const data = await response.json();
                lastUpdateId = (data.ok && data.result && data.result.length > 0) ? data.result[0].update_id : 0;
                isPolling = false;
                setTimeout(pollTelegramUpdates, 1000);
                return;
            }

            const response = await fetch(`https://api.telegram.org/bot${currentSettings.token}/getUpdates?offset=${lastUpdateId + 1}&timeout=30`);
            const data = await response.json();

            if (data.ok && data.result) {
                for (const update of data.result) {
                    lastUpdateId = update.update_id;
                    const message = update.message;

                    if (message && message.chat && String(message.chat.id) === String(currentSettings.chatId) && message.text) {
                        const text = message.text.trim();

                        // 1. Check if this is a command (starts with /)
                        if (text.startsWith('/')) {
                            const [rawCmd, ...args] = text.split(/\s+/);
                            const cmd = rawCmd.split('@')[0].toLowerCase(); // handle bot tag

                            if (commandHandlers[cmd]) {
                                console.log(`[Telegram Link] Executing command: ${cmd}`);
                                await commandHandlers[cmd](args, currentSettings.chatId, currentSettings.token);
                                continue; // skip to the next update after command execution
                            }
                        }

                        // 2. If not a command, handle as regular chat
                        const $textarea = $('#send_textarea');
                        const $sendBtn = $('#send_but'); 

                        if ($textarea.length > 0 && $sendBtn.length > 0) {
                            $textarea.val(text);
                            $textarea[0].dispatchEvent(new Event('input', { bubbles: true }));
                            setTimeout(() => { $sendBtn.trigger('click'); }, 100);
                        }
                    }
                }
            }
        } catch (error) {
            console.error('[Telegram Link] Polling error:', error);
        } finally {
            isPolling = false;
            setTimeout(pollTelegramUpdates, 1000);
        }
    }

    pollTelegramUpdates();

});