import { getContext, extension_settings } from '../../../extensions.js';
import { eventSource, event_types, extension_prompt_roles, extension_prompt_types, generateRaw, saveSettingsDebounced } from '../../../../script.js';
import { DEFAULT_SETTINGS, STATE_KEY, buildBootstrapPrompt, buildDirectorPrompt, buildReviewPrompt, cloneDefaults, formatInjection, mergeStatePatch, normalizeState, parseJsonResponse, recentTranscript } from './core.js';

const NAME = 'narrative_director';
const PROMPT_TAG = 'narrative_director_constraints';
let analyzing = false;
let lastReviewedMessage = null;

function settings() {
    extension_settings[NAME] ??= cloneDefaults(DEFAULT_SETTINGS);
    return extension_settings[NAME];
}

function state(context = getContext()) {
    context.chatMetadata[STATE_KEY] = normalizeState(context.chatMetadata[STATE_KEY]);
    return context.chatMetadata[STATE_KEY];
}

function saveState(context = getContext()) {
    context.saveMetadataDebounced();
    renderState();
}

function status(message, error = false) {
    $('#nd_status').text(message).toggleClass('nd-error', error);
}

function sourceMaterial(context, full = false) {
    const character = context.characterId !== undefined ? context.characters[context.characterId] : null;
    const card = character?.data ?? character ?? {};
    const chat = full ? recentTranscript(context.chat, context.chat.length || 1) : recentTranscript(context.chat, settings().recentMessages);
    const world = context.getWorldInfoNames?.().join(', ') || '';
    return `角色卡：${JSON.stringify(card)}\n已加载世界书名称：${world}\n聊天记录：${chat || '（新聊天）'}`;
}

async function callOpenAI(systemPrompt, userPrompt) {
    const config = settings();
    const baseUrl = config.baseUrl.replace(/\/$/, '');
    if (!baseUrl || !config.apiKey || !config.model) throw new Error('请填写独立模型的 Base URL、API Key 与模型名');
    const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({ model: config.model, temperature: 0.2, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }] }),
    });
    if (!response.ok) throw new Error(`独立模型请求失败：${response.status} ${await response.text()}`);
    const data = await response.json();
    return data.choices?.[0]?.message?.content || '';
}

async function callAnalyst(systemPrompt, userPrompt) {
    if (settings().provider === 'openai') return callOpenAI(systemPrompt, userPrompt);
    return generateRaw({ prompt: userPrompt, systemPrompt, responseLength: 1600 });
}

async function bootstrap() {
    const context = getContext();
    if (!context.chatId) return status('请先打开一个聊天。', true);
    status('正在从角色卡、世界书和聊天建立档案…');
    try {
        analyzing = true;
        const result = parseJsonResponse(await callAnalyst(buildBootstrapPrompt(), sourceMaterial(context, settings().contextMode === 'full')));
        const next = mergeStatePatch(state(context), result);
        next.source_summary = result.source_summary || next.source_summary;
        context.chatMetadata[STATE_KEY] = next;
        saveState(context);
        status('建档完成。请在下方审阅并按需修改档案。');
    } catch (error) {
        console.error('[剧情导演] 建档失败', error);
        status(`建档失败：${error.message}`, true);
    } finally { analyzing = false; }
}

async function planBeforeGeneration(type, options, dryRun) {
    if (analyzing || dryRun || type === 'quiet' || !settings().enabled) return;
    const context = getContext();
    if (!context.chatId || !context.chat.length) return;
    const current = state(context);
    if (current.frozen) return;
    try {
        analyzing = true;
        status('剧情导演正在规划本轮回复…');
        const userPrompt = `${sourceMaterial(context, settings().contextMode === 'full')}\n\n用户刚刚的输入：${context.chat.at(-1)?.mes || ''}`;
        const result = parseJsonResponse(await callAnalyst(buildDirectorPrompt(current), userPrompt));
        const next = mergeStatePatch(current, result.state_patch);
        next.last_plan = result.plan || null;
        context.chatMetadata[STATE_KEY] = next;
        const injection = formatInjection(next.last_plan);
        context.setExtensionPrompt(PROMPT_TAG, injection, extension_prompt_types.IN_CHAT, settings().promptDepth, false, extension_prompt_roles.SYSTEM);
        saveState(context);
        status('本轮剧情约束已注入。');
    } catch (error) {
        console.error('[剧情导演] 规划失败', error);
        status(`规划失败，已继续使用上次约束：${error.message}`, true);
    } finally { analyzing = false; }
}

function renderReview(messageId, review) {
    const container = $(`#chat .mes[mesid="${messageId}"] .mes_text`);
    container.find('.nd-review').remove();
    if (!review?.issues?.length || !container.length) return;
    const issues = review.issues.map(issue => `<li><b>${$('<span>').text(issue.type || '问题').html()}</b>：${$('<span>').text(issue.reason || '').html()}<br><small>修正：${$('<span>').text(issue.repair || '').html()}</small></li>`).join('');
    const high = review.issues.some(issue => issue.severity === 'high');
    container.after(`<div class="nd-review ${high ? 'nd-review-high' : ''}"><b>剧情导演审查</b><ul>${issues}</ul><button class="menu_button nd-repair" data-nd-message="${messageId}">生成修订版</button></div>`);
}

