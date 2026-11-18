// Package config reads the gateway's settings from the environment.
package config

import (
	"fmt"
	"log/slog"
	"net/url"
	"os"
	"strconv"
	"time"
)

// Config holds every setting the gateway reads at start-up.
type Config struct {
	Addr       string        // HONK_ADDR, default ":8080"
	DBPath     string        // HONK_DB, default "./data/honk.db"
	MessageTTL time.Duration // HONK_MESSAGE_TTL, default 168h (7 days)
	AckedKeep  time.Duration // HONK_ACKED_KEEP, default 24h: acked rows kept this long
	SendRate   float64       // HONK_SEND_RATE, messages per second per bot, default 5
	SendBurst  int           // HONK_SEND_BURST, default 20

	RegisterPerHour  float64 // HONK_REGISTER_PER_HOUR: device registrations per client IP, default 10
	MaxBotsPerDevice int     // HONK_MAX_BOTS_PER_DEVICE, default 100

	MetricsAddr string // HONK_METRICS_ADDR: listen address of /metrics; empty (default) turns it off
	RegisterKey string // HONK_REGISTER_KEY: when set, device registration must send the same register_key
	LogFormat   string // HONK_LOG_FORMAT: text (default) or json
	LogLevel    string // HONK_LOG_LEVEL: debug, info (default), warn or error; debug also logs every request

	PushQueue   int // HONK_PUSH_QUEUE: pushes that may wait, default 1024
	PushWorkers int // HONK_PUSH_WORKERS: concurrent pushes, default 16

	RelayURL            string  // HONK_RELAY_URL: relay for a platform without direct credentials; "off" disables it
	RelayServe          bool    // HONK_RELAY_SERVE: act as a push relay for other gateways
	PushContent         string  // HONK_PUSH_CONTENT: full or none; empty = full for direct pushes, none for the relay
	RelayRate           float64 // HONK_RELAY_RATE: pushes per second per relayed gateway, default 10
	RelayBurst          int     // HONK_RELAY_BURST, default 100
	RelayTokenPerMinute int     // HONK_RELAY_TOKEN_PER_MINUTE: pushes per push token, default 60

	APNs APNs
	FCM  FCM
}

// Push routes of a platform, as /v1/info reports them.
const (
	RouteDirect = "direct"
	RouteRelay  = "relay"
	RouteOff    = "off"
)

// PushRoute says how pushes to a platform ("ios" or "android") leave this
// gateway: direct with its own credentials, through the relay, or not at all.
// A gateway that serves a relay never uses one, so two relays cannot loop.
func (c Config) PushRoute(platform string) string {
	direct := c.APNs.KeyFile != ""
	if platform == "android" {
		direct = c.FCM.CredentialsFile != ""
	}
	switch {
	case direct:
		return RouteDirect
	case c.RelayServe || c.RelayURL == "off":
		return RouteOff
	}
	return RouteRelay
}

// BareFor reports whether pushes on a route leave out the banner text.
func (c Config) BareFor(route string) bool {
	switch c.PushContent {
	case "full":
		return false
	case "none":
		return true
	}
	return route == RouteRelay
}

// APNs is token-based (.p8) authentication for Apple Push Notification service.
// Push to iOS is off when KeyFile is empty.
type APNs struct {
	KeyFile string // HONK_APNS_KEY_FILE: path to AuthKey_XXXX.p8
	KeyID   string // HONK_APNS_KEY_ID
	TeamID  string // HONK_APNS_TEAM_ID
	Topic   string // HONK_APNS_TOPIC: the app's bundle ID
	Sandbox bool   // HONK_APNS_SANDBOX: use the development gateway
}

// FCM uses the HTTP v1 API with a service account. Push to Android is off when
// CredentialsFile is empty.
type FCM struct {
	CredentialsFile string // HONK_FCM_CREDENTIALS_FILE: service account JSON
}

// officialRelayURL is the relay run by the Honk project.
const officialRelayURL = "https://honk.bunship.site/"

