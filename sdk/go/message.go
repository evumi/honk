package honk

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

// Level is how a message interrupts.
type Level string

const (
	Passive       Level = "passive"       // no sound, no wake
	Active        Level = "active"        // the default banner
	TimeSensitive Level = "timeSensitive" // breaks through Focus
)

// Open values: what tapping the notification does.
const (
	OpenChat = "chat" // the default: open the chat
	OpenURL  = "url"  // open Message.URL
)

// Markdown is the ParseMode that renders the body as Markdown.
const Markdown = "Markdown"

// Message is what Send sends. Body is required (unless the client has a Key);
// everything else is optional. See the Bot API's sendMessage for limits.
type Message struct {
	Title string
	Body  string
	// HTML is a card: whitelisted HTML and CSS, inline scripts allowed.
	HTML string
	// Data fills the card's {{key}} placeholders and is its chatData: a
	// string, []byte or json.RawMessage is sent as written (JSON text), any
	// other value is marshalled to JSON. At most 1 KB.
	Data  any
	URL   string // a link; with Open = OpenURL, tapping the notification opens it
	Copy  string // text behind the notification's Copy button
	Icon  string // https URL of the sender icon
	Image string // https URL of an image attached to the notification

	// The fields below stay readable to the gateway even with a Key.
	Level        Level         // passive, active (the bot's default when empty) or timeSensitive
	Group        string        // thread notifications by this name
	ID           string        // collapse id: a later message with the same ID replaces this one
	Open         string        // OpenChat or OpenURL
	ParseMode    string        // Markdown, or empty
	TTL          time.Duration // how long it stays queued, whole seconds, at least 60 s
	Silent       bool          // no banner; it still reaches the chat and the badge
	AllowQueries bool          // the card's request() reaches this bot (see Poll and WebhookHandler)
}

// Sent is the message as the gateway queued it.
type Sent struct {
	MessageID    int64  `json:"message_id"`
	BotID        string `json:"bot_id"`
	Kind         string `json:"kind"`
	ID           string `json:"id,omitempty"`
	Level        Level  `json:"level,omitempty"`
	Group        string `json:"group,omitempty"`
	Title        string `json:"title,omitempty"`
	Body         string `json:"body,omitempty"`
	Ciphertext   string `json:"ciphertext,omitempty"`
	AllowQueries bool   `json:"allow_queries,omitempty"`
	// Date is when the gateway took it, in Unix milliseconds.
	Date int64 `json:"date"`
}

// DryRunReport is what DryRun returns: the card as the gateway's whitelist
// leaves it, its sizes (limits 32768 raw and 4096 compressed) and what was
// removed. For an encrypted message only Level and CiphertextSize are set.
type DryRunReport struct {
	Level          Level    `json:"level"`
	HTML           string   `json:"html"`
	InputSize      int      `json:"input_size"`
	RawSize        int      `json:"raw_size"`
	CompressedSize int      `json:"compressed_size"`
	Removed        []string `json:"removed"`
	CiphertextSize int      `json:"ciphertext_size"`
}

// Bot is the bot behind the token.
type Bot struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	Avatar       string `json:"avatar"`
	DefaultLevel Level  `json:"default_level"`
	Encrypted    bool   `json:"encrypted"`
	CreatedAt    int64  `json:"created_at"`
	UpdatedAt    int64  `json:"updated_at"`
}

// Target names a message to edit or delete: by its collapse id (the ID it
// was sent with) or by the gateway's MessageID.
type Target struct {
	ID        string
	MessageID int64
}

// ByID targets the message sent with this collapse id.
func ByID(id string) Target { return Target{ID: id} }

// ByMessageID targets the message with this gateway id (Sent.MessageID).
func ByMessageID(id int64) Target { return Target{MessageID: id} }

// Send queues a message and pushes it to the bot owner's devices.
func (c *Client) Send(ctx context.Context, m Message) (Sent, error) {
	p, err := c.sendParams(m)
	if err != nil {
		return Sent{}, err
	}
	var out Sent
	err = c.call(ctx, "sendMessage", p, &out, 0)
	return out, err
}

