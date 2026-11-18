package widget

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The app's whitelist (app/src/widget/sanitize.ts) is checked against the same
// cases: the gateway cleans what plaintext bots send, the app cleans every
// card on the device, and encrypted cards only ever meet the app's.
func TestSharedFixtures(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "app", "src", "widget", "sanitize.fixtures.json"))
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		Cases []struct {
			Name     string   `json:"name"`
			HTML     string   `json:"html"`
			Contains []string `json:"contains"`
			Absent   []string `json:"absent"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(b, &f); err != nil {
		t.Fatal(err)
	}
	if len(f.Cases) < 40 {
		t.Fatalf("only %d cases", len(f.Cases))
	}
	for _, c := range f.Cases {
		out, err := Clean(c.HTML)
		if err != nil {
			t.Errorf("%s: %v", c.Name, err)
			continue
		}
		for _, s := range c.Contains {
			if !strings.Contains(out, s) {
				t.Errorf("%s: %q is missing from %q", c.Name, s, out)
			}
		}
		for _, s := range c.Absent {
			if strings.Contains(strings.ToLower(out), strings.ToLower(s)) {
				t.Errorf("%s: %q survived in %q", c.Name, s, out)
			}
		}
	}
}
