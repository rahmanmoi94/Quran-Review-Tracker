# Quran Review Tracker

Open `index.html` in a browser to use the tracker. It saves locally by default.

Use **Memory Setup** to backfill your real history:

- Already memorized pages and whole Ajza' go directly into the weekly review pool.
- New or solidifying pages go into the priority queue for the 5-day streak.
- Weak pages go into the priority queue and stay there until the weak flag is cleared.
- Daily memorization logs require exact page numbers; the app does not assume memorization starts at page 1.

Use **Calendar** to move between dates and edit a specific day's activity. The tracker rebuilds the current heat map, priority queue, and weekly review position from Memory Setup plus every saved calendar day through today.

Use the **Weekly Review** cycle toggle to switch the daily quota between a 7-day cycle and a 10-day cycle. The review pointer and cycle progress continue from the same place; only the daily target changes.

## Built-In Supabase Settings

For GitHub Pages, edit `config.js` and paste your public Supabase values:

```js
window.QURAN_TRACKER_CONFIG = {
  supabaseUrl: "https://your-project.supabase.co",
  supabaseAnonKey: "your-anon-public-key",
};
```

The anon key is safe to include in a browser app when Row Level Security is enabled. Do not put a Supabase service-role key here.

## Supabase Sync

In Supabase, enable Email and/or Google auth, then create this table:

```sql
create table public.quran_tracker_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null,
  updated_at timestamptz default now()
);

alter table public.quran_tracker_profiles enable row level security;

create policy "Users manage their own tracker"
on public.quran_tracker_profiles
for all
using (auth.uid() = user_id)
with check (auth.uid() = user_id);
```

Paste the project URL and anon key into the app's Cloud Sync panel.
