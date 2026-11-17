// Package config reads the gateway's settings from the environment.
package config

import (
	"fmt"
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

	APNs APNs
	FCM  FCM
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

// Load reads the configuration from the environment.
func Load() (Config, error) {
	c := Config{
		Addr:      env("HONK_ADDR", ":8080"),
		DBPath:    env("HONK_DB", "./data/honk.db"),
		SendRate:  5,
		SendBurst: 20,
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
	if v := os.Getenv("HONK_APNS_SANDBOX"); v != "" {
		if c.APNs.Sandbox, err = strconv.ParseBool(v); err != nil {
			return c, fmt.Errorf("HONK_APNS_SANDBOX: %w", err)
		}
	}
	if c.APNs.KeyFile != "" && (c.APNs.KeyID == "" || c.APNs.TeamID == "" || c.APNs.Topic == "") {
		return c, fmt.Errorf("HONK_APNS_KEY_FILE is set: HONK_APNS_KEY_ID, HONK_APNS_TEAM_ID and HONK_APNS_TOPIC are required too")
	}
	return c, nil
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
