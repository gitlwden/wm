import { Panel } from './Panel';
import { t } from '@/services/i18n';
import type { Monitor, NewsItem } from '@/types';
import { MONITOR_COLORS } from '@/config';
import { generateId, formatTime, getCSSColor } from '@/utils';
import { sanitizeUrl } from '@/utils/sanitize';
import { h, replaceChildren, clearChildren } from '@/utils/dom-utils';

/**
 * WebKitGTK (Linux/Tauri) ignores click events on children when a parent has
 * `user-select: none`.  The `.panel-content` div carries that rule globally.
 * Rather than fighting CSS at the event level we use Pointer Events, which
 * fire reliably regardless of user-select state.
 *
 * PointerEvent guards:
 *   - only primary button (button === 0)
 *   - debounce 250 ms to collapse pointerdown → pointerup → click duplicates
 *   - stopPropagation on pointerdown so the panel drag handler never sees it
 */

export class MonitorPanel extends Panel {
  private monitors: Monitor[] = [];
  private onMonitorsChange?: (monitors: Monitor[]) => void;
  private inputEl: HTMLInputElement | null = null;
  private monitorsListEl: HTMLDivElement | null = null;
  private monitorsResultsEl: HTMLDivElement | null = null;

  constructor(initialMonitors: Monitor[] = []) {
    super({ id: 'monitors', title: t('panels.monitors'), infoTooltip: t('components.monitors.infoTooltip') });
    this.monitors = initialMonitors;
    this.renderInput();
  }

