export interface SwUpdateHandlerOptions {
  swContainer?: { readonly controller: object | null; addEventListener: (type: string, cb: () => void) => void };
  document?: unknown;
  reload?: () => void;
  raf?: (cb: () => void) => void;
  setTimer?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (id: ReturnType<typeof setTimeout> | null) => void;
  debug?: boolean;
  version?: string;
}

/** Disabled: no "Update Available" toast on production. */
export function installSwUpdateHandler(_options?: SwUpdateHandlerOptions): void {
  // noop
}
