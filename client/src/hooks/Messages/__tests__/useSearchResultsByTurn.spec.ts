import { renderHook } from '@testing-library/react';
import { Tools } from 'librechat-data-provider';
import { useSearchResultsByTurn } from '../useSearchResultsByTurn';

jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));

describe('useSearchResultsByTurn', () => {
  it('renders canonical external-index results as links and ordinary results as files', () => {
    const attachments = [
      {
        type: Tools.file_search,
        [Tools.file_search]: {
          sources: [
            {
              fileId: 'external:source:doc',
              fileName: 'External docs',
              canonicalUrl: 'https://docs.example/page',
            },
            { fileId: 'file-1', fileName: 'Upload.pdf' },
          ],
        },
      },
    ];

    const { result } = renderHook(() => useSearchResultsByTurn(attachments as never));

    expect(result.current['0'].references).toEqual([
      expect.objectContaining({
        type: 'link',
        link: 'https://docs.example/page',
        title: 'External docs',
      }),
      expect.objectContaining({ type: 'file', link: '#file-file-1', fileId: 'file-1' }),
    ]);
  });

  it('does not turn unsafe canonical URL schemes into clickable links', () => {
    const attachments = [
      {
        type: Tools.file_search,
        [Tools.file_search]: {
          sources: [
            {
              fileId: 'external:source:doc',
              fileName: 'Unsafe',
              canonicalUrl: 'javascript:alert(1)',
            },
          ],
        },
      },
    ];

    const { result } = renderHook(() => useSearchResultsByTurn(attachments as never));
    expect(result.current['0'].references?.[0]).toMatchObject({
      type: 'file',
      link: '#file-external:source:doc',
    });
  });
});
