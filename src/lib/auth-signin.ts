import {nextPath} from './account';
import {bindForm, postJson} from './form';
import {AUTH_RULES, rules} from './rules';
import {siteFetch} from '../platform/browser';

/**
 * BROWSER: the "Sign in" tab of `/account/login/` and `/account/register/`
 * (`src/components/auth/AuthTabs.astro`). The usual way is a 6-digit code emailed to the
 * account (`/site-api/auth/code`, then `/code/verify`): no password needed, and the site's admin
 * signs in this way. "Use a password instead" posts to `/site-api/auth/login` for an account that
 * set one. With two-step sign-in on, the first step answers a challenge and the authenticator step
 * (`/site-api/auth/login/two-factor`) finishes it; `?mfa=<challenge>` opens that step directly (a
 * one-click sign-in from the dashboard, owner.ts). `?notice=` explains why the visitor landed here.
 *
 * Returns `true` when `?mfa=` opened the authenticator step (the caller then skips the
 * "already signed in?" check and shows this tab).
 */
export function initSignIn(): boolean {
  const NOTICES: Record<string, string> = {
    'owner-link': 'That sign-in link has expired or was already used. Open the portal again from the dashboard, or sign in below.',
    suspended: 'This account is suspended. Contact the site owner.',
  };

  const params = new URLSearchParams(window.location.search);
  const next = nextPath();
  const notice = params.get('notice');
  const $ = <T extends HTMLElement>(id: string) => document.querySelector<T>(`#${id}`)!;
  const noticeBox = $('login-notice');
  if (notice && NOTICES[notice]) {
    noticeBox.textContent = NOTICES[notice];
    noticeBox.hidden = false;
  }

  const emailForm = $<HTMLFormElement>('email-form');
  const emailCodeForm = $<HTMLFormElement>('email-code-form');
  const loginForm = $<HTMLFormElement>('login-form');
  const codeForm = $<HTMLFormElement>('code-form');
  const forms = [emailForm, emailCodeForm, loginForm, codeForm];
  const titleEl = $('login-title');
  const leadEl = $('login-lead');
  const initialLead = leadEl.dataset.signin ?? '';
  let challenge = '';
  let email = '';

  function show(form: HTMLFormElement, title: string, focus: string, lead = initialLead) {
    for (const f of forms) f.hidden = f !== form;
    titleEl.textContent = title;
    leadEl.textContent = lead;
    $('use-password').hidden = form !== emailForm;
    $('use-code').hidden = form !== loginForm;
    $('login-links').hidden = form === codeForm || form === emailCodeForm;
    $<HTMLInputElement>(focus).focus();
  }

  /** Two-step sign-in: keep the challenge in memory only, ask for the authenticator code. */
  function askTwoFactor(value: string) {
    challenge = value;
    noticeBox.hidden = true;
    show(codeForm, 'Enter your code', 'login-code', 'One more step: the code from your authenticator app.');
  }

  /** After a one-click sign-in from the dashboard when two-step sign-in is on (`?mfa=`, 5 minutes). */
  const mfa = params.get('mfa');
  if (mfa) {
    history.replaceState(history.state, '', window.location.pathname + (params.get('next') ? `?next=${encodeURIComponent(next)}` : ''));
    askTwoFactor(mfa);
  }

  const done = (data: {next?: unknown} | null | undefined) => ({ok: true as const, redirect: typeof data?.next === 'string' ? data.next : next});

  async function sendCode(address: string) {
    const {result} = await postJson(siteFetch, '/site-api/auth/code', {email: address, next});
    if (result.ok) {
      email = address;
      $('email-code-lead').textContent = `If ${address} has an account here, we sent it a 6-digit code. It works for 10 minutes. Check your spam folder if it isn't there.`;
    }
    return result;
  }

  bindForm(emailForm, {
    rules: {email: AUTH_RULES.email},
    pendingLabel: 'Sending…',
    async submit(values) {
      const result = await sendCode(String(values.email).trim());
      if (result.ok) {
        show(emailCodeForm, 'Check your email', 'email-code', 'Enter the 6-digit code we just sent.');
        return {ok: true};
      }
      return result;
    },
  });

  bindForm(emailCodeForm, {
    rules: {code: [rules.required('Enter the 6-digit code from the email.')]},
    pendingLabel: 'Checking…',
    async submit(values) {
      const {result, data} = await postJson(siteFetch, '/site-api/auth/code/verify', {email, code: values.code, next});
      if (result.ok && data?.twoFactor === true && typeof data.challenge === 'string') {
        askTwoFactor(data.challenge);
        return {ok: true};
      }
      return result.ok ? done(data) : result;
    },
  });

  $('code-resend').addEventListener('click', async () => {
    const button = $<HTMLButtonElement>('code-resend');
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    const result = await sendCode(email);
    button.disabled = false;
    button.removeAttribute('aria-busy');
    const status = emailCodeForm.querySelector<HTMLElement>('[data-form-status]')!;
    status.textContent = result.ok ? 'We sent a new code. Only the newest one works.' : result.message ?? 'That did not work. Try again in a moment.';
    status.hidden = false;
  });
  $('code-other-email').addEventListener('click', () => show(emailForm, 'Welcome back', 'login-email'));
  $('use-password').addEventListener('click', () => {
    $<HTMLInputElement>('login-password-email').value = $<HTMLInputElement>('login-email').value;
    show(loginForm, 'Welcome back', 'login-password-email', 'Sign in with your email and password.');
  });
  $('use-code').addEventListener('click', () => {
    $<HTMLInputElement>('login-email').value = $<HTMLInputElement>('login-password-email').value;
    show(emailForm, 'Welcome back', 'login-email');
  });

  bindForm(loginForm, {
    rules: {email: AUTH_RULES.email, password: AUTH_RULES.password},
    pendingLabel: 'Signing in…',
    async submit(values) {
      const {result, data} = await postJson(siteFetch, '/site-api/auth/login', {...values, next});
      if (result.ok && data?.twoFactor === true && typeof data.challenge === 'string') {
        askTwoFactor(data.challenge);
        return {ok: true};
      }
      // A wrong email or password is ONE generic line (the server never says which).
      return result.ok ? done(data) : result;
    },
  });

  bindForm(codeForm, {
    rules: {code: [rules.required('Enter the 6-digit code from your app, or a recovery code.')]},
    pendingLabel: 'Checking…',
    async submit(values) {
      const {result, data, res} = await postJson(siteFetch, '/site-api/auth/login/two-factor', {...values, challenge, next});
      if (res?.status === 401) {
        // The challenge expired (5 minutes) or the password changed: start again.
        window.location.replace(`/account/login/?next=${encodeURIComponent(next)}`);
        return result;
      }
      return result.ok ? done(data) : result;
    },
  });

  return Boolean(mfa);
}
