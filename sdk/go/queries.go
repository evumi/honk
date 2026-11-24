package honk

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sync"
	"time"
)

// QueryTimeout is how long the gateway holds a card's request() for the
// bot's answer. A query answered later is refused.
const QueryTimeout = 15 * time.Second

// SecretHeader carries the secret token given to SetWebhook on every
// webhook delivery.
const SecretHeader = "X-Honk-Bot-Api-Secret-Token"

// WidgetQuery is what a card's request(data) sends: ID is answered with
// AnswerWidgetQuery, MessageID is the message the card belongs to, Data the
// 1–64 bytes the card passed.
type WidgetQuery struct {
	ID        string `json:"id"`
	MessageID int64  `json:"message_id"`
	Data      string `json:"data"`
}

// Update is one item from GetUpdates or a webhook delivery. WidgetQuery is
// nil for kinds of update this SDK does not know yet.
type Update struct {
	UpdateID    int64        `json:"update_id"`
	WidgetQuery *WidgetQuery `json:"widget_query,omitempty"`
}

// WebhookInfo is what GetWebhookInfo returns.
type WebhookInfo struct {
	URL                  string `json:"url"`
	HasCustomCertificate bool   `json:"has_custom_certificate"`
	PendingUpdateCount   int    `json:"pending_update_count"`
}

// QueryHandler answers a widget query: the string it returns (0–1024 bytes)
// is what the card's request() resolves with. An error leaves the query
// unanswered (see Poll and WebhookHandler for what the card then sees).
type QueryHandler func(ctx context.Context, q WidgetQuery) (string, error)

// GetUpdates long-polls for updates with an id of at least offset, waiting
// up to timeout (0–50 s) when there are none. It fails with 409 while a
// webhook is set. Poll is the loop around it.
func (c *Client) GetUpdates(ctx context.Context, offset int64, limit int, timeout time.Duration) ([]Update, error) {
	p := map[string]any{"timeout": int64(timeout / time.Second)}
	if offset != 0 {
		p["offset"] = offset
	}
	if limit > 0 {
		p["limit"] = limit
	}
	var out []Update
	err := c.call(ctx, "getUpdates", p, &out, timeout)
	return out, err
}

// AnswerWidgetQuery answers query id with data (0–1024 bytes), within
// QueryTimeout of the card's request.
func (c *Client) AnswerWidgetQuery(ctx context.Context, id, data string) error {
	return c.call(ctx, "answerWidgetQuery", map[string]any{"widget_query_id": id, "data": data}, nil, 0)
}

// SetWebhook has the gateway POST updates to url (https, on a public
// address) instead of keeping them for GetUpdates. secret, when not empty,
// comes back in the SecretHeader header of every delivery. An empty url
// removes the webhook.
func (c *Client) SetWebhook(ctx context.Context, url, secret string) error {
	p := map[string]any{"url": url}
	if secret != "" {
		p["secret_token"] = secret
	}
	return c.call(ctx, "setWebhook", p, nil, 0)
}

// DeleteWebhook removes the webhook, so GetUpdates works again.
func (c *Client) DeleteWebhook(ctx context.Context) error {
	return c.call(ctx, "deleteWebhook", map[string]any{}, nil, 0)
}

// GetWebhookInfo returns the webhook's URL and how many updates wait.
func (c *Client) GetWebhookInfo(ctx context.Context) (WebhookInfo, error) {
	var out WebhookInfo
	err := c.call(ctx, "getWebhookInfo", map[string]any{}, &out, 0)
	return out, err
}

// PollOptions tunes Poll.
type PollOptions struct {
	// Timeout is each long poll's wait in whole seconds; zero means 30 s.
	// It is kept between 1 s and 50 s.
	Timeout time.Duration
	// OnError hears about failures Poll gets over: a failed poll (retried
	// after 1 s, 2 s, … up to 30 s), a handler's error, a failed answer.
	OnError func(error)
}

