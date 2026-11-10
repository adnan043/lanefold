import {siteFetch} from '../platform/browser';

import {attemptKey, forgetAttempt} from './idempotency';

/**
 * BROWSER: makes every `<BuyButton>` form (`form[data-buy]`) start its checkout with a fetch, so
 * the button shows "Opening checkout…" and an error stays next to it. Without JavaScript the same
 * form still posts and the server redirects (src/server/routes/checkout.ts).
 */
export function bindBuyButtons(): void {
  for (const form of document.querySelectorAll<HTMLFormElement>('form[data-buy]')) {
    if (form.dataset.bound) continue;
    form.dataset.bound = '1';
    const button = form.querySelector<HTMLButtonElement>('button[type="submit"]');
    const status = form.querySelector<HTMLElement>('[data-form-status]');
    if (!button) continue;
    const idle = Array.from(button.childNodes, node => node.cloneNode(true));
    const pendingLabel = button.dataset.pendingLabel ?? 'Opening checkout…';

    const setPending = (pending: boolean) => {
      button.disabled = pending;
      if (pending) {
        button.setAttribute('aria-busy', 'true');
        const spinner = document.createElement('span');
        spinner.className = 'spinner';
        spinner.setAttribute('aria-hidden', 'true');
        button.replaceChildren(spinner, document.createTextNode(pendingLabel));
      } else {
        button.removeAttribute('aria-busy');
        button.replaceChildren(...idle.map(node => node.cloneNode(true)));
      }
    };
    const fail = (message: string) => {
      setPending(false);
      if (status) {
        status.dataset.tone = 'error';
        status.textContent = message;
      }
    };

    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (button.disabled) return;
      if (status) status.textContent = '';
      setPending(true);
      const values = Object.fromEntries(new FormData(form)) as Record<string, string>;
      delete values.csrf;
      // Never a second checkout from a double click, a retry or a reload (src/lib/idempotency.ts).
      const attempt = [values.price, Number(values.quantity || 1), values.gateway ?? null, values.noTrial ?? false];
      try {
        const res = await siteFetch(form.action, {
          method: 'POST',
          headers: {'content-type': 'application/json', accept: 'application/json'},
          body: JSON.stringify({...values, quantity: Number(values.quantity || 1), idempotencyKey: attemptKey(attempt)}),
        });
        const answer = (await res.json().catch(() => null)) as {redirectUrl?: string; message?: string; paid?: boolean; error?: string} | null;
        if (answer?.paid && answer.redirectUrl?.startsWith('/')) {
          forgetAttempt(attempt);
          window.location.assign(answer.redirectUrl);
          return;
        }
        // The checkout page (to pay, to choose how, or to continue without a used trial).
        if ((res.ok || res.status === 409) && answer?.redirectUrl?.startsWith('/checkout/')) {
          window.location.assign(answer.redirectUrl);
          return;
        }
        if (res.status >= 400 && res.status < 500 && answer?.error !== 'e_site_payments_in_progress') forgetAttempt(attempt);
        fail(answer?.message ?? 'Checkout did not open. Try again.');
      } catch {
        fail('Checkout did not open. Check your connection and try again.');
      }
    });
  }
}
