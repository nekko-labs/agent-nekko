# Hardware, quota refresh and savings investigation

## Findings

- Hardware previously used total minus OS free RAM. On macOS this counts file caches as used, explaining the roughly 59 GiB reading versus Activity Monitor's roughly 35 GB. The replacement reads resident anonymous pages minus purgeable pages, wired pages and physical compressor pages from vm_stat. Live probe returned 34677 MiB used out of 65536 MiB. This is not a simultaneous Activity Monitor verification.
- There was no periodic quota timer. Reads occurred on mount, manual refresh and subscription turn completion; host reads were throttled to 30 seconds and polling snapshots stale after 35 seconds. Mounted portfolios now schedule 60 seconds idle and 30 seconds for subscriptions with running chats, with a one-second display countdown. Host throttle remains unchanged.
- Budget date controls filter spend and tokens only. Savings already used the complete usage summary. Tests now explicitly verify an old subscription record contributes and a synthetic $2200 total survives the default date range.
- A read-only aggregate of the available local usage log reproduced $142.4812544 from 784 records at current prices. It contains October 5–8 records. The earlier $2200 total is not reproducible from these records. Some gpt-6-sol records have no published pricing entry and remain excluded; assigning an invented price would be misleading.

## Verification and limitations

Host and desktop typechecks pass. Focused memory parser, quota schedule, existing host throttle, usage aggregation and dock presentation tests pass. Synthetic network-blocked hidden Electron checks verified manual refresh and ticking countdown. Narrow light/dark matched renderer captures were inspected. This does not prove native window chrome or live provider accounting. Wide screenshots and theme-stable motion frames were subsequently inspected. Full desktop build and 718 tests pass after fixing the live-run server snapshot regression found by CI. Latest remote CI remains pending. Live user data was not modified.

## Next steps

Complete evidence inspection/publication and CI. For the original savings discrepancy, obtain the old profile/log or screenshot including its label; compare the prior calculation against that same dataset before claiming a correction. No pricing inflation or historical-log rewrite was made.

## Performance follow-up

CI speed contract failed on streaming work (p95 12.3 ms versus 10 ms gate) and warm switch (24.1 ms versus 20.8 ms gate). Quick head/base profiles also missed switch budgets (head warm 30.1 ms, base warm 87.2 ms; head cold 35.2 ms, base cold 32.2 ms). This does not prove all failures pre-existing: streaming work was not measured by the quick profiles. The quota hook unnecessarily subscribed to token-level versions; changed it to stable running-membership snapshots and verified token updates retain snapshot identity. Full desktop suite now passes 720 tests; latest CI performance verification remains required.
