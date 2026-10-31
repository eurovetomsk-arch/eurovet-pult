alter function public.pult_touch() set search_path = public;
revoke execute on function public.pult_touch() from public, anon, authenticated;
