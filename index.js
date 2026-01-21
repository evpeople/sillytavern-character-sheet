import { getStringHash, debounce, waitUntilCondition, extractAllWords, isTrueBoolean } from '../../../utils.js';
import { getContext, getApiUrl, extension_settings, doExtrasFetch, modules, renderExtensionTemplateAsync } from '../../../extensions.js';
import { translate } from '../../../i18n.js';
import {
    activateSendButtons,
    deactivateSendButtons,
    animation_duration,
    animation_easing,
    eventSource,
    event_types,
    extension_prompt_roles,
    extension_prompt_types,
    generateQuietPrompt,
    is_send_press,
    saveSettingsDebounced,
    substituteParamsExtended,
    generateRaw,
    getMaxContextSize,
    setExtensionPrompt,
    streamingProcessor,
} from '../../../../script.js';
import { is_group_generating, selected_group } from '../../../group-chats.js';
import { loadMovingUIState } from '../../../power-user.js';
import { dragElement } from '../../../RossAscends-mods.js';
import { getTokenCountAsync } from '../../../tokenizers.js';
import { debounce_timeout } from '../../../constants.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from '../../../slash-commands/SlashCommandArgument.js';
import { macros, MacroCategory } from '../../../macros/macro-system.js';
import { commonEnumProviders } from '../../../slash-commands/SlashCommandCommonEnumsProvider.js';
import { removeReasoningFromString } from '../../../reasoning.js';
import { countWebLlmTokens, generateWebLlmChatPrompt, getWebLlmContextSize, isWebLlmSupported } from '../../shared.js';

const MODULE_NAME = '1_character_sheet';

// Module state
let lastMessageHash = null;
let lastMessageId = null;
let inApiCall = false;

// Prompt builders
const prompt_builders = {
    DEFAULT: 0,
    RAW_BLOCKING: 1,
    RAW_NON_BLOCKING: 2,
};

// Default prompt for character sheet generation
const defaultPrompt = `Based on the chat history, update your character sheet.

## Previous Character Sheet
{{previous_sheet}}

## New Dialogue
{{new_dialogue}}

Please update your character sheet. Respond only with the updated character sheet content in markdown format.`;

const defaultTemplate = '[Character Sheet: {{sheet}}]';

const summary_sources = {
    'extras': 'extras',
    'main': 'main',
    'webllm': 'webllm',
};

// Default settings
const defaultSettings = {
    enabled: true,
    frozen: false,
    prompt: defaultPrompt,
    template: defaultTemplate,
    position: extension_prompt_types.IN_PROMPT,
    role: extension_prompt_roles.SYSTEM,
    scan: false,
    depth: 2,

    // Trigger settings
    promptInterval: 10,
    promptForceWords: 0,
    promptWords: 300,
    promptMinWords: 50,
    promptMaxWords: 1000,
    promptWordsStep: 50,

    // Generation settings
    overrideResponseLength: 0,
    maxMessagesPerRequest: 0,

    // Lock mode: when enabled, this extension triggers both updates
    // and disables the memory extension's automatic summarization
    lockMode: false,

    // Source selection (main/extras/webllm)
    source: summary_sources.main,

    // Skip WI_AN scanning
    SkipWIAN: false,
};

async function countSourceTokens(text, padding = 0) {
    if (isWebLlmSupported()) {
        const count = await countWebLlmTokens(text);
        return count + padding;
    }

    return await getTokenCountAsync(text, padding);
}

/**
 * Get the maximum context size for the source.
 * @returns {number} Context size
 */
async function getSourceContextSize() {
    const overrideLength = extension_settings.character_sheet.overrideResponseLength;

    if (isWebLlmSupported()) {
        const maxContext = await getWebLlmContextSize();
        return overrideLength > 0 ? (maxContext - overrideLength) : Math.round(maxContext * 0.75);
    }

    return getMaxContextSize(overrideLength);
}

/**
 * Format the character sheet value for injection.
 * @param {string} value Raw character sheet content
 * @returns {string} Formatted value
 */
function formatCharacterSheetValue(value) {
    if (!value) {
        return '';
    }

    value = value.trim();

    if (extension_settings.character_sheet.template) {
        return substituteParamsExtended(extension_settings.character_sheet.template, { sheet: value });
    }

    return `Character Sheet: ${value}`;
}

const saveChatDebounced = debounce(() => getContext().saveChat(), debounce_timeout.relaxed);

/**
 * Load settings from storage.
 */
function loadSettings() {
    if (Object.keys(extension_settings.character_sheet).length === 0) {
        Object.assign(extension_settings.character_sheet, defaultSettings);
    }

    for (const key of Object.keys(defaultSettings)) {
        if (extension_settings.character_sheet[key] === undefined) {
            extension_settings.character_sheet[key] = defaultSettings[key];
        }
    }

    // Update UI controls
    $('#character_sheet_enabled').prop('checked', extension_settings.character_sheet.enabled).trigger('input');
    $('#character_sheet_frozen').prop('checked', extension_settings.character_sheet.frozen).trigger('input');
    $('#character_sheet_prompt').val(extension_settings.character_sheet.prompt).trigger('input');
    $('#character_sheet_prompt_words').val(extension_settings.character_sheet.promptWords).trigger('input');
    $('#character_sheet_prompt_interval').val(extension_settings.character_sheet.promptInterval).trigger('input');
    $('#character_sheet_template').val(extension_settings.character_sheet.template).trigger('input');
    $('#character_sheet_depth').val(extension_settings.character_sheet.depth).trigger('input');
    $('#character_sheet_role').val(extension_settings.character_sheet.role).trigger('input');
    $('#character_sheet_lock_mode').prop('checked', extension_settings.character_sheet.lockMode).trigger('input');
    $(`input[name="character_sheet_position"][value="${extension_settings.character_sheet.position}"]`).prop('checked', true).trigger('input');
    $('#character_sheet_prompt_words_force').val(extension_settings.character_sheet.promptForceWords).trigger('input');
    $(`input[name="character_sheet_prompt_builder"][value="${extension_settings.character_sheet.prompt_builder ?? prompt_builders.DEFAULT}"]`).prop('checked', true).trigger('input');
    $('#character_sheet_override_response_length').val(extension_settings.character_sheet.overrideResponseLength).trigger('input');
    $('#character_sheet_max_messages_per_request').val(extension_settings.character_sheet.maxMessagesPerRequest).trigger('input');
    $('#character_sheet_include_wi_scan').prop('checked', extension_settings.character_sheet.scan).trigger('input');
    $('#character_sheet_source').val(extension_settings.character_sheet.source).trigger('change');
    $('#character_sheet_skipWIAN').prop('checked', extension_settings.character_sheet.SkipWIAN).trigger('input');
    switchSourceControls(extension_settings.character_sheet.source);
}

