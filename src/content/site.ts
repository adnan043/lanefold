/**
 * The site's own words: navigation, home and about copy.
 *
 * Edit freely. The site's NAME and LOGO are not here: they come from the
 * platform (`GET /site-api/site`), so a rename in the dashboard shows
 * up without a Publish. Use `{name}` in any string below for the site name.
 */

/** Search and social basics. The NAME comes from the platform (above). */
export const SITE = {
  /** One sentence: the meta description of pages that have none of their own. Use `{name}`. */
  description: '{name} is a kanban app with built-in chat: boards, cards and team conversation in one workspace, with a free plan to start.',
  /** `en`, `fr`, … : the page language (screen readers, search engines). */
  lang: 'en',
  /**
   * The address search engines should treat as THE address (canonical URLs,
   * sitemap, social cards): set it to the custom domain once the owner has one
   * (`https://www.example.com`, no trailing slash). Empty = the address
   * The platform gives the site (`SITE_URL`, src/lib/seo.ts).
   */
  url: '',
};

export interface NavItem {
  label: string;
  href: string;
  /**
   * `false` for a page rendered on every visit (rendered on every visit): it is
   * private (`no-store`), so fetching it ahead would be wasted. Every other
   * item is prerendered and prefetched as soon as the nav is on screen.
   */
  prefetch?: false;
}

/** Top navigation. Every href is a page of THIS site: plain links. */
export const NAV: NavItem[] = [
  {label: 'Features', href: '/features/'},
  {label: 'Pricing', href: '/pricing/', prefetch: false},
];

/** The footer's "Explore" column: every public page, the blog and about included. */
export const FOOTER_NAV: NavItem[] = [
  {label: 'Home', href: '/'},
  {label: 'Features', href: '/features/'},
  {label: 'Pricing', href: '/pricing/', prefetch: false},
  {label: 'Blog', href: '/blog/'},
  {label: 'About', href: '/about/'},
];

/** The signed-in visitor's menu in the header (the round avatar). */
export const USER_MENU = {
  label: 'Account menu',
  items: [
    {label: 'Dashboard', href: '/dashboard', icon: 'dashboard'},
    {label: 'Your boards', href: '/app', icon: 'briefcase'},
  ],
  signOut: 'Sign out',
};

