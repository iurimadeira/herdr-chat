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
byte core sends by `SLOW_HC_DELAY_MS`, and hold back the API methods listed in
`SLOW_HC_STALL` (core never answers them) while the file `SLOW_HC_STALL_FILE`
exists. The header of the script lists the variables.