// ===== Event Handlers =====

function onEnabledInput() {
    const value = Boolean($(this).prop('checked'));
    extension_settings.character_sheet.enabled = value;
    saveSettingsDebounced();
}

function onSourceChange(event) {
    const value = event.target.value;
    extension_settings.character_sheet.source = value;
    switchSourceControls(value);
    saveSettingsDebounced();
}

function switchSourceControls(value) {
    $('#characterSheetExtensionDrawerContents [data-character-sheet-source]').each((_, element) => {
        const source = element.dataset.characterSheetSource.split(',').map(s => s.trim());
        $(element).toggle(source.includes(value));
    });
}

function onSkipWIANInput() {
    const value = Boolean($(this).prop('checked'));
    extension_settings.character_sheet.SkipWIAN = value;
    saveSettingsDebounced();
}

function onFrozenInput() {
    const value = Boolean($(this).prop('checked'));
    extension_settings.character_sheet.frozen = value;
    saveSettingsDebounced();
}

function onPromptWordsInput() {
    const value = $(this).val();
    extension_settings.character_sheet.promptWords = Number(value);
    $('#character_sheet_prompt_words_value').text(extension_settings.character_sheet.promptWords);
    saveSettingsDebounced();
}

function onPromptIntervalInput() {
    const value = $(this).val();
    extension_settings.character_sheet.promptInterval = Number(value);
    $('#character_sheet_prompt_interval_value').text(extension_settings.character_sheet.promptInterval);
    saveSettingsDebounced();
}

function onPromptInput() {
    const value = $(this).val();
    extension_settings.character_sheet.prompt = value;
    saveSettingsDebounced();
}

function onTemplateInput() {
    const value = $(this).val();
    extension_settings.character_sheet.template = value;
    reinsertCharacterSheet();
    saveSettingsDebounced();
}

function onDepthInput() {
    const value = $(this).val();
    extension_settings.character_sheet.depth = Number(value);
    reinsertCharacterSheet();
    saveSettingsDebounced();
}

function onRoleInput() {
    const value = $(this).val();
    extension_settings.character_sheet.role = Number(value);
    reinsertCharacterSheet();
    saveSettingsDebounced();
}

function onPositionChange(e) {
    const value = e.target.value;
    extension_settings.character_sheet.position = value;
    reinsertCharacterSheet();
    saveSettingsDebounced();
}

function onIncludeWIScanInput() {
    const value = !!$(this).prop('checked');
    extension_settings.character_sheet.scan = value;
    reinsertCharacterSheet();
    saveSettingsDebounced();
}

function onLockModeInput() {
    const value = !!$(this).prop('checked');
    extension_settings.character_sheet.lockMode = value;
    saveSettingsDebounced();
    updateLockMode(value, false);
}

function onPromptWordsForceInput() {
    const value = $(this).val();
    extension_settings.character_sheet.promptForceWords = Number(value);
    $('#character_sheet_prompt_words_force_value').text(extension_settings.character_sheet.promptForceWords);
    saveSettingsDebounced();
}

function onOverrideResponseLengthInput() {
    const value = $(this).val();
    extension_settings.character_sheet.overrideResponseLength = Number(value);
    $('#character_sheet_override_response_length_value').text(extension_settings.character_sheet.overrideResponseLength);
    saveSettingsDebounced();
}

function onMaxMessagesPerRequestInput() {
    const value = $(this).val();
    extension_settings.character_sheet.maxMessagesPerRequest = Number(value);
    $('#character_sheet_max_messages_per_request_value').text(extension_settings.character_sheet.maxMessagesPerRequest);
    saveSettingsDebounced();
}

function onPromptBuilderInput(e) {
    const value = Number(e.target.value);
    extension_settings.character_sheet.prompt_builder = value;
    saveSettingsDebounced();
}

async function onPromptForceWordsAutoClick() {
    const context = getContext();
    const maxPromptLength = await getSourceContextSize();
    const chat = context.chat;
    const allMessages = chat.filter(m => !m.is_system && m.mes).map(m => m.mes);
    const messagesWordCount = allMessages.map(m => extractAllWords(m)).flat().length;
    const averageMessageWordCount = messagesWordCount / allMessages.length;
    const tokensPerWord = await countSourceTokens(allMessages.join('\n')) / messagesWordCount;
    const wordsPerToken = 1 / tokensPerWord;
    const maxPromptLengthWords = Math.round(maxPromptLength * wordsPerToken);
    const wordsPerPrompt = Math.floor(maxPromptLength / tokensPerWord);
    const summaryPromptWords = extractAllWords(extension_settings.character_sheet.prompt).length;
    const promptAllowanceWords = maxPromptLengthWords - extension_settings.character_sheet.promptWords - summaryPromptWords;
    const averageMessagesPerPrompt = Math.floor(promptAllowanceWords / averageMessageWordCount);
    const maxMessagesPerSummary = extension_settings.character_sheet.maxMessagesPerRequest || 0;
    const targetMessagesInPrompt = maxMessagesPerSummary > 0 ? maxMessagesPerSummary : Math.max(0, averageMessagesPerPrompt);
    const targetSummaryWords = (targetMessagesInPrompt * averageMessageWordCount) + (promptAllowanceWords / 4);

    console.table({
        maxPromptLength,
        maxPromptLengthWords,
        promptAllowanceWords,
        averageMessagesPerPrompt,
        targetMessagesInPrompt,
        targetSummaryWords,
        wordsPerPrompt,
        wordsPerToken,
        tokensPerWord,
        messagesWordCount,
    });

    const ROUNDING = 100;
    extension_settings.character_sheet.promptForceWords = Math.max(1, Math.floor(targetSummaryWords / ROUNDING) * ROUNDING);
    $('#character_sheet_prompt_words_force').val(extension_settings.character_sheet.promptForceWords).trigger('input');
}

