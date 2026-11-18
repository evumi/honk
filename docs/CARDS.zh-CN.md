# 卡片手册

卡片是 Honk 在消息里画出的一小段 HTML，由 `sendMessage` 的 `html` 参数发送。本页有四张可直接用的卡片。下面每个 `html` 代码块都由测试（`go test ./internal/widget`）用网关的白名单检查过，复制出去的就是手机上看到的。

English: [CARDS.md](CARDS.md)

## 一分钟读懂规则

- 限制和 Telegram 的 HTML 小组件一致：HTML 原文 32 KB，zlib 9 级压缩后 4 KB，`data` 1 KB。
- 静态 HTML 和 CSS：`div`、`span`、`p`、标题、列表、`table`、`a`、`img`（只能是内联 `data:image/...`）、`svg` 图形，以及最多 400 条规则的 `<style>`（支持 class 和 `@media (prefers-color-scheme: dark)`）。
- 一切可能联网的东西都会被删掉：`on*` 事件、外部 `src`、`<iframe>`、`<script src>`、`@import`、除内联图片和 SVG 内部引用（如 `url(#g)`）以外的 `url()`。链接必须是 `https://`。
- 文字和属性里的 `{{key}}` 会用消息的 `data`（JSON 对象，`{{a.b}}` 可取嵌套值）替换。把会变的值放进 `data`，HTML 就不变，`editMessageData` 只要几百字节就能原地更新卡片。
- 颜色要在深浅两种主题下都好看：用半透明灰（`rgba(127,127,127,.15)`）、用 `opacity` 做次要文字、沿用继承的文字颜色。真要深色配色时用 `@media (prefers-color-scheme: dark)`。

## 发送前先试

只校验、不发送。`dry_run` 返回清理后的 HTML、原文和压缩后的大小，以及白名单删掉的内容：

```sh
curl -s "$HONK_URL/bot$HONK_TOKEN/sendMessage" \
  -H 'Content-Type: application/json' \
  -d "$(jq -n --rawfile html card.html '{body:"x", html:$html, dry_run:true}')"
```

也可以用命令行。`honk preview` 用固定的 `id` 和 `level=passive` 把卡片发给你的 bot；加 `--watch` 后每次保存文件都会重发，手机上那条消息原地更新：

```sh
honk preview card.html --data data.json --watch
```

## 部署状态

状态圆点、服务名和版本、两项信息、一个链接。

```html
<div style="padding:14px;border-radius:14px;background:rgba(127,127,127,.12)">
  <div style="display:flex;flex-direction:row;align-items:center">
    <div style="width:10px;height:10px;border-radius:5px;background:{{color}};margin-right:8px"></div>
    <strong>{{service}}</strong>
  </div>
  <p style="margin:6px 0 0;opacity:.7">{{env}} · {{version}}</p>
  <table style="width:100%;margin-top:10px">
    <tr><td style="opacity:.6">提交</td><td>{{commit}}</td></tr>
    <tr><td style="opacity:.6">耗时</td><td>{{duration}}</td></tr>
  </table>
  <p style="margin:10px 0 0"><a href="{{url}}">查看部署</a></p>
</div>
```

```json data
{"service":"api","env":"production","version":"v1.8.2","color":"#12b76a","commit":"3f2a9c1","duration":"48 秒","url":"https://ci.example.com/runs/812"}
```

```sh
honk send "api v1.8.2 已上线" --title "部署成功" \
  --html @deploy.html --data @deploy.json --id deploy-api
```

部署失败时用同样的卡片、同样的 `--id`，把 `"color"` 换成 `"#d92d20"`，它会替换掉成功那张。

## 告警

红色或绿色的标签、标题和受影响的项目。`<style>` 演示了 class 和深色模式覆盖。

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
  <p style="margin:8px 0 0"><a href="{{url}}">打开仪表盘</a></p>
</div>
```

```json data
{"state":"FIRING","name":"HighCPU","item1":"web-1：94%","item2":"web-2：91%","url":"https://grafana.example.com/d/abc"}
```

Alertmanager 和 Grafana 的 webhook 适配（`/hook/alertmanager`、`/hook/grafana`）会自动生成类似的卡片。

## 进度条

进度条的宽度来自 `data`，所以任务可以用 `editMessageData` 推进它，消息本身不动。

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
{"label":"备份","percent":40,"note":"已完成 4 / 10 个卷"}
```

```sh
honk send "备份开始" --id backup --html @progress.html --data @p0.json
honk edit --id backup --data '{"label":"备份","percent":70,"note":"已完成 7 / 10 个卷"}'
```

## 折线图（内联 SVG）

图表就是带 `polyline` 的 `<svg>`。点坐标是 data 里的一个值，由你的脚本算好，之后只更新 `data`。SVG 的 y 轴向下：`y = 80 - 值 * 80 / 最大值`。

```html
<div style="padding:14px">
  <strong>{{title}}</strong>
  <svg viewBox="0 0 200 80" width="100%" height="120">
    <line x1="0" y1="79" x2="200" y2="79" stroke="#98a2b3" stroke-width="1"></line>
    <line x1="0" y1="40" x2="200" y2="40" stroke="#98a2b3" stroke-width="0.5" stroke-dasharray="3 3"></line>
    <polyline points="{{points}}" fill="none" stroke="#2e90fa" stroke-width="2" stroke-linejoin="round"></polyline>
  </svg>
  <p style="margin:4px 0 0;opacity:.7">当前：{{last}}</p>
</div>
```

```json data
{"title":"每分钟请求数","points":"0,60 20,52 40,55 60,38 80,42 100,30 120,34 140,22 160,26 180,14 200,18","last":"1,204"}
```

柱状图（`rect`）和环形图（`circle` 加 `stroke-dasharray`）同理。
