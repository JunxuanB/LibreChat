import { Button, OGDialog, OGDialogContent } from '@librechat/client';
import KnowledgeBasePicker from './KnowledgeBasePicker';
import { useLocalize } from '~/hooks';

export default function KnowledgeBaseSelectDialog({
  open,
  onOpenChange,
  value,
  onChange,
  disabled,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}) {
  const localize = useLocalize();
  return (
    <OGDialog open={open} onOpenChange={onOpenChange}>
      <OGDialogContent className="w-11/12 max-w-lg">
        <div className="p-2">
          <h2 className="text-lg font-semibold text-text-primary">
            {localize('com_ui_knowledge_select')}
          </h2>
          <p className="mt-1 text-sm text-text-secondary">
            {localize('com_ui_knowledge_select_desc')}
          </p>
          <div className="mt-4 max-h-80 overflow-y-auto">
            <KnowledgeBasePicker value={value} onChange={onChange} disabled={disabled} />
          </div>
          <div className="mt-4 flex justify-end">
            <Button type="button" onClick={() => onOpenChange(false)}>
              {localize('com_ui_done')}
            </Button>
          </div>
        </div>
      </OGDialogContent>
    </OGDialog>
  );
}
