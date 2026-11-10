import {useMutation, useQueryClient} from '@tanstack/react-query';
import {useNavigate} from './nav';
import {useEffect, useRef, useState} from 'react';

import {useI18n, useT} from '../i18n';
import {rules} from '../lib/rules';
import {Button, Card, Field, Notice, PageHeader, RadioCards, useForm, useToast} from '../portal/ui';
import {type ApiError, call, type WorkspaceT} from './api';
import {Kbd} from './shortcuts';
import {type Intent, INTENT_TEMPLATE, createBoardFromTemplate} from './templates';
import {useWorkspace} from './workspace';
import {useWriteCooldown} from './write-cooldown';

type Step = 1 | 2 | 3;

/**
 * `/app/onboarding`, three steps: 1 what it is for (picks the starter board), 2 name it (makes the workspace and the
 * board), 3 invite (a copyable join link; skippable). Steps 1 and 3 can be skipped; a later workspace uses the same flow.
 */
export function Onboarding() {
  const t = useT();
  const {fieldErrors, errorMessage} = useI18n();
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const {setCurrentId, workspaces} = useWorkspace();
  const [step, setStep] = useState<Step>(1);
  const stepRef = useRef<HTMLParagraphElement>(null);
  const firstStep = useRef(true);
  useEffect(() => {
    if (firstStep.current) {
      firstStep.current = false;
      return;
    }
    stepRef.current?.focus();
  }, [step]);
  const [intent, setIntent] = useState<Intent>('team');
  const [status, setStatus] = useState('');
  const [made, setMade] = useState<{workspace: WorkspaceT; boardId: number | null} | null>(null);
  const [link, setLink] = useState('');
  // The workspace a lost first response may already have created: a retry reuses it instead of making another.
  const createdWorkspace = useRef<WorkspaceT | null>(null);
  const lostFirst = useRef(false);
  const knownIds = useRef(new Set<number>());
  const linkField = useRef<HTMLInputElement>(null);
  const form = useForm(
    {name: ''},
    {name: [rules.required(t('onboarding.nameRequired')), rules.maxLength(80, t('onboarding.nameTooLong'))]}
  );

  const cooldown = useWriteCooldown();
  const create = useMutation({
    mutationFn: async (name: string) => {
      let workspace = createdWorkspace.current;
      if (!workspace && lostFirst.current) {
        // The first answer never reached us: it may have been created. Look for a new one with this name.
        const {items} = await call<{items: WorkspaceT[]}>('GET', '/workspaces');
        workspace = items.find(w => w.name.trim().toLowerCase() === name.trim().toLowerCase() && !knownIds.current.has(w.id)) ?? null;
      }
      if (!workspace) {
        knownIds.current = new Set((workspaces ?? []).map(w => w.id));
        try {
          ({workspace} = await call<{workspace: WorkspaceT}>('POST', '/workspaces', {name}));
        } catch (error) {
          const status = (error as ApiError).status;
          lostFirst.current = status === 0 || status === 502 || status === 503 || status === 504;
          throw error;
        }
      }
      createdWorkspace.current = workspace;
      lostFirst.current = false;
      let boardId: number | null = null;
      try {
        boardId = await createBoardFromTemplate(workspace.id, INTENT_TEMPLATE[intent], t(`onboarding.board.${intent}` as 'onboarding.board.team'), t);
      } catch {
        // The workspace exists; the board is one click away on the Boards screen.
      }
      return {workspace, boardId};
    },
    onSuccess: async result => {
      await queryClient.invalidateQueries({queryKey: ['workspaces']});
      setCurrentId(result.workspace.id);
      setMade(result);
      setStatus('');
      setStep(3);
    },
    onError: (error: ApiError) => {
      form.noteError(error);
      form.setServerErrors(fieldErrors(error));
      setStatus(errorMessage(error));
    },
  });

  const makeLink = useMutation({
    mutationFn: () => call<{token: string}>('POST', `/workspaces/${made!.workspace.id}/join-links`, {role: 'member', expiresInDays: 7, maxUses: 10}),
    onSuccess: ({token}) => {
      setLink(`${window.location.origin}/app/join/${token}`);
      setStatus('');
    },
    onError: (error: ApiError) => setStatus(errorMessage(error)),
  });

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      toast.success(t('members.copied'));
    } catch {
      linkField.current?.focus();
      linkField.current?.select();
    }
  };

  const finish = () => {
    toast.success(t('onboarding.created'));
    if (made?.boardId) void navigate({to: '/b/$boardId', params: {boardId: String(made.boardId)}});
    else void navigate({to: '/boards'});
  };

  const steps = [t('onboarding.step.intent'), t('onboarding.step.name'), t('onboarding.step.invite')];
  return (
    <div className="app-page">
      <PageHeader title={t('onboarding.title')} description={t('onboarding.lead')} />
      <p className="lf-steps" aria-live="polite" tabIndex={-1} ref={stepRef}>
        {t('onboarding.stepOf', {n: step, total: 3, name: steps[step - 1]!})}
      </p>
      <Card>
        {step === 1 && (
          <div className="lf-form">
            <RadioCards
              legend={t('onboarding.intentLegend')}
              name="intent"
              value={intent}
              onChange={setIntent}
              columns={1}
              options={(['team', 'personal', 'school'] as Intent[]).map(value => ({
                value,
                title: t(`onboarding.intent.${value}` as 'onboarding.intent.team'),
                description: t(`onboarding.intent.${value}.desc` as 'onboarding.intent.team.desc'),
              }))}
            />
            <div className="lf-form-actions">
              {workspaces && workspaces.length > 0 && (
                <Button variant="secondary" onClick={() => void navigate({to: '/boards'})}>
                  {t('onboarding.cancel')}
                </Button>
              )}
              <Button variant="ghost" onClick={() => setStep(2)}>
                {t('onboarding.skip')}
              </Button>
              <Button onClick={() => setStep(2)}>{t('onboarding.next')}</Button>
            </div>
          </div>
        )}
        {step === 2 && (
          <form
            className="lf-form"
            noValidate
            onSubmit={form.submit(values => {
              setStatus('');
              create.mutate(values.name.trim());
            })}>
            <Field id="f-name" label={t('onboarding.nameLabel')} hint={t('onboarding.nameHint')} error={form.error('name')}>
              <input {...form.field('name')} placeholder={t('onboarding.namePlaceholder')} maxLength={200} autoComplete="off" />
            </Field>
            {status && (
              <p className="field-error" role="alert">
                {status}
              </p>
            )}
            <div className="lf-form-actions">
              <Button variant="secondary" disabled={create.isPending} onClick={() => setStep(1)}>
                {t('common.back')}
              </Button>
              <Button type="submit" pending={create.isPending} pendingLabel={t('common.creating')} disabled={form.blocked}>
                {t('onboarding.submit')}
              </Button>
            </div>
          </form>
        )}
        {step === 3 && (
          <div className="lf-form">
            <h2 className="lf-step-title">{t('onboarding.inviteTitle')}</h2>
            <p className="muted">{t('onboarding.inviteLead')}</p>
            {link ? (
              <Field id="f-link" label={t('members.joinLink')} hint={t('onboarding.linkHint')}>
                <input id="f-link" ref={linkField} readOnly value={link} onFocus={event => event.currentTarget.select()} />
              </Field>
            ) : null}
            {status && (
              <p className="field-error" role="alert">
                {status}
              </p>
            )}
            <Notice tone="info">
              {t('onboarding.tipPrefix')} <Kbd>n</Kbd> {t('onboarding.tipAdd')} <Kbd>/</Kbd> {t('onboarding.tipSearch')} <Kbd>?</Kbd> {t('onboarding.tipHelp')}
            </Notice>
            <div className="lf-form-actions">
              <Button variant="ghost" disabled={makeLink.isPending} onClick={finish}>
                {t('onboarding.skip')}
              </Button>
              {link ? (
                <>
                  <Button variant="secondary" icon="copy" onClick={() => void copy()}>
                    {t('members.copy')}
                  </Button>
                  <Button onClick={finish}>{t('onboarding.done')}</Button>
                </>
              ) : (
                <Button pending={makeLink.isPending} pendingLabel={t('common.creating')} disabled={cooldown.blocked} onClick={() => makeLink.mutate()}>
                  {t('onboarding.createLink')}
                </Button>
              )}
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
