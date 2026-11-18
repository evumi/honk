// Command honk runs the notification gateway.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/evumi/honk/gateway/internal/api"
	"github.com/evumi/honk/gateway/internal/config"
	"github.com/evumi/honk/gateway/internal/push"
	"github.com/evumi/honk/gateway/internal/store"
)

var version = "dev"

func main() {
	if handled, code := cli(os.Args[1:]); handled { // honk send, honk preview, ...
		os.Exit(code)
	}
	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	if err := run(log); err != nil {
		log.Error("exit", "err", err)
		os.Exit(1)
	}
}

func run(log *slog.Logger) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	level, _ := config.ParseLevel(cfg.LogLevel) // validated by Load
	opts := &slog.HandlerOptions{Level: level}
	if cfg.LogFormat == "json" {
		log = slog.New(slog.NewJSONHandler(os.Stderr, opts))
	} else {
		log = slog.New(slog.NewTextHandler(os.Stderr, opts))
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	st, err := store.Open(cfg.DBPath)
	if err != nil {
		return err
	}
	defer st.Close()

	// direct holds only the pushers with this gateway's own credentials; the
	// relay endpoints send through it and never through a relay.
	direct := push.Router{Log: log}
	if cfg.APNs.KeyFile != "" {
		a, err := push.NewAPNs(cfg.APNs.KeyFile, cfg.APNs.KeyID, cfg.APNs.TeamID, cfg.APNs.Topic, cfg.APNs.Sandbox)
		if err != nil {
			return err
		}
		a.Bare = cfg.BareFor(config.RouteDirect)
		direct.APNs = a
	}
	if cfg.FCM.CredentialsFile != "" {
		f, err := push.NewFCM(ctx, cfg.FCM.CredentialsFile)
		if err != nil {
			return err
		}
		f.Bare = cfg.BareFor(config.RouteDirect)
		direct.FCM = f
	}
	router := direct
	var relay *push.Relay
	if cfg.PushRoute("ios") == config.RouteRelay || cfg.PushRoute("android") == config.RouteRelay {
		relay = push.NewRelay(cfg.RelayURL, st, version, log)
		relay.Bare = cfg.BareFor(config.RouteRelay)
	}
	for _, p := range []struct {
		name, flag string
		slot       *push.Pusher
	}{{"ios", "HONK_APNS_KEY_FILE", &router.APNs}, {"android", "HONK_FCM_CREDENTIALS_FILE", &router.FCM}} {
		switch cfg.PushRoute(p.name) {
		case config.RouteRelay:
			*p.slot = relay
			text := "does"
			if relay.Bare {
				text = "does not"
			}
			log.Warn("no push credentials for "+p.name+": pushes go through the relay "+relay.URL()+
				" (push token, message id and bot id pass through it; banner text "+text+
				"); set "+p.flag+" to push directly or HONK_RELAY_URL=off to turn this off", "platform", p.name)
		case config.RouteOff:
			log.Warn("no push for "+p.name+": devices get messages only when the app is opened (set "+p.flag+
				", or unset HONK_RELAY_URL=off)", "platform", p.name)
		}
	}
	if cfg.RelayServe {
		log.Info("serving as a push relay", "ios", direct.APNs != nil, "android", direct.FCM != nil,
			"rate", cfg.RelayRate, "burst", cfg.RelayBurst, "token_per_minute", cfg.RelayTokenPerMinute)
	}

	srv := api.New(st, router, log, api.Options{
		Version: version, MessageTTL: cfg.MessageTTL, SendRate: cfg.SendRate, SendBurst: cfg.SendBurst,
		RegisterPerHour: cfg.RegisterPerHour, MaxBotsPerDevice: cfg.MaxBotsPerDevice,
		PushQueue: cfg.PushQueue, PushWorkers: cfg.PushWorkers,
		RegisterKey: cfg.RegisterKey, AccessLog: level <= slog.LevelDebug,
		PushIOS: cfg.PushRoute("ios"), PushAndroid: cfg.PushRoute("android"),
		RelayServe: cfg.RelayServe, RelayRate: cfg.RelayRate, RelayBurst: cfg.RelayBurst, RelayTokenPerMinute: cfg.RelayTokenPerMinute,
		RelayAPNs: direct.APNs, RelayFCM: direct.FCM,
		WebhookAllowPrivate: cfg.WebhookAllowPrivate,
		TrustedProxies:      cfg.TrustedProxies,
	})
	httpSrv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	var metricsSrv *http.Server
	if cfg.MetricsAddr != "" {
		mux := http.NewServeMux()
		mux.Handle("/metrics", srv.Metrics())
		metricsSrv = &http.Server{Addr: cfg.MetricsAddr, Handler: mux, ReadHeaderTimeout: 10 * time.Second}
		go func() {
			log.Info("metrics listening", "addr", cfg.MetricsAddr)
			if err := metricsSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
				log.Error("metrics", "err", err)
			}
		}()
	}

	go cleanup(ctx, st, srv, cfg.AckedKeep, cfg.DeviceGC, log)

	errc := make(chan error, 1)
	go func() {
		log.Info("honk gateway listening", "addr", cfg.Addr, "db", cfg.DBPath, "version", version)
		errc <- httpSrv.ListenAndServe()
	}()
	select {
	case err := <-errc:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	case <-ctx.Done():
	}
	log.Info("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	err = httpSrv.Shutdown(shutdownCtx)
	if metricsSrv != nil {
		_ = metricsSrv.Shutdown(shutdownCtx)
	}
	srv.Close() // pushes in flight finish (each has its own 10 s timeout); waiting retries are dropped
	return err
}

// cleanup drops expired and long-acked queue items, abandoned devices (see
// HONK_DEVICE_GC) and idle rate limiters
// once at start, then hourly.
func cleanup(ctx context.Context, st *store.Store, srv *api.Server, ackedKeep, deviceGC time.Duration, log *slog.Logger) {
	t := time.NewTicker(time.Hour)
	defer t.Stop()
	for {
		if n, err := st.Cleanup(ctx, ackedKeep); err != nil {
			if ctx.Err() == nil {
				log.Error("cleanup", "err", err)
			}
		} else if n > 0 {
			log.Info("cleanup", "deleted", n)
		}
		if deviceGC > 0 {
			if n, err := st.GCDevices(ctx, deviceGC); err != nil {
				if ctx.Err() == nil {
					log.Error("device gc", "err", err)
				}
			} else if n > 0 {
				log.Info("device gc", "deleted", n)
			}
		}
		srv.PruneLimiters(time.Hour)
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}
