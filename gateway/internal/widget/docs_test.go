package widget

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

var fence = regexp.MustCompile("(?s)```([a-z]+(?: data)?)\n(.*?)```")

// The card cookbook's examples must survive the whitelist untouched, and the
// data blocks must be JSON within the 1 KB limit.
func TestCookbookCards(t *testing.T) {
	for _, name := range []string{"CARDS.md", "CARDS.zh-CN.md"} {
		b, err := os.ReadFile(filepath.Join("..", "..", "..", "docs", name))
		if err != nil {
			t.Fatal(err)
		}
		var cards, datas int
		for _, m := range fence.FindAllStringSubmatch(string(b), -1) {
			switch m[1] {
			case "html":
				cards++
				rp, err := Inspect(m[2])
				if err != nil {
					t.Errorf("%s card %d: %v", name, cards, err)
					continue
				}
				if len(rp.Removed) != 0 {
					t.Errorf("%s card %d: whitelist removed %v", name, cards, rp.Removed)
				}
				if rp.Raw != len(strings.TrimSpace(m[2])) && rp.Raw != len(m[2]) {
					// Whitespace may differ, content may not shrink noticeably.
					if rp.Raw < len(m[2])-len(m[2])/10 {
						t.Errorf("%s card %d shrank from %d to %d bytes", name, cards, len(m[2]), rp.Raw)
					}
				}
			case "json data":
				datas++
				var v map[string]any
				if err := json.Unmarshal([]byte(m[2]), &v); err != nil {
					t.Errorf("%s data %d: %v", name, datas, err)
				}
				if n := len(strings.TrimSpace(m[2])); n > MaxData {
					t.Errorf("%s data %d is %d bytes, limit %d", name, datas, n, MaxData)
				}
			}
		}
		if cards != 4 || datas != 4 {
			t.Errorf("%s: %d cards, %d data blocks, want 4 and 4", name, cards, datas)
		}
	}
}
