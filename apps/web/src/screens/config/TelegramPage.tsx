import { useCallback, useEffect, useState } from 'react';
import type { ApiClient } from '../../api/client';
import { getTelegramChannel, sendTelegramTest, updateTelegramChannel } from '../../api/channels';
import { listProfiles } from '../../api/profiles';
import type { TelegramChannelUpdate, TelegramChannelView } from '../../api/types';
import { EditableText, Toggle } from './SettingsFields';
import styles from './SystemPages.module.css';

const REFRESH_MS = 5000;

export interface TelegramPageProps {
  /** The service serving this page, never a workspace host: the bot runs here. */
  client: ApiClient;
}

/** Settings › Channels › Telegram: the serving device's Telegram bot —
 * settings, live health, its allowed users with recently ignored senders, and
 * a test message. The token is write-only. Other channels get their own page. */
export function TelegramPage({ client }: TelegramPageProps) {
  const [view, setView] = useState<TelegramChannelView>();
  const [profiles, setProfiles] = useState<string[]>([]);
  const [problem, setProblem] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [proxy, setProxy] = useState<string>();
  const [token, setToken] = useState('');
  const [newId, setNewId] = useState('');

  const refresh = useCallback(async () => {
    try {
      setView(await getTelegramChannel(client));
    } catch (error) {
      setProblem(messageOf(error));
    }
  }, [client]);

  useEffect(() => {
    void refresh();
    void listProfiles(client).then(list => setProfiles(list.map(profile => profile.name))).catch(() => undefined);
    const timer = setInterval(() => { void refresh(); }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [client, refresh]);

  async function save(update: TelegramChannelUpdate, done?: () => void): Promise<void> {
    setBusy(true);
    setNotice(undefined);
    try {
      setView(await updateTelegramChannel(client, update));
      setProblem(undefined);
      done?.();
    } catch (error) {
      setProblem(messageOf(error));
    } finally {
      setBusy(false);
    }
  }

  async function sendTest(userId: number): Promise<void> {
    setBusy(true);
    setNotice(undefined);
    try {
      await sendTelegramTest(client, userId);
      setProblem(undefined);
      setNotice(`Test message sent to ${userId}.`);
    } catch (error) {
      setProblem(messageOf(error));
    } finally {
      setBusy(false);
    }
  }

  if (!view) {
    return <div className={styles.empty}>{problem ?? 'Loading channel settings…'}</div>;
  }

  const allowlist = view.allowlist;
  const ignored = (view.bridge?.ignoredSenders ?? []).filter(sender => !allowlist.includes(sender.id));
  const parsedId = Number(newId.trim());
  const validId = Number.isSafeInteger(parsedId) && parsedId > 0 && !allowlist.includes(parsedId);
  const proxyValue = proxy ?? view.proxy ?? '';
  const profileOptions = profiles.includes(view.profile) ? profiles : [view.profile, ...profiles];

  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <div>
          <div className={styles.pageTitle}>Telegram</div>
          <div className={styles.pageSub}>Messaging channel: talk to a profile from Telegram. The bot runs inside this device's service; other workspace devices never see or change it.</div>
        </div>
      </header>

      {problem ? <div className={styles.problem} role="alert">{problem}</div> : null}
      {notice ? <div className={styles.note} role="status">{notice}</div> : null}

      <section className={styles.card} aria-label="Bot">
        <div className={styles.cardTitle}>Bot</div>
        <div className={styles.fieldRow}>
          <span className={styles.fieldLabel}>Status</span>
          <span className={styles.fieldStatic}>{statusText(view)}</span>
        </div>
        <div className={styles.fieldRow}>
          <span className={styles.fieldLabel}>Bot enabled</span>
          <Toggle label="Bot enabled" value={view.enabled} busy={busy} onChange={enabled => void save({ enabled })} />
        </div>
        <div className={styles.fieldRow}>
          <label className={styles.fieldLabel} htmlFor="telegram-profile">Profile</label>
          <select
            id="telegram-profile"
            className={styles.select}
            value={view.profile}
            disabled={busy}
            onChange={event => void save({ profile: event.target.value })}
          >
            {profileOptions.map(name => <option key={name} value={name}>{name}</option>)}
          </select>
        </div>
        <div className={styles.fieldRow}>
          <label className={styles.fieldLabel} htmlFor="telegram-token">Bot token</label>
          <div className={styles.fieldEdit}>
            <input
              id="telegram-token"
              className={styles.input}
              type="password"
              autoComplete="off"
              value={token}
              placeholder={tokenPlaceholder(view)}
              onChange={event => setToken(event.target.value)}
            />
            {token.trim() ? (
              <button className={styles.saveAction} type="button" disabled={busy} onClick={() => void save({ botToken: token.trim() }, () => setToken(''))}>
                Save
              </button>
            ) : null}
          </div>
        </div>
        <EditableText
          id="telegram-proxy"
          label="Proxy"
          value={proxyValue}
          changed={proxy !== undefined && proxy !== (view.proxy ?? '')}
          placeholder="http://127.0.0.1:7890"
          busy={busy}
          onChange={setProxy}
          onSave={() => void save({ proxy: proxyValue }, () => setProxy(undefined))}
        />
        <div className={styles.cardNote}>
          Create a bot with @BotFather and paste its token; it is saved in config.toml and never shown again. Set a proxy where Telegram is blocked. A new token or turning the bot on or off restarts it, after any reply in progress.
        </div>
      </section>

      <section className={styles.card} aria-label="Allowed users">
        <div className={styles.cardTitle}>Allowed users</div>
        {allowlist.length === 0 ? <div className={styles.fieldHint}>Nobody yet: the bot ignores every message until you allow a Telegram user id.</div> : null}
        {allowlist.map(id => (
          <div key={id} className={styles.optionRow}>
            <span className={styles.optionName}>{id}</span>
            <div className={styles.fieldEdit}>
              <button className={styles.linkAction} type="button" disabled={busy || view.state !== 'polling'} onClick={() => void sendTest(id)}>
                Send test message
              </button>
              <button
                className={styles.removeAction}
                type="button"
                aria-label={`Remove ${id}`}
                disabled={busy}
                onClick={() => void save({ allowlist: allowlist.filter(entry => entry !== id) })}
              >
                Remove
              </button>
            </div>
          </div>
        ))}
        <div className={styles.fieldRow}>
          <label className={styles.fieldLabel} htmlFor="telegram-add-id">Add user id</label>
          <div className={styles.fieldEdit}>
            <input
              id="telegram-add-id"
              className={styles.input}
              inputMode="numeric"
              value={newId}
              placeholder="e.g. 790880904"
              onChange={event => setNewId(event.target.value)}
            />
            {newId.trim() ? (
              <button className={styles.saveAction} type="button" disabled={busy || !validId} onClick={() => void save({ allowlist: [...allowlist, parsedId] }, () => setNewId(''))}>
                Add
              </button>
            ) : null}
          </div>
        </div>
        {ignored.length > 0 ? (
          <>
            <div className={styles.fieldHint}>Recently ignored: message the bot from your Telegram account, then allow yourself here.</div>
            {ignored.map(sender => (
              <div key={sender.id} className={styles.optionRow}>
                <div>
                  <div className={styles.optionName}>{sender.name ?? sender.id}{sender.username ? ` · @${sender.username}` : ''}</div>
                  <div className={styles.optionMeta}>{sender.id} · {formatTime(sender.at)}</div>
                </div>
                <button className={styles.saveAction} type="button" disabled={busy} onClick={() => void save({ allowlist: [...allowlist, sender.id] })}>
                  Allow
                </button>
              </div>
            ))}
          </>
        ) : (
          <div className={styles.cardNote}>To find your id, message the bot: unknown senders appear here with an Allow button.</div>
        )}
      </section>
    </div>
  );
}

function statusText(view: TelegramChannelView): string {
  switch (view.state) {
    case 'not-configured': return 'Not set up';
    case 'off': return 'Off';
    case 'no-token': return view.token.source === 'env' ? `No token: ${view.token.env} is not set` : 'Needs a bot token';
    case 'restarting': return 'Restarting after the current reply…';
    case 'polling': {
      const bridge = view.bridge;
      if (bridge?.pollError) { return `Can't reach Telegram since ${formatTime(bridge.pollError.since)}: ${bridge.pollError.message}`; }
      if (!bridge?.lastPollAt && !bridge?.botUsername) { return 'Connecting…'; }
      return bridge.botUsername ? `Connected as @${bridge.botUsername}` : 'Connected';
    }
  }
}

function tokenPlaceholder(view: TelegramChannelView): string {
  if (view.token.source === 'config') { return 'Saved — paste a new token to replace it'; }
  if (view.token.source === 'env') { return `From ${view.token.env}${view.token.set ? '' : ' (not set)'} — paste a token to save one instead`; }
  return 'Paste the token from @BotFather';
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
