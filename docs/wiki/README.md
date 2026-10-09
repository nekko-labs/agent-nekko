# Wiki source

These files mirror the [GitHub Wiki](https://github.com/nekko-labs/nekko-agent/wiki).

GitHub does not expose an API to create a wiki's first page, it must be created
once in the web UI (Wiki tab → "Create the first page"). After that one-time step,
the wiki's git repo (`nekko-agent.wiki.git`) exists and these pages can be pushed:

```bash
git clone git@github.com:nekko-labs/nekko-agent.wiki.git
cp docs/wiki/Home.md docs/wiki/Walkthrough.md nekko-agent.wiki/
cd nekko-agent.wiki && git add -A && git commit -m "Sync wiki" && git push
```

The same content also lives at [docs/WALKTHROUGH.md](../WALKTHROUGH.md) so it's
readable directly in the repo.