/** The home page, top to bottom (`src/pages/index.astro`). No invented reviews or numbers. */
export const HOME = {
  /** The home page's meta description (about 150 characters). */
  description: 'Lanefold is a kanban app with built-in chat: boards, lanes and cards with the team conversation beside them. Free to start, flat plans per workspace.',
  hero: {
    eyebrow: '{name}: kanban with built-in chat',
    title: 'Plan on the board, talk right beside it',
    highlight: 'talk right beside it',
    body: 'Boards, lanes and cards for the work, and chat for the conversation about it, in the same workspace. No more switching between a task tool and a messenger.',
    note: 'Free to start. No card needed.',
    /** Three short promises under the buttons (each true of the Free plan). */
    points: ['Free plan for small teams', 'Flat price per workspace', 'Chat included'],
    guest: {primary: 'Start free', secondary: 'See pricing'},
    user: {primary: 'Open your boards', secondary: 'Read the blog'},
    userHref: '/app',
  },
  /** The picture next to the headline: illustrative only, hidden from screen readers. */
  visual: {
    title: 'Launch board',
    lanes: [
      {name: 'To do', tone: 'info', cards: [{title: 'Draft release notes', flag: false}, {title: 'Review pricing copy', flag: false}]},
      {name: 'In progress', tone: 'warning', cards: [{title: 'Fix login on mobile', flag: true, talk: true}, {title: 'Write the launch checklist', flag: false}]},
      {name: 'Done', tone: 'success', cards: [{title: 'Set up the workspace', flag: false}]},
    ],
    chatTitle: 'Chat on this board',
    nav: ['Boards', 'My Day', 'Inbox', 'Chat'],
    chat: [
      {who: 'Sam', text: 'Login fails on small phones. Can someone look?', mine: false},
      {who: 'You', text: 'On it, moving the card now.', mine: true},
    ],
  },
  features: {
    eyebrow: 'What you get',
    title: 'One place for the work and the talk',
    body: 'The essentials of a kanban tool, with the conversation attached instead of left in another app.',
    items: [
      {icon: 'dashboard', title: 'Boards, lanes and cards', body: 'Drag cards across lanes, set owners and dates, and see at a glance where every piece of work stands.', size: 'wide', art: 'board'},
      {icon: 'chat', title: 'Chat built in', body: 'Talk in a channel or right on a board, and link a message to the card it is about.', size: 'tall', art: 'chat'},
      {icon: 'sun', title: 'My Day and Inbox', body: 'See what is yours today across every board, and jot ideas in the Inbox to sort into a board later.'},
      {icon: 'command', title: 'Keyboard first', body: 'A command palette and shortcuts to move around and add cards without the mouse.'},
      {icon: 'shield', title: 'Roles and access', body: 'Invite your team and decide who can edit and who can only read.'},
      {icon: 'import', title: 'Import from Trello', body: 'Bring a board over from a Trello JSON export, and export any board to JSON or CSV.'},
      {icon: 'phone', title: 'Works on every screen', body: 'Phone, tablet or computer: the same boards and the same chat.'},
    ],
  },
  /** The strip of small pills under the hero: things that are built, nothing invented. */
  chips: ['Kanban boards', 'Board chat', 'Channels', 'My Day', 'Inbox', 'Command palette', 'Keyboard shortcuts', 'Calendar', 'Board dashboard', 'Workload', 'Flows', 'Labels', 'Checklists', 'Trello import', 'CSV export', 'Dark mode', '20 languages'],
  /** Three alternating rows, each a feature with a small drawing (`art`). */
  spotlight: {
    eyebrow: 'A closer look',
    title: 'Made for the way teams really work',
    rows: [
      {
        art: 'chat',
        tag: 'Chat',
        title: 'Talk where the work is',
        body: 'Every board has its own chat, and channels keep the whole team in one place. Link a message to a card so the reason behind a change is never lost.',
        bullets: ['Channels and board chat', '@mentions that notify the person', 'Link any message to a card'],
      },
      {
        art: 'myday',
        tag: 'My Day',
        title: 'Start every morning knowing what is yours',
        body: 'My Day gathers the cards assigned to you and due soon from every board. Notifications tell you what changed and who needs you.',
        bullets: ['Your cards from all boards', 'Due dates at a glance', 'Notifications for mentions and changes'],
      },
      {
        art: 'palette',
        tag: 'Keyboard',
        title: 'Move fast without the mouse',
        body: 'Press Ctrl K (or ⌘K) to jump to any board, card or person, or start a new board. Shortcuts cover the things you do every day.',
        bullets: ['Command palette', 'Shortcuts for common actions', 'Add a card with one key'],
      },
    ],
  },
  /** Four ways to see one board (`art` picks the drawing). */
  views: {
    eyebrow: 'Views',
    title: 'One board, four ways to see it',
    body: 'Switch views in a click. The cards stay the same, only the picture changes.',
    items: [
      {art: 'board', title: 'Board', body: 'Lanes and cards you drag across, with swimlanes when you need them.'},
      {art: 'table', title: 'Dashboard', body: 'Cards per lane and per person, overdue, due soon and a weekly chart.'},
      {art: 'calendar', title: 'Calendar', body: 'Cards on the days they are due.'},
      {art: 'timeline', title: 'Workload', body: 'Who is carrying how much: open, overdue and due-soon cards per person.'},
    ],
  },
  /** Who it is for: plain examples, no customer names. */
  teams: {
    eyebrow: 'For every team',
    title: 'One app, many kinds of work',
    items: [
      {icon: 'dashboard', tone: 'mint', title: 'Product and engineering', body: 'Plan releases, track bugs and keep the discussion on the card it is about.'},
      {icon: 'sparkles', tone: 'sky', title: 'Marketing and content', body: 'Run a content calendar and review drafts with the team in the board chat.'},
      {icon: 'briefcase', tone: 'peach', title: 'Operations', body: 'Turn checklists into lanes and see what is waiting, in progress and done.'},
      {icon: 'user', tone: 'leaf', title: 'Agencies and freelancers', body: 'A board per client, and a read-only share link when they want to follow along.'},
    ],
  },
  /** Control and safety: only things that are built. */
  trust: {
    eyebrow: 'Safe by default',
    title: 'Your workspace, under your control',
    body: 'Decide who sees what, sign in safely, and take your data with you whenever you like.',
    items: [
      {icon: 'shield', title: 'Roles and permissions', body: 'Owners, admins, members and viewers, each with the right access.'},
      {icon: 'mail', title: 'Sign in with a code', body: 'A 6-digit code by email, so nobody needs to remember a password.'},
      {icon: 'lock', title: 'Two-step sign-in', body: 'Add an authenticator app for an extra lock on your account.'},
      {icon: 'import', title: 'Export any time', body: 'Download any board as JSON or CSV. Your work is never stuck.'},
    ],
  },
  /** A short look at the plans; the full table is on /pricing/. */
  plansTeaser: {
    eyebrow: 'Plans',
    title: 'Start free, grow when you need to',
    body: 'Every plan is a flat price for the whole workspace, not per person.',
    link: 'Compare all plans',
  },
  how: {
    eyebrow: 'How it works',
    title: 'Up and running in three steps',
    steps: [
      {title: 'Create a workspace', body: 'Sign up with your email and name your workspace. It takes about a minute.'},
      {title: 'Add a board', body: 'Make lanes for your process and add the first cards.'},
      {title: 'Invite your team', body: 'Share the workspace, plan together and keep the conversation next to the cards.'},
    ],
  },
  faq: {
    eyebrow: 'Questions',
    title: 'Questions, answered',
    items: [
      {
        q: 'What is Lanefold?',
        a: 'A kanban app with chat built in. You plan work on boards with lanes and cards, and your team talks about it in channels and on the boards themselves.',
      },
      {
        q: 'Is it free?',
        a: 'Yes, there is a Free plan for small teams. Pro and Team raise the member and storage limits. See the pricing page for the limits of each plan.',
      },
      {
        q: 'How is pricing set up?',
        a: 'Per workspace, not per person. A plan covers everyone in the workspace, up to that plan\'s member limit.',
      },
      {
        q: 'Can I move over from Trello?',
        a: 'Yes. Export your board from Trello as JSON, then choose Settings, Import and export in your workspace. Lanes, cards, labels, checklists and comments come across, and attachments arrive as links. Trello CSV files are not read; boards can be exported from Lanefold as JSON or CSV.',
      },
      {
        q: 'Can I use it on my phone?',
        a: 'Yes. Every page works on phones, tablets and computers.',
      },
      {
        q: 'I forgot my password. What now?',
        a: 'Choose Sign in, then Forgot your password. We email you a link to set a new one.',
      },
    ],
  },
  cta: {
    eyebrow: 'Free to start',
    title: 'Ready to try {name}?',
    body: 'Create your account, make a workspace and add your first board.',
    /** `{members}` is filled from PLAN_DEFAULTS.free on the page. */
    points: ['Free for up to {members} members', 'Boards and chat in one place', 'Bring your boards from Trello'],
    primary: 'Start free',
    secondary: 'Sign in',
  },
};

