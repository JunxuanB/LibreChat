import { ReasoningEffort } from 'librechat-data-provider';
import { Select, SelectValue, SelectTrigger, SelectContent, SelectItem } from '@librechat/client';
import type { TConversation } from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks';
import { useLocalize, useSetIndexOptions } from '~/hooks';

const labels: Partial<Record<ReasoningEffort, TranslationKeys>> = {
  [ReasoningEffort.unset]: 'com_ui_auto',
  [ReasoningEffort.low]: 'com_ui_low',
  [ReasoningEffort.medium]: 'com_ui_medium',
  [ReasoningEffort.high]: 'com_ui_high',
  [ReasoningEffort.xhigh]: 'com_ui_xhigh',
  [ReasoningEffort.max]: 'com_ui_max',
  [ReasoningEffort.ultra]: 'com_ui_sub2api_ultra',
};

export default function Reasoning({
  conversation,
  enabled,
  disabled,
}: {
  conversation: TConversation | null;
  enabled: boolean;
  disabled: boolean;
}) {
  const localize = useLocalize();
  const { setOption } = useSetIndexOptions();
  if (
    !enabled ||
    !conversation ||
    String(conversation?.endpoint) !== 'sub2api' ||
    !/^gpt-6(?:\.\d+)?-(?:sol|luna)(?:-|$)/.test(conversation.model ?? '')
  )
    return null;
  const value = conversation.reasoning_effort || 'auto';
  return (
    <Select
      value={value}
      disabled={disabled}
      onValueChange={(effort) => setOption('reasoning_effort')(effort === 'auto' ? '' : effort)}
    >
      <SelectTrigger
        aria-label={localize('com_endpoint_reasoning_effort')}
        className="w-auto gap-2 text-xs"
      >
        <span>{localize('com_endpoint_reasoning_effort')}</span>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {Object.entries(labels)
          .filter(
            ([effort]) =>
              effort !== ReasoningEffort.ultra ||
              /^gpt-6\.1-sol(?:-|$)/.test(conversation.model ?? ''),
          )
          .map(([effort, label]) => (
            <SelectItem key={effort || 'auto'} value={effort || 'auto'}>
              {localize(label)}
            </SelectItem>
          ))}
      </SelectContent>
    </Select>
  );
}
