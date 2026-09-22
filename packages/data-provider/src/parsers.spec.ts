import { EModelEndpoint } from './schemas';
import { parseCompactConvo } from './parsers';

describe('parseCompactConvo', () => {
  it.each([
    EModelEndpoint.openAI,
    EModelEndpoint.azureOpenAI,
    EModelEndpoint.custom,
    EModelEndpoint.google,
    EModelEndpoint.anthropic,
    EModelEndpoint.assistants,
    EModelEndpoint.azureAssistants,
    EModelEndpoint.agents,
    EModelEndpoint.bedrock,
  ])('preserves selected knowledge bases for %s', (endpoint) => {
    expect(
      parseCompactConvo({
        endpoint,
        conversation: {
          model: 'test-model',
          knowledge_base_ids: ['kb-one', 'kb-two'],
        },
      }),
    ).toMatchObject({ knowledge_base_ids: ['kb-one', 'kb-two'] });
  });
});