/**
 * The default plan limits, as the app enforces them (the `plan_limits` seed in the first migration and
 * `FALLBACK_LIMITS` in `src/server/entitlements.ts`). The pricing page is prerendered, so the numbers are
 * kept here and `tests/marketing.test.ts` fails when they differ from those defaults. When the owner edits a
 * plan in /dashboard (Plan limits) the live app follows at once, but this page needs a code change and a Publish.
 */
export const PLAN_DEFAULTS = {
  free: {members: 10, fileMb: 10, storageGb: 1, flows: 0, auditLog: false},
  pro: {members: 50, fileMb: 100, storageGb: 20, flows: 10, auditLog: false},
  team: {members: 100, fileMb: 100, storageGb: 100, flows: 100, auditLog: true},
} as const;

const D = PLAN_DEFAULTS;
const storage = (gb: number) => `${gb} GB`;
/** The compare table's Flows cell: how many a workspace may keep, or none. */
export const flowsCell = (max: number) => (max > 0 ? `Up to ${max}` : 'Not included');

export const PRICING = {
  title: 'Pricing',
  eyebrow: 'Pricing',
  heading: 'Simple plans that grow with your team',
  plansLabel: 'Plans',
  /** What the Free plan's price slot shows (it has no price in the catalogue). */
  freePrice: 'Free',
  includedTitle: 'Every plan includes',
  includedBody: 'The whole app is yours on every plan. Paid plans add room for more people and files, and Flows to automate the routine.',
  included: [
    {icon: 'dashboard', title: 'Unlimited boards', body: 'Boards, lanes, cards, labels and checklists.'},
    {icon: 'chat', title: 'Built-in chat', body: 'Channels and a chat on every board.'},
    {icon: 'sun', title: 'My Day and Inbox', body: 'What is yours today, and a place for quick notes.'},
    {icon: 'command', title: 'Command palette', body: 'Keyboard shortcuts and quick add.'},
    {icon: 'import', title: 'Import and export', body: 'From a Trello export in, JSON or CSV out.'},
    {icon: 'globe', title: '20 languages', body: 'On phone, tablet and computer.'},
  ],
  faqLede: 'Anything else? Sign up free and look around: the Free plan has every core feature.',
  endTitle: 'Start on the Free plan today',
  endBody: 'Make a workspace, add a board and invite your team. Upgrade only when you need more room.',
  endCta: 'Create your workspace',
  description: 'Simple flat plans per workspace: Free, Pro and Team. Everyone in the workspace is covered, up to the plan\'s member limit.',
  lede: 'Flat plans per workspace, not per person. Start free and upgrade when your team outgrows it.',
  testNote: 'Payments run in test mode for now: no real money is charged.',
  /** Billing can be switched off by the site owner (free for all); the page is static, so it says so instead of guessing. */
  modeNote: 'These are the plan limits when billing is on. If the site owner runs {name} free for everyone, the member and storage limits are not enforced.',
  /** Shown instead of the two notes above when the site owner runs it free for everyone. */
  freeNote: '{name} is free for everyone right now: every feature is open, and the member and storage limits below are not enforced.',
  popularLabel: 'Most popular',
  perWorkspace: 'per workspace, not per person',
  /** Signed-in visitors see this instead of a sign-up button; it opens the workspace's billing screen. */
  changePlan: 'Change plan',
  changePlanHref: '/app/settings/billing',
  compareTitle: 'Compare the limits',
  compareCaption: 'What each plan includes. Limits apply to the whole workspace.',
  compareHeaders: {plan: 'Plan', members: 'Members', file: 'Per file', storage: 'Storage', flows: 'Flows (automations)', audit: 'Audit log'},
  yes: 'Included',
  no: 'Not included',
  plans: [
    {
      key: 'free',
      name: 'Free',
      blurb: 'For a small team getting started.',
      cta: 'Start free',
      featured: false,
      lead: 'Everything you need to start:',
      limits: {members: String(D.free.members), file: `${D.free.fileMb} MB`, storage: storage(D.free.storageGb), flows: flowsCell(D.free.flows), audit: D.free.auditLog},
      features: ['Boards, cards and chat', 'My Day and Inbox', 'Keyboard shortcuts and command palette', `Up to ${D.free.members} members`],
    },
    {
      key: 'pro',
      name: 'Pro',
      blurb: 'For a growing team that shares more files.',
      cta: 'Sign up',
      featured: true,
      lead: 'Everything in Free, plus:',
      limits: {members: String(D.pro.members), file: `${D.pro.fileMb} MB`, storage: storage(D.pro.storageGb), flows: flowsCell(D.pro.flows), audit: D.pro.auditLog},
      features: [`Up to ${D.pro.members} members`, `${D.pro.fileMb} MB per file`, `${storage(D.pro.storageGb)} of storage`, `Up to ${D.pro.flows} flows (automations)`],
    },
    {
      key: 'team',
      name: 'Team',
      blurb: 'For larger teams that need control.',
      cta: 'Sign up',
      featured: false,
      lead: 'Everything in Pro, plus:',
      limits: {members: String(D.team.members), file: `${D.team.fileMb} MB`, storage: storage(D.team.storageGb), flows: flowsCell(D.team.flows), audit: D.team.auditLog},
      features: [`Up to ${D.team.members} members`, `${storage(D.team.storageGb)} of storage`, `Up to ${D.team.flows} flows (automations)`, 'Audit log'],
    },
  ],
  faqTitle: 'Questions',
  faq: [
    {q: 'Is the price per person?', a: 'No. Each plan is a flat price for the whole workspace, up to its member limit.'},
    {q: 'Can I change plan later?', a: 'Yes. A workspace owner or admin can upgrade from the workspace billing screen after signing up.'},
    {q: 'Is real money charged?', a: 'Not yet. Checkout is in test mode for now, so nothing is charged.'},
  ],
};

