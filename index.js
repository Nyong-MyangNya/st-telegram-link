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

async function loadCommandHandlers() {
    try {
        const module = await import('./commands.js');
        if (typeof module.createCommandHandlers === 'function') {
            return module.createCommandHandlers();
        }
        if (module.commandHandlers) {
            return module.commandHandlers;
        }
    } catch (error) {
        console.warn('[Telegram Link] External command handlers not loaded.', error);
    }

    return {};
}
jQuery(async () => {
    const settings = getSettings();
    const commandHandlers = await loadCommandHandlers();

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
        const cmdList = [];

        // My commands
        cmdList.push({ 
            command: 'next', 
            description: 'Next message' 
        });
        cmdList.push({ 
            command: 'sendas', 
            description: 'sends a message as a specific character (e.g. /sendas name: text)' 
        });
        cmdList.push({ 
            command: 'cancel', 
            description: 'Cancel' 
        });
        cmdList.push({ 
            command: 'history', 
            description: 'Show recent conversation history (e.g. /history 5)' 
        });
        cmdList.push({ 
            command: 'char_list', 
            description: 'List all loaded characters' 
        });
        cmdList.push({ 
            command: 'char_change', 
            description: 'Switch to a character by name or index' 
        });


        // Register SillyTavern commands
        const FILTERS = [
            /^send$/,
            /^continue$/,

            // /char$/,
            // /chat/,

            /^sys$/,
            // /^comment$/,
            // /^persona/,

            /^help$/
        ];
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

        console.log(cmdList);
        await fetch(`https://api.telegram.org/bot${settings.token}/setMyCommands`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ commands: cmdList.slice(0, 100) })
        });
    }
    registerTelegramCommands();

    // Telegram typing action helper
    async function sendTypingAction(token, chatId) {
        try {
            await fetch(`https://api.telegram.org/bot${token}/sendChatAction`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: chatId, action: 'typing' })
            });
        } catch (err) {
            console.error('[Telegram Link] Typing action failed:', err);
        }
    }
    let typingInterval = null;

    // Start and refresh typing action
    function startTyping(token, chatId) {
        if (typingInterval) return; // Prevent duplicate execution if already running
        
        // Execute once immediately
        sendTypingAction(token, chatId);
        
        // Refresh every 4 seconds considering Telegram action duration (5 seconds)
        typingInterval = setInterval(() => {
            sendTypingAction(token, chatId);
        }, 4000);
    }

    // Stop typing action
    function stopTyping() {
        if (typingInterval) {
            clearInterval(typingInterval);
            typingInterval = null;
        }
    }

    eventSource.on(event_types.GENERATION_AFTER_COMMANDS, () => {
        const currentSettings = getSettings();
        if (!currentSettings.token || !currentSettings.chatId) return;
        
        // Start typing action when AI begins thinking
        startTyping(currentSettings.token, currentSettings.chatId);
    });

    // Generation stopped or ended (exception handling and completion)
    eventSource.on(event_types.GENERATION_STOPPED, () => {
        stopTyping();
    });
    eventSource.on(event_types.GENERATION_ENDED, () => {
        stopTyping();
    });    


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
                    const callbackQuery = update.callback_query;

                    if (message && message.chat && String(message.chat.id) === String(currentSettings.chatId) && message.text) {
                        let text = message.text.trim();

                        // 1. Check if this is a command (starts with /)
                        if (text.startsWith('/')) {
                            const [rawCmd, ...args] = text.split(/\s+/);
                            const cmd = rawCmd.split('@')[0].toLowerCase(); // handle bot tag
                            console.log(`rawCmd:${rawCmd}`);

                            if (commandHandlers[cmd]) {
                                console.log(`[Telegram Link] Executing command: ${cmd}`);
                                await commandHandlers[cmd](args, currentSettings.chatId, currentSettings.token, text);
                                continue;
                            }
                        }

                        // 2. If not a command, handle as regular chat
                        const $textarea = $('#send_textarea');
                        const $sendBtn = $('#send_but');

                        // Replace _ with - for SillyTavern commands
                        const parts = text.split(' ');
                        if (parts[0].startsWith('/')) {
                            text = parts[0].replace(/_/g, '-') + (parts.length > 1 ? ' ' + parts.slice(1).join(' ') : '');
                        }

                        if ($textarea.length > 0 && $sendBtn.length > 0) {
                            $textarea.val(text);
                            $textarea[0].dispatchEvent(new Event('input', { bubbles: true }));
                            setTimeout(() => { $sendBtn.trigger('click'); }, 100);
                        }
                    } else if (callbackQuery && callbackQuery.from && String(callbackQuery.from.id) === String(currentSettings.chatId)) {
                        const data = callbackQuery.data;
                        console.log(`callbackQuery.data=${data}`);
                        if (typeof data === 'string') {
                            const [cmd, ...args] = data.split(':');
                            if (commandHandlers[cmd]) {
                                console.log(`[Telegram Link] Executing command: ${cmd} from callback query`);
                                await commandHandlers[cmd](args, currentSettings.chatId, currentSettings.token);
                                // Acknowledge the callback to remove the loading state on the button
                                await fetch(`https://api.telegram.org/bot${currentSettings.token}/answerCallbackQuery`, {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ callback_query_id: callbackQuery.id })
                                });
                            }
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