// DryRun has the gateway check m without queueing or pushing anything. It
// counts against the bot's rate limit.
func (c *Client) DryRun(ctx context.Context, m Message) (DryRunReport, error) {
	p, err := c.sendParams(m)
	if err != nil {
		return DryRunReport{}, err
	}
	p["dry_run"] = true
	var out DryRunReport
	err = c.call(ctx, "sendMessage", p, &out, 0)
	return out, err
}

// Edit replaces a sent message's card data, silently. With a Key the data is
// sealed.
func (c *Client) Edit(ctx context.Context, t Target, data any) error {
	p, err := target(t)
	if err != nil {
		return err
	}
	d, err := dataText(data)
	if err != nil {
		return err
	}
	if c.Key != nil {
		sealed, err := c.seal(map[string]string{"data": d})
		if err != nil {
			return err
		}
		p["ciphertext"] = sealed
	} else {
		p["data"] = d
	}
	return c.call(ctx, "editMessageData", p, nil, 0)
}

// Delete removes a message and its notification.
func (c *Client) Delete(ctx context.Context, t Target) error {
	p, err := target(t)
	if err != nil {
		return err
	}
	return c.call(ctx, "deleteMessage", p, nil, 0)
}

// Me returns the bot behind the token.
func (c *Client) Me(ctx context.Context) (Bot, error) {
	var b Bot
	err := c.call(ctx, "getMe", map[string]any{}, &b, 0)
	return b, err
}

func (c *Client) sendParams(m Message) (map[string]any, error) {
	data, err := dataText(m.Data)
	if err != nil {
		return nil, err
	}
	p := map[string]any{}
	content := map[string]string{
		"title": m.Title, "body": m.Body, "html": m.HTML, "data": data,
		"url": m.URL, "copy": m.Copy, "icon": m.Icon, "image": m.Image,
	}
	if c.Key != nil {
		for k, v := range content {
			if v == "" {
				delete(content, k)
			}
		}
		sealed, err := c.seal(content)
		if err != nil {
			return nil, err
		}
		p["ciphertext"] = sealed
	} else {
		for k, v := range content {
			if v != "" {
				p[k] = v
			}
		}
	}
	set := func(k, v string) {
		if v != "" {
			p[k] = v
		}
	}
	set("level", string(m.Level))
	set("group", m.Group)
	set("id", m.ID)
	set("open", m.Open)
	set("parse_mode", m.ParseMode)
	if m.TTL != 0 {
		if m.TTL < time.Second {
			return nil, errors.New("honk: TTL is shorter than a second")
		}
		p["ttl"] = int64(m.TTL / time.Second)
	}
	if m.Silent {
		p["silent"] = true
	}
	if m.AllowQueries {
		p["allow_queries"] = true
	}
	return p, nil
}

func (c *Client) seal(content map[string]string) (string, error) {
	b, err := marshal(content)
	if err != nil {
		return "", err
	}
	s, err := Seal(c.Key, c.BotID(), b)
	if err != nil {
		return "", fmt.Errorf("honk: Key: %w", err)
	}
	return s, nil
}

func target(t Target) (map[string]any, error) {
	p := map[string]any{}
	switch {
	case t.ID != "":
		p["id"] = t.ID
	case t.MessageID > 0:
		p["message_id"] = t.MessageID
	default:
		return nil, errors.New("honk: Target needs ID or MessageID")
	}
	return p, nil
}

// dataText turns Message.Data into the JSON text the API takes.
func dataText(v any) (string, error) {
	switch d := v.(type) {
	case nil:
		return "", nil
	case string:
		return d, nil
	case []byte:
		return string(d), nil
	case json.RawMessage:
		return string(d), nil
	}
	b, err := json.Marshal(v)
	if err != nil {
		return "", fmt.Errorf("honk: Data: %w", err)
	}
	return string(b), nil
}
