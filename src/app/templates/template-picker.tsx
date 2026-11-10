import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';

import {useI18n, useT} from '../../i18n';
import {Button, Field, Select, useConfirm, useToast} from '../../portal/ui';
import {call} from '../api';
import {type CardTemplate, cardTemplatesQuery} from './templates';

/**
 * The "Start from a template" select of the create-card dialog. Renders nothing until the workspace has a template.
 * Picking one is reported with `onPick` (the dialog fills the title); it is applied to the card after it is made.
 */
export function TemplatePicker({workspaceId, enabled, value, disabled, onPick}: {workspaceId: number; enabled: boolean; value: number; disabled: boolean; onPick: (template: CardTemplate | null) => void}) {
  const t = useT();
  const {errorMessage} = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const query = useQuery({...cardTemplatesQuery(workspaceId), enabled});
  const items = query.data?.items ?? [];
  const selected = items.find(item => item.id === value) ?? null;
  const remove = useMutation({
    mutationFn: (id: number) => call('DELETE', `/card-templates/${id}`),
    onSuccess: async () => {
      onPick(null);
      await queryClient.invalidateQueries({queryKey: ['card-templates', workspaceId]});
      toast.success(t('ctpl.deleted'));
    },
  });
  if (items.length === 0) return null;
  const canDelete = selected && (selected.mine || query.data?.canManage === true);
  return (
    <>
      <Field id="cc-template" label={t('ctpl.pick')}>
        <Select
          id="cc-template"
          value={String(value || '')}
          disabled={disabled}
          onChange={event => onPick(items.find(item => item.id === Number(event.target.value)) ?? null)}
          options={[{value: '', label: t('ctpl.none')}, ...items.map(item => ({value: String(item.id), label: item.name}))]}
        />
      </Field>
      {canDelete && (
        <Button
          variant="ghost"
          size="sm"
          type="button"
          disabled={disabled || remove.isPending}
          onClick={() =>
            void confirm({
              title: t('ctpl.deleteTitle', {name: selected.name}),
              body: t('ctpl.deleteBody'),
              confirmLabel: t('ctpl.delete'),
              action: async () => {
                try {
                  await remove.mutateAsync(selected.id);
                } catch (error) {
                  throw new Error(errorMessage(error));
                }
              },
            })
          }>
          {t('ctpl.delete')}
        </Button>
      )}
    </>
  );
}
