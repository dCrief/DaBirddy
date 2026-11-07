-- Applied to the live project on 2026-11-07.
-- Customer card alerts: let a shopper narrow an alert to a kind of listing and a top price,
-- and manage all of their alerts from one page (cards/alerts.html). Additive only.
alter table public.shop_alerts
  add column if not exists category text check (category in ('single', 'graded', 'sealed', 'bundle')),
  add column if not exists max_price numeric(10,2) check (max_price is null or max_price > 0),
  add column if not exists updated_at timestamptz not null default now();

comment on column public.shop_alerts.category is 'Only alert for this kind of listing (null = any).';
comment on column public.shop_alerts.max_price is 'Only alert for listings at or under this price in dollars, after any sale (null = any price).';

create index if not exists shop_alerts_email_idx on public.shop_alerts (email);
