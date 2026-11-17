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
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	st, err := store.Open(cfg.DBPath)
	if err != nil {
		return err
	}
	defer st.Close()

	router := push.Router{Log: log}
	if cfg.APNs.KeyFile != "" {
		a, err := push.NewAPNs(cfg.APNs.KeyFile, cfg.APNs.KeyID, cfg.APNs.TeamID, cfg.APNs.Topic, cfg.APNs.Sandbox)
		if err != nil {
			return err
		}
		router.APNs = a
	} else {
		log.Warn("APNs not configured: iOS devices get no pushes (set HONK_APNS_KEY_FILE)")
	}
	if cfg.FCM.CredentialsFile != "" {
		f, err := push.NewFCM(ctx, cfg.FCM.CredentialsFile)
		if err != nil {
			return err
		}
		router.FCM = f
	} else {
		log.Warn("FCM not configured: Android devices get no pushes (set HONK_FCM_CREDENTIALS_FILE)")
	}

	srv := api.New(st, router, log, api.Options{MessageTTL: cfg.MessageTTL, SendRate: cfg.SendRate, SendBurst: cfg.SendBurst})
	httpSrv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	go cleanup(ctx, st, cfg.AckedKeep, log)

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
	return httpSrv.Shutdown(shutdownCtx)
}

// cleanup drops expired and long-acked queue items once at start, then hourly.
func cleanup(ctx context.Context, st *store.Store, ackedKeep time.Duration, log *slog.Logger) {
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
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}
