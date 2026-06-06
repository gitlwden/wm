import { Panel } from './Panel';
import { sanitizeUrl } from '@/utils/sanitize';
import { t } from '@/services/i18n';
import { h, replaceChildren, safeHtml } from '@/utils/dom-utils';
import {
  TELEGRAM_TOPICS,
  fetchTelegramFeed,
  formatTelegramTime,
  type TelegramItem,
  type TelegramFeedResponse,
} from '@/services/telegram-intel';

const LIVE_THRESHOLD_MS = 600_000;

export class TelegramIntelPanel extends Panel {
  private items: TelegramItem[] = [];
  private activeTopic = 'all';
  private tabsEl: HTMLElement | null = null;
  private relayEnabled = true;
  private topicCache = new Map<string, TelegramItem[]>();

  constructor() {
    super({
      id: 'telegram-intel',
      title: t('panels.telegramIntel'),
      showCount: true,
      trackActivity: true,
      infoTooltip: t('components.telegramIntel.infoTooltip'),
      defaultRowSpan: 2,
    });
    this.createTabs();
    this.showLoading(t('components.telegramIntel.loading'));
  }

  private createTabs(): void {
    this.tabsEl = h('div', { className: 'panel-tabs' },
      ...TELEGRAM_TOPICS.map(topic =>
        h('button', {
          className: `panel-tab ${topic.id === this.activeTopic ? 'active' : ''}`,
          dataset: { topicId: topic.id },
          onClick: () => this.selectTopic(topic.id),
        }, t(topic.labelKey)),
      ),
    );
    this.element.insertBefore(this.tabsEl, this.content);
  }

  private selectTopic(topicId: string): void {
    if (topicId === this.activeTopic) return;
    this.activeTopic = topicId;

    this.tabsEl?.querySelectorAll('.panel-tab').forEach(tab => {
      tab.classList.toggle('active', (tab as HTMLElement).dataset.topicId === topicId);
    });

    // If we already have data for this topic in cache, use it
    const cached = this.topicCache.get(topicId);
    if (cached) {
      this.items = cached;
      this.renderItems();
      return;
    }

    // Otherwise fetch topic-specific data
    this.showLoading(t('components.telegramIntel.loading'));
    this.fetchTopicData(topicId);
  }

  private async fetchTopicData(topicId: string): Promise<void> {
    const topic = topicId === 'all' ? undefined : topicId;
    try {
      let result = await fetchTelegramFeed(30, topic);
      // Retry once after 3s if empty (Telegram rate limiting)
      if ((result.items || []).length === 0) {
        await new Promise(r => setTimeout(r, 3000));
        if (this.activeTopic !== topicId) return;
        result = await fetchTelegramFeed(30, topic);
      }
      if (this.activeTopic === topicId) {
        this.items = result.items || [];
        if (this.items.length > 0) this.topicCache.set(topicId, this.items);
        this.renderItems();
      }
    } catch {
      if (this.activeTopic === topicId) {
        this.items = [];
        this.renderItems();
      }
    }
  }

  public setData(response: TelegramFeedResponse & { error?: string }): void {
    this.relayEnabled = response.enabled !== false;
    this.items = response.items || [];

    if (!this.relayEnabled || response.error) {
      this.setCount(0);
      replaceChildren(this.content,
        h('div', { className: 'empty-state error' },
          response.error || t('components.telegramIntel.disabled')
        ),
      );
      return;
    }

    this.renderItems();
  }

  private renderItems(): void {
    const filtered = this.activeTopic === 'all'
      ? this.items
      : this.items.filter(item => item.topic === this.activeTopic);

    this.setCount(filtered.length);

    if (filtered.length === 0) {
      replaceChildren(this.content,
        h('div', { className: 'empty-state' }, t('components.telegramIntel.empty')),
      );
      return;
    }

    replaceChildren(this.content,
      h('div', { className: 'telegram-intel-items' },
        ...filtered.map(item => this.buildItem(item)),
      ),
    );
  }

  private buildItem(item: TelegramItem): HTMLElement {
    const timeAgo = formatTelegramTime(item.ts);
    const itemDate = new Date(item.ts).getTime();
    const isLive = !Number.isNaN(itemDate) && (Date.now() - itemDate) < LIVE_THRESHOLD_MS;
    const raw = item.text || '';
    const escaped = raw
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
    const textHtml = escaped.replace(/\n/g, '<br>');

    return h('div', { className: `telegram-intel-item ${isLive ? 'is-live' : ''}` },
      h('div', { className: 'telegram-intel-item-header' },
        h('div', { className: 'telegram-intel-channel-wrapper' },
          h('span', { className: 'telegram-intel-channel' }, item.channelTitle || item.channel),
          isLive ? h('span', { className: 'live-indicator' }, t('components.telegramIntel.live')) : null,
        ),
        h('div', { className: 'telegram-intel-meta' },
          h('span', { className: 'telegram-intel-topic' }, item.topic),
          h('span', { className: 'telegram-intel-time' }, timeAgo),
        ),
      ),
      h('div', { className: 'telegram-intel-text' }, safeHtml(textHtml)),
      item.mediaUrls && item.mediaUrls.length > 0 ? h('div', { className: 'telegram-intel-media-grid' },
        ...item.mediaUrls.map(url => {
          const isVideo = url.match(/\.(mp4|webm|mov)(\?.*)?$/i);
          if (isVideo) {
            return h('video', {
              className: 'telegram-intel-video',
              src: sanitizeUrl(url),
              controls: true,
              preload: 'metadata',
              playsinline: true,
            });
          }
          return h('img', {
            className: 'telegram-intel-image',
            src: sanitizeUrl(url),
            loading: 'lazy',
            onClick: () => window.open(sanitizeUrl(url), '_blank', 'noopener,noreferrer'),
          });
        })
      ) : null,
      h('div', { className: 'telegram-intel-item-actions' },
        h('a', {
          href: sanitizeUrl(item.url),
          target: '_blank',
          rel: 'noopener noreferrer',
          className: 'telegram-follow-btn',
        }, t('components.telegramIntel.viewSource')),
      ),
    );
  }

  public async refresh(): Promise<void> {
    // Handled by DataLoader + RefreshScheduler
  }

  public destroy(): void {
    if (this.tabsEl) {
      this.tabsEl.remove();
      this.tabsEl = null;
    }
    super.destroy();
  }
}
