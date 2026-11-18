package api

import (
	"fmt"
	"net/http/httptest"
	"testing"
)

func TestClientIP(t *testing.T) {
	def, err := ParseTrustedProxies("")
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name    string
		trusted string
		peer    string
		hdr     map[string]string
		want    string
	}{
		{"public peer spoofing", "", "203.0.113.9:1", map[string]string{"X-Forwarded-For": "1.2.3.4", "X-Real-IP": "5.6.7.8", "True-Client-IP": "9.9.9.9"}, "203.0.113.9"},
		{"proxy forwards", "", "10.0.0.2:1", map[string]string{"X-Forwarded-For": "198.51.100.7"}, "198.51.100.7"},
		{"right-most untrusted", "", "127.0.0.1:1", map[string]string{"X-Forwarded-For": "6.6.6.6, 198.51.100.7, 10.1.1.1"}, "198.51.100.7"},
		{"spoofed prefix ignored", "", "127.0.0.1:1", map[string]string{"X-Forwarded-For": "1.1.1.1, 198.51.100.7"}, "198.51.100.7"},
		{"x-real-ip fallback", "", "127.0.0.1:1", map[string]string{"X-Real-IP": "198.51.100.8"}, "198.51.100.8"},
		{"none", "none", "127.0.0.1:1", map[string]string{"X-Forwarded-For": "1.2.3.4"}, "127.0.0.1"},
		{"custom", "203.0.113.0/24", "203.0.113.9:1", map[string]string{"X-Forwarded-For": "1.2.3.4"}, "1.2.3.4"},
		{"ipv6 /64", "", "[2001:db8:1:2:aaaa:bbbb:cccc:dddd]:1", nil, "2001:db8:1:2::"},
		{"ipv6 xff /64", "", "127.0.0.1:1", map[string]string{"X-Forwarded-For": "2001:db8:1:2:1::5"}, "2001:db8:1:2::"},
	}
	for _, c := range cases {
		s := &Server{trustedProxies: def}
		if c.trusted != "" {
			s.trustedProxies, err = ParseTrustedProxies(c.trusted)
			if err != nil {
				t.Fatal(err)
			}
		}
		r := httptest.NewRequest("GET", "/", nil)
		r.RemoteAddr = c.peer
		for k, v := range c.hdr {
			r.Header.Set(k, v)
		}
		if got := s.clientIP(r); got != c.want {
			t.Errorf("%s: clientIP = %q, want %q", c.name, got, c.want)
		}
	}
	if _, err := ParseTrustedProxies("bogus"); err == nil {
		t.Error("bogus accepted")
	}
}

func TestLimiterMapBounded(t *testing.T) {
	m := map[string]*limiter{}
	for i := 0; i < maxLimiters*2; i++ {
		bucket(m, fmt.Sprint("k", i), 1, 1)
	}
	if len(m) > maxLimiters {
		t.Errorf("map grew to %d", len(m))
	}
}
