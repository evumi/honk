package api

import (
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"strings"
)

// DefaultTrustedProxies are the peers whose forwarding headers are believed
// when HONK_TRUSTED_PROXIES is unset: loopback and private ranges, where a
// local reverse proxy or a docker network sits.
const DefaultTrustedProxies = "127.0.0.0/8,::1/128,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,fc00::/7"

// ParseTrustedProxies reads a comma-separated list of CIDRs (or bare
// addresses). "" means DefaultTrustedProxies; "none" trusts nobody.
func ParseTrustedProxies(v string) ([]netip.Prefix, error) {
	v = strings.TrimSpace(v)
	if v == "" {
		v = DefaultTrustedProxies
	}
	if strings.EqualFold(v, "none") {
		return nil, nil
	}
	var out []netip.Prefix
	for _, part := range strings.Split(v, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		if p, err := netip.ParsePrefix(part); err == nil {
			out = append(out, p.Masked())
			continue
		}
		a, err := netip.ParseAddr(part)
		if err != nil {
			return nil, fmt.Errorf("want CIDRs, addresses or none, got %q", part)
		}
		a = a.Unmap()
		out = append(out, netip.PrefixFrom(a, a.BitLen()))
	}
	return out, nil
}

func trusted(list []netip.Prefix, a netip.Addr) bool {
	a = a.Unmap()
	for _, p := range list {
		if p.Contains(a) {
			return true
		}
	}
	return false
}

// clientIP is the address a per-IP limit is keyed by. Forwarding headers count
// only when the immediate peer is a trusted proxy; then the right-most
// X-Forwarded-For address that is not itself trusted is the client (falling
// back to X-Real-IP, then to the peer). IPv6 clients are keyed by their /64.
func (s *Server) clientIP(r *http.Request) string {
	host := r.RemoteAddr
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	peer, err := netip.ParseAddr(host)
	if err != nil {
		return host
	}
	ip := peer.Unmap()
	if trusted(s.trustedProxies, ip) {
		found := false
		xff := strings.Join(r.Header.Values("X-Forwarded-For"), ",")
		parts := strings.Split(xff, ",")
		for i := len(parts) - 1; i >= 0; i-- {
			a, err := netip.ParseAddr(strings.TrimSpace(parts[i]))
			if err != nil {
				break // garbage: stop trusting the chain here
			}
			ip, found = a.Unmap(), true
			if !trusted(s.trustedProxies, ip) {
				break
			}
		}
		if !found {
			if a, err := netip.ParseAddr(strings.TrimSpace(r.Header.Get("X-Real-IP"))); err == nil {
				ip = a.Unmap()
			}
		}
	}
	if ip.Is6() {
		return netip.PrefixFrom(ip, 64).Masked().Addr().String()
	}
	return ip.String()
}
