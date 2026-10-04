import { useRef, useState } from 'react';
import {
  Label,
  Button,
  OGDialog,
  OGDialogTitle,
  OGDialogHeader,
  InfoHoverCard,
  OGDialogTrigger,
  OGDialogContent,
} from '@librechat/client';
import { useGetEndpointsQuery, useGetStartupConfig } from '~/data-provider';
import useProviderKeys from './useProviderKeys';
import ProviderKeyRow from './ProviderKeyRow';
import { useLocalize } from '~/hooks';

export default function ProviderKeys() {
  const localize = useLocalize();
  const [open, setOpen] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const { data: endpointsConfig } = useGetEndpointsQuery();
  const endpoints = useProviderKeys();
  const { data: startupConfig } = useGetStartupConfig();

  const handleOpenAutoFocus = (event: Event) => {
    event.preventDefault();
    contentRef.current?.focus();
  };

  if (startupConfig?.sub2api?.enabled) {
    return (
      <a
        href={`${startupConfig.sub2api.siteUrl}/keys`}
        target="_blank"
        rel="noopener noreferrer"
        className="text-sm text-accent-primary underline"
      >
        {localize('com_auth_sub2api_manage')}
      </a>
    );
  }

  return (
    <div className="flex items-center justify-between">
      <Label id="provider-api-keys-label">
        {localize('com_ui_settings_label_provider_api_keys')}
      </Label>
      <OGDialog open={open} onOpenChange={setOpen}>
        <OGDialogTrigger asChild>
          <Button variant="outline" aria-labelledby="provider-api-keys-label">
            {localize('com_ui_manage')}
          </Button>
        </OGDialogTrigger>
        <OGDialogContent
          ref={contentRef}
          tabIndex={-1}
          onOpenAutoFocus={handleOpenAutoFocus}
          className="w-11/12 max-w-2xl bg-surface-dialog text-text-primary shadow-2xl focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-text-primary"
          aria-describedby={undefined}
        >
          <OGDialogHeader className="space-y-0 pr-8 text-left">
            <div className="flex items-center gap-1.5">
              <OGDialogTitle>{localize('com_ui_settings_label_provider_api_keys')}</OGDialogTitle>
              <InfoHoverCard text={localize('com_ui_provider_api_keys_description')} />
            </div>
          </OGDialogHeader>
          {endpointsConfig && (
            <div className="divide-y divide-border-light">
              {endpoints.map((endpoint) => (
                <ProviderKeyRow
                  key={endpoint}
                  endpoint={endpoint}
                  endpointsConfig={endpointsConfig}
                />
              ))}
            </div>
          )}
        </OGDialogContent>
      </OGDialog>
    </div>
  );
}
