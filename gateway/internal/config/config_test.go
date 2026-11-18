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
