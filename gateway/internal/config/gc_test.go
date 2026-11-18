package config

import (
	"testing"
	"time"
)

func TestDeviceGCCanBeDisabled(t *testing.T) {
	for v, want := range map[string]time.Duration{"": 2160 * time.Hour, "0": 0, "off": 0, "24h": 24 * time.Hour} {
		t.Setenv("HONK_DEVICE_GC", v)
		c, err := Load()
		if err != nil || c.DeviceGC != want {
			t.Errorf("HONK_DEVICE_GC=%q: %v, %v; want %v", v, c.DeviceGC, err, want)
		}
	}
	for _, v := range []string{"-1h", "soon"} {
		t.Setenv("HONK_DEVICE_GC", v)
		if _, err := Load(); err == nil {
			t.Errorf("HONK_DEVICE_GC=%q accepted", v)
		}
	}
}

func TestTrustedProxiesConfig(t *testing.T) {
	c, err := Load()
	if err != nil || len(c.TrustedProxies) == 0 {
		t.Fatalf("default: %v, %v", c.TrustedProxies, err)
	}
	t.Setenv("HONK_TRUSTED_PROXIES", "none")
	if c, err = Load(); err != nil || len(c.TrustedProxies) != 0 {
		t.Errorf("none: %v, %v", c.TrustedProxies, err)
	}
	t.Setenv("HONK_TRUSTED_PROXIES", "not-a-cidr")
	if _, err = Load(); err == nil {
		t.Error("garbage accepted")
	}
}
