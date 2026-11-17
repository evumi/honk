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
		"script":        `<div>a<script>alert(1)</script></div>`,
		"handler":       `<button onclick="x()">b</button>`,
		"iframe":        `<iframe src="https://evil"></iframe>`,
		"remote img":    `<img src="https://evil/p.png">`,
		"javascript a":  `<a href="javascript:alert(1)">x</a>`,
		"http a":        `<a href="http://plain">x</a>`,
		"css url":       `<div style="background:url(https://evil/t.png)">x</div>`,
		"css import":    `<style>@import "https://evil/a.css";</style>`,
		"css escape":    `<div style="background:u\72l(https://evil)">x</div>`,
		"input":         `<input value="x">`,
		"remote use":    `<svg><use href="https://evil/s.svg#a"></use></svg>`,
		"xlink":         `<svg><a xlink:href="javascript:x">y</a></svg>`,
		"form":          `<form action="https://evil"><button>go</button></form>`,
		"svg on":        `<svg onload="x()"></svg>`,
		"foreignObject": `<svg><foreignObject><div>x</div></foreignObject></svg>`,
	}
	bad := []string{"script", "onclick", "iframe", "https://evil", "javascript:", "http://plain", "@import", `\72`, "<input", "onload", "<form", "foreignobject", "foreignObject"}
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
