import { useEffect, useState } from 'react';
import { Button, Skeleton } from '@librechat/client';
import { useFilePreviewBlob } from '~/data-provider';
import { useLocalize } from '~/hooks';
import Image from './Image';

export default function PrivateImage({
  userId,
  fileId,
  alt,
}: {
  userId: string;
  fileId: string;
  alt: string;
}) {
  const localize = useLocalize();
  const { data, error, refetch } = useFilePreviewBlob(userId, fileId);
  const [url, setURL] = useState('');
  useEffect(() => {
    void refetch();
  }, [refetch, userId, fileId]);
  useEffect(() => {
    if (!data) return;
    const objectURL = URL.createObjectURL(data);
    setURL(objectURL);
    return () => URL.revokeObjectURL(objectURL);
  }, [data]);
  if (error)
    return (
      <Button variant="outline" onClick={() => void refetch()}>
        {localize('com_ui_sub2api_image_retry')}
      </Button>
    );
  if (!url)
    return <Skeleton className="h-48 w-full max-w-lg" aria-label={localize('com_ui_loading')} />;
  return <Image imagePath={url} altText={alt} />;
}