async function onPromptIntervalAutoClick() {
    const context = getContext();
    const maxPromptLength = await getSourceContextSize();
    const chat = context.chat;
    const allMessages = chat.filter(m => !m.is_system && m.mes).map(m => m.mes);
    const messagesWordCount = allMessages.map(m => extractAllWords(m)).flat().length;
    const messagesTokenCount = await countSourceTokens(allMessages.join('\n'));
    const tokensPerWord = messagesTokenCount / messagesWordCount;
    const averageMessageTokenCount = messagesTokenCount / allMessages.length;
    const targetSummaryTokens = Math.round(extension_settings.character_sheet.promptWords * tokensPerWord);
    const promptTokens = await countSourceTokens(extension_settings.character_sheet.prompt);
    const promptAllowance = maxPromptLength - promptTokens - targetSummaryTokens;
    const maxMessagesPerSummary = extension_settings.character_sheet.maxMessagesPerRequest || 0;
    const averageMessagesPerPrompt = Math.floor(promptAllowance / averageMessageTokenCount);
    const targetMessagesInPrompt = maxMessagesPerSummary > 0 ? maxMessagesPerSummary : Math.max(0, averageMessagesPerPrompt);
    const adjustedAverageMessagesPerPrompt = targetMessagesInPrompt + (averageMessagesPerPrompt - targetMessagesInPrompt) / 4;

    console.table({
        maxPromptLength,
        promptAllowance,
        targetSummaryTokens,
        promptTokens,
        messagesWordCount,
        messagesTokenCount,
        tokensPerWord,
        averageMessageTokenCount,
        averageMessagesPerPrompt,
        targetMessagesInPrompt,
        adjustedAverageMessagesPerPrompt,
        maxMessagesPerSummary,
    });

    const ROUNDING = 5;
    extension_settings.character_sheet.promptInterval = Math.max(1, Math.floor(adjustedAverageMessagesPerPrompt / ROUNDING) * ROUNDING);

    $('#character_sheet_prompt_interval').val(extension_settings.character_sheet.promptInterval).trigger('input');
}

function onCharacterSheetContentInput() {
    const value = $(this).val();
    setCharacterSheetContext(value, true);
}

function onCharacterSheetRestoreClick() {
    const context = getContext();
    const content = $('#character_sheet_contents').val();
    const reversedChat = context.chat.slice().reverse();
    reversedChat.shift();

    for (let mes of reversedChat) {
        if (mes.extra && mes.extra.characterSheet == content) {
            delete mes.extra.characterSheet;
            break;
        }
    }

    const newContent = getLatestCharacterSheetFromChat(context.chat);
    setCharacterSheetContext(newContent, false);
}

// ===== Core Functions =====

/**
 * Get the latest character sheet from the chat.
 * @param {ChatMessage[]} chat Chat messages
 * @returns {string} Latest character sheet or empty string
 */
function getLatestCharacterSheetFromChat(chat) {
    if (!Array.isArray(chat) || !chat.length) {
        return '';
    }

    const reversedChat = chat.slice().reverse();
    reversedChat.shift(); // Skip the most recent message (being generated)

    for (let mes of reversedChat) {
        if (mes.extra && mes.extra.characterSheet) {
            return mes.extra.characterSheet;
        }
    }

    return '';
}

/**
 * Get the index of the latest character sheet from the chat.
 * @param {ChatMessage[]} chat Chat messages
 * @returns {number} Index or -1 if not found
 */
function getIndexOfLatestCharacterSheet(chat) {
    if (!Array.isArray(chat) || !chat.length) {
        return -1;
    }

    const reversedChat = chat.slice().reverse();
    reversedChat.shift();

    for (let mes of reversedChat) {
        if (mes.extra && mes.extra.characterSheet) {
            return chat.indexOf(mes);
        }
    }

    return -1;
}

/**
 * Set the character sheet value to the context and save it to the chat message extra.
 * @param {string} value Value of character sheet
 * @param {boolean} saveToMessage Should save to message extra
 * @param {number|null} index Index of chat message to save to
 */
function setCharacterSheetContext(value, saveToMessage, index = null) {
    setExtensionPrompt(
        MODULE_NAME,
        formatCharacterSheetValue(value),
        extension_settings.character_sheet.position,
        extension_settings.character_sheet.depth,
        extension_settings.character_sheet.scan,
        extension_settings.character_sheet.role
    );

    $('#character_sheet_contents').val(value);

    const logMessage = value
        ? `Character Sheet set. Position: ${extension_settings.character_sheet.position}. Depth: ${extension_settings.character_sheet.depth}. Role: ${extension_settings.character_sheet.role}`
        : 'Character Sheet is empty';
    console.debug(logMessage);

    const context = getContext();
    if (saveToMessage && context.chat.length) {
        const idx = index ?? context.chat.length - 2;
        const mes = context.chat[idx < 0 ? 0 : idx];

        if (!mes.extra) {
            mes.extra = {};
        }

        mes.extra.characterSheet = value;
        saveChatDebounced();
    }
}

