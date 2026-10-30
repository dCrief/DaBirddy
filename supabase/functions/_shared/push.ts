/**
 * Phone notifications to the partners' ledger app (Web Push), for new website
 * orders and offers. Uses the same VAPID keys as the family hub
 * (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY secrets). Never throws: a notification
 * that can't be sent must not break an order or an offer.
 */

import webpush from 'npm:web-push@3.6.7';
import { db } from './cards.ts';

const LEDGER_URL = 'https://partner-ledger-rosy.vercel.app';
let ready = false;

export type Note = { title: string; body: string; url?: string; tag?: string };

/** Send to every device that wants this kind (or the given partner's devices). */
export async function notifyLedger(kind: 'orders' | 'offers' | 'test', note: Note, partnerId?: string): Promise<number> {
  try {
    const pub = Deno.env.get('VAPID_PUBLIC_KEY'), priv = Deno.env.get('VAPID_PRIVATE_KEY');
    if (!pub || !priv) return 0;
    if (!ready) {
      webpush.setVapidDetails(LEDGER_URL, pub, priv);
      ready = true;
    }
    let q = db.from('ledger_push_devices').select('id, endpoint, p256dh, auth, failures');
    if (kind !== 'test') q = q.eq(kind, true);
    if (partnerId) q = q.eq('partner_id', partnerId);
    const { data: devices } = await q;
    let sent = 0;
    for (const d of devices ?? []) {
      try {
        await webpush.sendNotification(
          { endpoint: d.endpoint, keys: { p256dh: d.p256dh, auth: d.auth } },
          JSON.stringify({ url: '/?tab=shop', ...note }),
          { TTL: 12 * 3600, urgency: 'high' },
        );
        sent++;
        await db.from('ledger_push_devices').update({ last_ok_at: new Date().toISOString(), failures: 0 }).eq('id', d.id);
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        console.error('push failed', status, (err as Error).message);
        // Gone: notifications were turned off on that phone or the app removed.
        if (status === 404 || status === 410 || d.failures >= 5) await db.from('ledger_push_devices').delete().eq('id', d.id);
        else await db.from('ledger_push_devices').update({ failures: d.failures + 1 }).eq('id', d.id);
      }
    }
    return sent;
  } catch (err) {
    console.error('notifyLedger', err);
    return 0;
  }
}

export const money = (cents: number) => '$' + (cents / 100).toFixed(cents % 100 ? 2 : 0);
