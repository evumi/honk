package config

import "testing"

func TestLoadOps(t *testing.T) {
	t.Setenv("HONK_PUSH_QUEUE", "8")
	t.Setenv("HONK_PUSH_WORKERS", "2")
	t.Setenv("HONK_METRICS_ADDR", "127.0.0.1:9100")
	t.Setenv("HONK_REGISTER_KEY", "k")
	t.Setenv("HONK_LOG_FORMAT", "json")
	t.Setenv("HONK_LOG_LEVEL", "debug")
	c, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if c.PushQueue != 8 || c.PushWorkers != 2 || c.MetricsAddr != "127.0.0.1:9100" || c.RegisterKey != "k" || c.LogFormat != "json" || c.LogLevel != "debug" {
		t.Errorf("config = %+v", c)
	}
}

func TestLoadDefaultsAndErrors(t *testing.T) {
	c, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if c.PushQueue != 1024 || c.PushWorkers != 16 || c.MetricsAddr != "" || c.LogFormat != "text" || c.LogLevel != "info" {
		t.Errorf("defaults = %+v", c)
	}
	for k, v := range map[string]string{"HONK_PUSH_QUEUE": "0", "HONK_PUSH_WORKERS": "x", "HONK_LOG_FORMAT": "xml", "HONK_LOG_LEVEL": "loud"} {
		t.Run(k, func(t *testing.T) {
			t.Setenv(k, v)
			if _, err := Load(); err == nil {
				t.Errorf("%s=%s accepted", k, v)
			}
		})
	}
}

func TestRelayConfig(t *testing.T) {
	c, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if c.RelayURL != "https://honk.bunship.site/" || c.RelayServe || c.RelayRate != 10 || c.RelayBurst != 100 || c.RelayTokenPerMinute != 60 {
		t.Errorf("defaults = %+v", c)
	}
	// No credentials: both platforms go through the relay, without banner text.
	for _, p := range []string{"ios", "android"} {
		if r := c.PushRoute(p); r != RouteRelay || !c.BareFor(r) {
			t.Errorf("%s: route %s bare %v", p, r, c.BareFor(r))
		}
	}
	c.APNs.KeyFile = "k.p8"
	if r := c.PushRoute("ios"); r != RouteDirect || c.BareFor(r) {
		t.Errorf("direct ios: %s bare %v", r, c.BareFor(r))
	}
	if c.PushRoute("android") != RouteRelay {
		t.Error("android without credentials should use the relay")
	}
	c.RelayURL = "off"
	if c.PushRoute("android") != RouteOff {
		t.Error("HONK_RELAY_URL=off")
	}
	c.RelayURL, c.PushContent = "https://x/", "none"
	if !c.BareFor(RouteDirect) {
		t.Error("HONK_PUSH_CONTENT=none applies to direct pushes too")
	}
	c.PushContent = "full"
	if c.BareFor(RouteRelay) {
		t.Error("HONK_PUSH_CONTENT=full applies to the relay too")
	}
	c.RelayServe = true
	if c.PushRoute("android") != RouteOff {
		t.Error("a relay server never uses a relay")
	}
}

func TestRelayConfigErrors(t *testing.T) {
	t.Run("serve needs credentials", func(t *testing.T) {
		t.Setenv("HONK_RELAY_SERVE", "true")
		if _, err := Load(); err == nil {
			t.Error("HONK_RELAY_SERVE without credentials accepted")
		}
	})
	t.Run("serve with credentials", func(t *testing.T) {
		t.Setenv("HONK_RELAY_SERVE", "true")
		t.Setenv("HONK_FCM_CREDENTIALS_FILE", "sa.json")
		if c, err := Load(); err != nil || !c.RelayServe {
			t.Errorf("Load = %+v, %v", c, err)
		}
	})
	for k, v := range map[string]string{"HONK_PUSH_CONTENT": "some", "HONK_RELAY_URL": "ftp://x", "HONK_RELAY_RATE": "0", "HONK_RELAY_BURST": "x", "HONK_RELAY_TOKEN_PER_MINUTE": "-1", "HONK_RELAY_SERVE": "maybe"} {
		t.Run(k, func(t *testing.T) {
			t.Setenv(k, v)
			if _, err := Load(); err == nil {
				t.Errorf("%s=%s accepted", k, v)
			}
		})
	}
}