/** The features page (`src/pages/features.astro`): only what is built. */
export const FEATURES = {
  title: 'Features',
  description: 'Everything in {name}: kanban boards, built-in chat, My Day and Inbox, four views, Flows automations, roles, import and export, on every device and in 20 languages.',
  hero: {
    eyebrow: 'Features',
    title: 'Everything your team needs, in one calm place',
    /** Words of `title` drawn in the accent gradient. */
    highlight: 'one calm place',
    body: 'Boards for the work, chat for the conversation, and the small things that make every day faster. All of it on the Free plan, with Flows on Pro and Team.',
    primary: 'Start free',
    secondary: 'See pricing',
    user: {primary: 'Open your boards', href: '/app'},
  },
  groups: [
    {
      id: 'boards',
      icon: 'dashboard',
      tone: 'mint',
      title: 'Boards, lanes and cards',
      body: 'Plan any process as lanes and move cards across them as the work moves.',
      items: [
        {icon: 'move', title: 'Drag and drop', body: 'Move cards between lanes and boards, by mouse, touch or keyboard.'},
        {icon: 'tag', title: 'Labels, checklists and due dates', body: 'Everything a card needs, without popups on top of popups.'},
        {icon: 'rows', title: 'Swimlanes', body: 'Group a board into rows by person, label or priority.'},
        {icon: 'filter', title: 'Filters and saved filters', body: 'Find the cards you care about and keep the filter for next time.'},
        {icon: 'copy', title: 'Templates', body: 'Start a new board or card from one you already use.'},
        {icon: 'repeat', title: 'Custom fields and recurring cards', body: 'Add your own fields and let routine cards come back on a schedule.'},
      ],
    },
    {
      id: 'chat',
      icon: 'chat',
      tone: 'sky',
      title: 'Chat built in',
      body: 'The conversation lives next to the work, so nobody has to switch apps.',
      items: [
        {icon: 'hash', title: 'Channels', body: 'A place for the whole team, a project or a topic.'},
        {icon: 'chat', title: 'Board chat', body: 'Every board has its own chat beside the lanes.'},
        {icon: 'at', title: '@mentions', body: 'Call someone in and they get a notification.'},
        {icon: 'link', title: 'Link messages to cards', body: 'Keep the reason behind a change with the card it changed.'},
      ],
    },
    {
      id: 'focus',
      icon: 'sun',
      tone: 'peach',
      title: 'My Day and Inbox',
      body: 'See what needs you without opening every board.',
      items: [
        {icon: 'sun', title: 'My Day', body: 'Your cards, due soon, from all your boards in one list.'},
        {icon: 'inbox', title: 'Inbox', body: 'Jot a card down now and sort it into a board later.'},
        {icon: 'at', title: 'Notifications', body: 'Mentions, assignments and changes on the cards you follow.'},
        {icon: 'mail', title: 'Email notifications', body: 'Opt in to get the important updates by email.'},
      ],
    },
    {
      id: 'views',
      icon: 'globe',
      tone: 'leaf',
      title: 'Views',
      body: 'One board, four ways to see it. The cards stay the same.',
      items: [
        {icon: 'dashboard', title: 'Board', body: 'Lanes and cards, the kanban way.'},
        {icon: 'calendar', title: 'Calendar', body: 'Cards on the days they are due.'},
        {icon: 'table', title: 'Dashboard', body: 'Cards per lane and per person, overdue, due soon and a weekly chart.'},
        {icon: 'timeline', title: 'Workload', body: 'Who is carrying how much, person by person.'},
      ],
    },
    {
      id: 'keyboard',
      icon: 'command',
      tone: 'mint',
      title: 'Keyboard first',
      body: 'Fast for people who live on the keyboard, simple for everyone else.',
      items: [
        {icon: 'command', title: 'Command palette', body: 'Ctrl K or ⌘K to jump to any board or card, or run an action.'},
        {icon: 'keyboard', title: 'Shortcuts', body: 'Add a card, search and move around without the mouse.'},
        {icon: 'layers', title: 'Bulk actions', body: 'Select many cards and move, label or archive them at once.'},
      ],
    },
    {
      id: 'flows',
      icon: 'sparkles',
      tone: 'peach',
      title: 'Flows (automations)',
      body: 'Let the board do the routine steps for you. On the Pro and Team plans; board admins set them up.',
      items: [
        {icon: 'sparkles', title: 'When something happens', body: 'A card is added, moved into a lane, or is due in a set number of days.'},
        {icon: 'tag', title: 'Only the cards you mean', body: 'Limit a flow to a lane, or to cards with a chosen label.'},
        {icon: 'layers', title: 'Up to three steps', body: 'Assign someone, add a label, move the card, post a comment or send a notification.'},
        {icon: 'shield', title: 'Safe by design', body: 'A failing flow never blocks your change, and flows cannot loop on themselves.'},
      ],
    },
    {
      id: 'team',
      icon: 'shield',
      tone: 'sky',
      title: 'Team and control',
      body: 'Invite people, decide what they can do and keep your account safe.',
      items: [
        {icon: 'user-plus', title: 'Invites', body: 'Invite by link or by email.'},
        {icon: 'users', title: 'Roles', body: 'Owners, admins, members and viewers.'},
        {icon: 'globe', title: 'Public share links', body: 'A read-only link to a board for people outside the team.'},
        {icon: 'lock', title: 'Safe sign-in', body: 'Sign in with a code by email, and add two-step sign-in.'},
        {icon: 'history', title: 'Audit log', body: 'On the Team plan: who changed what, and when.'},
      ],
    },
    {
      id: 'data',
      icon: 'import',
      tone: 'peach',
      title: 'Your data, your way',
      body: 'Come over from Trello in minutes and leave with everything if you ever want to.',
      items: [
        {icon: 'import', title: 'Import from Trello', body: 'Lanes, cards, labels, checklists and comments from a Trello JSON export.'},
        {icon: 'download', title: 'Export to JSON or CSV', body: 'Download any board whenever you like.'},
      ],
    },
    {
      id: 'everywhere',
      icon: 'phone',
      tone: 'leaf',
      title: 'Works everywhere',
      body: 'The same boards and the same chat on every screen and in your language.',
      items: [
        {icon: 'monitor', title: 'Phone, tablet and computer', body: 'A layout made for each, with a bottom bar on phones.'},
        {icon: 'languages', title: '20 languages', body: 'Including right-to-left languages like Arabic and Urdu.'},
      ],
    },
  ],
  cta: {
    eyebrow: 'Free to start',
    title: 'Try it free, upgrade when you need more',
    body: 'Create your workspace, add a board and invite your team.',
    /** True of the Free plan (the groups above); nothing invented. */
    points: ['Boards and chat in one place', 'All four views of every board', 'My Day and Inbox for each person'],
    primary: 'Start free',
    user: {primary: 'Open your boards', href: '/app'},
    secondary: 'See pricing',
  },
};