// Load reads the configuration from the environment.
func Load() (Config, error) {
	c := Config{
		Addr:                env("HONK_ADDR", ":8080"),
		DBPath:              env("HONK_DB", "./data/honk.db"),
		SendRate:            5,
		SendBurst:           20,
		RegisterPerHour:     10,
		MaxBotsPerDevice:    100,
		MetricsAddr:         os.Getenv("HONK_METRICS_ADDR"),
		RegisterKey:         os.Getenv("HONK_REGISTER_KEY"),
		LogFormat:           env("HONK_LOG_FORMAT", "text"),
		LogLevel:            env("HONK_LOG_LEVEL", "info"),
		PushQueue:           1024,
		PushWorkers:         16,
		RelayURL:            env("HONK_RELAY_URL", officialRelayURL),
		PushContent:         os.Getenv("HONK_PUSH_CONTENT"),
		RelayRate:           10,
		RelayBurst:          100,
		RelayTokenPerMinute: 60,
		APNs: APNs{
			KeyFile: os.Getenv("HONK_APNS_KEY_FILE"),
			KeyID:   os.Getenv("HONK_APNS_KEY_ID"),
			TeamID:  os.Getenv("HONK_APNS_TEAM_ID"),
			Topic:   os.Getenv("HONK_APNS_TOPIC"),
		},
		FCM: FCM{CredentialsFile: os.Getenv("HONK_FCM_CREDENTIALS_FILE")},
	}
	var err error
	if c.MessageTTL, err = duration("HONK_MESSAGE_TTL", 7*24*time.Hour); err != nil {
		return c, err
	}
	if c.AckedKeep, err = duration("HONK_ACKED_KEEP", 24*time.Hour); err != nil {
		return c, err
	}
	if v := os.Getenv("HONK_SEND_RATE"); v != "" {
		if c.SendRate, err = strconv.ParseFloat(v, 64); err != nil || c.SendRate <= 0 {
			return c, fmt.Errorf("HONK_SEND_RATE: want a positive number, got %q", v)
		}
	}
	if v := os.Getenv("HONK_SEND_BURST"); v != "" {
		if c.SendBurst, err = strconv.Atoi(v); err != nil || c.SendBurst <= 0 {
			return c, fmt.Errorf("HONK_SEND_BURST: want a positive integer, got %q", v)
		}
	}
	if v := os.Getenv("HONK_REGISTER_PER_HOUR"); v != "" {
		if c.RegisterPerHour, err = strconv.ParseFloat(v, 64); err != nil || c.RegisterPerHour <= 0 {
			return c, fmt.Errorf("HONK_REGISTER_PER_HOUR: want a positive number, got %q", v)
		}
	}
	if v := os.Getenv("HONK_MAX_BOTS_PER_DEVICE"); v != "" {
		if c.MaxBotsPerDevice, err = strconv.Atoi(v); err != nil || c.MaxBotsPerDevice <= 0 {
			return c, fmt.Errorf("HONK_MAX_BOTS_PER_DEVICE: want a positive integer, got %q", v)
		}
	}
	if v := os.Getenv("HONK_PUSH_QUEUE"); v != "" {
		if c.PushQueue, err = strconv.Atoi(v); err != nil || c.PushQueue <= 0 {
			return c, fmt.Errorf("HONK_PUSH_QUEUE: want a positive integer, got %q", v)
		}
	}
	if v := os.Getenv("HONK_PUSH_WORKERS"); v != "" {
		if c.PushWorkers, err = strconv.Atoi(v); err != nil || c.PushWorkers <= 0 {
			return c, fmt.Errorf("HONK_PUSH_WORKERS: want a positive integer, got %q", v)
		}
	}
	if v := os.Getenv("HONK_APNS_SANDBOX"); v != "" {
		if c.APNs.Sandbox, err = strconv.ParseBool(v); err != nil {
			return c, fmt.Errorf("HONK_APNS_SANDBOX: %w", err)
		}
	}
	if v := os.Getenv("HONK_RELAY_SERVE"); v != "" {
		if c.RelayServe, err = strconv.ParseBool(v); err != nil {
			return c, fmt.Errorf("HONK_RELAY_SERVE: %w", err)
		}
	}
	if v := os.Getenv("HONK_RELAY_RATE"); v != "" {
		if c.RelayRate, err = strconv.ParseFloat(v, 64); err != nil || c.RelayRate <= 0 {
			return c, fmt.Errorf("HONK_RELAY_RATE: want a positive number, got %q", v)
		}
	}
	if v := os.Getenv("HONK_RELAY_BURST"); v != "" {
		if c.RelayBurst, err = strconv.Atoi(v); err != nil || c.RelayBurst <= 0 {
			return c, fmt.Errorf("HONK_RELAY_BURST: want a positive integer, got %q", v)
		}
	}
	if v := os.Getenv("HONK_RELAY_TOKEN_PER_MINUTE"); v != "" {
		if c.RelayTokenPerMinute, err = strconv.Atoi(v); err != nil || c.RelayTokenPerMinute <= 0 {
			return c, fmt.Errorf("HONK_RELAY_TOKEN_PER_MINUTE: want a positive integer, got %q", v)
		}
	}
	if c.PushContent != "" && c.PushContent != "full" && c.PushContent != "none" {
		return c, fmt.Errorf("HONK_PUSH_CONTENT: want full or none, got %q", c.PushContent)
	}
	if c.RelayURL != "off" {
		u, err := url.Parse(c.RelayURL)
		if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
			return c, fmt.Errorf("HONK_RELAY_URL: want an http(s) URL or off, got %q", c.RelayURL)
		}
	}
	if c.LogFormat != "text" && c.LogFormat != "json" {
		return c, fmt.Errorf("HONK_LOG_FORMAT: want text or json, got %q", c.LogFormat)
	}
	if _, err := ParseLevel(c.LogLevel); err != nil {
		return c, fmt.Errorf("HONK_LOG_LEVEL: %w", err)
	}
	if c.APNs.KeyFile != "" && (c.APNs.KeyID == "" || c.APNs.TeamID == "" || c.APNs.Topic == "") {
		return c, fmt.Errorf("HONK_APNS_KEY_FILE is set: HONK_APNS_KEY_ID, HONK_APNS_TEAM_ID and HONK_APNS_TOPIC are required too")
	}
	if c.RelayServe && c.APNs.KeyFile == "" && c.FCM.CredentialsFile == "" {
		return c, fmt.Errorf("HONK_RELAY_SERVE needs push credentials for at least one platform (HONK_APNS_KEY_FILE or HONK_FCM_CREDENTIALS_FILE): a relay with nothing to send through is useless")
	}
	return c, nil
}

// ParseLevel maps debug, info, warn or error to a slog level.
func ParseLevel(v string) (slog.Level, error) {
	var l slog.Level
	if err := l.UnmarshalText([]byte(v)); err != nil {
		return l, fmt.Errorf("want debug, info, warn or error, got %q", v)
	}
	return l, nil
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func duration(key string, def time.Duration) (time.Duration, error) {
	v := os.Getenv(key)
	if v == "" {
		return def, nil
	}
	d, err := time.ParseDuration(v)
	if err != nil || d <= 0 {
		return 0, fmt.Errorf("%s: want a positive duration such as 168h, got %q", key, v)
	}
	return d, nil
}
