import {useQuery} from '@tanstack/react-query';
import {Link} from '@tanstack/react-router';

import {
  healthQuery,
  type OverviewCard,
  overviewMyDayQuery,
  overviewWorkspacesQuery,
  sessionsQuery,
  siteQuery,
  twoFactorQuery,
  unreadCountQuery,
} from '../queries';
import {useMe} from '../shared';
import {todayISO} from '../ui/date';
import {
  Avatar,
  Badge,
  buttonClass,
  Card,
  EmptyState,
  ErrorNote,
  Icon,
  LoadingBlock,
  Notice,
  PageHeader,
  Skeleton,
  Stat,
  StatusBadge,
  type Tone,
} from '../ui';

/**
 * `/` of the dashboard: what is on YOUR plate in Lanefold first (cards due,
 * unread notifications, your workspaces), then your account.
 * Every number is cheap (one bounded read, never a count per request):
 * docs/agent/performance.md.
 */
const capitalise = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** Where the app keeps the chosen workspace (src/app/workspace.tsx). */
const WORKSPACE_KEY = 'lf:workspace';

const DUE: Record<OverviewCard['group'], {label: string; tone: Tone}> = {
  overdue: {label: 'Overdue', tone: 'danger'},
  today: {label: 'Today', tone: 'warning'},
  next7: {label: 'This week', tone: 'info'},
  later: {label: 'Later', tone: 'neutral'},
  none: {label: 'No date', tone: 'neutral'},
};

const PLAN_TONES: Record<string, Tone> = {free: 'neutral', pro: 'brand', team: 'success'};

const shortDate = (iso: string) =>
  new Intl.DateTimeFormat('en-GB', {day: 'numeric', month: 'short', timeZone: 'UTC'}).format(new Date(`${iso}T00:00:00Z`));

