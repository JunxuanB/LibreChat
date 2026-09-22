import { isKnowledgeBasesEnabled } from '../feature';

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
