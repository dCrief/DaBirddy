-- Applied to the live project on 2026-11-01.
-- When a listing sells out (website, show or marked in the ledger), close its open offers.
-- Fires on any update: selling usually only sets quantity to 0, and shop_listings_before_write
-- then flips status to 'sold'. A paid offer is marked 'paid' by the webhook right after.
create or replace function private.shop_close_offers_on_sold()
 returns trigger
 language plpgsql
 security definer
 set search_path to ''
as $function$
begin
  update public.shop_offers set status = 'declined'
  where listing_id = new.id and status in ('pending', 'accepted', 'countered');
  return null;
end $function$;

drop trigger if exists shop_listings_close_offers on public.shop_listings;
create trigger shop_listings_close_offers
  after update on public.shop_listings
  for each row
  when (new.status = 'sold' and old.status is distinct from 'sold')
  execute function private.shop_close_offers_on_sold();

-- Offers already left open on cards that sold.
update public.shop_offers o set status = 'declined'
from public.shop_listings l
where l.id = o.listing_id and l.status = 'sold' and o.status in ('pending', 'accepted', 'countered');