// Poll receives updates with GetUpdates and runs h for every widget query,
// each in its own goroutine, answering with what h returns. It blocks until
// ctx ends (returning ctx.Err()) or the gateway refuses the polling itself:
// 401 or 404 (a wrong token) and 409 (a webhook is set) are returned. When h
// fails the query stays unanswered and the card's request() rejects with
// TIMEOUT after QueryTimeout. Poll waits for running handlers before it
// returns.
func (c *Client) Poll(ctx context.Context, h QueryHandler, opts *PollOptions) error {
	var o PollOptions
	if opts != nil {
		o = *opts
	}
	timeout := o.Timeout
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	// At least 1 s: a zero wait would have the loop ask again at once, over and over.
	timeout = min(max(timeout.Truncate(time.Second), time.Second), 50*time.Second)
	report := func(err error) {
		if o.OnError != nil && err != nil {
			o.OnError(err)
		}
	}
	var wg sync.WaitGroup
	defer wg.Wait()
	var offset int64
	var backoff time.Duration
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		updates, err := c.GetUpdates(ctx, offset, 100, timeout)
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			if IsCode(err, http.StatusUnauthorized) || IsCode(err, http.StatusNotFound) || IsCode(err, http.StatusConflict) {
				return err
			}
			report(err)
			backoff = min(max(2*backoff, time.Second), 30*time.Second)
			t := time.NewTimer(backoff)
			select {
			case <-ctx.Done():
				t.Stop()
				return ctx.Err()
			case <-t.C:
			}
			continue
		}
		backoff = 0
		for _, u := range updates {
			if u.UpdateID >= offset {
				offset = u.UpdateID + 1
			}
			if u.WidgetQuery == nil {
				continue
			}
			q := *u.WidgetQuery
			wg.Add(1)
			go func() {
				defer wg.Done()
				report(c.handleQuery(ctx, h, q, QueryTimeout))
			}()
		}
	}
}

// handleQuery runs h for q, giving it at most limit, and answers.
func (c *Client) handleQuery(ctx context.Context, h QueryHandler, q WidgetQuery, limit time.Duration) error {
	hctx, cancel := context.WithTimeout(ctx, limit)
	data, err := h(hctx, q)
	cancel()
	if err != nil {
		return fmt.Errorf("honk: widget query %s: %w", q.ID, err)
	}
	// Answer even when ctx has just ended, so a finished handler is not lost.
	actx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	if err := c.AnswerWidgetQuery(actx, q.ID, data); err != nil {
		return fmt.Errorf("honk: widget query %s: %w", q.ID, err)
	}
	return nil
}

// WebhookOptions tunes WebhookHandler.
type WebhookOptions struct {
	// Secret is the secret given to SetWebhook; deliveries without it in the
	// SecretHeader header are refused with 401. Empty: no check.
	Secret string
	// OnError hears about handlers that failed and answers that failed.
	OnError func(error)
}

// WebhookHandler serves the URL given to SetWebhook: it checks the secret
// (when opts has one), runs h for a widget query and answers it before
// replying 200. The gateway waits 5 s for the delivery, so h should
// be quick; its context ends when the gateway gives up. When h or the answer
// fails the handler replies 500, and the gateway fails the card's request()
// at once (REQUEST_FAILED) instead of letting it time out. Other updates are
// acknowledged with 200.
func (c *Client) WebhookHandler(h QueryHandler, opts *WebhookOptions) http.Handler {
	var o WebhookOptions
	if opts != nil {
		o = *opts
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if o.Secret != "" && subtle.ConstantTimeCompare([]byte(r.Header.Get(SecretHeader)), []byte(o.Secret)) != 1 {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		var u Update
		if err := json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(&u); err != nil {
			http.Error(w, "bad update", http.StatusBadRequest)
			return
		}
		if u.WidgetQuery != nil {
			if err := c.handleQuery(r.Context(), h, *u.WidgetQuery, QueryTimeout); err != nil {
				if o.OnError != nil {
					o.OnError(err)
				}
				http.Error(w, "query failed", http.StatusInternalServerError)
				return
			}
		}
		w.WriteHeader(http.StatusOK)
	})
}
