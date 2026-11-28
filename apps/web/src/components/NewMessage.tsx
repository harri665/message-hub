import { useDeferredValue, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type ComposeService, type ContactMatch } from '../api.ts';
import { initials, serviceClass } from '../format.ts';

interface Recipient { address: string; name: string | null; personId: number | null; tid: string | null }

const SERVICES: { key: ComposeService; label: string }[] = [
  { key: 'imessage', label: 'iMessage' },
  { key: 'sms', label: 'SMS' },
  { key: 'whatsapp', label: 'WhatsApp' },
];

/** Something that looks like an address, before the server checks it properly. */
function looksLikeAddress(s: string) {
  const t = s.trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t) || t.replace(/\D/g, '').length >= 7;
}

const isPhone = (a: string) => !a.includes('@');

/** Start a conversation: pick people (or type a number or email), a service, and write the first message. */
export function NewMessage({ onOpen, onCancel }: { onOpen: (tid: string) => void; onCancel: () => void }) {
  const qc = useQueryClient();
  const [to, setTo] = useState<Recipient[]>([]);
  const [query, setQuery] = useState('');
  const [service, setService] = useState<ComposeService>('imessage');
  const [chosen, setChosen] = useState(false);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const toRef = useRef<HTMLInputElement>(null);
  const msgRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => toRef.current?.focus(), []);

  const q = useDeferredValue(query.trim());
  const contacts = useQuery({ queryKey: ['contacts', q], queryFn: () => api.contacts(q), enabled: q.length >= 2, staleTime: 30_000 });

  // One row per address, so a person with a phone number and an email can be reached at either.
  const options = useMemo(() => {
    const rows: { c: ContactMatch; address: string; networks: string[] }[] = [];
    for (const c of contacts.data ?? []) {
      const by = new Map<string, Set<string>>();
      for (const a of c.addresses) (by.get(a.address) ?? by.set(a.address, new Set()).get(a.address)!).add(a.network);
      for (const [address, nets] of by) {
        if (!to.some((r) => r.address === address)) rows.push({ c, address, networks: [...nets] });
      }
    }
    return rows.slice(0, 12);
  }, [contacts.data, to]);
  useEffect(() => setActive(0), [q]);

  const single = to.length === 1 ? to[0] : null;
  const check = useQuery({
    queryKey: ['compose-check', single?.address],
    queryFn: () => api.checkAddress(single!.address),
    enabled: !!single,
    staleTime: 5 * 60_000,
    retry: false,
  });

  // Pick a sensible service for one person until it's chosen by hand: iMessage if they have it, else SMS or WhatsApp.
  useEffect(() => {
    if (chosen) return;
    if (to.length > 1) return setService('imessage');
    const c = check.data;
    if (!c) return;
    if (c.imessage) setService('imessage');
    else if (c.imessage === false && c.sms) setService('sms');
    else if (c.imessage === false && c.whatsapp) setService('whatsapp');
  }, [check.data, to.length, chosen]);

  const add = (r: Recipient) => {
    setTo((cur) => (cur.some((x) => x.address === r.address) ? cur : [...cur, r]));
    setQuery('');
    setError(null);
    toRef.current?.focus();
  };
  const addTyped = () => {
    const t = query.trim().replace(/[,;]$/, '');
    if (!t) return false;
    if (!looksLikeAddress(t)) {
      setError('Enter a phone number with area code, or an email address.');
      return true;
    }
    add({ address: t, name: null, personId: null, tid: null });
    return true;
  };

  const onToKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' && options.length) {
      e.preventDefault();
      setActive((a) => (a + 1) % options.length);
    } else if (e.key === 'ArrowUp' && options.length) {
      e.preventDefault();
      setActive((a) => (a - 1 + options.length) % options.length);
    } else if (e.key === 'Enter' || e.key === ',' || e.key === ';' || (e.key === 'Tab' && query.trim())) {
      if (!query.trim()) {
        if (e.key === 'Enter' && to.length) {
          e.preventDefault();
          msgRef.current?.focus();
        }
        return;
      }
      e.preventDefault();
      const o = options[active];
      if (o && e.key !== ',' && e.key !== ';') add({ address: o.address, name: o.c.name, personId: o.c.personId, tid: o.c.tid });
      else addTyped();
    } else if (e.key === 'Backspace' && !query && to.length) {
      setTo((cur) => cur.slice(0, -1));
    } else if (e.key === 'Escape') {
      if (query) setQuery('');
      else onCancel();
    }
  };

  const group = to.length > 1;
  const disabledReason = (s: ComposeService): string | null => {
    if (s === 'whatsapp' && group) return 'New WhatsApp groups have to be made on the phone';
    if (s === 'sms' && group) return 'Group texts start as iMessage';
    if (s !== 'imessage' && to.some((r) => !isPhone(r.address))) return 'Needs a phone number';
    return null;
  };
  useEffect(() => {
    if (disabledReason(service)) setService('imessage');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [to]);

  const availability = (() => {
    const c = check.data;
    if (!single) return null;
    if (check.isFetching) return 'Checking which services reach them';
    if (!c) return null;
    if (service === 'imessage' && c.imessage === false) return `${single.name ?? single.address} doesn't seem to have iMessage. It may not be delivered.`;
    if (service === 'whatsapp' && c.whatsapp === false) return `${single.name ?? single.address} isn't on WhatsApp.`;
    return null;
  })();

  const send = async () => {
    if (query.trim() && addTyped()) return;
    if (!to.length) {
      setError('Add who the message is for.');
      toRef.current?.focus();
      return;
    }
    if (!text.trim()) {
      setError('Write a message to start the conversation.');
      msgRef.current?.focus();
      return;
    }
    setSending(true);
    setError(null);
    try {
      const res = await api.compose(to.map((r) => r.address), service, text.trim());
      await qc.invalidateQueries({ queryKey: ['threads'] });
      onOpen(res.tid);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Not sent');
      setSending(false);
    }
  };

  const svcClass = serviceClass(service);
  return (
    <section className={`compose ${svcClass}`} aria-label="New message">
      <header className="thread-head glass">
        <div className="thread-head-main">
          <h2>New message</h2>
        </div>
        <button className="pill-btn" onClick={onCancel}>Cancel</button>
      </header>

      <div className="compose-body">
        <div className="compose-card glass">
          <div className="to-row">
            <label htmlFor="compose-to">To</label>
            <div className="to-chips">
              {to.map((r) => (
                <span key={r.address} className="chip">
                  {r.name ?? r.address}
                  <button type="button" onClick={() => setTo((cur) => cur.filter((x) => x !== r))} aria-label={`Remove ${r.name ?? r.address}`}>
                    Remove
                  </button>
                </span>
              ))}
              <input
                id="compose-to"
                ref={toRef}
                className="to-input"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setError(null);
                }}
                onKeyDown={onToKey}
                onBlur={() => query.trim() && looksLikeAddress(query) && addTyped()}
                placeholder={to.length ? '' : 'Name, phone number or email'}
                autoComplete="off"
                role="combobox"
                aria-expanded={options.length > 0}
                aria-controls="compose-suggestions"
              />
            </div>
          </div>

          {q.length >= 2 && (
            <ul id="compose-suggestions" className="suggestions" role="listbox">
              {contacts.isPending && <li className="list-note">Searching</li>}
              {contacts.data && !options.length && (
                <li className="list-note">{looksLikeAddress(q) ? `Press Enter to send to ${q}.` : 'No one matches. Type a phone number or email.'}</li>
              )}
              {options.map((o, i) => (
                <li key={`${o.c.personId}-${o.address}`} role="option" aria-selected={i === active}>
                  <button
                    type="button"
                    className={`suggestion ${i === active ? 'active' : ''}`}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => add({ address: o.address, name: o.c.name, personId: o.c.personId, tid: o.c.tid })}
                  >
                    <span className="avatar small" aria-hidden="true">{initials(o.c.name)}</span>
                    <span className="thread-main">
                      <span className="thread-title">{o.c.name}</span>
                      <span className="thread-preview">
                        {o.address}
                        {o.networks.includes('whatsapp') && <span className="svc-text svc-whatsapp"> WhatsApp</span>}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="compose-service">
            <div className="segmented" role="radiogroup" aria-label="Send with">
              {SERVICES.map((s) => {
                const why = disabledReason(s.key);
                return (
                  <button
                    key={s.key}
                    type="button"
                    role="radio"
                    aria-checked={service === s.key}
                    className={serviceClass(s.key)}
                    disabled={!!why}
                    title={why ?? undefined}
                    onClick={() => {
                      setService(s.key);
                      setChosen(true);
                    }}
                  >
                    {s.label}
                  </button>
                );
              })}
            </div>
            {availability && <p className="field-hint">{availability}</p>}
            {single?.tid && (
              <p className="field-hint">
                You already have a conversation with {single.name ?? single.address}.{' '}
                <button type="button" className="link-btn" onClick={() => onOpen(single.tid!)}>Open it</button>
              </p>
            )}
          </div>
        </div>

        {error && <p className="form-error compose-error" role="alert">{error}</p>}
      </div>

      <form
        className={`composer glass ${svcClass}`}
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <div className="composer-row">
          <textarea
            ref={msgRef}
            rows={1}
            value={text}
            placeholder={SERVICES.find((s) => s.key === service)!.label}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
            aria-label="First message"
          />
          <button className="pill-btn btn-send" disabled={sending || !text.trim()}>{sending ? 'Sending' : 'Send'}</button>
        </div>
      </form>
    </section>
  );
}
