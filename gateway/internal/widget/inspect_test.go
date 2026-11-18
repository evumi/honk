package widget

import (
	"strings"
	"testing"
)

func TestInspectReportsRemovals(t *testing.T) {
	rp, err := Inspect(`<div onclick="x()"><iframe src="https://e"></iframe><img src="https://e/a.png"><b>hi</b><script src="x.js"></script></div>`)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"<iframe>", "onclick on <div>", "src on <img>", "<script> (external, module or ambiguous)"} {
		found := false
		for _, r := range rp.Removed {
			found = found || r == want
		}
		if !found {
			t.Errorf("Removed %v lacks %q", rp.Removed, want)
		}
	}
	if rp.Raw != len(rp.HTML) || rp.Compressed <= 0 || rp.InputSize == 0 || !strings.Contains(rp.HTML, "<b>hi</b>") {
		t.Errorf("bad report: %+v", rp)
	}
	clean, _ := Inspect(`<p>ok</p>`)
	if clean.Removed == nil || len(clean.Removed) != 0 {
		t.Errorf("Removed should be an empty list, got %#v", clean.Removed)
	}
	big, err := Inspect(strings.Repeat("<p>x</p>", MaxRaw))
	if err != ErrTooLarge || big.InputSize == 0 {
		t.Errorf("oversized: %v %+v", err, big.InputSize)
	}
}
