import type {} from '@/utils/dom-utils';

interface ServiceWorkerContainerLike {
  readonly controller: object | null;
  addEventListener: (type: string, cb: () => void) => void;
}

export interface SwUpdateHandlerOptions {
  swContainer?: ServiceWorkerContainerLike;
  document?: unknown;
  reload?: () => void;
  raf?: (cb: () => void) => void;
  setTimer?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (id: ReturnType<typeof setTimeout> | null) => void;
  debug?: boolean;
  version?: string;
}

export const SW_DEBUG_LOG_KEY = 'wm-sw-debug-log';
export const OPEN_MODAL_SELECTOR =
  '[aria-modal="true"], [role="dialog"], .cl-modalBackdrop, .modal-overlay, dialog[open]';

/** Disabled: no "Update Available" toast on production. */
export function installSwUpdateHandler(_options?: SwUpdateHandlerOptions): void {
  // noop
}
