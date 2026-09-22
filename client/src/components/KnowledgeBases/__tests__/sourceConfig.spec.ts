import { buildKnowledgeSourceInput, partitionConnectorValues } from '../sourceConfig';

describe('partitionConnectorValues', () => {
  it('keeps secret fields out of persisted source config', () => {
    const result = partitionConnectorValues(
      [
        { key: 'url', label: 'URL', type: 'url' },
        { key: 'token', label: 'Token', type: 'password' },
      ],
      { url: 'https://example.com', token: 'secret-value' },
    );

    expect(result.config).toEqual({ url: 'https://example.com' });
    expect(result.credentials).toEqual({ token: 'secret-value' });
    expect(JSON.stringify(result.config)).not.toContain('secret-value');
  });

  it('omits blank values', () => {
    expect(
      partitionConnectorValues([{ key: 'token', label: 'Token', type: 'password' }], {
        token: '',
      }),
    ).toEqual({ config: {}, credentials: {} });
  });

  it('normalizes string_array fields into trimmed string arrays', () => {
    expect(
      partitionConnectorValues(
        [{ key: 'contentColumns', label: 'Content columns', type: 'string_array' }],
        { contentColumns: 'title, body\n summary, ' },
      ),
    ).toEqual({
      config: { contentColumns: ['title', 'body', 'summary'] },
      credentials: {},
    });
  });

  it('omits credentials when a connector has no credential values', () => {
    expect(
      buildKnowledgeSourceInput({
        type: 'postgres',
        name: ' Product docs ',
        fields: [{ key: 'contentColumns', label: 'Content columns', type: 'string_array' }],
        values: { contentColumns: 'title, body' },
      }),
    ).toEqual({
      type: 'postgres',
      name: 'Product docs',
      config: { contentColumns: ['title', 'body'] },
    });
  });
});
