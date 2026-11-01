-- Applied to the live project on 2026-11-01. Limited coupons are claimed when checkout starts.

alter table public.shop_orders add column if not exists coupon_claimed_until timestamptz;

-- A limited coupon counts as used by paid/shipped orders and by checkouts in progress that claimed it.
create or replace function public.shop_coupon_uses(p_code text)
 returns integer
 language sql
 stable security definer
 set search_path to ''
as $function$
  select count(*)::int from public.shop_orders o
  where o.coupon_code = upper(p_code)
    and (o.status in ('paid', 'shipped')
         or (o.status = 'pending' and o.coupon_claimed_until > now()))
$function$;

-- Claims a use of a limited coupon for an order at checkout start. Locks the coupon row so two
-- checkouts starting at the same moment can't both get the last use. Returns false if used up.
create or replace function public.shop_coupon_claim(p_code text, p_order uuid, p_minutes int default 32)
 returns boolean
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_max int;
begin
  select max_uses into v_max from public.shop_coupons where code = upper(p_code) for update;
  if not found then return false; end if;
  if v_max is not null and public.shop_coupon_uses(p_code) >= v_max then
    return false;
  end if;
  update public.shop_orders set coupon_claimed_until = now() + make_interval(mins => p_minutes)
  where id = p_order;
  return true;
end
$function$;

revoke all on function public.shop_coupon_claim(text, uuid, int) from public, anon, authenticated;
grant execute on function public.shop_coupon_claim(text, uuid, int) to service_role;