/**
 * Re-insert the character sheet into the context.
 */
function reinsertCharacterSheet() {
    const existingValue = String($('#character_sheet_contents').val());
    setCharacterSheetContext(existingValue, false);
}

/**
 * Check if context has changed during API call.
 * @param {object} context Original context
 * @returns {boolean} True if changed
 */
function isContextChanged(context) {
    const newContext = getContext();
    if (newContext.groupId !== context.groupId
        || newContext.chatId !== context.chatId
        || (!newContext.groupId && (newContext.characterId !== context.characterId))) {
        console.debug('Context changed, character sheet update discarded');
        return true;
    }
    return false;
}

/**
 * Get new dialogue since last update.
 * @param {ChatMessage[]} chat Full chat array
 * @param {number} lastIndex Last updated message index
 * @returns {string} New dialogue content
 */
function getNewDialogueSince(chat, lastIndex) {
    const messages = [];
    const startIndex = lastIndex + 1;

    for (let i = startIndex; i < chat.length; i++) {
        const message = chat[i];
        if (!message.is_system && message.mes) {
            messages.push(`${message.name}: ${message.mes}`);
        }
    }

    return messages.join('\n\n');
}

/**
 * Check if update should be triggered.
 * @param {object} context ST context
 * @param {boolean} force Force update
 * @returns {Promise<string>} Prompt or empty string
 */
async function getUpdatePromptForNow(context, force) {
    if (extension_settings.character_sheet.promptInterval === 0 && !force) {
        return '';
    }

    // Wait for generation to finish
    try {
        if (selected_group) {
            await waitUntilCondition(() => is_group_generating === false, 1000, 10);
        }
        await waitUntilCondition(() => is_send_press === false, 30000, 100);
    } catch {
        return '';
    }

    if (!context.chat.length) {
        return '';
    }

    if (context.chat.length < extension_settings.character_sheet.promptInterval && !force) {
        return '';
    }

    let messagesSinceUpdate = 0;
    let wordsSinceUpdate = 0;

    for (let i = context.chat.length - 1; i >= 0; i--) {
        if (context.chat[i].extra && context.chat[i].extra.characterSheet) {
            break;
        }
        messagesSinceUpdate++;
        wordsSinceUpdate += extractAllWords(context.chat[i].mes).length;
    }

    const conditionSatisfied =
        messagesSinceUpdate >= extension_settings.character_sheet.promptInterval ||
        (extension_settings.character_sheet.promptForceWords > 0 && wordsSinceUpdate >= extension_settings.character_sheet.promptForceWords);

    if (!conditionSatisfied && !force) {
        return '';
    }

    console.log(`Updating character sheet. Messages since last update: ${messagesSinceUpdate}, words: ${wordsSinceUpdate}`);

    const prompt = substituteParamsExtended(extension_settings.character_sheet.prompt, {
        words: extension_settings.character_sheet.promptWords,
    });

    if (!prompt) {
        return '';
    }

    return prompt;
}

/**
 * Get the raw prompt for character sheet update.
 * @param {object} context ST context
 * @param {string} systemPrompt System prompt with placeholders
 * @returns {Promise<{rawPrompt: string, lastUsedIndex: number, processedSystemPrompt: string}>}
 */
async function getRawCharacterSheetPrompt(context, systemPrompt) {
    /**
     * Build the raw prompt string.
     * @param {boolean} includeSystem Include the system prompt
     * @param {string} processedPrompt The processed system prompt with placeholders replaced
     * @returns {string} The built string
     */
    function buildString(includeSystem, processedPrompt) {
        const delimiter = '\n\n';
        const parts = [];

        if (includeSystem) {
            parts.push(processedPrompt);
        }

        const latestSheet = getLatestCharacterSheetFromChat(context.chat.slice());
        if (latestSheet) {
            parts.push(latestSheet);
        }

        parts.push(chatBuffer.slice().join(delimiter));

        return parts.join(delimiter).trim();
    }

    const chat = context.chat.slice();
    const latestSheet = getLatestCharacterSheetFromChat(chat);
    const latestSheetIndex = getIndexOfLatestCharacterSheet(chat);

    chat.pop();
    const chatBuffer = [];
    const PADDING = 64;
    const PROMPT_SIZE = await getSourceContextSize();
    let latestUsedMessage = null;

    // Process system prompt with placeholders
    let processedPrompt = systemPrompt;
    if (latestSheet) {
        processedPrompt = processedPrompt.replace(/\{\{previous_sheet\}\}/g, latestSheet);
    } else {
        processedPrompt = processedPrompt.replace(/\{\{previous_sheet\}\}/g, '(No previous character sheet)');
    }

    // Collect new dialogue content
    const newDialogueContent = [];

    for (let index = latestSheetIndex + 1; index < chat.length; index++) {
        const message = chat[index];

        if (!message) break;

        if (message.is_system || !message.mes) continue;

        const entry = `${message.name}:\n${message.mes}`;
        chatBuffer.push(entry);
        newDialogueContent.push(entry);

        const tokens = await countSourceTokens(buildString(true, processedPrompt), PADDING);

        if (tokens > PROMPT_SIZE) {
            chatBuffer.pop();
            newDialogueContent.pop();
            break;
        }

        latestUsedMessage = message;

        if (extension_settings.character_sheet.maxMessagesPerRequest > 0 &&
            chatBuffer.length >= extension_settings.character_sheet.maxMessagesPerRequest) {
            break;
        }
    }

    // Replace {{new_dialogue}} placeholder with actual dialogue content
    const newDialogueText = newDialogueContent.join('\n\n');
    processedPrompt = processedPrompt.replace(/\{\{new_dialogue\}\}/g, newDialogueText);

    const lastUsedIndex = context.chat.indexOf(latestUsedMessage);
    const rawPrompt = buildString(false, processedPrompt);
    return { rawPrompt, lastUsedIndex, processedSystemPrompt: processedPrompt };
}