  /** Attach pointer-event-based click to an interactive element. */
  private bindPointerClick(el: HTMLElement, handler: () => void): void {
    let pending = false;
    const trigger = (e: PointerEvent) => {
      if (e.button !== 0) return;          // primary button only
      if (pending) return;
      pending = true;
      handler();
      setTimeout(() => { pending = false; }, 250);
    };
    // pointerdown: block propagation so makeDraggable never activates
    el.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
    });
    // pointerup: the actual "click"
    el.addEventListener('pointerup', (e) => {
      e.preventDefault();
      trigger(e as PointerEvent);
    });
    // Keep a native click handler as well for non-WebKitGTK browsers
    el.addEventListener('click', (e) => {
      trigger(e as unknown as PointerEvent);
    });
  }

  private renderInput(): void {
    clearChildren(this.content);

    this.inputEl = h('input', {
      type: 'text',
      className: 'monitor-input',
      id: 'monitorKeywords',
      placeholder: t('components.monitor.placeholder'),
      onKeydown: (e: Event) => { if ((e as KeyboardEvent).key === 'Enter') this.addMonitor(); },
    }) as HTMLInputElement;

    // Block pointerdown so the panel drag handler (makeDraggable) never
    // intercepts events on the input — also prevents user-select:none
    // on .panel-content from suppressing focus/click on WebKitGTK.
    this.inputEl.addEventListener('pointerdown', (e) => e.stopPropagation());

    const addBtn = h('button', {
      className: 'monitor-add-btn',
      id: 'addMonitorBtn',
      type: 'button',
    },
      t('components.monitor.add'),
    );

    // Wire the button via pointer events (see class-level JSDoc)
    this.bindPointerClick(addBtn, () => this.addMonitor());

    const inputContainer = h('div', { className: 'monitor-input-container' },
      this.inputEl,
      addBtn,
    );

    this.monitorsListEl = h('div', { id: 'monitorsList' }) as HTMLDivElement;
    this.monitorsResultsEl = h('div', { id: 'monitorsResults' }) as HTMLDivElement;

    this.content.appendChild(inputContainer);
    this.content.appendChild(this.monitorsListEl);
    this.content.appendChild(this.monitorsResultsEl);

    this.renderMonitorsList();
  }

  private addMonitor(): void {
    const input = this.inputEl ?? document.getElementById('monitorKeywords') as HTMLInputElement | null;
    if (!input) return;

    const keywords = input.value.trim();

    if (!keywords) return;

    const monitor: Monitor = {
      id: generateId(),
      keywords: keywords.split(',').map((k) => k.trim().toLowerCase()),
      color: MONITOR_COLORS[this.monitors.length % MONITOR_COLORS.length] ?? getCSSColor('--status-live'),
    };

    this.monitors.push(monitor);
    input.value = '';
    this.renderMonitorsList();
    this.onMonitorsChange?.(this.monitors);
  }

  public removeMonitor(id: string): void {
    this.monitors = this.monitors.filter((m) => m.id !== id);
    this.renderMonitorsList();
    this.onMonitorsChange?.(this.monitors);
  }

  private renderMonitorsList(): void {
    const list = this.monitorsListEl ?? document.getElementById('monitorsList');
    if (!list) return;

    replaceChildren(list,
      ...this.monitors.map((m) => {
        const removeBtn = h('span', {
          className: 'monitor-tag-remove',
        }, '×');
        this.bindPointerClick(removeBtn, () => this.removeMonitor(m.id));

        return h('span', { className: 'monitor-tag' },
          h('span', { className: 'monitor-tag-color', style: { background: m.color } }),
          m.keywords.join(', '),
          removeBtn,
        );
      }),
    );
  }

  public renderResults(news: NewsItem[]): void {
    const results = this.monitorsResultsEl ?? document.getElementById('monitorsResults');
    if (!results) return;

    if (this.monitors.length === 0) {
      replaceChildren(results,
        h('div', { style: 'color: var(--text-dim); font-size: 10px; margin-top: 12px;' },
          t('components.monitor.addKeywords'),
        ),
      );
      return;
    }

    const matchedItems: NewsItem[] = [];

    news.forEach((item) => {
      this.monitors.forEach((monitor) => {
        // Search both title and description for better coverage
        const searchText = `${item.title} ${(item as unknown as { description?: string }).description || ''}`.toLowerCase();
        const matched = monitor.keywords.some((kw) => {
          // Use word boundary matching to avoid false positives like "ai" in "train"
          const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const regex = new RegExp(`\\b${escaped}\\b`, 'i');
          return regex.test(searchText);
        });
        if (matched) {
          matchedItems.push({ ...item, monitorColor: monitor.color });
        }
      });
    });

    // Dedupe by link
    const seen = new Set<string>();
    const unique = matchedItems.filter(item => {
      if (seen.has(item.link)) return false;
      seen.add(item.link);
      return true;
    });

    if (unique.length === 0) {
      replaceChildren(results,
        h('div', { style: 'color: var(--text-dim); font-size: 10px; margin-top: 12px;' },
          t('components.monitor.noMatches', { count: String(news.length) }),
        ),
      );
      return;
    }

    const countText = unique.length > 10
      ? t('components.monitor.showingMatches', { count: '10', total: String(unique.length) })
      : `${unique.length} ${unique.length === 1 ? t('components.monitor.match') : t('components.monitor.matches')}`;

    replaceChildren(results,
      h('div', { style: 'color: var(--text-dim); font-size: 10px; margin: 12px 0 8px;' }, countText),
      ...unique.slice(0, 10).map((item) =>
        h('div', {
          className: 'item',
          style: `border-left: 2px solid ${item.monitorColor || ''}; padding-left: 8px; margin-left: -8px;`,
        },
          h('div', { className: 'item-source' }, item.source),
          h('a', {
            className: 'item-title',
            href: sanitizeUrl(item.link),
            target: '_blank',
            rel: 'noopener',
          }, item.title),
          h('div', { className: 'item-time' }, formatTime(item.pubDate)),
        ),
      ),
    );
  }

  public onChanged(callback: (monitors: Monitor[]) => void): void {
    this.onMonitorsChange = callback;
  }

  public getMonitors(): Monitor[] {
    return [...this.monitors];
  }

  public setMonitors(monitors: Monitor[]): void {
    this.monitors = monitors;
    this.renderMonitorsList();
  }
}
