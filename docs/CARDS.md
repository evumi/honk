# Card cookbook

A card is a small HTML document that Honk draws inside a message, from the
`html` parameter of `sendMessage`. This page has four ready-made cards. Every
`html` block below is checked by a test (`go test ./internal/widget`) against
the gateway's whitelist, so what you copy is what the phone gets.

中文版：[CARDS.zh-CN.md](CARDS.zh-CN.md)

## The rules in one minute

- Limits (the same as Telegram's HTML widgets): 32 KB of HTML, 4 KB after zlib
  level 9, 1 KB of `data`.
- Static HTML and CSS: `div`, `span`, `p`, headings, lists, `table`, `a`, `img`
  (inline `data:image/...` only), `svg` shapes, and `<style>` blocks with up to
  400 rules, classes and `@media (prefers-color-scheme: dark)`.
- Anything that could reach the network is removed: `on*` handlers, external
  `src`, `<iframe>`, `<script src>`, `@import`, `url()` other than an inline
  image or an SVG reference such as `url(#g)`. Links must be `https://`.
- `{{key}}` anywhere in text or attributes is replaced from the message's
  `data` (a JSON object; `{{a.b}}` reads nested values). Putting the changing
  values in `data` keeps the HTML constant, so `editMessageData` can update a
  card in place with a few hundred bytes.
- Use colours that work on both themes: translucent greys
  (`rgba(127,127,127,.15)`), `opacity` for secondary text, and inherited text
  colour. Use `@media (prefers-color-scheme: dark)` when you need real
  dark-mode colours.

## Try a card before you send it

Validate without sending anything. `dry_run` returns the cleaned HTML, its raw
and compressed size, and what the whitelist removed:

```sh
curl -s "$HONK_URL/bot$HONK_TOKEN/sendMessage" \
  -H 'Content-Type: application/json' \
  -d "$(jq -n --rawfile html card.html '{body:"x", html:$html, dry_run:true}')"
```

Or use the command line. `honk preview` sends the card to your bot with a fixed
`id` and `level=passive`; with `--watch` it sends again each time you save the
file, and the message on the phone is replaced in place:

```sh
honk preview card.html --data data.json --watch
```

## Deploy status

A status dot, the service and version, two facts and a link.

```html
<div style="padding:14px;border-radius:14px;background:rgba(127,127,127,.12)">
  <div style="display:flex;flex-direction:row;align-items:center">
    <div style="width:10px;height:10px;border-radius:5px;background:{{color}};margin-right:8px"></div>
    <strong>{{service}}</strong>
  </div>
  <p style="margin:6px 0 0;opacity:.7">{{env}} · {{version}}</p>
  <table style="width:100%;margin-top:10px">
    <tr><td style="opacity:.6">Commit</td><td>{{commit}}</td></tr>
    <tr><td style="opacity:.6">Took</td><td>{{duration}}</td></tr>
  </table>
  <p style="margin:10px 0 0"><a href="{{url}}">View deployment</a></p>
</div>
```

```json data
{"service":"api","env":"production","version":"v1.8.2","color":"#12b76a","commit":"3f2a9c1","duration":"48 s","url":"https://ci.example.com/runs/812"}
```

```sh
honk send "api v1.8.2 is live" --title "Deploy succeeded" \
  --html @deploy.html --data @deploy.json --id deploy-api
```

For a failed deploy send the same card with `"color":"#d92d20"` and the same
`--id`: it replaces the success card.

## Alert

A red or green pill, the title and the affected items. The `<style>` block
shows classes and a dark-mode override.

```html
<style>
.alert { padding: 14px; border-radius: 14px; background: #fef3f2; color: #912018; }
.pill { display: inline-block; padding: 2px 10px; border-radius: 999px; background: #d92d20; color: #fff; font-size: 12px; font-weight: 600; }
.alert h3 { margin: 8px 0 4px; }
.alert li { margin: 2px 0; }
@media (prefers-color-scheme: dark) {
  .alert { background: #55160c; color: #fecdca; }
}
</style>
<div class="alert">
  <span class="pill">{{state}}</span>
  <h3>{{name}}</h3>
  <ul style="margin:0;padding-left:18px">
    <li>{{item1}}</li>
    <li>{{item2}}</li>
  </ul>
  <p style="margin:8px 0 0"><a href="{{url}}">Open dashboard</a></p>
</div>
```

```json data
{"state":"FIRING","name":"HighCPU","item1":"web-1: 94%","item2":"web-2: 91%","url":"https://grafana.example.com/d/abc"}
```

The Alertmanager and Grafana webhook adapters (`/hook/alertmanager`,
`/hook/grafana`) build a similar card for you.

## Progress bar

The bar's width comes from `data`, so a job can move it with
`editMessageData` while the message stays in place.

```html
<div style="padding:14px">
  <div style="display:flex;flex-direction:row">
    <strong style="flex:1">{{label}}</strong>
    <span>{{percent}}%</span>
  </div>
  <div style="margin-top:8px;height:8px;border-radius:4px;background:rgba(127,127,127,.25)">
    <div style="width:{{percent}}%;height:8px;border-radius:4px;background:#2e90fa"></div>
  </div>
  <p style="margin:8px 0 0;opacity:.7">{{note}}</p>
</div>
```

```json data
{"label":"Backup","percent":40,"note":"4 of 10 volumes"}
```

```sh
honk send "Backup started" --id backup --html @progress.html --data @p0.json
honk edit --id backup --data '{"label":"Backup","percent":70,"note":"7 of 10 volumes"}'
```

## Line chart (inline SVG)

A chart is an `<svg>` with a `polyline`. The points are a data value, so you
compute them in your script and update only `data`. SVG's y axis points down:
`y = 80 - value * 80 / max`.

```html
<div style="padding:14px">
  <strong>{{title}}</strong>
  <svg viewBox="0 0 200 80" width="100%" height="120">
    <line x1="0" y1="79" x2="200" y2="79" stroke="#98a2b3" stroke-width="1"></line>
    <line x1="0" y1="40" x2="200" y2="40" stroke="#98a2b3" stroke-width="0.5" stroke-dasharray="3 3"></line>
    <polyline points="{{points}}" fill="none" stroke="#2e90fa" stroke-width="2" stroke-linejoin="round"></polyline>
  </svg>
  <p style="margin:4px 0 0;opacity:.7">Now: {{last}}</p>
</div>
```

```json data
{"title":"Requests per minute","points":"0,60 20,52 40,55 60,38 80,42 100,30 120,34 140,22 160,26 180,14 200,18","last":"1,204"}
```

The same works for bars (`rect`) and rings (`circle` with `stroke-dasharray`).
