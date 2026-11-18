package main

import (
	"context"
	"os"
	"os/signal"

	"github.com/evumi/honk/gateway/internal/client"
)

// cli runs a sender subcommand (send, edit, delete, me, preview, help) and
// reports whether args named one. With no arguments, or `serve`, it returns
// false and main starts the gateway as before.
func cli(args []string) (handled bool, code int) {
	if len(args) == 0 || args[0] == "serve" {
		return false, 0
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	st, _ := os.Stdin.Stat()
	return true, client.Run(ctx, args, client.IO{
		Stdin:      os.Stdin,
		StdinPiped: st != nil && st.Mode()&os.ModeCharDevice == 0,
		Stdout:     os.Stdout,
		Stderr:     os.Stderr,
		Getenv:     os.Getenv,
	})
}
