import {Component, createElement, useEffect, useState, type ComponentType, type ErrorInfo, type ReactNode} from 'react';

/**
 * Lazy widgets that can never take the shell down. `React.lazy` caches a rejected import for good and throws
 * into the router's error screen; this loader retries once, forgets a failure (the next call tries again) and
 * the widget renders nothing until its chunk is here.
 */
export type Loader<T> = {
  /** Resolves the module, or null when both tries failed. A later call tries again. */
  load: () => Promise<T | null>;
  /** The module when already loaded. */
  loaded: () => T | null;
};

export function createLoader<T>(importer: () => Promise<T>, retryDelayMs = 400): Loader<T> {
  let value: T | null = null;
  let pending: Promise<T | null> | null = null;
  const attempt = async (): Promise<T | null> => {
    try {
      return await importer();
    } catch {
      await new Promise(resolve => setTimeout(resolve, retryDelayMs));
      try {
        return await importer();
      } catch {
        return null;
      }
    }
  };
  return {
    loaded: () => value,
    load: () => {
      if (value) return Promise.resolve(value);
      if (!pending) {
        pending = attempt().then(result => {
          value = result;
          pending = null; // a failure is not cached
          return result;
        });
      }
      return pending;
    },
  };
}

class Boundary extends Component<{children: ReactNode}, {failed: boolean}> {
  state = {failed: false};
  static getDerivedStateFromError() {
    return {failed: true};
  }
  componentDidCatch(_error: Error, _info: ErrorInfo) {}
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

export type LazyProps = {onLoadError?: () => void};

export function lazyWithRetry<P extends object>(importer: () => Promise<ComponentType<P>>) {
  const loader = createLoader(importer);
  function Lazy(props: P & LazyProps) {
    const [Loaded, setLoaded] = useState<ComponentType<P> | null>(() => loader.loaded());
    const {onLoadError, ...rest} = props;
    useEffect(() => {
      if (Loaded) return;
      let live = true;
      void loader.load().then(component => {
        if (!live) return;
        if (component) setLoaded(() => component);
        else onLoadError?.();
      });
      return () => {
        live = false;
      };
      // Retried when the widget is mounted again.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [Loaded]);
    return Loaded ? createElement(Boundary, null, createElement(Loaded, rest as unknown as P)) : null;
  }
  return {
    Component: Lazy,
    preload: () => void loader.load(),
    load: () => loader.load(),
    isLoaded: () => loader.loaded() !== null,
  };
}
