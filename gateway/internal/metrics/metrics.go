// Package metrics is a tiny Prometheus text-format registry: labelled counters
// and callback gauges, with no dependency.
package metrics

import (
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"sync"
)

// Registry holds the metrics in registration order.
type Registry struct {
	mu    sync.Mutex
	items []item
}

type item interface {
	write(w io.Writer)
}

// New returns an empty Registry.
func New() *Registry { return &Registry{} }

// Counter is a monotonically increasing value per label combination.
type Counter struct {
	name, help string
	labels     []string
	mu         sync.Mutex
	vals       map[string]uint64
}

// Counter registers a counter with the given label names.
func (r *Registry) Counter(name, help string, labels ...string) *Counter {
	c := &Counter{name: name, help: help, labels: labels, vals: map[string]uint64{}}
	r.mu.Lock()
	r.items = append(r.items, c)
	r.mu.Unlock()
	return c
}

// Inc adds one for the label values (one per label name, in order).
func (c *Counter) Inc(values ...string) { c.Add(1, values...) }

// Add adds n for the label values.
func (c *Counter) Add(n uint64, values ...string) {
	if len(values) != len(c.labels) {
		panic(fmt.Sprintf("metrics: %s wants %d label values, got %d", c.name, len(c.labels), len(values)))
	}
	k := labelString(c.labels, values)
	c.mu.Lock()
	c.vals[k] += n
	c.mu.Unlock()
}

// Value returns the current count for the label values.
func (c *Counter) Value(values ...string) uint64 {
	k := labelString(c.labels, values)
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.vals[k]
}

func (c *Counter) write(w io.Writer) {
	fmt.Fprintf(w, "# HELP %s %s\n# TYPE %s counter\n", c.name, c.help, c.name)
	c.mu.Lock()
	keys := make([]string, 0, len(c.vals))
	for k := range c.vals {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	if len(keys) == 0 && len(c.labels) == 0 {
		fmt.Fprintf(w, "%s 0\n", c.name)
	}
	for _, k := range keys {
		fmt.Fprintf(w, "%s%s %d\n", c.name, k, c.vals[k])
	}
	c.mu.Unlock()
}

type gauge struct {
	name, help string
	f          func() float64
}

// Gauge registers a value that is read each time the metrics are written.
func (r *Registry) Gauge(name, help string, f func() float64) {
	r.mu.Lock()
	r.items = append(r.items, gauge{name, help, f})
	r.mu.Unlock()
}

func (g gauge) write(w io.Writer) {
	fmt.Fprintf(w, "# HELP %s %s\n# TYPE %s gauge\n%s %v\n", g.name, g.help, g.name, g.name, g.f())
}

// Write renders every metric in the Prometheus text format.
func (r *Registry) Write(w io.Writer) {
	r.mu.Lock()
	items := append([]item(nil), r.items...)
	r.mu.Unlock()
	for _, it := range items {
		it.write(w)
	}
}

// Handler serves the metrics over HTTP.
func (r *Registry) Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
		r.Write(w)
	})
}

func labelString(names, values []string) string {
	if len(names) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteByte('{')
	for i, n := range names {
		if i > 0 {
			b.WriteByte(',')
		}
		v := ""
		if i < len(values) {
			v = values[i]
		}
		v = strings.NewReplacer(`\`, `\\`, `"`, `\"`, "\n", `\n`).Replace(v)
		fmt.Fprintf(&b, `%s="%s"`, n, v)
	}
	b.WriteByte('}')
	return b.String()
}
