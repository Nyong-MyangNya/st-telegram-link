import { chat } from '../../../../script.js';
import { SlashCommandParser } from '../../../../scripts/slash-commands/SlashCommandParser.js';

// Get extension settings and helper functions from SillyTavern context
const { extensionSettings, saveSettingsDebounced, renderExtensionTemplateAsync } = SillyTavern.getContext();
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

    let lastUpdateId = 0;
    let lastChatIndex = 0;
    const messageQueue = [];
    let isProcessingQueue = false;
    let isInitialized = false;
    setTimeout(() => { isInitialized = true; }, 3000);

    // Process queued Telegram send/edit jobs sequentially
    async function processQueue() {
        if (isProcessingQueue || messageQueue.length === 0 || !settings.token || !settings.chatId) return;
        isProcessingQueue = true;
        while (messageQueue.length > 0) {
            const job = messageQueue.shift();
            const msg = job.msg;
            const payloadText = `[${msg.name || 'System'}]\n${msg.mes}`;
            try {
                if (job.type === 'SEND') {
                    const response = await fetch(`https://api.telegram.org/bot${settings.token}/sendMessage`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ chat_id: settings.chatId, text: payloadText })
                    });
                    const data = await response.json();
                    if (data.ok) {
                        msg.tgMsgId = data.result.message_id;
                        msg.tgLastAttemptedText = msg.mes;
                        msg.tgLastEditTime = Date.now();
                    }
                } else if (job.type === 'EDIT') {
                    job.msg.isQueuedForEdit = false;
                    if (!isInitialized || !msg.tgMsgId) continue;
                    const response = await fetch(`https://api.telegram.org/bot${settings.token}/editMessageText`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ chat_id: settings.chatId, message_id: msg.tgMsgId, text: payloadText })
                    });
                    const data = await response.json();
                    if (data.ok || (data.description && data.description.includes("message is not modified"))) {
                        msg.tgLastAttemptedText = msg.mes;
                    }
                }
            } catch (e) { console.error(e); }
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        isProcessingQueue = false;
    }

    // Check for new chat messages and queue them for sending or editing
    function checkNewChatMessages() {
        if (!chat || chat.length === 0) return;
        if (lastChatIndex === 0) { lastChatIndex = chat.length; return; }
        while (lastChatIndex < chat.length) {
            const msg = chat[lastChatIndex];
            if (msg && msg.mes && !msg.telegramSent && !msg.is_user) {
                msg.telegramSent = true;
                msg.tgLastAttemptedText = msg.mes;
                messageQueue.push({ type: 'SEND', msg });
            }
            lastChatIndex++;
        }
        const lastMsg = chat[chat.length - 1];
        if (lastMsg && !lastMsg.is_user && lastMsg.tgMsgId) {
            if (lastMsg.mes !== lastMsg.tgLastAttemptedText && !lastMsg.isQueuedForEdit) {
                const now = Date.now();
                if (!lastMsg.tgLastEditTime || (now - lastMsg.tgLastEditTime > 2000)) {
                    lastMsg.isQueuedForEdit = true;
                    lastMsg.tgLastEditTime = now;
                    lastMsg.tgLastAttemptedText = lastMsg.mes;
                    messageQueue.push({ type: 'EDIT', msg: lastMsg });
                }
            }
        }
        processQueue();
    }

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
        console.log(cmdList);
        await fetch(`https://api.telegram.org/bot${settings.token}/setMyCommands`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ commands: cmdList.slice(0, 100) })
        });
    }

    // Poll Telegram getUpdates endpoint for incoming messages
    async function pollTelegramMessages() {
        if (!settings.token) return;
        try {
            const response = await fetch(`https://api.telegram.org/bot${settings.token}/getUpdates?offset=${lastUpdateId + 1}`);
            const data = await response.json();
            if (data.ok && data.result.length > 0) {
                for (const update of data.result) {
                    lastUpdateId = update.update_id;
                    let text = update.message?.text;
                    if (!text) continue;
                    const parts = text.split(' ');
                    if (parts[0].startsWith('/')) {
                        text = parts[0].replace(/_/g, '-') + (parts.length > 1 ? ' ' + parts.slice(1).join(' ') : '');
                    }
                    const textarea = document.getElementById('send_textarea');
                    if (textarea) { textarea.value = text; document.getElementById('send_but')?.click(); }
                }
            }
        } catch (e) { console.error(e); }
    }

    setTimeout(registerTelegramCommands, 3000);
    setInterval(pollTelegramMessages, 2000);
    setInterval(checkNewChatMessages, 1000);
});