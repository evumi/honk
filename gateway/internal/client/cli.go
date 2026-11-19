package client

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// IO is everything the commands touch outside their arguments, so tests can
// run them against a fake terminal and an httptest gateway.
type IO struct {
	Stdin      io.Reader
	StdinPiped bool // stdin is a pipe or file, not a terminal: it is the body
	Stdout     io.Writer
	Stderr     io.Writer
	Getenv     func(string) string
	HTTP       *http.Client
	Poll       time.Duration // `preview --watch` poll interval; default 500 ms
}

// Usage is printed by `honk help`.
const Usage = `honk: gateway and sender tool

Usage:
  honk [serve]                        run the gateway (configured by HONK_* environment variables)
  honk send [flags] [body]            send a message (body from the argument or from stdin)
  honk edit [flags]                   replace a message's data (--id or --message-id, --data)
  honk delete [flags]                 delete a message (--id or --message-id)
  honk me                             show the bot behind the token
  honk preview card.html [flags]      send a card; with --watch, again on every save
  honk version                        print the version

Connection (all commands except serve):
  HONK_URL, HONK_TOKEN                gateway address and bot token; or --server, --token;
                                      or ~/.config/honk/config.json: {"url": "...", "token": "..."}
  HONK_KEY, --key                     base64 32-byte key: send the content as end-to-end
                                      encrypted "ciphertext" (AES-256-GCM, AAD = bot id). The
                                      key is the one the app shows in the bot's settings.

Flag values written @file are read from that file.
Exit status: 0 success, 1 failure (the gateway's description is printed), 2 usage.
`

type opts struct {
	server, token, key string
}

func (o *opts) bind(fs *flag.FlagSet, withKey bool) {
	fs.StringVar(&o.server, "server", "", "gateway `URL` (default $HONK_URL)")
	fs.StringVar(&o.token, "token", "", "bot token (default $HONK_TOKEN)")
	if withKey {
		fs.StringVar(&o.key, "key", "", "base64 32-byte `key`: send the content end-to-end encrypted (default $HONK_KEY)")
	}
}

// Run executes a subcommand and returns the process exit code.
func Run(ctx context.Context, args []string, io IO) int {
	if len(args) == 0 {
		fmt.Fprint(io.Stderr, Usage)
		return 2
	}
	if io.Getenv == nil {
		io.Getenv = os.Getenv
	}
	cmd, rest := args[0], args[1:]
	var err error
	switch cmd {
	case "help", "-h", "--help":
		fmt.Fprint(io.Stdout, Usage)
		return 0
	case "send":
		err = cmdSend(ctx, rest, io)
	case "edit":
		err = cmdChange(ctx, "edit", rest, io)
	case "delete":
		err = cmdChange(ctx, "delete", rest, io)
	case "me":
		err = cmdMe(ctx, rest, io)
	case "preview":
		err = cmdPreview(ctx, rest, io)
	default:
		fmt.Fprintf(io.Stderr, "honk: unknown command %q\n\n%s", cmd, Usage)
		return 2
	}
	switch {
	case err == nil, errors.Is(err, flag.ErrHelp):
		return 0
	case errors.As(err, new(usageError)):
		fmt.Fprintf(io.Stderr, "honk %s: %v\n", cmd, err)
		return 2
	}
	fmt.Fprintf(io.Stderr, "honk: %v\n", err)
	return 1
}

type usageError struct{ msg string }

func (e usageError) Error() string { return e.msg }

// parse is flag.Parse that also accepts flags after positional arguments
// (`honk send hello --title x`).
func parse(fs *flag.FlagSet, args []string, io IO) ([]string, error) {
	fs.SetOutput(io.Stderr)
	var pos []string
	for {
		if err := fs.Parse(args); err != nil {
			if errors.Is(err, flag.ErrHelp) {
				return nil, err
			}
			return nil, usageError{err.Error()}
		}
		args = fs.Args()
		if len(args) == 0 {
			return pos, nil
		}
		pos = append(pos, args[0])
		args = args[1:]
	}
}

func (o opts) client(io IO) (*Client, Config, error) {
	cfg, err := LoadConfig(io.Getenv)
	if err != nil {
		return nil, cfg, err
	}
	if o.server != "" {
		cfg.URL = o.server
	}
	if o.token != "" {
		cfg.Token = o.token
	}
	return &Client{URL: cfg.URL, Token: cfg.Token, HTTP: io.HTTP}, cfg, nil
}

