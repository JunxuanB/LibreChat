import { isKnowledgeBaseActionEnabled, isKnowledgeBasesEnabled } from '../feature';

describe('isKnowledgeBasesEnabled', () => {
  it.each([
    [undefined, false],
    [false, false],
    [true, true],
    [{}, true],
    [{ use: true }, true],
    [{ use: false }, false],
  ])('maps %p to %p', (config, expected) => {
    expect(isKnowledgeBasesEnabled(config)).toBe(expected);
  });
});

describe('isKnowledgeBaseActionEnabled', () => {
  it('honors action-level opt-outs without disabling use', () => {
    const config = { use: true, create: false, share: true };
    expect(isKnowledgeBaseActionEnabled(config, 'create')).toBe(false);
    expect(isKnowledgeBaseActionEnabled(config, 'share')).toBe(true);
  });

  it('disables every action when the feature is off', () => {
    expect(isKnowledgeBaseActionEnabled(false, 'create')).toBe(false);
  });
});