/**
 * Update the character sheet using main API.
 * @param {object} context ST context
 * @param {boolean} force Force update
 * @returns {Promise<string|null>}
 */
async function updateCharacterSheetMain(context, force) {
    const prompt = await getUpdatePromptForNow(context, force);
    if (!prompt) return null;

    console.log('Updating character sheet via main API');
    let result = '';
    let index = null;

    if ((extension_settings.character_sheet.prompt_builder ?? prompt_builders.DEFAULT) === prompt_builders.DEFAULT) {
        try {
            inApiCall = true;
            const params = {
                quietPrompt: prompt,
                skipWIAN: extension_settings.character_sheet.SkipWIAN,
                responseLength: extension_settings.character_sheet.overrideResponseLength,
            };
            result = await generateQuietPrompt(params);
        } finally {
            inApiCall = false;
        }
    } else {
        const isBlocking = extension_settings.character_sheet.prompt_builder === prompt_builders.RAW_BLOCKING;
        try {
            inApiCall = true;
            if (isBlocking) {
                deactivateSendButtons();
            }

            const { rawPrompt, lastUsedIndex, processedSystemPrompt } = await getRawCharacterSheetPrompt(context, prompt);

            if (lastUsedIndex === null || lastUsedIndex === -1) {
                if (force) {
                    toastr.info(translate('Remove the latest character sheet to try again'), translate('No messages found to update from'));
                }
                return null;
            }

            const params = {
                prompt: rawPrompt,
                systemPrompt: processedSystemPrompt,
                responseLength: extension_settings.character_sheet.overrideResponseLength,
            };

            const rawResult = await generateRaw(params);
            result = removeReasoningFromString(rawResult);
            index = lastUsedIndex;
        } finally {
            inApiCall = false;
            if (isBlocking) {
                activateSendButtons();
            }
        }
    }

    if (!result) {
        console.warn('Empty character sheet received');
        return null;
    }

    if (isContextChanged(context)) {
        return null;
    }

    setCharacterSheetContext(result, true, index);
    return result;
}

/**
 * Update the character sheet using WebLLM.
 * @param {object} context ST context
 * @param {boolean} force Force update
 * @returns {Promise<string|null>}
 */
async function updateCharacterSheetWebLLM(context, force) {
    if (!isWebLlmSupported()) {
        return null;
    }

    const prompt = await getUpdatePromptForNow(context, force);
    if (!prompt) return null;

    const { rawPrompt, lastUsedIndex, processedSystemPrompt } = await getRawCharacterSheetPrompt(context, prompt);

    if (lastUsedIndex === null || lastUsedIndex === -1) {
        if (force) {
            toastr.info(translate('Remove the latest character sheet to try again'), translate('No messages found to update from'));
        }
        return null;
    }

    const messages = [
        { role: 'system', content: processedSystemPrompt },
        { role: 'user', content: rawPrompt },
    ];

    const params = {};
    if (extension_settings.character_sheet.overrideResponseLength > 0) {
        params.max_tokens = extension_settings.character_sheet.overrideResponseLength;
    }

    try {
        inApiCall = true;
        const result = await generateWebLlmChatPrompt(messages, params);

        if (!result) {
            console.warn('Empty character sheet received');
            return null;
        }

        if (isContextChanged(context)) {
            return null;
        }

        setCharacterSheetContext(result, true, lastUsedIndex);
        return result;
    } finally {
        inApiCall = false;
    }
}

/**
 * Update character sheet using Extras API.
 * @param {object} context ST context
 * @returns {Promise<void>}
 */
async function updateCharacterSheetExtras(context) {
    if (!modules.includes('summarize')) {
        return;
    }

    const prompt = await getUpdatePromptForNow(context, false);
    if (!prompt) return;

    const chat = context.chat;
    const latestSheet = getLatestCharacterSheetFromChat(chat);
    const latestSheetIndex = getIndexOfLatestCharacterSheet(chat);

    chat.pop();
    const chatBuffer = [];
    const CONTEXT_SIZE = await getSourceContextSize();

    for (let index = latestSheetIndex + 1; index < chat.length; index++) {
        const message = chat[index];

        if (!message) break;

        if (message.is_system || !message.mes) continue;

        const entry = `${message.name}:\n${message.mes}`;
        chatBuffer.push(entry);

        const tokens = await countSourceTokens(entry, 0);
        const currentTokens = await countSourceTokens(chatBuffer.join('\n\n'), 0);

        if (currentTokens >= CONTEXT_SIZE) {
            chatBuffer.pop();
            break;
        }
    }

    const resultingString = (latestSheet ? latestSheet + '\n\n' : '') + chatBuffer.slice().reverse().join('\n\n');
    const resultingTokens = await countSourceTokens(resultingString);

    if (!resultingString || resultingTokens < CONTEXT_SIZE) {
        return;
    }

    try {
        inApiCall = true;
        const summary = await callExtrasSummarizeAPI(resultingString);

        if (!summary) {
            console.warn('Empty character sheet received');
            return;
        }

        if (isContextChanged(context)) {
            return;
        }

        setCharacterSheetContext(summary, true);
    } catch (error) {
        console.error('Character sheet update failed:', error);
    } finally {
        inApiCall = false;
    }
}

/**
 * Call the Extras API to update character sheet.
 * @param {string} text Text to process
 * @returns {Promise<string>} Processed text
 */
async function callExtrasSummarizeAPI(text) {
    if (!modules.includes('summarize')) {
        throw new Error('Summarize module is not enabled in Extras API');
    }

    const url = new URL(getApiUrl());
    url.pathname = '/api/summarize';

    const apiResult = await doExtrasFetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Bypass-Tunnel-Reminder': 'bypass',
        },
        body: JSON.stringify({
            text: text,
            params: {},
        }),
    });

    if (apiResult.ok) {
        const data = await apiResult.json();
        return data.summary;
    }

    throw new Error('Extras API call failed');
}

