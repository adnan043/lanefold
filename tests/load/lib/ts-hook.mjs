// Lets plain `node` import the site's TypeScript helpers (src/platform/auth/password.ts imports './encoding'
// without an extension). Node strips the types itself; this hook only adds the missing `.ts`.
//   node --import ./tests/load/lib/ts-hook.mjs …
import {registerHooks} from 'node:module';

registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (err) {
      if (specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier)) return next(`${specifier}.ts`, context);
      throw err;
    }
  },
});
