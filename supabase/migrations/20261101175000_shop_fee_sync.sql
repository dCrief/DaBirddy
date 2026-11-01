-- Applied to the live project on 2026-11-01. Every 10 minutes, shop-fee-sync fills in Stripe fees
-- that weren't ready when the payment webhook ran and takes them off the sale's ledger lines.

do $$
begin
  if not exists (select 1 from vault.secrets where name = 'shop_sync_token') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(24), 'hex'), 'shop_sync_token', 'Token for the shop-fee-sync cron job');
  end if;
end $$;

create or replace function public.shop_sync_token_ok(p_token text)
 returns boolean
 language sql
 stable security definer
 set search_path to ''
as $function$
  select exists (select 1 from vault.decrypted_secrets where name = 'shop_sync_token' and decrypted_secret = p_token and p_token <> '')
$function$;

revoke all on function public.shop_sync_token_ok(text) from public, anon, authenticated;
grant execute on function public.shop_sync_token_ok(text) to service_role;

select cron.schedule('shop-fee-sync', '*/10 * * * *', $$
  select net.http_post(
    url := 'https://fbxrizapfpjyvhxwyweb.supabase.co/functions/v1/shop-fee-sync',
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-hub-token', (select decrypted_secret from vault.decrypted_secrets where name = 'shop_sync_token')
    ),
    body := '{}'::jsonb
  )
$$);