/**
 * Main update function - delegates to appropriate source.
 * @param {object} context ST context
 * @returns {Promise<void>}
 */
async function updateCharacterSheet(context) {
    if (!extension_settings.character_sheet.enabled) {
        return;
    }

    if (streamingProcessor && !streamingProcessor.isFinished) {
        return;
    }

    if (inApiCall || extension_settings.character_sheet.frozen) {
        return;
    }

    const chat = context.chat;

    // Check if there's anything new to process
    if (chat.length === 0 ||
        (lastMessageId === chat.length && getStringHash(chat[chat.length - 1].mes) === lastMessageHash)) {
        return;
    }

    // Handle message deletion
    if (chat.length < lastMessageId) {
        const latestSheet = getLatestCharacterSheetFromChat(chat);
        setCharacterSheetContext(latestSheet, false);
    }

    // Handle message edit/regenerate
    if (chat.length && chat[chat.length - 1].extra && chat[chat.length - 1].extra.characterSheet &&
        lastMessageId === chat.length && getStringHash(chat[chat.length - 1].mes) !== lastMessageHash) {
        delete chat[chat.length - 1].extra.characterSheet;
    }

    let characterSheetResult = null;

    try {
        // Update character sheet based on source
        switch (extension_settings.character_sheet.source) {
            case summary_sources.extras:
                await updateCharacterSheetExtras(context);
                break;
            case summary_sources.webllm:
                characterSheetResult = await updateCharacterSheetWebLLM(context, false);
                break;
            case summary_sources.main:
            default:
                characterSheetResult = await updateCharacterSheetMain(context, false);
                break;
        }

        // In lock mode, also trigger memory update after character sheet update
        // Only trigger memory update if character sheet was successfully updated
        if (extension_settings.character_sheet.lockMode && characterSheetResult) {
            try {
                const memoryModule = await import('../memory/index.js');
                if (typeof memoryModule.forceSummarizeChat === 'function') {
                    await memoryModule.forceSummarizeChat(true);
                }
            } catch (e) {
                console.warn('Could not trigger memory update in lock mode:', e);
            }
        }
    } catch (error) {
        console.error('Character sheet update failed:', error);
    } finally {
        lastMessageId = context.chat?.length ?? null;
        lastMessageHash = getStringHash((context.chat.length && context.chat[context.chat.length - 1]['mes']) ?? '');
    }
}

/**
 * Force an immediate update of the character sheet.
 * @param {boolean} quiet Suppress toast messages
 * @returns {Promise<string>}
 */
async function forceUpdateCharacterSheet(quiet) {
    const context = getContext();
    const toast = quiet ? jQuery() : toastr.info(translate('Updating character sheet...'), translate('Please wait'), { timeOut: 0, extendedTimeOut: 0 });

    let result = null;

    switch (extension_settings.character_sheet.source) {
        case summary_sources.extras:
            await updateCharacterSheetExtras(context);
            // Extras API doesn't return the result directly
            result = getLatestCharacterSheetFromChat(context.chat);
            break;
        case summary_sources.webllm:
            result = await updateCharacterSheetWebLLM(context, true);
            break;
        case summary_sources.main:
        default:
            result = await updateCharacterSheetMain(context, true);
            break;
    }

    toastr.clear(toast);

    if (!result) {
        toastr.warning(translate('Failed to update character sheet'));
        return '';
    }

    return result;
}

/**
 * Handle chat change - restore latest character sheet.
 */
function onChatChanged() {
    const context = getContext();
    const latestSheet = getLatestCharacterSheetFromChat(context.chat);
    setCharacterSheetContext(latestSheet, false);
}

/**
 * Handle chat events - trigger update if needed.
 */
function onChatEvent() {
    updateCharacterSheet(getContext()).catch(console.error);
}

/**
 * Update lock mode state.
 * When lock mode is enabled, this extension triggers both character sheet and memory updates.
 * @param {boolean} enabled Whether lock mode is enabled
 * @param {boolean} fromSyncButton Whether this was triggered from the sync button
 */
function updateLockMode(enabled, fromSyncButton = false) {
    // Check if state actually changed to avoid duplicate notifications
    const wasLocked = extension_settings.memory?.memoryFrozen === true;
    const isChanging = wasLocked !== enabled;

    if (enabled && extension_settings.memory) {
        // Freeze memory extension when lock mode is active
        extension_settings.memory.memoryFrozen = true;
        // Update memory checkbox UI if it exists
        const memoryFrozenCheckbox = document.getElementById('memory_frozen');
        if (memoryFrozenCheckbox) {
            memoryFrozenCheckbox.checked = true;
        }
        if (isChanging && !fromSyncButton) {
            toastr.info(translate('Memory extension has been frozen. Character Sheet extension will handle both updates'), translate('Lock Mode Active'), { timeOut: 3000 });
        }
    } else if (!enabled && extension_settings.memory) {
        // Unfreeze memory extension when lock mode is disabled
        extension_settings.memory.memoryFrozen = false;
        // Update memory checkbox UI if it exists
        const memoryFrozenCheckbox = document.getElementById('memory_frozen');
        if (memoryFrozenCheckbox) {
            memoryFrozenCheckbox.checked = false;
        }
        if (isChanging && !fromSyncButton) {
            toastr.success(translate('Memory extension has been unfrozen. It can now update independently'), translate('Lock Mode Disabled'), { timeOut: 3000 });
        }
    }
}

/**
 * Trigger both character sheet and memory updates together.
 * Used when user manually syncs. Lock Mode uses a different flow.
 * @param {boolean} isLockModeUpdate Whether this is triggered by lock mode automatic update (deprecated, not used)
 */
