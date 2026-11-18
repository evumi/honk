package widget

import (
	"strings"
	"testing"
)

func TestCleanKeepsCard(t *testing.T) {
	src := `<div style="padding:12px"><span class="pill">{{status}}</span><h3>{{service}}</h3>` +
		`<a href="{{url}}">查看</a><a href="https://example.com">ok</a><table><tr><td colspan="2">x</td></tr></table>` +
		`<svg viewBox="0 0 10 10"><linearGradient id="g"></linearGradient><use href="#g"></use></svg></div>`
	got, err := Clean(src)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`style="padding:12px"`, `{{status}}`, `href="{{url}}"`, `href="https://example.com"`, `colspan="2"`, `viewBox="0 0 10 10"`, `href="#g"`, `linearGradient`} {
		if !strings.Contains(got, want) {
			t.Errorf("cleaned HTML lost %q:\n%s", want, got)
		}
	}
}

func TestCleanRemovesActiveContent(t *testing.T) {
	cases := map[string]string{
		"script src":    `<div>a<script src="https://evil/x.js"></script></div>`,
		"module":        `<script type="module">import x from "https://evil/m.js"</script>`,
		"json script":   `<script type="text/plain">evil</script>`,
		"svg script":    `<svg><script>evil()</script></svg>`,
		"escaped":       `<script><!--<script></script><a href="https://evil/x">x</a></script>`,
		"handler":       `<button onclick="x()">b</button>`,
		"iframe":        `<iframe src="https://evil"></iframe>`,
		"remote img":    `<img src="https://evil/p.png">`,
		"javascript a":  `<a href="javascript:alert(1)">x</a>`,
		"http a":        `<a href="http://plain">x</a>`,
		"css url":       `<div style="background:url(https://evil/t.png)">x</div>`,
		"css import":    `<style>@import "https://evil/a.css";</style>`,
		"css escape":    `<div style="background:u\72l(https://evil)">x</div>`,
		"image-set":     `<div style="background-image:image-set('https://evil/p.png' 1x)">x</div>`,
		"webkit set":    `<style>.a{background:-webkit-image-set("https://evil/p.png" 1x)}</style>`,
		"cross-fade":    `<div style="background:cross-fade('https://evil/a.png', red 50%)">x</div>`,
		"input":         `<input value="x">`,
		"remote use":    `<svg><use href="https://evil/s.svg#a"></use></svg>`,
		"xlink":         `<svg><a xlink:href="javascript:x">y</a></svg>`,
		"form":          `<form action="https://evil"><button>go</button></form>`,
		"svg on":        `<svg onload="x()"></svg>`,
		"foreignObject": `<svg><foreignObject><div>x</div></foreignObject></svg>`,
	}
	bad := []string{"<script", "evil", "onclick", "iframe", "https://evil", "javascript:", "http://plain", "@import", `\72`, "<input", "onload", "<form", "foreignobject", "foreignObject"}
	for name, src := range cases {
		got, err := Clean(src)
		if err != nil {
			t.Errorf("%s: %v", name, err)
			continue
		}
		for _, b := range bad {
			if strings.Contains(got, b) {
				t.Errorf("%s: cleaned HTML still has %q: %s", name, b, got)
			}
		}
	}
}

func TestCleanKeepsInlineScript(t *testing.T) {
	src := `<p id="n">{{n}}</p><button id="b">+1</button>` +
		`<script type="text/javascript" defer>document.getElementById("b").addEventListener("click", () => { if (1 < 2 && "</p>") n++ })</script>`
	got, err := Clean(src)
	if err != nil {
		t.Fatal(err)
	}
	want := `<script>document.getElementById("b").addEventListener("click", () => { if (1 < 2 && "</p>") n++ })</script>`
	// "<script" only counts as a tag: comparisons like i<scriptCount stay.
	if got, _ := Clean(`<script>var i = 0, scriptCount = 2; if (i<scriptCount) i++</script>`); !strings.Contains(got, "i<scriptCount") {
		t.Errorf("script with <scriptCount dropped: %q", got)
	}
	if !strings.Contains(got, want) {
		t.Errorf("inline script changed:\n got %s\nwant %s", got, want)
	}
	// The script counts towards the size limits like the rest of the card.
	if _, err := Clean("<script>" + strings.Repeat("x", MaxRaw) + "</script>"); err != ErrTooLarge {
		t.Errorf("script over limit: got %v", err)
	}
}

func TestCleanKeepsStyleSheet(t *testing.T) {
	// A card written as for a Telegram widget: a <style> block in <head>,
	// classes and ids, media queries, custom properties and {{key}} in both.
	sheet := `:root { --accent: #f00 } .card > .title, #x { color: var(--accent) } ` +
		`.status-{{status}} .pill { background: {{tone}} } ` +
		`@media (prefers-color-scheme: dark) { .card { color: light-dark(#000, #fff) } }`
	src := `<html><head><style>` + sheet + `</style></head><body>` +
		`<div class="card status-{{status}}"><p class="title" id="x">t</p><span class="pill">{{label}}</span></div></body></html>`
	got, err := Clean(src)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"<style>" + sheet + "</style>", `class="card status-{{status}}"`, `class="title" id="x"`, `class="pill"`} {
		if !strings.Contains(got, want) {
			t.Errorf("cleaned HTML lost %q:\n%s", want, got)
		}
	}
}

func TestCleanKeepsDataImage(t *testing.T) {
	src := `<img src="data:image/png;base64,iVBORw0KGgo=" alt="x"><div style="background:url(data:image/png;base64,iVBO)">y</div>`
	got, err := Clean(src)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got, `src="data:image/png;base64,iVBORw0KGgo="`) || !strings.Contains(got, `url(data:image/png`) {
		t.Errorf("data: images were removed: %s", got)
	}
}

func TestCleanLimits(t *testing.T) {
	if _, err := Clean(strings.Repeat("a", MaxRaw+1)); err != ErrTooLarge {
		t.Errorf("raw over limit: got %v", err)
	}
	// Random-looking text barely compresses, so 8 KB of it is over 4 KB zlib.
	var b strings.Builder
	x := uint32(1)
	for b.Len() < 8*1024 {
		x = x*1664525 + 1013904223
		b.WriteByte(byte('a' + x>>27%26))
	}
	if _, err := Clean("<p>" + b.String() + "</p>"); err != ErrTooLarge {
		t.Errorf("compressed over limit: got %v", err)
	}
	if _, err := Clean("<p>a\x00b</p>"); err != ErrInvalid {
		t.Errorf("NUL: got %v", err)
	}
	if got, err := Clean(""); got != "" || err != nil {
		t.Errorf("empty: got %q, %v", got, err)
	}
}
