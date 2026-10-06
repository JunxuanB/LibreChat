import { useState } from 'react';
import { useSetAtom } from 'jotai';
import * as Ariakit from '@ariakit/react';
import { ScrollText, ChevronDown } from 'lucide-react';
import { Permissions, PermissionTypes } from 'librechat-data-provider';
import { DropdownPopup, TooltipAnchor, composerControlClasses } from '@librechat/client';
import { showSkillsPopoverFamily } from './skillsState';
import { useLocalize, useHasAccess } from '~/hooks';

export default function SkillsMenu({
  index,
  disabled,
  onSummarize,
}: {
  index: number;
  disabled: boolean;
  onSummarize: () => void;
}) {
  const localize = useLocalize();
  const [open, setOpen] = useState(false);
  const setShowSkills = useSetAtom(showSkillsPopoverFamily(index));
  const canUse = useHasAccess({
    permissionType: PermissionTypes.SKILLS,
    permission: Permissions.USE,
  });
  const canCreate = useHasAccess({
    permissionType: PermissionTypes.SKILLS,
    permission: Permissions.CREATE,
  });
  if (!canUse) {
    return null;
  }
  return (
    <DropdownPopup
      menuId={`skills-menu-${index}`}
      isOpen={open}
      setIsOpen={setOpen}
      portal={true}
      unmountOnHide={true}
      trigger={
        <TooltipAnchor
          description={localize('com_ui_sub2api_skill_hint')}
          disabled={open}
          render={
            <Ariakit.MenuButton
              disabled={disabled}
              aria-label={localize('com_ui_skills')}
              className={composerControlClasses()}
            />
          }
        >
          <ScrollText className="size-4" aria-hidden="true" />
          <span>{localize('com_ui_skills')}</span>
          <ChevronDown className="size-3" aria-hidden="true" />
        </TooltipAnchor>
      }
      items={[
        {
          label: localize('com_ui_sub2api_skill_select'),
          onClick: () => setShowSkills(true),
        },
        {
          label: localize('com_ui_sub2api_skill_save'),
          show: canCreate,
          onClick: onSummarize,
        },
      ]}
    />
  );
}
