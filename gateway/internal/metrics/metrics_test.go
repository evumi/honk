package metrics

import (
	"strings"
	"testing"
)

func TestWrite(t *testing.T) {
	r := New()
	c := r.Counter("honk_pushes_total", "Pushes.", "platform", "result")
	c.Inc("ios", "ok")
	c.Add(2, "ios", "ok")
	c.Inc("android", `we"ird`)
	plain := r.Counter("honk_dropped_total", "Dropped.")
	r.Gauge("honk_devices", "Devices.", func() float64 { return 3 })
	if c.Value("ios", "ok") != 3 || plain.Value() != 0 {
		t.Fatal("values")
	}
	var b strings.Builder
	r.Write(&b)
	out := b.String()
	for _, want := range []string{
		"# TYPE honk_pushes_total counter\n",
		`honk_pushes_total{platform="android",result="we\"ird"} 1` + "\n",
		`honk_pushes_total{platform="ios",result="ok"} 3` + "\n",
		"honk_dropped_total 0\n",
		"# TYPE honk_devices gauge\nhonk_devices 3\n",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in\n%s", want, out)
		}
	}
}