// arg returns the value, or the content of the file when it is written @file.
func arg(v string) (string, error) {
	if !strings.HasPrefix(v, "@") || len(v) == 1 {
		return v, nil
	}
	b, err := os.ReadFile(v[1:])
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// dataArg is arg for data: JSON from a file is compacted, because the
// gateway's 1 KB limit counts bytes.
func dataArg(v string) (string, error) {
	s, err := arg(v)
	if err != nil || s == "" {
		return s, err
	}
	var buf bytes.Buffer
	if json.Compact(&buf, []byte(s)) == nil {
		return buf.String(), nil
	}
	return strings.TrimSpace(s), nil
}

func cmdSend(ctx context.Context, args []string, io IO) error {
	var o opts
	var title, body, html, data, id, level, group, link, copyText, icon string
	var dry bool
	fs := flag.NewFlagSet("send", flag.ContinueOnError)
	o.bind(fs, true)
	fs.StringVar(&title, "title", "", "title")
	fs.StringVar(&body, "body", "", "body (default: the arguments, then stdin)")
	fs.StringVar(&html, "html", "", "card HTML, or @file")
	fs.StringVar(&data, "data", "", "card data JSON, or @file")
	fs.StringVar(&id, "id", "", "collapse id: a later message with the same id replaces this one")
	fs.StringVar(&level, "level", "", "passive, active or timeSensitive")
	fs.StringVar(&group, "group", "", "group")
	fs.StringVar(&link, "link", "", "link opened from the message (the bot API's url)")
	fs.StringVar(&copyText, "copy", "", "text the copy button copies")
	fs.StringVar(&icon, "icon", "", "https icon URL")
	fs.BoolVar(&dry, "dry-run", false, "validate only; print the cleaned card's sizes and what was removed")
	pos, err := parse(fs, args, io)
	if err != nil {
		return err
	}
	if body == "" && len(pos) > 0 {
		body = strings.Join(pos, " ")
	}
	if body == "" && io.StdinPiped && io.Stdin != nil {
		b, err := readStdin(io.Stdin)
		if err != nil {
			return err
		}
		body = b
	}
	if body, err = arg(body); err != nil {
		return err
	}
	if html, err = arg(html); err != nil {
		return err
	}
	if data, err = dataArg(data); err != nil {
		return err
	}
	body = strings.TrimSpace(body)
	if body == "" {
		body = strings.TrimSpace(title) // the gateway needs a body; a card-only message shows its title
	}
	if body == "" {
		return usageError{"nothing to send: give a body as the argument, --body, or on stdin"}
	}
	c, cfg, err := o.client(io)
	if err != nil {
		return err
	}
	key := o.key
	if key == "" {
		key = cfg.Key
	}
	fields := map[string]string{"title": title, "body": body, "html": html, "data": data, "url": link, "copy": copyText, "icon": icon}
	params := map[string]string{"level": level, "group": group, "id": id}
	if dry {
		params["dry_run"] = "true"
	}
	if key != "" {
		sealed, err := seal(key, c.Token, fields)
		if err != nil {
			return err
		}
		params["ciphertext"] = sealed
	} else {
		for k, v := range fields {
			params[k] = v
		}
	}
	res, err := c.Call(ctx, "sendMessage", nonEmpty(params))
	if err != nil {
		return err
	}
	if dry {
		printDryRun(io.Stdout, res)
		return nil
	}
	var m struct {
		ID int64 `json:"message_id"`
	}
	json.Unmarshal(res, &m)
	fmt.Fprintf(io.Stdout, "sent message %d\n", m.ID)
	return nil
}

func readStdin(r io.Reader) (string, error) {
	b, err := io.ReadAll(io.LimitReader(r, 1<<20))
	return strings.TrimRight(string(b), "\r\n"), err
}

// seal encrypts the content fields into the "ciphertext" value.
func seal(keyText, token string, fields map[string]string) (string, error) {
	key, err := ParseKey(keyText)
	if err != nil {
		return "", err
	}
	plain, _ := json.Marshal(nonEmpty(fields))
	return Encrypt(key, BotID(token), plain)
}

func nonEmpty(m map[string]string) map[string]string {
	out := map[string]string{}
	for k, v := range m {
		if v != "" {
			out[k] = v
		}
	}
	return out
}

type dryRunResult struct {
	HTML       string   `json:"html"`
	Raw        int      `json:"raw_size"`
	Compressed int      `json:"compressed_size"`
	Removed    []string `json:"removed"`
}

func printDryRun(w io.Writer, res json.RawMessage) {
	var d dryRunResult
	json.Unmarshal(res, &d)
	fmt.Fprintf(w, "dry run ok: %d bytes (limit 32768), %d bytes zlib (limit 4096)\n", d.Raw, d.Compressed)
	if len(d.Removed) > 0 {
		fmt.Fprintf(w, "removed by the whitelist: %s\n", strings.Join(d.Removed, ", "))
	}
}

// cmdChange is `edit` and `delete`.
func cmdChange(ctx context.Context, kind string, args []string, io IO) error {
	var o opts
	var id, data string
	var msgID int64
	fs := flag.NewFlagSet(kind, flag.ContinueOnError)
	o.bind(fs, kind == "edit")
	fs.StringVar(&id, "id", "", "collapse id of the message")
	fs.Int64Var(&msgID, "message-id", 0, "message id (from `honk send`)")
	if kind == "edit" {
		fs.StringVar(&data, "data", "", "new card data JSON, or @file")
	}
	pos, err := parse(fs, args, io)
	if err != nil {
		return err
	}
	if len(pos) > 0 {
		return usageError{"unexpected argument " + pos[0]}
	}
	if id == "" && msgID == 0 {
		return usageError{"--id or --message-id is required"}
	}
	c, cfg, err := o.client(io)
	if err != nil {
		return err
	}
	if o.key == "" {
		o.key = cfg.Key
	}
	params := map[string]string{"id": id}
	if msgID != 0 {
		params["message_id"] = fmt.Sprint(msgID)
	}
	method := "deleteMessage"
	if kind == "edit" {
		method = "editMessageData"
		if data, err = dataArg(data); err != nil {
			return err
		}
		if o.key != "" {
			if params["ciphertext"], err = seal(o.key, c.Token, map[string]string{"data": data}); err != nil {
				return err
			}
		} else {
			params["data"] = data
		}
	}
	if _, err := c.Call(ctx, method, nonEmpty(params)); err != nil {
		return err
	}
	fmt.Fprintln(io.Stdout, "ok")
	return nil
}

func cmdMe(ctx context.Context, args []string, io IO) error {
	var o opts
	fs := flag.NewFlagSet("me", flag.ContinueOnError)
	o.bind(fs, false)
	if _, err := parse(fs, args, io); err != nil {
		return err
	}
	c, _, err := o.client(io)
	if err != nil {
		return err
	}
	res, err := c.Call(ctx, "getMe", nil)
	if err != nil {
		return err
	}
	var out bytes.Buffer
	json.Indent(&out, res, "", "  ")
	fmt.Fprintln(io.Stdout, out.String())
	return nil
}

func cmdPreview(ctx context.Context, args []string, io IO) error {
	var o opts
	var data, id, title, body, level string
	var watch bool
	fs := flag.NewFlagSet("preview", flag.ContinueOnError)
	o.bind(fs, false)
	fs.StringVar(&data, "data", "", "card data JSON file (or JSON text)")
	fs.StringVar(&id, "id", "honk-preview", "collapse id: every save replaces the same message")
	fs.StringVar(&title, "title", "", "title (default: the file name)")
	fs.StringVar(&body, "body", "", "body (default: a short preview note)")
	fs.StringVar(&level, "level", "passive", "level; passive keeps the phone quiet")
	fs.BoolVar(&watch, "watch", false, "keep running; send again whenever the card or data file changes")
	pos, err := parse(fs, args, io)
	if err != nil {
		return err
	}
	if len(pos) != 1 {
		return usageError{"usage: honk preview card.html [--data data.json] [--watch]"}
	}
	file := pos[0]
	c, _, err := o.client(io)
	if err != nil {
		return err
	}
	dataFile := ""
	if strings.HasPrefix(data, "@") {
		data = data[1:]
	}
	if data != "" {
		if _, err := os.Stat(data); err == nil {
			dataFile = data
		}
	}
	if title == "" {
		title = filepath.Base(file)
	}
	if body == "" {
		body = "Preview of " + filepath.Base(file)
	}

	send := func() error {
		html, err := os.ReadFile(file)
		if err != nil {
			return err
		}
		d := data
		if dataFile != "" {
			if d, err = dataArg("@" + dataFile); err != nil {
				return err
			}
		} else if d, err = dataArg(d); err != nil {
			return err
		}
		params := nonEmpty(map[string]string{"title": title, "body": body, "html": string(html), "data": d, "id": id, "level": level})
		params["dry_run"] = "true"
		res, err := c.Call(ctx, "sendMessage", params)
		if err != nil {
			return err
		}
		printDryRun(io.Stdout, res)
		delete(params, "dry_run")
		if _, err := c.Call(ctx, "sendMessage", params); err != nil {
			return err
		}
		fmt.Fprintf(io.Stdout, "sent %s at %s\n", id, time.Now().Format("15:04:05"))
		return nil
	}
	if err := send(); err != nil {
		if !watch {
			return err
		}
		fmt.Fprintf(io.Stderr, "honk: %v\n", err)
	}
	if !watch {
		return nil
	}
	fmt.Fprintf(io.Stdout, "watching %s (Ctrl-C to stop)\n", file)
	poll := io.Poll
	if poll <= 0 {
		poll = 500 * time.Millisecond
	}
	files := []string{file}
	if dataFile != "" {
		files = append(files, dataFile)
	}
	last := stamp(files)
	t := time.NewTicker(poll)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-t.C:
		}
		if now := stamp(files); now != last {
			last = now
			if err := send(); err != nil {
				fmt.Fprintf(io.Stderr, "honk: %v\n", err) // keep watching: the next save may fix it
			}
		}
	}
}

// stamp summarises the files' modification times and sizes; it changes when
// any file is saved.
func stamp(files []string) string {
	var b strings.Builder
	for _, f := range files {
		if st, err := os.Stat(f); err == nil {
			fmt.Fprintf(&b, "%d:%d;", st.ModTime().UnixNano(), st.Size())
		} else {
			b.WriteString("-;")
		}
	}
	return b.String()
}