async function triggerBothUpdates(isLockModeUpdate = false) {
    // This function is only called for manual sync operations
    // Lock Mode uses a different flow: character_sheet triggers memory after its own update
    const toast = toastr.info(translate('Updating character sheet and memory...'), translate('Please wait'), { timeOut: 0, extendedTimeOut: 0 });

    try {
        // Save current states
        const wasLockMode = extension_settings.character_sheet.lockMode;
        const wasMemoryFrozen = extension_settings.memory?.memoryFrozen ?? false;

        // Temporarily disable lock mode and unfreeze memory
        extension_settings.character_sheet.lockMode = false;
        if (extension_settings.memory) {
            extension_settings.memory.memoryFrozen = false;
        }

        // Update character sheet first
        const sheetResult = await forceUpdateCharacterSheet(true);

        // Then update memory (forceSummarizeChat bypasses frozen state)
        try {
            const memoryModule = await import('../memory/index.js');
            if (typeof memoryModule.forceSummarizeChat === 'function') {
                await memoryModule.forceSummarizeChat(true);
            }
        } catch (e) {
            console.warn('Could not trigger memory update:', e);
        }

        // Restore lock mode and memoryFrozen state
        extension_settings.character_sheet.lockMode = wasLockMode;
        if (extension_settings.memory) {
            extension_settings.memory.memoryFrozen = wasMemoryFrozen;
            // Update memory checkbox UI if it exists
            const memoryFrozenCheckbox = document.getElementById('memory_frozen');
            if (memoryFrozenCheckbox) {
                memoryFrozenCheckbox.checked = wasMemoryFrozen;
            }
        }

        toastr.success(translate('Both updates completed'), translate('Sync Result'));
    } catch (error) {
        console.error('Sync failed:', error);
        toastr.error(String(error), translate('Sync Failed'));
    } finally {
        toastr.clear(toast);
    }
}

// ===== Slash Commands =====

async function characterSheetCallback(args, text) {
    text = text.trim();

    const quiet = isTrueBoolean(args.quiet);

    switch (args.action) {
        case 'update':
            if (extension_settings.character_sheet.lockMode) {
                await triggerBothUpdates();
            } else {
                await forceUpdateCharacterSheet(quiet);
            }
            return '';

        case 'sync':
            // Always trigger both updates when explicitly syncing
            await triggerBothUpdates();
            return '';

        case 'freeze':
            extension_settings.character_sheet.frozen = true;
            saveSettingsDebounced();
            return translate('Character sheet updates frozen');

        case 'unfreeze':
            extension_settings.character_sheet.frozen = false;
            saveSettingsDebounced();
            return translate('Character sheet updates unfrozen');

        case 'lock':
            extension_settings.character_sheet.lockMode = true;
            updateLockMode(true, false);
            saveSettingsDebounced();
            return translate('Lock mode enabled. Memory extension will be frozen.');

        case 'unlock':
            extension_settings.character_sheet.lockMode = false;
            updateLockMode(false, false);
            saveSettingsDebounced();
            return translate('Lock mode disabled. Memory extension can now update independently.');

        case 'get':
            return $('#character_sheet_contents').val() || '';

        case 'edit':
            return 'Use the character sheet editor in the extension panel';

        default:
            // Show current status
            const status = extension_settings.character_sheet.frozen ? 'frozen' : 'active';
            const lockStatus = extension_settings.character_sheet.lockMode ? ' (lock mode)' : '';
            const statusKey = extension_settings.character_sheet.frozen ? 'Character sheet is frozen. Use /sheet update to force update' : 'Character sheet is active. Use /sheet update to force update';
            return translate(statusKey);
    }
}

// ===== Macros =====

function registerMacros() {
    macros.register('char_sheet', {
        category: MacroCategory.MISC,
        handler: () => $('#character_sheet_contents').val() || '',
        description: 'Get the current character sheet content',
    });

    macros.register('char_sheet_enabled', {
        category: MacroCategory.MISC,
        handler: () => String(extension_settings.character_sheet.enabled ?? true),
        description: 'Check if character sheet extension is enabled',
    });

    macros.register('char_sheet_frozen', {
        category: MacroCategory.MISC,
        handler: () => String(extension_settings.character_sheet.frozen),
        description: 'Check if character sheet is frozen',
    });

    macros.register('char_sheet_lock_mode', {
        category: MacroCategory.MISC,
        handler: () => String(extension_settings.character_sheet.lockMode),
        description: 'Check if lock mode is enabled',
    });
}

// ===== UI Setup =====

function doPopout(e) {
    const target = e.target;
    if ($('#characterSheetExtensionPopout').length === 0) {
        console.debug('Creating character sheet popout');
        const originalHTMLClone = $(target).parent().parent().parent().find('.inline-drawer-content').html();
        const originalElement = $(target).parent().parent().parent().find('.inline-drawer-content');
        const template = $('#zoomed_avatar_template').html();
        const controlBarHtml = `<div class="panelControlBar flex-container">
            <div id="characterSheetExtensionPopoutheader" class="fa-solid fa-grip drag-grabber hoverglow"></div>
            <div id="characterSheetExtensionPopoutClose" class="fa-solid fa-circle-xmark hoverglow dragClose"></div>
        </div>`;
        const newElement = $(template);
        newElement.attr('id', 'characterSheetExtensionPopout')
            .css('opacity', 0)
            .removeClass('zoomed_avatar')
            .addClass('draggable')
            .empty();
        const prevSheetBoxContents = $('#character_sheet_contents').val().toString();
        originalElement.empty();
        originalElement.html('<div class="flex-container alignitemscenter justifyCenter wide100p"><small>Currently popped out</small></div>');
        newElement.append(controlBarHtml).append(originalHTMLClone);
        $('#movingDivs').append(newElement);
        newElement.transition({ opacity: 1, duration: animation_duration, easing: animation_easing });
        $('#characterSheetExtensionDrawerContents').addClass('scrollableInnerFull');
        setCharacterSheetContext(prevSheetBoxContents, false);
        setupListeners();
        loadSettings();
        loadMovingUIState();

        dragElement(newElement);

        $('#characterSheetExtensionPopoutClose').off('click').on('click', function () {
            $('#characterSheetExtensionDrawerContents').removeClass('scrollableInnerFull');
            const summaryPopoutHTML = $('#characterSheetExtensionDrawerContents');
            $('#characterSheetExtensionPopout').fadeOut(animation_duration, () => {
                originalElement.empty();
                originalElement.append(summaryPopoutHTML);
                $('#characterSheetExtensionPopout').remove();
            });
            loadSettings();
        });
    } else {
        console.debug('Removing existing popout');
        $('#characterSheetExtensionPopout').fadeOut(animation_duration, () => {
            $('#characterSheetExtensionPopoutClose').trigger('click');
        });
    }
}