/** The account pages' brand panel (`src/components/auth/AuthShell.astro`). Nothing invented: no reviews, no numbers. */
export const AUTH = {
  asideLabel: 'About this app',
  asideTitle: 'Plan on the board, talk right beside it',
  asideBody: 'Boards, lanes and cards for the work, and chat for the conversation about it, in one workspace.',
  mock: {
    lane: 'In progress',
    cards: ['Fix login on mobile', 'Write the launch checklist'],
    message: 'Login fails on small phones. Can someone look?',
    reply: 'On it, moving the card now.',
  },
  points: ['Free plan for small teams', 'Chat built into every board', 'Flat price per workspace, not per person'],
};

export const ABOUT = {
  title: 'About {name}',
  lede: 'A kanban app where the conversation lives next to the work.',
  sections: [
    {
      heading: 'Why Lanefold',
      body: 'Plans live in one tool and the talk about them in another, so the reasons behind a card get lost. {name} keeps boards and chat in the same workspace, so a card and the conversation about it stay together.',
    },
    {
      heading: 'What it does',
      body: 'Boards with lanes and cards. My Day shows what needs you, and the Inbox holds quick notes until you sort them. Channel and board chat sit beside the work. Roles control who can do what.',
    },
    {
      heading: 'How to take part',
      body: 'Create a free account, make a workspace and add your first board. Plans are flat per workspace, so upgrade only when you need more members or storage.',
    },
  ],
};

/** Fill `{name}` with the site's name. */
export function withName(text: string, name: string): string {
  return text.replaceAll('{name}', name);
}
