import {nextPath, rememberSignUpEmail} from './account';
import {bindForm, postJson} from './form';
import {bindPasswordChecks} from './password-checks';
import {AUTH_RULES, passwordMeetsRules} from './rules';
import {siteFetch} from '../platform/browser';

/**
 * BROWSER: the "Create account" tab of `/account/login/` and `/account/register/`
 * (`src/components/auth/AuthTabs.astro`). Posts to `/site-api/auth/register`. The answer is the
 * same whether or not the email already has an account, and no account exists until the emailed
 * code comes back in this browser (`/account/verify/`).
 */
export function initSignUp(): void {
  const next = nextPath();
  const form = document.querySelector<HTMLFormElement>('#register-form')!;
  const email = form.elements.namedItem('email') as HTMLInputElement;
  const password = form.elements.namedItem('password') as HTMLInputElement;
  bindPasswordChecks(password, document.getElementById('register-password-checks')!, {email});
  bindForm(form, {
    rules: {name: AUTH_RULES.name, email: AUTH_RULES.email, password: [passwordMeetsRules(() => email.value)]},
    pendingLabel: 'Creating account…',
    async submit(values) {
      const {result} = await postJson(siteFetch, '/site-api/auth/register', values);
      if (!result.ok) return result;
      rememberSignUpEmail(String(values.email));
      return {ok: true, redirect: `/account/verify/?next=${encodeURIComponent(next)}`};
    },
  });
}