function setupListeners() {
    $('#character_sheet_restore').off('click').on('click', onCharacterSheetRestoreClick);
    $('#character_sheet_contents').off('input').on('input', onCharacterSheetContentInput);
    $('#character_sheet_enabled').off('input').on('input', onEnabledInput);
    $('#character_sheet_frozen').off('input').on('input', onFrozenInput);
    $('#character_sheet_source').off('change').on('change', onSourceChange);
    $('#character_sheet_skipWIAN').off('input').on('input', onSkipWIANInput);
    $('#character_sheet_prompt_words').off('input').on('input', onPromptWordsInput);
    $('#character_sheet_prompt_interval').off('input').on('input', onPromptIntervalInput);
    $('#character_sheet_prompt').off('input').on('input', onPromptInput);
    $('#character_sheet_force_update').off('click').on('click', () => forceUpdateCharacterSheet(false));
    $('#character_sheet_template').off('input').on('input', onTemplateInput);
    $('#character_sheet_depth').off('input').on('input', onDepthInput);
    $('#character_sheet_role').off('input').on('input', onRoleInput);
    $('input[name="character_sheet_position"]').off('change').on('change', onPositionChange);
    $('#character_sheet_prompt_words_force').off('input').on('input', onPromptWordsForceInput);
    $('#character_sheet_prompt_builder_default').off('input').on('input', onPromptBuilderInput);
    $('#character_sheet_prompt_builder_raw_blocking').off('input').on('input', onPromptBuilderInput);
    $('#character_sheet_prompt_builder_raw_non_blocking').off('input').on('input', onPromptBuilderInput);
    $('#character_sheet_prompt_restore').off('click').on('click', () => {
        $('#character_sheet_prompt').val(defaultPrompt).trigger('input');
    });
    $('#character_sheet_override_response_length').off('input').on('input', onOverrideResponseLengthInput);
    $('#character_sheet_max_messages_per_request').off('input').on('input', onMaxMessagesPerRequestInput);
    $('#character_sheet_include_wi_scan').off('input').on('input', onIncludeWIScanInput);
    $('#character_sheet_lock_mode').off('input').on('input', onLockModeInput);
    $('#characterSheetSettingsBlockToggle').off('click').on('click', function () {
        $('#characterSheetSettingsBlock').slideToggle(200, 'swing');
    });
    $('#character_sheet_sync_button').off('click').on('click', triggerBothUpdates);
    $('#character_sheet_prompt_interval_auto').off('click').on('click', onPromptIntervalAutoClick);
    $('#character_sheet_prompt_words_auto').off('click').on('click', onPromptForceWordsAutoClick);
}

// ===== Initialization =====

jQuery(async function () {
    async function addExtensionControls() {
        // Create container dynamically for third-party extension
        const container = $('<div>', { id: 'character_sheet_container', class: 'extension_container' });
        $('#summarize_container').after(container);

        const settingsHtml = await renderExtensionTemplateAsync('third-party/character-sheet', 'settings', { defaultSettings });
        container.append(settingsHtml);
        setupListeners();
        $('#characterSheetExtensionPopoutButton').off('click').on('click', function (e) {
            doPopout(e);
            e.stopPropagation();
        });
    }

    // Wait for summarize container to be available
    await new Promise(resolve => {
        const checkExist = setInterval(() => {
            if ($('#summarize_container').length > 0) {
                clearInterval(checkExist);
                resolve();
            }
        }, 100);
    });

    await addExtensionControls();
    loadSettings();

    // Restore character sheet on chat change
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);

    // Update character sheet after messages
    eventSource.makeLast(event_types.CHARACTER_MESSAGE_RENDERED, onChatEvent);

    // Handle message modifications
    for (const event of [event_types.MESSAGE_DELETED, event_types.MESSAGE_UPDATED, event_types.MESSAGE_SWIPED]) {
        eventSource.on(event, onChatEvent);
    }

    // Register slash command
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'sheet',
        callback: characterSheetCallback,
        returns: 'string',
        helpString: 'Manage character sheet: /sheet [update|sync|freeze|unfreeze|lock|unlock|get|edit]',
        namedArgumentList: [
            new SlashCommandNamedArgument('action', 'Action to perform', [ARGUMENT_TYPE.STRING], true, false, 'update', ['update', 'sync', 'freeze', 'unfreeze', 'lock', 'unlock', 'get', 'edit']),
            SlashCommandNamedArgument.fromProps({
                name: 'quiet',
                description: 'Suppress toast messages',
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: 'false',
                enumList: commonEnumProviders.boolean('trueFalse')(),
            }),
        ],
    }));

    // Register macros
    registerMacros();

    // Restore character sheet if exists
    onChatChanged();

    console.log('Character Sheet extension loaded');
});

// Export for external use
export { MODULE_NAME, forceUpdateCharacterSheet };