async function reviewAfterMessage(messageId) {
    if (analyzing || !settings().enabled || messageId === lastReviewedMessage) return;
    const context = getContext();
    const message = context.chat[messageId];
    if (!message || message.is_user || !message.mes) return;
    lastReviewedMessage = messageId;
    const current = state(context);
    try {
        analyzing = true;
        status('剧情导演正在审查回复…');
        const result = parseJsonResponse(await callAnalyst(buildReviewPrompt(current, message.mes), sourceMaterial(context, settings().contextMode === 'full')));
        const next = mergeStatePatch(current, result.state_patch);
        next.reviews[messageId] = { issues: Array.isArray(result.issues) ? result.issues : [], reviewed_at: new Date().toISOString() };
        context.chatMetadata[STATE_KEY] = next;
        saveState(context);
        renderReview(messageId, next.reviews[messageId]);
        status(next.reviews[messageId].issues.length ? `审查发现 ${next.reviews[messageId].issues.length} 项风险。` : '审查通过，未发现明显剧情风险。');
    } catch (error) {
        console.error('[剧情导演] 审查失败', error);
        status(`审查失败：${error.message}`, true);
    } finally { analyzing = false; }
}

async function repairMessage(messageId) {
    const context = getContext();
    const message = context.chat[messageId];
    const review = state(context).reviews[messageId];
    if (!message || !review?.issues?.length) return;
    const repair = review.issues.map(item => `- ${item.repair}`).join('\n');
    try {
        status('正在生成修订版…');
        const revised = await generateRaw({ systemPrompt: '你是严谨的互动叙事作者。保留原回复信息，但严格修复下列问题。只输出修订后的正文。', prompt: `原回复：\n${message.mes}\n\n修正要求：\n${repair}`, responseLength: 1200 });
        message.swipes ??= [message.mes];
        message.swipes.push(revised);
        message.swipe_id = message.swipes.length - 1;
        message.mes = revised;
        context.updateMessageBlock(messageId, message.mes, message);
        context.saveChat();
        status('已生成修订版，原回复保留在消息滑动候选中。');
    } catch (error) { status(`修订失败：${error.message}`, true); }
}

function renderState() {
    if (!$('#nd_story').length) return;
    const current = state();
    $('#nd_story').val(JSON.stringify(current.story, null, 2));
    $('#nd_relationships').val(JSON.stringify(current.relationships, null, 2));
    $('#nd_portrayals').val(JSON.stringify(current.portrayals, null, 2));
    $('#nd_freeze').text(current.frozen ? '解除冻结剧情状态' : '冻结剧情状态');
}

function loadSettings() {
    const config = settings();
    $('#nd_enabled').prop('checked', config.enabled);
    $('#nd_provider').val(config.provider);
    $('#nd_base_url').val(config.baseUrl); $('#nd_api_key').val(config.apiKey); $('#nd_model').val(config.model);
    $('#nd_context_mode').val(config.contextMode); $('#nd_recent_messages').val(config.recentMessages);
    $('.nd-openai-only').toggle(config.provider === 'openai');
    renderState();
}

function saveConfig() {
    const config = settings();
    config.enabled = $('#nd_enabled').prop('checked'); config.provider = $('#nd_provider').val();
    config.baseUrl = $('#nd_base_url').val().trim(); config.apiKey = $('#nd_api_key').val().trim(); config.model = $('#nd_model').val().trim();
    config.contextMode = $('#nd_context_mode').val(); config.recentMessages = Number($('#nd_recent_messages').val()) || 12;
    $('.nd-openai-only').toggle(config.provider === 'openai'); saveSettingsDebounced();
}

function saveEditor(field) {
    try {
        const current = state();
        current[field] = JSON.parse($(`#nd_${field}`).val() || '{}');
        saveState(); status('档案已保存。');
    } catch { status('档案必须是有效 JSON，未保存。', true); }
}

jQuery(async () => {
    const path = '/scripts/extensions/third-party/sillytavern-narrative-director';
    $('#extensions_settings2').append(await $.get(`${path}/settings.html`));
    loadSettings();
    $('#narrative_director_settings').on('input change', 'input, select', saveConfig);
    $('#nd_bootstrap').on('click', bootstrap);
    $('#nd_freeze').on('click', () => { const current = state(); current.frozen = !current.frozen; saveState(); });
    $('#nd_story').on('change', () => saveEditor('story'));
    $('#nd_relationships').on('change', () => saveEditor('relationships'));
    $('#nd_portrayals').on('change', () => saveEditor('portrayals'));
    $(document).on('click', '.nd-repair', event => repairMessage(Number($(event.currentTarget).data('nd-message'))));
    eventSource.on(event_types.GENERATION_AFTER_COMMANDS, planBeforeGeneration);
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, reviewAfterMessage);
    eventSource.on(event_types.CHAT_CHANGED, () => { lastReviewedMessage = null; renderState(); });
});
