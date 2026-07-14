import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_STATE, formatInjection, mergeStatePatch, normalizeState, parseJsonResponse, recentTranscript } from '../core.js';

test('normalizes incomplete state without losing defaults', () => {
    const state = normalizeState({ story: { current_scene: '酒馆' }, relationships: null });
    assert.equal(state.story.current_scene, '酒馆');
    assert.equal(state.story.power_limits, '');
    assert.deepEqual(state.relationships, {});
});

test('merges state patches at story and relationship boundaries', () => {
    const state = mergeStatePatch(DEFAULT_STATE, { story: { current_scene: '办公室' }, relationships: { '林': { respect: 4 } } });
    assert.equal(state.story.current_scene, '办公室');
    assert.equal(state.relationships['林'].respect, 4);
});

test('extracts JSON from fenced analyst output', () => {
    assert.deepEqual(parseJsonResponse('```json\n{"plan":{"forbidden":[]}}\n```'), { plan: { forbidden: [] } });
});

test('keeps only recent non-system transcript messages', () => {
    const text = recentTranscript([{ is_system: true, mes: 'x' }, { is_user: true, mes: '你好' }, { name: 'A', mes: '回应' }], 1);
    assert.equal(text, 'A: 回应');
});

test('formats director constraints for prompt injection', () => {
    const prompt = formatInjection({ causal_next_step: '调查线索', forbidden: ['突然表白'], portrayal_focus: ['克制'] });
    assert.match(prompt, /调查线索/);
    assert.match(prompt, /突然表白/);
});
