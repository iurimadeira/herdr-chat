# fake-hc

Stands in for `hc get <terminal> --json`, which the host's hand-off watch polls
(the host runs `$HERDR_CHAT_HC`, default `hc`). A terminal is
`$FAKE_HC_DIR/<address>.json`, holding what `hc get` would print, such as
`{"state":"live"}` or `{"state":"finished"}`. Without that file it prints
hc's `not_found` error and exits 3, like a terminal that was killed and
cleaned up.

It also takes `hc label <terminal> k=v…` (what the sub-agent launcher runs on
its own terminal): each call is a JSON line `{terminal, labels}` in
`$FAKE_HC_DIR/label.log`. `FAKE_HC_LABEL_FAIL=1` makes it exit 1.

## slow-connect.mjs

Stands between the relay and the real `hc` (`relay.test.ts` `slowHc`). It
passes every command to the real hc, but for `hc connect` it can delay every
byte core sends by `SLOW_HC_DELAY_MS`, and drop the calls to the API methods
listed in `SLOW_HC_STALL` while the file `SLOW_HC_STALL_FILE` exists: they
never reach core, so core never answers them, even after the file is removed
(calls made after that pass). The header of the script lists the variables.
A core that answers late is faked in `hccore.test.ts` instead.
