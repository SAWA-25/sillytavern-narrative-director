export const STATE_KEY = 'narrative_director';

export const DEFAULT_STATE = Object.freeze({
    version: 1,
    enabled: true,
    frozen: false,
    story: {
        world_rules: '', power_limits: '', current_scene: '', active_conflicts: [],
        npc_agendas: [], timeline: [], unresolved_threads: [], pacing: '',
    },
    relationships: {},
    portrayals: {},
    last_plan: null,
    reviews: {},
    source_summary: '',
    updated_at: null,
});

export const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    provider: 'current',
    baseUrl: '',
    apiKey: '',
    model: '',
    contextMode: 'recent',
    recentMessages: 12,
    promptPosition: 1,
    promptDepth: 2,
});

export function cloneDefaults(value) {
    return JSON.parse(JSON.stringify(value));
}

export function normalizeState(value) {
    const state = value && typeof value === 'object' ? value : {};
    const merged = { ...cloneDefaults(DEFAULT_STATE), ...state };
    merged.story = { ...cloneDefaults(DEFAULT_STATE).story, ...(state.story || {}) };
    merged.relationships = state.relationships && typeof state.relationships === 'object' ? state.relationships : {};
    merged.portrayals = state.portrayals && typeof state.portrayals === 'object' ? state.portrayals : {};
    merged.reviews = state.reviews && typeof state.reviews === 'object' ? state.reviews : {};
    return merged;
}

export function parseJsonResponse(text) {
    const raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('分析模型没有返回 JSON 对象');
    return JSON.parse(raw.slice(start, end + 1));
}

export function recentTranscript(chat, limit) {
    return (Array.isArray(chat) ? chat : []).filter(m => !m.is_system && m.mes)
        .slice(-Math.max(1, Number(limit) || 12))
        .map(m => `${m.is_user ? '用户' : (m.name || '角色')}: ${m.mes}`)
        .join('\n\n');
}

export function buildDirectorPrompt(state) {
    const story = state.story;
    const relationshipText = Object.entries(state.relationships).map(([name, value]) => `${name}: ${JSON.stringify(value)}`).join('\n');
    const portrayalText = Object.entries(state.portrayals).map(([name, value]) => `${name}: ${JSON.stringify(value)}`).join('\n');
    return `你是严谨的互动叙事导演。你只为下一段角色回复制定约束，不直接写正文。\n\n硬规则：\n1. 所有人受同一世界观、能力、资源、信息和后果限制；主控角色不享有自动胜利或特殊待遇。\n2. NPC 有自己的目标、工作、关系与场外行动，不能只为用户服务。\n3. 恋爱、兴趣、依赖和亲密必须由持续互动、事件与用户态度逐步产生，不能跳级。\n4. 高位或上司角色保持职责和基本尊重；不得物化、占有或贬低用户，除非设定明确且当前聊天有用户明确接受。\n5. 病态或偏执是受其原有目标、逻辑和代价约束的性格，不等于遇到用户就失智。\n6. 角色特质必须按频率、触发条件和对象范围表现。偶尔毒舌不等于粗鄙无礼；可爱不等于幼稚无知。核心人格优先于标签。\n\n当前剧情：${JSON.stringify(story)}\n关系档案：${relationshipText || '无'}\n角色演绎档案：${portrayalText || '无'}\n\n输出 JSON，不要 Markdown：{\"plan\":{\"causal_next_step\":\"\",\"character_basis\":[],\"npc_offscreen_actions\":[],\"relationship_limit\":\"\",\"portrayal_focus\":[],\"forbidden\":[],\"injection\":\"\"},\"state_patch\":{\"story\":{},\"relationships\":{},\"portrayals\":{}}}`;
}

export function buildBootstrapPrompt() {
    return `你是互动叙事编辑。根据给出的角色卡、世界书和聊天，建立可编辑的剧情导演档案。不要以单个关键词概括角色。将核心人格与偶发特质分开；为关系保留尊重、边界和渐进发展。输出 JSON，不要 Markdown：{\"story\":{\"world_rules\":\"\",\"power_limits\":\"\",\"current_scene\":\"\",\"active_conflicts\":[],\"npc_agendas\":[],\"timeline\":[],\"unresolved_threads\":[],\"pacing\":\"\"},\"relationships\":{},\"portrayals\":{\"角色名\":{\"core_personality\":\"\",\"values\":\"\",\"boundaries\":\"\",\"communication_style\":\"\",\"situational_traits\":[],\"anti_stereotypes\":[],\"evidence\":[]}},\"source_summary\":\"\"}`;
}

export function buildReviewPrompt(state, reply) {
    return `你是互动叙事审查员。按剧情、关系和角色演绎档案检查这段新回复。重点找 OOC、关键词放大、刻板化、无依据恋爱、物化/权力失真、NPC 工具化、战力越级、主角特权、因果与节奏问题。每项必须给出简短依据与修正方向；没有问题则返回空数组。\n\n档案：${JSON.stringify({ story: state.story, relationships: state.relationships, portrayals: state.portrayals })}\n\n回复：${reply}\n\n输出 JSON，不要 Markdown：{\"issues\":[{\"type\":\"\",\"severity\":\"low|medium|high\",\"reason\":\"\",\"repair\":\"\"}],\"state_patch\":{\"story\":{},\"relationships\":{},\"portrayals\":{}}}`;
}

export function mergeStatePatch(state, patch) {
    const next = normalizeState(state);
    if (!patch || typeof patch !== 'object') return next;
    if (patch.story && typeof patch.story === 'object') next.story = { ...next.story, ...patch.story };
    for (const key of ['relationships', 'portrayals']) {
        if (patch[key] && typeof patch[key] === 'object') next[key] = { ...next[key], ...patch[key] };
    }
    next.updated_at = new Date().toISOString();
    return next;
}

export function formatInjection(plan) {
    if (!plan || typeof plan !== 'object') return '';
    const list = value => Array.isArray(value) ? value.filter(Boolean).join('；') : '';
    return `[剧情导演约束]\n因果推进：${plan.causal_next_step || '遵循现有局势，避免强行推进。'}\n角色依据：${list(plan.character_basis)}\nNPC 场外行动：${list(plan.npc_offscreen_actions)}\n关系边界：${plan.relationship_limit || '关系只可按已有互动渐进。'}\n演绎重点：${list(plan.portrayal_focus)}\n禁止：${list(plan.forbidden)}\n执行：${plan.injection || '保持完整人格、世界规则、尊重和因果；不要解释这些约束。'}`;
}