function greeting(hour: number) {
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

/** Opens the app on that workspace's boards. */
function rememberWorkspace(id: number) {
  try {
    localStorage.setItem(WORKSPACE_KEY, String(id));
  } catch {
    // Private mode: the app falls back to the first workspace.
  }
}

export function Overview() {
  const me = useMe();
  const viewer = me.data?.viewer;
  const today = todayISO();
  const health = useQuery(healthQuery);
  const site = useQuery(siteQuery);
  const twoFactor = useQuery(twoFactorQuery);
  const sessions = useQuery(sessionsQuery);
  const myDay = useQuery(overviewMyDayQuery(today));
  const workspaces = useQuery(overviewWorkspacesQuery);
  const unread = useQuery(unreadCountQuery);
  const firstName = viewer?.name?.split(/\s+/)[0];

  const cards = (myDay.data?.items ?? []).filter(c => !c.completed);
  const more = myDay.data?.truncated ? '+' : '';
  const overdue = cards.filter(card => card.group === 'overdue').length;
  const dueToday = cards.filter(card => card.group === 'today').length;
  const thisWeek = cards.filter(card => card.group === 'next7').length;
  // The soonest first: the server returns them grouped in this order already.
  const upNext = cards.filter(card => card.group !== 'later' && card.group !== 'none').slice(0, 6);
  const shown = upNext.length ? upNext : cards.slice(0, 6);

  const role = me.data ? capitalise(me.data.roles.find(name => name !== 'member') ?? 'member') : null;
  const devices = sessions.data?.sessions.length;


  const summary = myDay.data
    ? overdue + dueToday
      ? `You have ${overdue + dueToday}${more} card${overdue + dueToday === 1 ? '' : 's'} to look at today${overdue ? `, ${overdue} of them overdue` : ''}.`
      : cards.length
        ? 'Nothing is due today. Here is what is coming up.'
        : 'Nothing is assigned to you right now.'
    : `Here is what is happening on ${site.data?.site?.name ?? 'your site'}.`;

  return (
    <div className="app-page screen-overview">
      <PageHeader
        title={firstName ? `${greeting(new Date().getHours())}, ${firstName}` : 'Welcome back'}
        description={summary}
        actions={
          <>
            <a className={buttonClass({variant: 'secondary'})} href="/">
              <Icon name="globe" size={18} />
              View the website
            </a>
            <a className={buttonClass({variant: 'primary'})} href="/app/boards">
              <Icon name="layout-kanban" size={18} />
              Open your boards
            </a>
          </>
        }
      />

      {me.error && <ErrorNote error={me.error} />}
      {health.data && !health.data.siteKey && (
        <Notice tone="info" title="Emails are not sent here">
          This copy has no Site Key, so sign-in codes and password resets are not emailed. The live site has one.
        </Notice>
      )}

      <section className="overview-section" aria-labelledby="overview-work">
        <h3 id="overview-work" className="overview-section-title">
          Your work
        </h3>
        <div className="stat-grid">
          <Stat
            label="Overdue"
            icon="alert"
            href="/app/my-day"
            value={myDay.data ? `${overdue}${more}` : myDay.error ? '—' : null}
            hint={myDay.data ? (overdue ? 'Past their due date' : 'You are on top of things') : 'Assigned to you'}
          />
          <Stat
            label="Due today"
            icon="calendar"
            href="/app/my-day"
            value={myDay.data ? `${dueToday}${more}` : myDay.error ? '—' : null}
            hint={myDay.data ? `${thisWeek}${more} more this week` : 'Assigned to you'}
          />
          <Stat
            label="Unread"
            icon="bell"
            href="/app/boards"
            value={unread.data ? `${unread.data.count}${unread.data.more ? '+' : ''}` : unread.error ? '—' : null}
            hint="Notifications and mentions"
          />
          <Stat
            label="Workspaces"
            icon="layers"
            href="/app/boards"
            value={workspaces.data ? String(workspaces.data.length) : workspaces.error ? '—' : null}
            hint="You are a member of"
          />
        </div>
      </section>

      <div className="grid-main-side">
        <div className="overview-column">
          <Card
            title="Your cards"
            description={upNext.length ? 'Overdue, due today and this week, soonest first.' : 'Cards assigned to you.'}
            flush
            actions={
              <a className={buttonClass({variant: 'ghost', size: 'sm'})} href="/app/my-day">
                Open My Day
                <Icon name="arrow-right" size={16} />
              </a>
            }>
            {myDay.error ? (
              <div className="card-body">
                <ErrorNote error={myDay.error} />
              </div>
            ) : myDay.isPending ? (
              <div className="card-body">
                <LoadingBlock rows={4} />
              </div>
            ) : shown.length ? (
              <ul className="list">
                {shown.map(card => (
                  <li key={card.id} className="list-row overview-link-row">
                    <a className="overview-row-link" href={`/app/b/${card.boardId}/c/${card.id}`}>
                      <span className="list-row-icon" data-tone={card.group === 'overdue' ? 'danger' : card.group === 'today' ? 'warning' : undefined}>
                        <Icon name="check-square" size={16} />
                      </span>
                      <span className="list-row-text">
                        <span className="list-row-title" dir="auto">
                          {card.title}
                        </span>
                        <span className="list-row-sub" dir="auto">
                          {card.boardName} · {card.laneName}
                        </span>
                      </span>
                      <span className="overview-row-end">
                        {(card.priority === 'urgent' || card.priority === 'high') && (
                          <Badge tone="danger" icon="flag">
                            {capitalise(card.priority)}
                          </Badge>
                        )}
                        <StatusBadge tone={DUE[card.group].tone}>
                          {card.dueDate && card.group !== 'today' ? shortDate(card.dueDate) : DUE[card.group].label}
                        </StatusBadge>
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState
                icon="check-circle"
                title="Nothing assigned to you"
                action={
                  <a className={buttonClass({variant: 'secondary'})} href="/app/boards">
                    Open your boards
                  </a>
                }>
                Cards assigned to you show here, with what is due first.
              </EmptyState>
            )}
          </Card>
        </div>

        <div className="overview-column">
          <Card title="Your workspaces" description="Pick one to open its boards." flush>
            {workspaces.error ? (
              <div className="card-body">
                <ErrorNote error={workspaces.error} />
              </div>
            ) : workspaces.isPending ? (
              <div className="card-body">
                <LoadingBlock rows={2} />
              </div>
            ) : workspaces.data.length ? (
              <ul className="list">
                {workspaces.data.slice(0, 6).map(workspace => (
                  <li key={workspace.id} className="list-row overview-link-row">
                    <a className="overview-row-link" href="/app/boards" onClick={() => rememberWorkspace(workspace.id)}>
                      <Avatar name={workspace.name} size="sm" />
                      <span className="list-row-text">
                        <span className="list-row-title" dir="auto">
                          {workspace.name}
                        </span>
                        <span className="list-row-sub">
                          {capitalise(workspace.role)} · {workspace.memberCount} member{workspace.memberCount === 1 ? '' : 's'}
                        </span>
                      </span>
                      <Badge tone={PLAN_TONES[workspace.plan.toLowerCase()] ?? 'neutral'}>{capitalise(workspace.plan.toLowerCase())}</Badge>
                    </a>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState
                icon="layers"
                title="No workspace yet"
                action={
                  <a className={buttonClass({variant: 'secondary'})} href="/app/boards">
                    Create a workspace
                  </a>
                }>
                Create one, or ask a teammate for an invite link.
              </EmptyState>
            )}
          </Card>

          <Card
            title="Your account"
            flush
            actions={
              <Link className={buttonClass({variant: 'ghost', size: 'sm'})} to="/account">
                Manage
                <Icon name="arrow-right" size={16} />
              </Link>
            }>
            <div className="card-body overview-account">
              {viewer?.name ? <Avatar name={viewer.name} size="lg" /> : <Skeleton width="third" />}
              <div className="overview-account-text">
                <p className="overview-account-name">{viewer?.name ?? '…'}</p>
                {role && <Badge tone={role === 'Member' ? 'neutral' : 'brand'} icon="shield">{role}</Badge>}
              </div>
            </div>
            <dl className="overview-facts">
              <div>
                <dt>Email</dt>
                <dd>{viewer ? (viewer.emailVerified ? <StatusBadge tone="success">Confirmed</StatusBadge> : <StatusBadge tone="warning">Not confirmed</StatusBadge>) : '…'}</dd>
              </div>
              <div>
                <dt>Two-step sign-in</dt>
                <dd>{twoFactor.data ? <StatusBadge tone={twoFactor.data.enabled ? 'success' : 'neutral'}>{twoFactor.data.enabled ? 'On' : 'Off'}</StatusBadge> : '…'}</dd>
              </div>
              <div>
                <dt>Signed-in devices</dt>
                <dd>{devices ?? '…'}</dd>
              </div>
            </dl>
          </Card>
        </div>
      </div>
    </div>
  );
}
