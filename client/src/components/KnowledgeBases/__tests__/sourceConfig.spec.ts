import { partitionConnectorValues } from '../sourceConfig';

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
});
