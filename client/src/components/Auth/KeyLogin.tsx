import { useState } from 'react';
import { Button, Input } from '@librechat/client';
import type { TLoginUser, TStartupConfig } from 'librechat-data-provider';
import { useLocalize } from '~/hooks';

export default function KeyLogin({
  login,
  startupConfig,
  error,
}: {
  login: (data: TLoginUser) => void;
  startupConfig: TStartupConfig;
  error?: string;
}) {
  const localize = useLocalize();
  const [apiKey, setApiKey] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const busy = submitting && !error;
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!apiKey.trim() || busy) return;
        setSubmitting(true);
        login({ email: 'key@sub2api.invalid', password: apiKey.trim() });
      }}
    >
      {startupConfig.sub2api?.subtitle && (
        <p className="text-center text-sm text-text-secondary">{startupConfig.sub2api.subtitle}</p>
      )}
      <p className="text-center text-sm text-text-secondary">
        {localize('com_auth_sub2api_intro')}
      </p>
      <label htmlFor="sub2api-key" className="text-sm font-medium">
        {localize('com_auth_sub2api_key')}
      </label>
      <Input
        id="sub2api-key"
        name="apiKey"
        type="password"
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        maxLength={8192}
        required
        value={apiKey}
        placeholder={localize('com_auth_sub2api_placeholder')}
        onChange={(event) => {
          setApiKey(event.target.value);
          setSubmitting(false);
        }}
      />
      <Button type="submit" disabled={busy || !apiKey.trim()} className="w-full">
        {localize(busy ? 'com_auth_sub2api_connecting' : 'com_auth_sub2api_enter')}
      </Button>
      <p className="text-sm text-text-secondary">{localize('com_auth_sub2api_history')}</p>
      <a
        href={`${startupConfig.sub2api?.siteUrl}/keys`}
        target="_blank"
        rel="noopener noreferrer"
        className="text-center text-sm text-accent-primary underline"
      >
        {localize('com_auth_sub2api_manage')}
      </a>
    </form>
  );
}
